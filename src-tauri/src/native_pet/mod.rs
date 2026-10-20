mod frame_pack;
mod model;
mod settings;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod stub;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
use stub as platform;

pub use frame_pack::{
    encode_image_as_data_url, scan_action_frames, scan_pack, write_manual_frame_pack,
    MIN_FRAMES_PER_ACTION,
};
#[allow(unused_imports)]
pub use model::{
    frame_interval_ms, is_action, is_looping, normalize_action, normalize_frame_root,
    normalize_scale, resolve_frame_root, scaled_canvas_size, ACTIONS, CANVAS_SIZE,
    DEFAULT_FRAME_ROOT, LOOPING_ACTIONS, MAX_SCALE, MIN_SCALE, PET_SIZE, SETTINGS_FILE_NAME,
};
pub use settings::{
    load_settings, save_settings, settings_file_path, write_atomic, NativePetSettings, PetPosition,
};

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct Runtime {
    pub action: String,
    pub root_dir: PathBuf,
    pub scale: f64,
    pub reload_requested: bool,
    pub settings_path: Option<PathBuf>,
    pub app: Option<AppHandle>,
    pub position: Option<PetPosition>,
    pub reset_position_requested: bool,
    pub position_dirty_at: Option<Instant>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            action: "idle".to_string(),
            root_dir: resolve_frame_root(DEFAULT_FRAME_ROOT),
            scale: 1.0,
            reload_requested: false,
            settings_path: None,
            app: None,
            position: None,
            reset_position_requested: false,
            position_dirty_at: None,
        }
    }
}

static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

pub(crate) fn runtime() -> &'static Mutex<Runtime> {
    RUNTIME.get_or_init(|| Mutex::new(Runtime::default()))
}

pub fn init_runtime() {
    let _ = runtime();
}

pub fn configure(settings: &NativePetSettings, settings_path: Option<PathBuf>) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.action = normalize_action(settings.current_action.clone());
        runtime.root_dir =
            resolve_frame_root(&normalize_frame_root(Some(settings.frame_root.clone())));
        runtime.scale = normalize_scale(settings.scale);
        runtime.settings_path = settings_path;
        runtime.position = settings.position.clone();
        runtime.reload_requested = true;
        runtime.reset_position_requested = false;
        runtime.position_dirty_at = None;
    }
}

pub fn spawn_window(app: AppHandle) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.app = Some(app.clone());
    }
    platform::spawn_window(app);
}

pub fn shutdown() {
    platform::shutdown();
}

pub fn set_action(action: &str) -> Result<(), String> {
    if !is_action(action) {
        return Err(format!("未知动作：{action}"));
    }

    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.action = action.to_string();
    Ok(())
}

pub fn set_frame_root(root_dir: &str) -> Result<(), String> {
    let root = root_dir.trim();
    if root.is_empty() {
        return Err("帧目录不能为空".to_string());
    }

    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.root_dir = resolve_frame_root(root);
    runtime.reload_requested = true;
    Ok(())
}

pub fn set_scale(scale: f64) -> Result<(), String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.scale = normalize_scale(scale);
    Ok(())
}

pub fn update_position(position: PetPosition) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.position = Some(position);
        runtime.reset_position_requested = false;
        runtime.position_dirty_at = None;
    }
}

pub fn reset_position() -> Result<(), String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.position = None;
    runtime.reset_position_requested = true;
    runtime.position_dirty_at = None;
    Ok(())
}

pub(crate) fn mark_position_dirty() {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.position_dirty_at = Some(Instant::now());
    }
}

pub(crate) fn take_position_dirty_request() -> bool {
    let mut runtime = match runtime().lock() {
        Ok(runtime) => runtime,
        Err(_) => return false,
    };
    match runtime.position_dirty_at {
        Some(changed_at) if changed_at.elapsed() >= Duration::from_millis(150) => {
            runtime.position_dirty_at = None;
            true
        }
        _ => false,
    }
}

pub(crate) fn take_position_reset_request() -> bool {
    let mut runtime = match runtime().lock() {
        Ok(runtime) => runtime,
        Err(_) => return false,
    };
    let requested = runtime.reset_position_requested;
    runtime.reset_position_requested = false;
    requested
}

pub fn current_settings() -> NativePetSettings {
    let runtime = runtime().lock();
    match runtime {
        Ok(runtime) => NativePetSettings {
            frame_root: runtime.root_dir.to_string_lossy().to_string(),
            scale: runtime.scale,
            current_action: runtime.action.clone(),
            position: runtime.position.clone(),
        },
        Err(_) => NativePetSettings::default(),
    }
}

pub fn persist_runtime_settings() -> Result<(), String> {
    let (settings, path) = {
        let runtime = runtime()
            .lock()
            .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
        let Some(path) = runtime.settings_path.clone() else {
            return Ok(());
        };
        (
            NativePetSettings {
                frame_root: runtime.root_dir.to_string_lossy().to_string(),
                scale: runtime.scale,
                current_action: runtime.action.clone(),
                position: runtime.position.clone(),
            },
            path,
        )
    };

    let data = serde_json::to_vec_pretty(&settings.normalized())
        .map_err(|err| format!("序列化原生宠物配置失败：{err}"))?;
    write_atomic(&path, &data)
}

pub fn app_handle() -> Option<AppHandle> {
    runtime()
        .lock()
        .ok()
        .and_then(|runtime| runtime.app.clone())
}

pub fn emit_error(message: &str) {
    eprintln!("native pet: {message}");
    if let Some(app) = app_handle() {
        let _ = app.emit("native-pet-error", message.to_string());
    }
}

pub(crate) fn runtime_root() -> PathBuf {
    runtime()
        .lock()
        .map(|runtime| runtime.root_dir.clone())
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_FRAME_ROOT))
}

pub(crate) fn runtime_action_scale() -> (String, f64) {
    runtime()
        .lock()
        .map(|runtime| (runtime.action.clone(), runtime.scale))
        .unwrap_or_else(|_| ("idle".to_string(), 1.0))
}

pub(crate) fn take_reload_request() -> Option<PathBuf> {
    let mut runtime = runtime().lock().ok()?;
    if runtime.reload_requested {
        runtime.reload_requested = false;
        Some(runtime.root_dir.clone())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_position_request_is_one_shot() {
        reset_position().expect("reset position");
        assert!(take_position_reset_request());
        assert!(!take_position_reset_request());
    }
}
