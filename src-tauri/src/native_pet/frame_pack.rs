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

    #[test]
    fn rejects_packs_with_missing_actions_or_frames() {
        let dir = tempfile::tempdir().expect("temp dir");
        touch(&dir.path().join("idle").join("000.png"));

        let err = scan_pack(dir.path()).expect_err("pack should be rejected");
        assert!(err.contains("至少需要 5 帧"), "unexpected error: {err}");
    }
}
