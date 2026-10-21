use std::path::{Path, PathBuf};

pub const DEFAULT_FRAME_ROOT: &str = "./frame-pack";
pub const SETTINGS_FILE_NAME: &str = "native-pet-settings.json";

pub const CANVAS_SIZE: f64 = 360.0;
pub const PET_SIZE: f64 = 320.0;
pub const MIN_SCALE: f64 = 0.5;
pub const MAX_SCALE: f64 = 1.5;

pub const ACTIONS: [(&str, &str); 6] = [
    ("idle", "待机"),
    ("sit", "坐下"),
    ("sleep", "睡觉"),
    ("happy", "开心"),
    ("walk", "走路"),
    ("jump", "跳跃"),
];

pub const LOOPING_ACTIONS: [&str; 2] = ["idle", "walk"];

pub fn is_action(action: &str) -> bool {
    ACTIONS.iter().any(|(id, _)| *id == action)
}

pub fn normalize_action(action: String) -> String {
    if is_action(&action) {
        action
    } else {
        "idle".to_string()
    }
}

pub fn is_looping(action: &str) -> bool {
    LOOPING_ACTIONS.contains(&action)
}

/// Actions that play once and then hand control back to idle.
///
/// `sit` and `sleep` are deliberately absent: they are resting states and hold
/// their last frame until something else changes the action.
pub fn one_shot_next(action: &str) -> Option<&'static str> {
    match action {
        "jump" | "happy" => Some("idle"),
        _ => None,
    }
}

pub fn frame_interval_ms(action: &str) -> u64 {
    match action {
        "sleep" => 420,
        "sit" => 160,
        "happy" => 130,
        "jump" => 110,
        _ => 150,
    }
}

pub fn normalize_scale(scale: f64) -> f64 {
    if scale.is_finite() {
        scale.clamp(MIN_SCALE, MAX_SCALE)
    } else {
        1.0
    }
}

pub fn resolve_frame_root(root: &str) -> PathBuf {
    let path = PathBuf::from(root);
    if path.is_absolute() {
        return path.canonicalize().unwrap_or(path);
    }

    let mut candidates = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(&path));
    }

    // `tauri dev` runs the binary with `src-tauri` as the working directory.
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(project_root) = manifest_dir.parent() {
            candidates.push(project_root.join(&path));
        }
    }

    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(&path));
    }

    // Only the shipped default falls back to the bundled pack. A path the user
    // typed by hand must fail loudly instead of silently showing the default pet.
    let bundled = if is_default_frame_root(root) {
        super::bundled_frame_root()
    } else {
        None
    };
    pick_frame_root(&candidates, bundled.as_deref())
}

pub fn is_default_frame_root(root: &str) -> bool {
    root.trim().trim_end_matches(['/', '\\']) == DEFAULT_FRAME_ROOT
}

/// First existing candidate wins; otherwise fall back to the frame pack that
/// ships inside the app bundle, then to the first candidate so the caller gets a
/// meaningful path in the error message.
pub fn pick_frame_root(candidates: &[PathBuf], bundled: Option<&Path>) -> PathBuf {
    for candidate in candidates {
        if candidate.is_dir() {
            return candidate
                .canonicalize()
                .unwrap_or_else(|_| candidate.clone());
        }
    }

    if let Some(dir) = bundled.filter(|dir| dir.is_dir()) {
        return dir.to_path_buf();
    }

    candidates.first().cloned().unwrap_or_default()
}

pub fn normalize_frame_root(root_dir: Option<String>) -> String {
    root_dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_FRAME_ROOT.to_string())
}

pub fn scaled_canvas_size(scale: f64) -> f64 {
    (CANVAS_SIZE * normalize_scale(scale)).round().max(180.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pet-frames-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn picks_the_first_existing_candidate() {
        let missing = std::env::temp_dir().join("pet-frames-does-not-exist");
        let existing = temp_dir("existing");

        let picked = pick_frame_root(&[missing, existing.clone()], None);

        assert_eq!(picked, existing.canonicalize().unwrap());
        std::fs::remove_dir_all(existing).ok();
    }

    #[test]
    fn falls_back_to_the_bundled_pack() {
        let bundled = temp_dir("bundled");
        let missing = std::env::temp_dir().join("pet-frames-does-not-exist");

        let picked = pick_frame_root(&[missing], Some(&bundled));

        assert_eq!(picked, bundled);
        std::fs::remove_dir_all(bundled).ok();
    }

    #[test]
    fn falls_back_to_the_first_candidate_when_nothing_exists() {
        let first = std::env::temp_dir().join("pet-frames-does-not-exist");

        let picked = pick_frame_root(std::slice::from_ref(&first), None);

        assert_eq!(picked, first);
    }

    #[test]
    fn only_the_default_root_may_use_the_bundled_pack() {
        assert!(is_default_frame_root("./frame-pack"));
        assert!(is_default_frame_root(" ./frame-pack/ "));
        assert!(!is_default_frame_root("/Users/me/my-pack"));
        assert!(!is_default_frame_root("./my-pack"));
    }

    #[test]
    fn one_shots_hand_back_to_idle() {
        assert_eq!(one_shot_next("jump"), Some("idle"));
        assert_eq!(one_shot_next("happy"), Some("idle"));
        assert_eq!(one_shot_next("sit"), None);
        assert_eq!(one_shot_next("sleep"), None);
        assert_eq!(one_shot_next("idle"), None);
    }

    #[test]
    fn only_idle_and_walk_loop() {
        assert!(is_looping("idle"));
        assert!(is_looping("walk"));
        for action in ["jump", "happy", "sit", "sleep"] {
            assert!(!is_looping(action), "{action} must not loop");
        }
    }
}
