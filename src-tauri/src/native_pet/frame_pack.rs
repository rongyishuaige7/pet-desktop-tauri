use base64::Engine;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, Limits};
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

pub fn scan_action_frames(root: &Path, action: &str) -> Result<Vec<PathBuf>, String> {
    let action_dir = root.join(action);
    let mut paths = std::fs::read_dir(&action_dir)
        .map_err(|err| format!("读取动作目录失败 {}：{err}", action_dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_file() && is_supported_image(path))
        .collect::<Vec<_>>();

    paths.sort_by_key(|path| path.file_name().map(|name| name.to_os_string()));
    if paths.len() > MAX_FRAMES_PER_ACTION {
        return Err(format!("{action} 超过 60 帧"));
    }
    Ok(paths)
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
