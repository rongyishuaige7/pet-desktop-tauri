use base64::Engine;
use image::{GenericImageView, ImageFormat, imageops::FilterType};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};

use super::frame_pack::{
    MAX_DECODED_PACK_BYTES, MAX_FRAMES_PER_ACTION, MAX_IMAGE_BYTES, MAX_PACK_BYTES,
};
use super::frame_pack::read_frame_bytes;
use super::{decode_frame, inspect_frame_directory, scan_action_frames, ACTIONS};

const FORMAT: &str = "desktop-sticker-pet";
const FORMAT_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "pet-package.json";
const THUMBNAIL_NAME: &str = "thumbnail.png";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MIN_FRAMES: usize = 5;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetMeta {
    name: String,
    species: String,
    style: String,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFrame {
    path: String,
    sha256: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    format_version: u32,
    pet: PetMeta,
    actions: BTreeMap<String, Vec<ManifestFrame>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPetPackage {
    pub root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSummary {
    pub name: String,
    pub species: String,
    pub style: String,
    pub created_at: String,
    pub actions: BTreeMap<String, usize>,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPetPackage {
    pub asset_id: String,
    pub root: String,
    pub name: String,
    pub species: String,
    pub style: String,
    pub created_at: String,
    pub thumbnail: Option<String>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_meta(pet: &PetMeta) -> Result<(), String> {
    let name = pet.name.trim();
    if name.is_empty() || name.chars().count() > 20 {
        return Err("伙伴包名字为空或超过 20 个字符".into());
    }
    if pet.species != "cat" && pet.species != "dog" {
        return Err("伙伴包物种只能是 cat 或 dog".into());
    }
    if pet.style != "q-sticker" {
        return Err("伙伴包风格必须是 q-sticker".into());
    }
    if pet.created_at.trim().is_empty() || pet.created_at.len() > 64 {
        return Err("伙伴包创建时间无效".into());
    }
    Ok(())
}

fn resolve_package_file(root: &Path, relative: &str, seen: &mut HashSet<String>) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.contains('\\') {
        return Err(format!("伙伴包路径无效：{relative}"));
    }
    let rel = Path::new(relative);
    if rel.is_absolute()
        || rel
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err(format!("伙伴包拒绝绝对路径或 ..：{relative}"));
    }
    if !seen.insert(relative.to_string()) {
        return Err(format!("伙伴包重复引用文件：{relative}"));
    }
    let root_canonical = root
        .canonicalize()
        .map_err(|err| format!("读取伙伴包目录失败：{err}"))?;
    let mut current = root.to_path_buf();
    for component in rel.components() {
        current.push(component.as_os_str());
        let meta = std::fs::symlink_metadata(&current)
            .map_err(|err| format!("伙伴包文件不存在 {}：{err}", current.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("伙伴包拒绝符号链接：{relative}"));
        }
    }
    let canonical = current
        .canonicalize()
        .map_err(|err| format!("伙伴包文件无法解析：{err}"))?;
    if !canonical.starts_with(&root_canonical) {
        return Err(format!("伙伴包路径越界：{relative}"));
    }
    Ok(current)
}

fn read_manifest(root: &Path) -> Result<Manifest, String> {
    let path = root.join(MANIFEST_NAME);
    let meta = std::fs::symlink_metadata(&path)
        .map_err(|err| format!("缺少 {MANIFEST_NAME}：{err}"))?;
    if meta.file_type().is_symlink() {
        return Err("伙伴包清单不能是符号链接".into());
    }
    if meta.len() > MAX_MANIFEST_BYTES as u64 {
        return Err("伙伴包清单超过 64 KiB".into());
    }
    let bytes = std::fs::read(&path).map_err(|err| format!("读取伙伴包清单失败：{err}"))?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|err| format!("伙伴包清单不是有效 JSON：{err}"))?;
    if manifest.format != FORMAT {
        return Err("不是桌面贴贴宠物伙伴包".into());
    }
    if manifest.format_version != FORMAT_VERSION {
        return Err(format!(
            "不支持的伙伴包版本：{}",
            manifest.format_version
        ));
    }
    validate_meta(&manifest.pet)?;
    Ok(manifest)
}

fn validate_package(root: &Path) -> Result<(Manifest, HashMap<String, Vec<PathBuf>>, Option<String>), String> {
    let manifest = read_manifest(root)?;
    let mut seen = HashSet::new();
    let mut paths = HashMap::new();
    let mut total_bytes = 0usize;
    let mut decoded_bytes = 0u64;

    for (action, _) in ACTIONS {
        let entries = manifest
            .actions
            .get(action)
            .ok_or_else(|| format!("伙伴包缺少动作：{action}"))?;
        if entries.len() < MIN_FRAMES || entries.len() > MAX_FRAMES_PER_ACTION {
            return Err(format!(
                "伙伴包 {action} 需要 5–60 帧，当前 {} 帧",
                entries.len()
            ));
        }
        let mut action_paths = Vec::new();
        for entry in entries {
            let path = resolve_package_file(root, &entry.path, &mut seen)?;
            let bytes = read_frame_bytes(&path)?;
            total_bytes += bytes.len();
            if total_bytes > MAX_PACK_BYTES {
                return Err("伙伴包文件总量超过 128 MiB".into());
            }
            if entry.sha256.len() != 64 || sha256_hex(&bytes) != entry.sha256 {
                return Err(format!("伙伴包散列不匹配：{}", entry.path));
            }
            let image = decode_frame(&bytes)?;
            let (width, height) = image.dimensions();
            if width != entry.width || height != entry.height {
                return Err(format!("伙伴包图片尺寸不匹配：{}", entry.path));
            }
            decoded_bytes += width as u64 * height as u64 * 4;
            if decoded_bytes > MAX_DECODED_PACK_BYTES {
                return Err("伙伴包解码总量超过 256 MiB".into());
            }
            action_paths.push(path);
        }
        paths.insert(action.to_string(), action_paths);
    }
    if manifest.actions.len() != ACTIONS.len() {
        return Err("伙伴包包含未知动作".into());
    }

    let thumbnail_path = root.join(THUMBNAIL_NAME);
    let thumbnail_meta = std::fs::symlink_metadata(&thumbnail_path)
        .map_err(|err| format!("伙伴包缺少 {THUMBNAIL_NAME}：{err}"))?;
    if thumbnail_meta.file_type().is_symlink() || thumbnail_meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err("伙伴包缩略图无效".into());
    }
    let thumbnail_bytes = std::fs::read(&thumbnail_path).map_err(|err| format!("读取缩略图失败：{err}"))?;
    decode_frame(&thumbnail_bytes)?;
    let thumbnail = Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&thumbnail_bytes)
    ));
    Ok((manifest, paths, thumbnail))
}

fn safe_base(name: &str) -> String {
    let base: String = name
        .trim()
        .chars()
        .filter(|ch| ch.is_alphanumeric() || *ch == '-' || *ch == '_')
        .take(40)
        .collect();
    if base.is_empty() { "pet".into() } else { base }
}

fn unique_target(parent: &Path, base: &str) -> PathBuf {
    let first = parent.join(format!("{base}-pet-package"));
    if !first.exists() {
        return first;
    }
    for index in 2..10_000 {
        let candidate = parent.join(format!("{base}-pet-package-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{base}-pet-package-{}", std::process::id()))
}

pub fn export_pet_package(
    parent: &Path,
    name: &str,
    species: &str,
    style: &str,
    created_at: &str,
    frame_root: &Path,
) -> Result<ExportedPetPackage, String> {
    let meta = PetMeta {
        name: name.to_string(),
        species: species.to_string(),
        style: style.to_string(),
        created_at: created_at.to_string(),
    };
    validate_meta(&meta)?;
    let inspection = inspect_frame_directory(frame_root)?;
    if !inspection.valid {
        return Err(format!("素材不完整，未导出：{}", inspection.issues.join("；")));
    }
    std::fs::create_dir_all(parent).map_err(|err| format!("创建导出目录失败：{err}"))?;
    let base = safe_base(name);
    let target = unique_target(parent, &base);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = parent.join(format!(".pet-package-{nonce}-{}", std::process::id()));
    std::fs::create_dir_all(&staging).map_err(|err| format!("创建导出暂存目录失败：{err}"))?;

    let result = (|| -> Result<(), String> {
        let mut actions = BTreeMap::new();
        let mut thumbnail_bytes: Option<Vec<u8>> = None;
        for (action, _) in ACTIONS {
            let frames = scan_action_frames(frame_root, action)?;
            if frames.len() < MIN_FRAMES || frames.len() > MAX_FRAMES_PER_ACTION {
                return Err(format!("{action} 帧数不在 5–60 范围内"));
            }
            let mut entries = Vec::new();
            for (index, path) in frames.iter().enumerate() {
                let bytes = read_frame_bytes(path)?;
                let image = decode_frame(&bytes)?;
                let (width, height) = image.dimensions();
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("png")
                    .to_ascii_lowercase();
                let relative = format!("frames/{action}/{index:03}.{extension}");
                let destination = staging.join(&relative);
                if let Some(dir) = destination.parent() {
                    std::fs::create_dir_all(dir)
                        .map_err(|err| format!("创建导出动作目录失败：{err}"))?;
                }
                std::fs::write(&destination, &bytes)
                    .map_err(|err| format!("写入导出帧失败：{err}"))?;
                if action == "idle" && thumbnail_bytes.is_none() {
                    let mut buffer = Cursor::new(Vec::new());
                    image
                        .resize(256, 256, FilterType::Lanczos3)
                        .write_to(&mut buffer, ImageFormat::Png)
                        .map_err(|err| format!("生成缩略图失败：{err}"))?;
                    thumbnail_bytes = Some(buffer.into_inner());
                }
                entries.push(ManifestFrame {
                    path: relative,
                    sha256: sha256_hex(&bytes),
                    width,
                    height,
                });
            }
            actions.insert(action.to_string(), entries);
        }
        let thumbnail = thumbnail_bytes.ok_or_else(|| "没有可用的待机帧生成缩略图".to_string())?;
        std::fs::write(staging.join(THUMBNAIL_NAME), thumbnail)
            .map_err(|err| format!("写入缩略图失败：{err}"))?;
        let manifest = Manifest {
            format: FORMAT.to_string(),
            format_version: FORMAT_VERSION,
            pet: meta,
            actions,
        };
        let json = serde_json::to_vec_pretty(&manifest)
            .map_err(|err| format!("序列化伙伴包清单失败：{err}"))?;
        if json.len() > MAX_MANIFEST_BYTES {
            return Err("伙伴包清单超过 64 KiB".into());
        }
        std::fs::write(staging.join(MANIFEST_NAME), json)
            .map_err(|err| format!("写入伙伴包清单失败：{err}"))?;
        std::fs::rename(&staging, &target).map_err(|err| format!("提交伙伴包失败：{err}"))?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err);
    }
    Ok(ExportedPetPackage {
        root: target.display().to_string(),
    })
}

pub fn inspect_pet_package(root: &Path) -> Result<PackageSummary, String> {
    let (manifest, paths, thumbnail) = validate_package(root)?;
    let mut counts = BTreeMap::new();
    for (action, _) in ACTIONS {
        counts.insert(action.to_string(), paths.get(action).map(Vec::len).unwrap_or(0));
    }
    Ok(PackageSummary {
        name: manifest.pet.name,
        species: manifest.pet.species,
        style: manifest.pet.style,
        created_at: manifest.pet.created_at,
        actions: counts,
        thumbnail,
    })
}

pub fn import_pet_package(
    root: &Path,
    assets_root: &Path,
    asset_id: &str,
) -> Result<ImportedPetPackage, String> {
    if asset_id.is_empty()
        || asset_id.len() > 80
        || !asset_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("素材 id 只能包含字母、数字、- 和 _".into());
    }
    let (manifest, paths, thumbnail) = validate_package(root)?;
    std::fs::create_dir_all(assets_root)
        .map_err(|err| format!("创建应用素材目录失败：{err}"))?;
    let final_root = assets_root.join(asset_id);
    if final_root.exists() {
        return Err(format!("目标素材已存在，不覆盖：{}", final_root.display()));
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = assets_root.join(format!(".staging-package-{asset_id}-{nonce}-{}", std::process::id()));
    std::fs::create_dir_all(&staging).map_err(|err| format!("创建导入暂存目录失败：{err}"))?;

    let result = (|| -> Result<(), String> {
        for (action, _) in ACTIONS {
            let frames = paths
                .get(action)
                .ok_or_else(|| format!("缺少动作：{action}"))?;
            let dir = staging.join(action);
            std::fs::create_dir_all(&dir).map_err(|err| format!("创建导入动作目录失败：{err}"))?;
            for (index, source) in frames.iter().enumerate() {
                let extension = source
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("png")
                    .to_ascii_lowercase();
                let destination = dir.join(format!("{index:03}.{extension}"));
                std::fs::copy(source, &destination)
                    .map_err(|err| format!("复制导入帧失败：{err}"))?;
            }
        }
        let copied = inspect_frame_directory(&staging)?;
        if !copied.valid {
            return Err(format!("导入后的素材预检未通过：{}", copied.issues.join("；")));
        }
        std::fs::rename(&staging, &final_root)
            .map_err(|err| format!("提交导入素材失败：{err}"))?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err);
    }
    Ok(ImportedPetPackage {
        asset_id: asset_id.to_string(),
        root: final_root.display().to_string(),
        name: manifest.pet.name,
        species: manifest.pet.species,
        style: manifest.pet.style,
        created_at: manifest.pet.created_at,
        thumbnail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::DynamicImage;
    use std::io::Cursor;

    fn write_png(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let image = DynamicImage::new_rgba8(2, 2);
        let mut buffer = Cursor::new(Vec::new());
        image.write_to(&mut buffer, ImageFormat::Png).unwrap();
        std::fs::write(path, buffer.into_inner()).unwrap();
    }

    fn write_pack(root: &Path) {
        for (action, _) in ACTIONS {
            for index in 0..5 {
                write_png(&root.join(action).join(format!("{index:03}.png")));
            }
        }
    }

    fn mutate_manifest(root: &Path, change: impl FnOnce(&mut serde_json::Value)) {
        let path = root.join(MANIFEST_NAME);
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        change(&mut value);
        std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }

    #[test]
    fn export_and_import_round_trip_uses_new_ids_and_relative_paths() {
        let source = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        write_pack(source.path());

        let first = export_pet_package(
            parent.path(),
            "咕唧",
            "cat",
            "q-sticker",
            "2026-10-21T00:00:00Z",
            source.path(),
        )
        .expect("export");
        let second = export_pet_package(
            parent.path(),
            "咕唧",
            "cat",
            "q-sticker",
            "2026-10-21T00:00:00Z",
            source.path(),
        )
        .expect("second export");
        assert_ne!(first.root, second.root);
        assert!(Path::new(&first.root).join(MANIFEST_NAME).is_file());
        assert!(Path::new(&first.root).join(THUMBNAIL_NAME).is_file());

        let manifest_text = std::fs::read_to_string(Path::new(&first.root).join(MANIFEST_NAME)).unwrap();
        assert!(!manifest_text.contains("sourceImage"));
        assert!(!manifest_text.contains("http"));
        assert!(!manifest_text.contains(source.path().to_string_lossy().as_ref()));

        let summary = inspect_pet_package(Path::new(&first.root)).expect("inspect");
        assert_eq!(summary.name, "咕唧");
        assert_eq!(summary.actions.get("idle"), Some(&5));
        assert!(summary.thumbnail.is_some());

        let imported = import_pet_package(
            Path::new(&first.root),
            assets.path(),
            "pet-import-1",
        )
        .expect("import");
        assert_eq!(imported.asset_id, "pet-import-1");
        assert_eq!(imported.name, "咕唧");
        assert!(Path::new(&imported.root).join("idle").join("000.png").is_file());
        assert!(inspect_frame_directory(Path::new(&imported.root)).unwrap().valid);
        assert!(source.path().join("idle").join("000.png").is_file());
    }

    #[test]
    fn export_refuses_an_incomplete_source_without_creating_a_package() {
        let source = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        write_pack(source.path());
        std::fs::remove_dir_all(source.path().join("walk")).unwrap();

        let result = export_pet_package(
            parent.path(),
            "咕唧",
            "cat",
            "q-sticker",
            "2026-10-21T00:00:00Z",
            source.path(),
        );

        assert!(result.is_err());
        assert!(
            std::fs::read_dir(parent.path())
                .unwrap()
                .filter_map(|entry| entry.ok())
                .all(|entry| !entry.file_name().to_string_lossy().ends_with("-pet-package"))
        );
    }

    #[test]
    fn package_validation_rejects_unknown_version_absolute_parent_and_duplicate_paths() {
        let source = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        write_pack(source.path());
        let exported = export_pet_package(
            parent.path(),
            "咕唧",
            "cat",
            "q-sticker",
            "2026-10-21T00:00:00Z",
            source.path(),
        )
        .unwrap();
        let root = Path::new(&exported.root);

        mutate_manifest(root, |value| value["formatVersion"] = 2.into());
        assert!(inspect_pet_package(root).is_err());

        mutate_manifest(root, |value| {
            value["formatVersion"] = 1.into();
            value["actions"]["idle"][0]["path"] = "/tmp/evil.png".into();
        });
        assert!(inspect_pet_package(root).is_err());

        mutate_manifest(root, |value| {
            value["actions"]["idle"][0]["path"] = "../evil.png".into();
        });
        assert!(inspect_pet_package(root).is_err());

        mutate_manifest(root, |value| {
            value["actions"]["idle"][0]["path"] = "frames/idle/000.png".into();
            value["actions"]["idle"][1]["path"] = "frames/idle/000.png".into();
        });
        assert!(inspect_pet_package(root).is_err());
    }

    #[test]
    fn package_validation_rejects_hash_mismatch_missing_action_and_symlink() {
        let source = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        write_pack(source.path());
        let exported = export_pet_package(
            parent.path(),
            "咕唧",
            "cat",
            "q-sticker",
            "2026-10-21T00:00:00Z",
            source.path(),
        )
        .unwrap();
        let root = Path::new(&exported.root);

        mutate_manifest(root, |value| {
            value["actions"]["idle"][0]["sha256"] = "0".repeat(64).into();
        });
        assert!(inspect_pet_package(root).is_err());
        assert!(import_pet_package(root, assets.path(), "pet-bad").is_err());
        assert!(!assets.path().join("pet-bad").exists());

        mutate_manifest(root, |value| {
            value["actions"]["idle"][0]["sha256"] =
                sha256_hex(&std::fs::read(root.join("frames/idle/000.png")).unwrap()).into();
            value["actions"].as_object_mut().unwrap().remove("walk");
        });
        assert!(inspect_pet_package(root).is_err());

        #[cfg(unix)]
        {
            let exported = export_pet_package(
                parent.path(),
                "咕唧",
                "cat",
                "q-sticker",
                "2026-10-21T00:00:00Z",
                source.path(),
            )
            .unwrap();
            let symlink_root = Path::new(&exported.root);
            let target = source.path().join("idle/000.png");
            let link = symlink_root.join("frames/idle/000.png");
            std::fs::remove_file(&link).unwrap();
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(inspect_pet_package(symlink_root).is_err());
        }
    }
}
