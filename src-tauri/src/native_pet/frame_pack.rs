use base64::Engine;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use super::model::ACTIONS;

pub const MIN_FRAMES_PER_ACTION: usize = 5;
const MAX_FRAMES_PER_ACTION: usize = 60;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PACK_BYTES: usize = 128 * 1024 * 1024;
const MAX_DECODED_PACK_BYTES: u64 = 256 * 1024 * 1024;

pub fn decode_frame(bytes: &[u8]) -> Result<DynamicImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("帧图为空或超过 16 MiB".into());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| format!("识别图片失败：{err}"))?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err("帧图必须是有效 PNG、JPEG 或 WebP".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|err| format!("帧图解码失败（最大 2048×2048）：{err}"))
}

fn read_frame_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let size = std::fs::metadata(path)
        .map_err(|err| format!("读取帧图属性失败：{err}"))?
        .len();
    if size > MAX_IMAGE_BYTES as u64 {
        return Err(format!("帧图超过 16 MiB：{}", path.display()));
    }
    let bytes =
        std::fs::read(path).map_err(|err| format!("读取帧图失败 {}：{err}", path.display()))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("帧图超过 16 MiB".into());
    }
    Ok(bytes)
}

pub fn read_frame(path: &Path) -> Result<DynamicImage, String> {
    decode_frame(&read_frame_bytes(path)?)
}

pub fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp"
            )
        })
        .unwrap_or(false)
}

fn enumerate_action_frames(root: &Path, action: &str) -> Result<Vec<PathBuf>, String> {
    let action_dir = root.join(action);
    let mut paths = std::fs::read_dir(&action_dir)
        .map_err(|err| format!("读取动作目录失败 {}：{err}", action_dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_file() && is_supported_image(path))
        .collect::<Vec<_>>();

    paths.sort_by_key(|path| path.file_name().map(|name| name.to_os_string()));
    Ok(paths)
}

pub fn scan_action_frames(root: &Path, action: &str) -> Result<Vec<PathBuf>, String> {
    let paths = enumerate_action_frames(root, action)?;
    if paths.len() > MAX_FRAMES_PER_ACTION {
        return Err(format!(
            "{action} 超过 60 帧（当前 {} 帧）",
            paths.len()
        ));
    }
    Ok(paths)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInspection {
    pub action: String,
    pub frames: usize,
    pub min_frames: usize,
    pub max_frames: usize,
    pub issues: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameInspection {
    pub root: String,
    pub actions: Vec<ActionInspection>,
    pub missing_actions: Vec<String>,
    pub total_bytes: usize,
    pub decoded_bytes: u64,
    pub valid: bool,
    pub issues: Vec<String>,
    pub global_issues: Vec<String>,
    pub thumbnail: Option<String>,
}

/// Read-only preflight. It never writes, activates or attaches anything; every
/// action and file issue is collected instead of failing at the first error.
pub fn inspect_frame_directory(root: &Path) -> Result<FrameInspection, String> {
    if !root.is_dir() {
        return Err(format!("目录不存在或不是文件夹：{}", root.display()));
    }
    let mut actions = Vec::new();
    let mut missing_actions = Vec::new();
    let mut issues = Vec::new();
    let mut global_issues = Vec::new();
    let mut total_bytes = 0usize;
    let mut decoded_bytes = 0u64;
    let mut thumbnail: Option<String> = None;

    for (action, _) in ACTIONS {
        let mut action_issues = Vec::new();
        let mut enumerated = true;
        let frames = match enumerate_action_frames(root, action) {
            Ok(frames) => frames,
            Err(err) => {
                enumerated = false;
                action_issues.push(err);
                Vec::new()
            }
        };
        let frame_count = frames.len();
        if frame_count == 0 {
            missing_actions.push(action.to_string());
        }
        if enumerated && frame_count < MIN_FRAMES_PER_ACTION {
            action_issues.push(format!(
                "至少需要 {} 帧，当前只有 {} 帧",
                MIN_FRAMES_PER_ACTION,
                frame_count
            ));
        }
        if frame_count > MAX_FRAMES_PER_ACTION {
            action_issues.push(format!(
                "超过 {} 帧（当前 {} 帧）",
                MAX_FRAMES_PER_ACTION, frame_count
            ));
        }
        for path in &frames {
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string());
            match read_frame_bytes(path) {
                Ok(bytes) => {
                    total_bytes += bytes.len();
                    match decode_frame(&bytes) {
                        Ok(image) => {
                            let (w, h) = image.dimensions();
                            decoded_bytes += w as u64 * h as u64 * 4;
                            if thumbnail.is_none() && (action == "idle" || frames.len() > 0) {
                                if bytes.len() <= 2 * 1024 * 1024 {
                                    thumbnail = Some(format!(
                                        "data:{};base64,{}",
                                        image_mime(path),
                                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                                    ));
                                }
                            }
                        }
                        Err(err) => action_issues.push(format!("{name}：{err}")),
                    }
                }
                Err(err) => action_issues.push(format!("{name}：{err}")),
            }
        }
        issues.extend(action_issues.iter().cloned());
        actions.push(ActionInspection {
            action: action.to_string(),
            frames: frame_count,
            min_frames: MIN_FRAMES_PER_ACTION,
            max_frames: MAX_FRAMES_PER_ACTION,
            issues: action_issues,
        });
    }

    if total_bytes > MAX_PACK_BYTES {
        global_issues.push("帧包文件总量超过 128 MiB".to_string());
    }
    if decoded_bytes > MAX_DECODED_PACK_BYTES {
        global_issues.push("帧包解码总量超过 256 MiB".to_string());
    }
    issues.extend(global_issues.iter().cloned());

    Ok(FrameInspection {
        root: root.display().to_string(),
        actions,
        missing_actions,
        total_bytes,
        decoded_bytes,
        valid: issues.is_empty(),
        issues,
        global_issues,
        thumbnail,
    })
}

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

pub fn scan_pack(root: &Path) -> Result<HashMap<String, Vec<PathBuf>>, String> {
    let mut actions = HashMap::new();
    let mut total_bytes = 0;
    let mut decoded_bytes = 0;

    for (action, _) in ACTIONS {
        let frames = scan_action_frames(root, action)?;
        if frames.len() < MIN_FRAMES_PER_ACTION {
            return Err(format!(
                "{}/{} 至少需要 {} 帧，当前只有 {} 帧",
                root.display(),
                action,
                MIN_FRAMES_PER_ACTION,
                frames.len()
            ));
        }
        for path in &frames {
            let bytes = read_frame_bytes(path)?;
            total_bytes += bytes.len();
            let image = decode_frame(&bytes)?;
            let (w, h) = image.dimensions();
            decoded_bytes += w as u64 * h as u64 * 4;
            if total_bytes > MAX_PACK_BYTES || decoded_bytes > MAX_DECODED_PACK_BYTES {
                return Err("帧包超过容量限制（文件 128 MiB / 解码 256 MiB）".into());
            }
        }
        actions.insert(action.to_string(), frames);
    }

    Ok(actions)
}

pub fn write_manual_frame_pack(
    root: &Path,
    actions: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut decoded = HashMap::new();
    let mut total_bytes = 0;
    let mut decoded_bytes = 0;

    for (action, _) in ACTIONS {
        let frames = actions
            .get(action)
            .ok_or_else(|| format!("缺少动作目录：{action}"))?;
        if frames.len() < MIN_FRAMES_PER_ACTION {
            return Err(format!(
                "{action} 至少需要 {} 帧，当前只有 {} 帧",
                MIN_FRAMES_PER_ACTION,
                frames.len()
            ));
        }

        if frames.len() > MAX_FRAMES_PER_ACTION {
            return Err(format!("{action} 超过 60 帧"));
        }
        let mut files = Vec::with_capacity(frames.len());
        for data_url in frames {
            let (bytes, extension) = decode_image_data_url(data_url)?;
            let image = decode_frame(&bytes)?;
            let (w, h) = image.dimensions();
            total_bytes += bytes.len();
            decoded_bytes += w as u64 * h as u64 * 4;
            if total_bytes > MAX_PACK_BYTES || decoded_bytes > MAX_DECODED_PACK_BYTES {
                return Err("帧包超过容量限制".into());
            }
            files.push((bytes, extension));
        }
        decoded.insert(action.to_string(), files);
    }

    // Pack names are unique. Never remove or overwrite an existing pack.
    if root.exists() {
        return Err(format!("帧包目录已存在，请使用新目录：{}", root.display()));
    }
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建帧包父目录失败：{err}"))?;
    }
    std::fs::create_dir(root)
        .map_err(|err| format!("创建手动帧包目录失败 {}：{err}", root.display()))?;

    for (action, files) in decoded {
        let action_dir = root.join(&action);
        std::fs::create_dir_all(&action_dir)
            .map_err(|err| format!("创建动作目录失败 {}：{err}", action_dir.display()))?;

        for (index, (bytes, extension)) in files.into_iter().enumerate() {
            let path = action_dir.join(format!("{index:03}.{extension}"));
            std::fs::write(&path, bytes)
                .map_err(|err| format!("写入帧图失败 {}：{err}", path.display()))?;
        }
    }

    Ok(())
}

fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "帧图不是有效的 data URL".to_string())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.split_once(';').map(|(mime, _)| mime))
        .ok_or_else(|| "帧图缺少 MIME 类型".to_string())?;

    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => return Err(format!("不支持的帧图类型：{mime}")),
    };

    if payload.len() > MAX_IMAGE_BYTES * 4 / 3 + 4 {
        return Err("帧图超过 16 MiB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|err| format!("帧图 base64 解码失败：{err}"))?;
    if bytes.is_empty() {
        return Err("帧图内容为空".to_string());
    }

    let expected = match extension {
        "png" => ImageFormat::Png,
        "jpg" => ImageFormat::Jpeg,
        _ => ImageFormat::WebP,
    };
    if image::guess_format(&bytes).ok() != Some(expected) {
        return Err("帧图内容与声明的图片类型不符".into());
    }
    Ok((bytes, extension))
}

pub fn encode_image_as_data_url(path: &Path) -> Result<String, String> {
    let bytes = read_frame_bytes(path)?;
    let content_type = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{content_type};base64,{encoded}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create dir");
        }
        std::fs::write(path, b"frame").expect("write frame");
    }

    fn write_png(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create dir");
        }
        let image = DynamicImage::new_rgba8(2, 2);
        let mut buffer = Cursor::new(Vec::new());
        image.write_to(&mut buffer, ImageFormat::Png).unwrap();
        std::fs::write(path, buffer.into_inner()).expect("write png");
    }

    fn write_pack(root: &Path, count: usize) {
        for (action, _) in ACTIONS {
            for index in 0..count {
                write_png(&root.join(action).join(format!("{index:03}.png")));
            }
        }
    }

    #[test]
    fn inspection_reports_a_complete_pack_without_writing() {
        let dir = tempfile::tempdir().expect("temp dir");
        write_pack(dir.path(), 5);
        let before = std::fs::read_dir(dir.path()).unwrap().count();

        let report = inspect_frame_directory(dir.path()).expect("inspect");

        assert!(report.valid);
        assert_eq!(report.actions.len(), ACTIONS.len());
        assert!(report.missing_actions.is_empty());
        assert!(report.issues.is_empty());
        assert_eq!(
            report.actions.iter().map(|action| action.frames).sum::<usize>(),
            30
        );
        assert!(report.thumbnail.is_some());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), before);
    }

    #[test]
    fn inspection_collects_missing_actions_and_bad_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        for (action, _) in ACTIONS {
            if action == "walk" {
                continue;
            }
            for index in 0..5 {
                write_png(&dir.path().join(action).join(format!("{index:03}.png")));
            }
        }
        std::fs::write(dir.path().join("idle").join("bad.png"), b"not an image").unwrap();

        let report = inspect_frame_directory(dir.path()).expect("inspect");

        assert!(!report.valid);
        assert!(report.missing_actions.contains(&"walk".to_string()));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("bad.png")));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("walk")));
    }

    #[test]
    fn inspection_reports_an_oversized_file_without_reading_it_fully() {
        let dir = tempfile::tempdir().expect("temp dir");
        write_pack(dir.path(), 5);
        std::fs::write(
            dir.path().join("idle").join("999.png"),
            vec![0u8; MAX_IMAGE_BYTES + 1],
        )
        .unwrap();

        let report = inspect_frame_directory(dir.path()).expect("inspect");

        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("16 MiB")));
    }

    #[test]
    fn inspection_reports_too_many_frames_instead_of_truncating() {
        let dir = tempfile::tempdir().expect("temp dir");
        write_pack(dir.path(), 5);
        for index in 5..61 {
            write_png(&dir.path().join("idle").join(format!("{index:03}.png")));
        }

        let report = inspect_frame_directory(dir.path()).expect("inspect");

        assert!(!report.valid);
        let idle = report
            .actions
            .iter()
            .find(|action| action.action == "idle")
            .expect("idle");
        assert_eq!(idle.frames, 61);
        assert!(!report.missing_actions.contains(&"idle".to_string()));
        assert!(idle
            .issues
            .iter()
            .any(|issue| issue.contains("超过 60 帧（当前 61 帧）")));
        assert!(report.total_bytes > 0);
    }

    #[test]
    fn inspection_rejects_one_to_four_frames_per_action() {
        for count in 1..=4 {
            let dir = tempfile::tempdir().expect("temp dir");
            write_pack(dir.path(), count);

            let report = inspect_frame_directory(dir.path()).expect("inspect");

            assert!(!report.valid, "count {count}");
            assert!(report.missing_actions.is_empty(), "count {count}");
            assert!(
                report.actions.iter().all(|action| action.frames == count),
                "count {count}"
            );
            assert!(
                report.actions.iter().all(|action| action.issues.iter().any(
                    |issue| issue.contains(&format!("至少需要 5 帧，当前只有 {count} 帧"))
                )),
                "count {count}"
            );
        }
    }

    #[test]
    fn inspection_rejects_six_present_but_empty_action_directories() {
        let dir = tempfile::tempdir().expect("temp dir");
        for (action, _) in ACTIONS {
            std::fs::create_dir_all(dir.path().join(action)).expect("create dir");
        }

        let report = inspect_frame_directory(dir.path()).expect("inspect");

        assert!(!report.valid);
        assert_eq!(report.missing_actions.len(), ACTIONS.len());
        assert_eq!(report.actions.len(), ACTIONS.len());
        assert!(report
            .actions
            .iter()
            .all(|action| action.frames == 0
                && action
                    .issues
                    .iter()
                    .any(|issue| issue.contains("至少需要 5 帧"))));
        assert!(report.issues.iter().any(|issue| issue.contains("至少需要 5 帧")));
    }

    #[test]
    fn inspection_reports_decoded_capacity_as_a_global_issue() {
        let dir = tempfile::tempdir().expect("temp dir");
        let image = DynamicImage::new_rgba8(2048, 2048);
        let mut buffer = Cursor::new(Vec::new());
        image.write_to(&mut buffer, ImageFormat::Png).unwrap();
        let bytes = buffer.into_inner();
        for (action, _) in ACTIONS {
            for index in 0..5 {
                let path = dir.path().join(action).join(format!("{index:03}.png"));
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, &bytes).unwrap();
            }
        }

        let report = inspect_frame_directory(dir.path()).expect("inspect");

        assert!(!report.valid);
        assert!(report.decoded_bytes > MAX_DECODED_PACK_BYTES);
        assert!(report
            .global_issues
            .iter()
            .any(|issue| issue.contains("256 MiB")));
    }

    #[test]
    fn scans_supported_images_in_lexicographic_order() {
        let dir = tempfile::tempdir().expect("temp dir");
        for name in ["002.png", "000.PNG", "001.jpg", "notes.txt", "003.webp"] {
            touch(&dir.path().join("idle").join(name));
        }

        let frames = scan_action_frames(dir.path(), "idle").expect("scan");

        let names = frames
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names, ["000.PNG", "001.jpg", "002.png", "003.webp"]);
    }

    fn png_data_url() -> String {
        let image = DynamicImage::new_rgba8(2, 2);
        let mut buffer = Cursor::new(Vec::new());
        image.write_to(&mut buffer, ImageFormat::Png).unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(buffer.into_inner())
        )
    }

    #[test]
    fn writes_manual_pack_and_rejects_missing_actions() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut actions = HashMap::new();
        for (action, _) in ACTIONS {
            actions.insert(
                action.to_string(),
                vec![png_data_url(); MIN_FRAMES_PER_ACTION],
            );
        }

        let root = dir.path().join("pack");
        write_manual_frame_pack(&root, &actions).expect("write pack");
        let pack = scan_pack(&root).expect("scan pack");
        assert_eq!(pack["idle"].len(), MIN_FRAMES_PER_ACTION);
        assert!(pack["idle"][0].ends_with("000.png"));

        let mut missing = actions.clone();
        missing.remove("sleep");
        let err = write_manual_frame_pack(&dir.path().join("missing"), &missing)
            .expect_err("missing action");
        assert!(err.contains("sleep"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_packs_with_missing_actions_or_frames() {
        let dir = tempfile::tempdir().expect("temp dir");
        touch(&dir.path().join("idle").join("000.png"));

        let err = scan_pack(dir.path()).expect_err("pack should be rejected");
        assert!(err.contains("至少需要 5 帧"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_fake_png_and_oversized_images() {
        assert!(decode_image_data_url("data:image/png;base64,aGVsbG8=").is_err());
        assert!(decode_frame(&vec![0; MAX_IMAGE_BYTES + 1]).is_err());
        let image = DynamicImage::new_rgba8(2049, 1);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        assert!(decode_frame(bytes.get_ref()).is_err());
    }

    #[test]
    fn never_overwrites_existing_pack() {
        let dir = tempfile::tempdir().unwrap();
        let actions = ACTIONS
            .iter()
            .map(|(a, _)| (a.to_string(), vec![png_data_url(); 5]))
            .collect();
        assert!(write_manual_frame_pack(dir.path(), &actions).is_err());
    }
}
