use base64::Engine;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::model::ACTIONS;

pub const MIN_FRAMES_PER_ACTION: usize = 5;

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
        .filter(|path| is_supported_image(path))
        .collect::<Vec<_>>();

    paths.sort_by_key(|path| path.file_name().map(|name| name.to_os_string()));
    Ok(paths)
}

pub fn scan_pack(root: &Path) -> Result<HashMap<String, Vec<PathBuf>>, String> {
    let mut actions = HashMap::new();

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
        actions.insert(action.to_string(), frames);
    }

    Ok(actions)
}

pub fn write_manual_frame_pack(
    root: &Path,
    actions: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut decoded = HashMap::new();

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

        let mut files = Vec::with_capacity(frames.len());
        for data_url in frames {
            files.push(decode_image_data_url(data_url)?);
        }
        decoded.insert(action.to_string(), files);
    }

    std::fs::create_dir_all(root)
        .map_err(|err| format!("创建手动帧包目录失败 {}：{err}", root.display()))?;

    for (action, files) in decoded {
        let action_dir = root.join(&action);
        if action_dir.exists() {
            std::fs::remove_dir_all(&action_dir)
                .map_err(|err| format!("清理动作目录失败 {}：{err}", action_dir.display()))?;
        }
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

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|err| format!("帧图 base64 解码失败：{err}"))?;
    if bytes.is_empty() {
        return Err("帧图内容为空".to_string());
    }

    Ok((bytes, extension))
}

pub fn encode_image_as_data_url(path: &Path) -> Result<String, String> {
    let bytes =
        std::fs::read(path).map_err(|err| format!("读取图片失败 {}：{err}", path.display()))?;
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

    const TINY_PNG_DATA_URL: &str = "data:image/png;base64,aGVsbG8=";

    #[test]
    fn writes_manual_pack_and_rejects_missing_actions() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut actions = HashMap::new();
        for (action, _) in ACTIONS {
            actions.insert(
                action.to_string(),
                vec![TINY_PNG_DATA_URL.to_string(); MIN_FRAMES_PER_ACTION],
            );
        }

        write_manual_frame_pack(dir.path(), &actions).expect("write pack");
        let pack = scan_pack(dir.path()).expect("scan pack");
        assert_eq!(pack["idle"].len(), MIN_FRAMES_PER_ACTION);
        assert!(pack["idle"][0].ends_with("000.png"));

        let mut missing = actions.clone();
        missing.remove("sleep");
        let err = write_manual_frame_pack(dir.path(), &missing).expect_err("missing action");
        assert!(err.contains("sleep"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_packs_with_missing_actions_or_frames() {
        let dir = tempfile::tempdir().expect("temp dir");
        touch(&dir.path().join("idle").join("000.png"));

        let err = scan_pack(dir.path()).expect_err("pack should be rejected");
        assert!(err.contains("至少需要 5 帧"), "unexpected error: {err}");
    }
}
