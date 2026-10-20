use std::path::PathBuf;

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

pub const LOOPING_ACTIONS: [&str; 3] = ["idle", "walk", "jump"];

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

pub fn frame_interval_ms(action: &str) -> u64 {
    if action == "sleep" {
        420
    } else {
        150
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
        return path;
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

    for candidate in &candidates {
        if candidate.is_dir() {
            return candidate.clone();
        }
    }

    candidates.into_iter().next().unwrap_or(path)
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
