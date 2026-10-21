mod frame_pack;
mod model;
mod playback;
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

pub(crate) use frame_pack::decode_frame;
pub use frame_pack::{
    encode_image_as_data_url, scan_action_frames, scan_pack, write_manual_frame_pack,
    MIN_FRAMES_PER_ACTION,
};
#[allow(unused_imports)]
pub use model::{
    frame_interval_ms, is_action, is_looping, normalize_action, normalize_frame_root,
    normalize_scale, one_shot_next, resolve_frame_root, scaled_canvas_size, ACTIONS, CANVAS_SIZE,
    DEFAULT_FRAME_ROOT, LOOPING_ACTIONS, MAX_SCALE, MIN_SCALE, PET_SIZE, SETTINGS_FILE_NAME,
};
pub use settings::{
    load_settings, settings_file_path, write_atomic, NativePetSettings, PetPosition,
};

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Where the frame pack that ships inside the app bundle lives, if any.
static BUNDLED_FRAME_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Record the bundled frame pack location once, during app setup.
///
/// A packaged app is launched with `/` as its working directory, so the relative
/// `./frame-pack` default can never resolve; the bundled copy is the fallback
/// that keeps the pet visible on a fresh install.
pub fn set_bundled_frame_root(app: &AppHandle) {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("frame-pack"))
        .filter(|dir| dir.is_dir());
    let _ = BUNDLED_FRAME_ROOT.set(bundled);
}

pub(crate) fn bundled_frame_root() -> Option<PathBuf> {
    BUNDLED_FRAME_ROOT.get().cloned().flatten()
}

pub struct Runtime {
    pub action: String,
    pub action_revision: u64,
    pub pet_id: Option<String>,
    pub frame_source: String,
    pub visible: bool,
    pub root_dir: PathBuf,
    pub scale: f64,
    pub reload_requested: bool,
    pub settings_path: Option<PathBuf>,
    pub app: Option<AppHandle>,
    pub position: Option<PetPosition>,
    pub reset_position_requested: bool,
    pub position_dirty_at: Option<Instant>,
    pub autonomous: bool,
    pub click_through: bool,
    pub animation_paused: bool,
    pub next_behavior_at: Option<Instant>,
    pub behavior_rng: u64,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            action: "idle".to_string(),
            action_revision: 0,
            pet_id: None,
            frame_source: DEFAULT_FRAME_ROOT.to_string(),
            visible: true,
            root_dir: resolve_frame_root(DEFAULT_FRAME_ROOT),
            scale: 1.0,
            reload_requested: false,
            settings_path: None,
            app: None,
            position: None,
            reset_position_requested: false,
            position_dirty_at: None,
            autonomous: true,
            click_through: true,
            animation_paused: false,
            next_behavior_at: None,
            behavior_rng: behavior_seed(),
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
        runtime.action_revision += 1;
        runtime.frame_source = normalize_frame_root(Some(settings.frame_root.clone()));
        runtime.visible = settings.visible;
        runtime.root_dir =
            resolve_frame_root(&normalize_frame_root(Some(settings.frame_root.clone())));
        runtime.scale = normalize_scale(settings.scale);
        runtime.settings_path = settings_path;
        runtime.position = settings.position.clone();
        runtime.reload_requested = true;
        runtime.reset_position_requested = false;
        runtime.position_dirty_at = None;
        runtime.autonomous = settings.autonomous;
        runtime.click_through = settings.click_through;
        runtime.animation_paused = false;
        runtime.behavior_rng = behavior_seed();
        runtime.next_behavior_at = Some(Instant::now() + Duration::from_secs(5));
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
    runtime.action_revision += 1;
    runtime.next_behavior_at = Some(Instant::now() + Duration::from_secs(20));
    Ok(())
}

/// Hand control back to idle after a one-shot action finished.
///
/// Unlike `set_action` this leaves the autonomous schedule untouched: the pet
/// should keep the idle time it was already granted, not restart a 20s wait.
pub fn return_to_idle() -> Result<(), String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.action = "idle".to_string();
    runtime.action_revision += 1;
    Ok(())
}

pub fn set_frame_root(root_dir: &str, pet_id: Option<String>) -> Result<(), String> {
    let root = root_dir.trim();
    if root.is_empty() {
        return Err("帧目录不能为空".to_string());
    }

    let source = normalize_frame_root(Some(root.to_string()));
    let resolved = resolve_frame_root(&source);
    // Prepare before committing the runtime path. Invalid packs leave the old pet intact.
    scan_pack(&resolved)?;
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.root_dir = resolved;
    runtime.frame_source = source;
    runtime.pet_id = pet_id;
    runtime.visible = true;
    runtime.action_revision += 1;
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

pub fn autonomous_enabled() -> bool {
    runtime()
        .lock()
        .map(|runtime| runtime.autonomous)
        .unwrap_or(true)
}

pub fn set_autonomous(enabled: bool) -> Result<(), String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.autonomous = enabled;
    runtime.next_behavior_at = if enabled {
        Some(Instant::now() + Duration::from_secs(5))
    } else {
        None
    };
    Ok(())
}

pub fn click_through_enabled() -> bool {
    runtime()
        .lock()
        .map(|runtime| runtime.click_through)
        .unwrap_or(true)
}

pub fn set_click_through(enabled: bool) -> Result<(), String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.click_through = enabled;
    Ok(())
}

pub fn animation_paused() -> bool {
    runtime()
        .lock()
        .map(|runtime| runtime.animation_paused)
        .unwrap_or(false)
}

pub fn set_animation_paused(paused: bool) -> Result<(), String> {
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.animation_paused = paused;
    if !paused && runtime.autonomous {
        runtime.next_behavior_at = Some(Instant::now() + Duration::from_secs(2));
    }
    Ok(())
}

pub fn maybe_auto_advance(now: Instant) -> Option<String> {
    let mut runtime = runtime().lock().ok()?;
    if !runtime.autonomous || runtime.animation_paused || !runtime.visible {
        return None;
    }

    let next_at = match runtime.next_behavior_at {
        Some(next_at) => next_at,
        None => {
            runtime.next_behavior_at = Some(now + Duration::from_secs(5));
            return None;
        }
    };
    if now < next_at {
        return None;
    }

    let current = runtime.action.clone();
    let next = choose_next_action(&current, &mut runtime.behavior_rng);
    let duration = action_duration(next, &mut runtime.behavior_rng);
    runtime.action = next.to_string();
    runtime.action_revision += 1;
    runtime.next_behavior_at = Some(now + duration);
    Some(next.to_string())
}

fn behavior_seed() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    (nanos ^ ((std::process::id() as u64) << 32)) | 1
}

fn next_random(state: &mut u64) -> u64 {
    let mut value = *state;
    value ^= value << 13;
    value ^= value >> 7;
    value ^= value << 17;
    *state = value;
    value
}

fn random_range(state: &mut u64, min: u64, max: u64) -> u64 {
    if max <= min {
        return min;
    }
    min + next_random(state) % (max - min)
}

fn choose_next_action(current: &str, state: &mut u64) -> &'static str {
    let choices: &[&str] = match current {
        "idle" => &["walk", "walk", "sit", "sit", "happy", "sleep"],
        "walk" => &["idle", "sit"],
        "sit" => &["idle", "sleep", "happy"],
        "sleep" => &["idle"],
        "happy" => &["idle"],
        _ => &["idle"],
    };
    choices[(next_random(state) as usize) % choices.len()]
}

fn action_duration(action: &str, state: &mut u64) -> Duration {
    let seconds = match action {
        "walk" => random_range(state, 4, 9),
        "sit" => random_range(state, 5, 11),
        "sleep" => random_range(state, 15, 31),
        "happy" => random_range(state, 2, 4),
        _ => random_range(state, 6, 13),
    };
    Duration::from_secs(seconds)
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
            frame_root: runtime.frame_source.clone(),
            visible: runtime.visible,
            scale: runtime.scale,
            current_action: runtime.action.clone(),
            autonomous: runtime.autonomous,
            click_through: runtime.click_through,
            position: runtime.position.clone(),
        },
        Err(_) => NativePetSettings::default(),
    }
}

pub fn persist_runtime_settings() -> Result<(), String> {
    static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());
    let _write_guard = SETTINGS_WRITE_LOCK
        .lock()
        .map_err(|_| "配置写入锁已损坏".to_string())?;
    let (settings, path) = {
        let runtime = runtime()
            .lock()
            .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
        let Some(path) = runtime.settings_path.clone() else {
            return Ok(());
        };
        (
            NativePetSettings {
                frame_root: runtime.frame_source.clone(),
                visible: runtime.visible,
                scale: runtime.scale,
                current_action: runtime.action.clone(),
                autonomous: runtime.autonomous,
                click_through: runtime.click_through,
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeActionEvent {
    pub action: String,
    pub pet_id: Option<String>,
    pub revision: u64,
}

pub fn action_event() -> Result<NativeActionEvent, String> {
    let state = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    Ok(NativeActionEvent {
        action: state.action.clone(),
        pet_id: state.pet_id.clone(),
        revision: state.action_revision,
    })
}

pub fn emit_action_changed() {
    if let (Some(app), Ok(event)) = (app_handle(), action_event()) {
        let _ = app.emit("native-pet-action-changed", event);
    }
}

pub fn visible() -> bool {
    runtime().lock().map(|state| state.visible).unwrap_or(false)
}

pub fn set_visible(visible: bool) -> Result<(), String> {
    runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?
        .visible = visible;
    Ok(())
}

pub(crate) fn runtime_root() -> PathBuf {
    runtime()
        .lock()
        .map(|runtime| runtime.root_dir.clone())
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_FRAME_ROOT))
}

pub(crate) fn runtime_action_scale() -> (String, f64, u64) {
    runtime()
        .lock()
        .map(|runtime| {
            (
                runtime.action.clone(),
                runtime.scale,
                runtime.action_revision,
            )
        })
        .unwrap_or_else(|_| ("idle".to_string(), 1.0, 0))
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

    #[test]
    fn invalid_pack_keeps_runtime_selection() {
        let previous = current_settings();
        let missing = tempfile::tempdir().unwrap();
        assert!(set_frame_root(missing.path().to_str().unwrap(), Some("invalid".into())).is_err());
        assert_eq!(current_settings().frame_root, previous.frame_root);
    }
}
