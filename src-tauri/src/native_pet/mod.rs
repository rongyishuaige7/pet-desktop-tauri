mod frame_pack;
mod model;
mod playback;
mod settings;
mod state;

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
    encode_image_as_data_url, inspect_frame_directory, scan_action_frames, scan_pack,
    write_manual_frame_pack, copy_to_managed_asset, FrameInspection, ManagedAsset,
    MIN_FRAMES_PER_ACTION,
};
#[allow(unused_imports)]
pub use model::{
    frame_interval_ms, is_action, is_looping, normalize_action, normalize_frame_root,
    normalize_scale, one_shot_next, resolve_frame_root, scaled_canvas_size, ACTIONS, CANVAS_SIZE,
    DEFAULT_FRAME_ROOT, LOOPING_ACTIONS, MAX_SCALE, MIN_SCALE, PET_SIZE, SETTINGS_FILE_NAME,
};
#[allow(unused_imports)]
pub use settings::{
    load_settings, load_settings_with_issue, settings_file_path, write_atomic, NativePetSettings,
    PetPosition, SettingsIssue,
};
pub use state::{
    action_for_interaction, detach_target_conflict, effective_autonomous, effective_paused,
    interaction_rejection, reduced_motion_active, target_conflict, AutostartState, Availability,
    Capabilities,
    InteractionKind, InteractionReason, InteractionResult, MotionPreference, NativePetState,
    OperationError, PreferencesRequest, VisibilityMode, DEFAULT_SNOOZE_MINUTES,
    SNOOZE_DURATIONS_MINUTES,
};

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Where the frame pack that ships inside the app bundle lives, if any.
static BUNDLED_FRAME_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Serialises every multi-step control operation (mutate + persist + emit).
static CONTROL_LOCK: Mutex<()> = Mutex::new(());

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
    pub pet_name: Option<String>,
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
    pub session_id: String,
    pub revision: u64,
    pub visibility_mode: VisibilityMode,
    pub snooze_until_ms: Option<i64>,
    pub motion_preference: MotionPreference,
    pub system_reduced_motion: Option<bool>,
    pub availability: Availability,
    pub frames_ready: bool,
    pub pending: bool,
    pub autostart_enabled: bool,
    pub last_error: Option<OperationError>,
    pub error_seq: u64,
    pub last_interaction: Option<Instant>,
    pub last_motion_check: Option<Instant>,
    /// Discards a slow frame-pack load that a newer attach/detach superseded.
    pub attach_seq: u64,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            action: "idle".to_string(),
            action_revision: 0,
            pet_id: None,
            pet_name: None,
            frame_source: DEFAULT_FRAME_ROOT.to_string(),
            visible: false,
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
            session_id: new_session_id(),
            revision: 0,
            visibility_mode: VisibilityMode::Shown,
            snooze_until_ms: None,
            motion_preference: MotionPreference::System,
            system_reduced_motion: None,
            availability: Availability::Absent,
            frames_ready: false,
            pending: false,
            autostart_enabled: false,
            last_error: None,
            error_seq: 0,
            last_interaction: None,
            last_motion_check: None,
            attach_seq: 0,
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

fn new_session_id() -> String {
    let counter = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{:x}-{:x}-{:x}",
        state::now_ms(),
        std::process::id(),
        counter
    )
}

pub fn configure(
    settings: &NativePetSettings,
    settings_path: Option<PathBuf>,
    issue: Option<SettingsIssue>,
) {
    let system_reduced_motion = platform::system_reduced_motion();
    if let Ok(mut runtime) = runtime().lock() {
        runtime.action = normalize_action(settings.current_action.clone());
        runtime.action_revision += 1;
        runtime.frame_source = normalize_frame_root(Some(settings.frame_root.clone()));
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
        runtime.pet_id = settings.pet_id.clone();
        runtime.pet_name = None;
        runtime.visibility_mode = settings.visibility_mode();
        runtime.snooze_until_ms = settings.snooze_until_ms;
        runtime.motion_preference = settings.motion_preference;
        runtime.system_reduced_motion = system_reduced_motion;
        runtime.frames_ready = false;
        runtime.availability = if runtime.pet_id.is_some() {
            Availability::Loading
        } else {
            Availability::Absent
        };
        // Material is not decoded yet, so nothing may appear until the frontend
        // attaches a validated pack.
        runtime.visible = false;
        runtime.pending = false;
        runtime.autostart_enabled = crate::autostart::is_enabled();
        runtime.last_error = issue.map(|issue| OperationError {
            id: format!("{}-0", runtime.session_id),
            operation: "loadSettings".to_string(),
            code: match issue {
                SettingsIssue::InvalidSnooze => "SETTINGS_SNOOZE_INVALID",
                SettingsIssue::CorruptFile => "SETTINGS_INVALID",
            }
            .to_string(),
            recoverable: true,
        });
        runtime.error_seq = 0;
        runtime.attach_seq = 0;
        runtime.next_behavior_at = Some(Instant::now() + Duration::from_secs(5));
        runtime.revision += 1;
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

fn reduced_motion(rt: &Runtime) -> bool {
    reduced_motion_active(rt.motion_preference, rt.system_reduced_motion)
}

fn recompute_visible(rt: &mut Runtime) {
    rt.visible = rt.visibility_mode == VisibilityMode::Shown
        && rt.frames_ready
        && rt.availability == Availability::Ready;
}

fn schedule_behavior(rt: &mut Runtime, delay: Duration) {
    let paused = effective_paused(rt.animation_paused, reduced_motion(rt));
    rt.next_behavior_at = if rt.autonomous && !paused && rt.visible && rt.availability == Availability::Ready
    {
        Some(Instant::now() + delay)
    } else {
        None
    };
}

fn bump(rt: &mut Runtime) {
    rt.revision += 1;
}

pub fn state_snapshot() -> NativePetState {
    let capabilities = capabilities();
    let Ok(runtime) = runtime().lock() else {
        return NativePetState {
            session_id: "unavailable".to_string(),
            revision: 0,
            pet_id: None,
            pet_name: None,
            availability: Availability::Error,
            visibility_mode: VisibilityMode::Hidden,
            snooze_until_ms: None,
            visible: false,
            action: "idle".to_string(),
            action_revision: 0,
            animation_paused: false,
            autonomous: false,
            motion_preference: MotionPreference::System,
            system_reduced_motion: None,
            effective_paused: false,
            effective_autonomous: false,
            scale: 1.0,
            click_through: false,
            pending: false,
            autostart: AutostartState {
                enabled: false,
                pending: false,
            },
            last_operation_error: Some(OperationError {
                id: "unavailable".to_string(),
                operation: "state".to_string(),
                code: "NATIVE_STATE_UNAVAILABLE".to_string(),
                recoverable: true,
            }),
            capabilities,
        };
    };
    let paused = effective_paused(runtime.animation_paused, reduced_motion(&runtime));
    let autonomous = effective_autonomous(
        runtime.autonomous,
        paused,
        runtime.visible,
        runtime.availability,
    );
    NativePetState {
        session_id: runtime.session_id.clone(),
        revision: runtime.revision,
        pet_id: runtime.pet_id.clone(),
        pet_name: runtime.pet_name.clone(),
        availability: runtime.availability,
        visibility_mode: runtime.visibility_mode,
        snooze_until_ms: runtime.snooze_until_ms,
        visible: runtime.visible,
        action: runtime.action.clone(),
        action_revision: runtime.action_revision,
        animation_paused: runtime.animation_paused,
        autonomous: runtime.autonomous,
        motion_preference: runtime.motion_preference,
        system_reduced_motion: runtime.system_reduced_motion,
        effective_paused: paused,
        effective_autonomous: autonomous,
        scale: runtime.scale,
        click_through: runtime.click_through,
        pending: runtime.pending,
        autostart: AutostartState {
            enabled: runtime.autostart_enabled,
            pending: false,
        },
        last_operation_error: runtime.last_error.clone(),
        capabilities,
    }
}

pub fn capabilities() -> Capabilities {
    let native = cfg!(any(target_os = "macos", target_os = "linux"));
    Capabilities {
        native_window: native,
        tap_feedback: native,
        click_through: cfg!(target_os = "macos"),
        reset_position: cfg!(target_os = "macos"),
        autostart: native,
        system_reduced_motion: native,
    }
}

fn record_error(operation: &str, code: &str, recoverable: bool) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.error_seq += 1;
        let id = format!("{}-{}", runtime.session_id, runtime.error_seq);
        runtime.last_error = Some(OperationError {
            id,
            operation: operation.to_string(),
            code: code.to_string(),
            recoverable,
        });
        bump(&mut runtime);
    }
}

fn clear_error(operation: &str) {
    if let Ok(mut runtime) = runtime().lock() {
        if runtime
            .last_error
            .as_ref()
            .is_some_and(|error| error.operation == operation)
        {
            runtime.last_error = None;
            bump(&mut runtime);
        }
    }
}

pub fn emit_state_changed() {
    let state = state_snapshot();
    if let Some(app) = app_handle() {
        let _ = app.emit("native-pet-state-changed", state);
        if let Ok(event) = action_event() {
            let _ = app.emit("native-pet-action-changed", event);
        }
        crate::refresh_tray();
    }
}

pub fn apply_action(action: &str) -> Result<(), String> {
    let _guard = CONTROL_LOCK
        .lock()
        .map_err(|_| "原生宠物控制锁已损坏".to_string())?;
    set_action(action)?;
    if let Err(err) = persist_runtime_settings() {
        record_error("setAction", "SETTINGS_WRITE_FAILED", true);
        emit_state_changed();
        return Err(err);
    }
    clear_error("setAction");
    emit_state_changed();
    Ok(())
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
    bump(&mut runtime);
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
    bump(&mut runtime);
    Ok(())
}

pub fn set_frame_root(
    root_dir: &str,
    pet_id: Option<String>,
    pet_name: Option<String>,
) -> Result<(), String> {
    let root = root_dir.trim();
    if root.is_empty() {
        return Err("帧目录不能为空".to_string());
    }

    let source = normalize_frame_root(Some(root.to_string()));
    let resolved = resolve_frame_root(&source);
    let operation = {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
        runtime.attach_seq += 1;
        runtime.attach_seq
    };
    // Validate before committing the runtime path. Invalid packs leave the old
    // pet intact and only surface an operation-level error.
    if let Err(error) = scan_pack(&resolved) {
        let current = runtime()
            .lock()
            .map(|runtime| (runtime.attach_seq == operation, runtime.frames_ready && runtime.availability == Availability::Ready))
            .unwrap_or((false, false));
        if !current.0 {
            return Err(error);
        }
        if !current.1 {
            if let Ok(mut runtime) = runtime().lock() {
                runtime.availability = Availability::Error;
                runtime.frames_ready = false;
                runtime.visible = false;
                bump(&mut runtime);
            }
        }
        record_error("set_frame_root", "ASSET_NOT_FOUND", true);
        emit_state_changed();
        return Err(error);
    }

    let _guard = CONTROL_LOCK
        .lock()
        .map_err(|_| "原生宠物控制锁已损坏".to_string())?;
    {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
        if runtime.attach_seq != operation {
            return Err("宠物选择已更新，已忽略旧请求".to_string());
        }
        runtime.root_dir = resolved;
        runtime.frame_source = source;
        runtime.pet_id = pet_id;
        runtime.pet_name = pet_name
            .map(|name| name.trim().chars().take(20).collect::<String>())
            .filter(|name| !name.is_empty());
        runtime.frames_ready = true;
        runtime.availability = Availability::Ready;
        runtime.reload_requested = true;
        runtime.action_revision += 1;
        recompute_visible(&mut runtime);
        schedule_behavior(&mut runtime, Duration::from_secs(5));
        bump(&mut runtime);
    }
    clear_error("set_frame_root");
    let persisted = persist_runtime_settings();
    emit_state_changed();
    persisted.map_err(|err| {
        record_error("set_frame_root", "SETTINGS_WRITE_FAILED", true);
        emit_state_changed();
        err
    })
}

pub fn set_pet_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("伙伴名字不能为空".to_string());
    }
    let trimmed = trimmed.chars().take(20).collect::<String>();
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    if runtime.pet_name.as_deref() != Some(trimmed.as_str()) {
        runtime.pet_name = Some(trimmed);
        bump(&mut runtime);
        drop(runtime);
        emit_state_changed();
    }
    Ok(())
}

pub fn detach_native_pet(expected_pet_id: Option<String>) -> Result<(), String> {
    let _guard = CONTROL_LOCK
        .lock()
        .map_err(|_| "原生宠物控制锁已损坏".to_string())?;
    {
        let runtime = runtime()
            .lock()
            .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
        if detach_target_conflict(runtime.pet_id.as_deref(), expected_pet_id.as_deref()) {
            return Err("TARGET_CHANGED: 当前伙伴已切换，未执行这次操作".to_string());
        }
    }
    {
        let mut runtime = runtime()
            .lock()
            .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
        runtime.attach_seq += 1;
        runtime.pet_id = None;
        runtime.pet_name = None;
        runtime.frames_ready = false;
        runtime.availability = Availability::Absent;
        runtime.visible = false;
        runtime.next_behavior_at = None;
        bump(&mut runtime);
    }
    let persisted = persist_runtime_settings();
    emit_state_changed();
    persisted
}

pub fn set_scale(scale: f64) -> Result<(), String> {
    update_preferences(PreferencesRequest::SetScale { value: scale }).map(|_| ())
}

pub fn set_visible(visible: bool) -> Result<(), String> {
    let request = if visible {
        PreferencesRequest::Show {
            expected_pet_id: None,
            expected_state: None,
        }
    } else {
        PreferencesRequest::Hide
    };
    update_preferences(request).map(|_| ())
}

#[allow(dead_code)]
pub fn set_autonomous(enabled: bool) -> Result<(), String> {
    update_preferences(PreferencesRequest::SetAutonomous { value: enabled }).map(|_| ())
}

#[allow(dead_code)]
pub fn set_click_through(enabled: bool) -> Result<(), String> {
    update_preferences(PreferencesRequest::SetClickThrough { value: enabled }).map(|_| ())
}

#[allow(dead_code)]
pub fn set_animation_paused(paused: bool) -> Result<(), String> {
    update_preferences(PreferencesRequest::SetAnimationPaused { value: paused }).map(|_| ())
}

pub fn autonomous_enabled() -> bool {
    runtime()
        .lock()
        .map(|runtime| runtime.autonomous)
        .unwrap_or(true)
}

pub fn user_animation_paused() -> bool {
    runtime()
        .lock()
        .map(|runtime| runtime.animation_paused)
        .unwrap_or(false)
}

pub fn animation_paused() -> bool {
    runtime()
        .lock()
        .map(|runtime| effective_paused(runtime.animation_paused, reduced_motion(&runtime)))
        .unwrap_or(false)
}

pub fn click_through_enabled() -> bool {
    runtime()
        .lock()
        .map(|runtime| runtime.click_through)
        .unwrap_or(true)
}

pub fn maybe_auto_advance(now: Instant) -> Option<String> {
    let mut runtime = runtime().lock().ok()?;
    if !runtime.autonomous
        || effective_paused(runtime.animation_paused, reduced_motion(&runtime))
        || !runtime.visible
        || runtime.availability != Availability::Ready
    {
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
    bump(&mut runtime);
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
    if !capabilities().reset_position {
        return Err("当前平台暂不支持重置位置".to_string());
    }
    let mut runtime = runtime()
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.position = None;
    runtime.reset_position_requested = true;
    runtime.position_dirty_at = None;
    bump(&mut runtime);
    Ok(())
}

pub(crate) fn mark_position_dirty() {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.position_dirty_at = Some(Instant::now());
    }
}

pub fn update_position(position: PetPosition) {
    if let Ok(mut runtime) = runtime().lock() {
        runtime.position = Some(position);
        runtime.reset_position_requested = false;
        runtime.position_dirty_at = None;
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
            schema_version: 2,
            frame_root: runtime.frame_source.clone(),
            visible: runtime.visible,
            scale: runtime.scale,
            current_action: runtime.action.clone(),
            autonomous: runtime.autonomous,
            click_through: runtime.click_through,
            position: runtime.position.clone(),
            visibility_mode: Some(runtime.visibility_mode),
            snooze_until_ms: runtime.snooze_until_ms,
            motion_preference: runtime.motion_preference,
            pet_id: runtime.pet_id.clone(),
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
                schema_version: 2,
                frame_root: runtime.frame_source.clone(),
                visible: runtime.visible,
                scale: runtime.scale,
                current_action: runtime.action.clone(),
                autonomous: runtime.autonomous,
                click_through: runtime.click_through,
                position: runtime.position.clone(),
                visibility_mode: Some(runtime.visibility_mode),
                snooze_until_ms: runtime.snooze_until_ms,
                motion_preference: runtime.motion_preference,
                pet_id: runtime.pet_id.clone(),
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

#[allow(dead_code)]
pub fn emit_action_changed() {
    if let (Some(app), Ok(event)) = (app_handle(), action_event()) {
        let _ = app.emit("native-pet-action-changed", event);
    }
}

pub fn visible() -> bool {
    runtime().lock().map(|state| state.visible).unwrap_or(false)
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

pub fn current_pet_id() -> Option<String> {
    runtime()
        .lock()
        .ok()
        .and_then(|runtime| runtime.pet_id.clone())
}

pub fn update_preferences(request: PreferencesRequest) -> Result<NativePetState, String> {
    let _guard = CONTROL_LOCK
        .lock()
        .map_err(|_| "原生宠物控制锁已损坏".to_string())?;
    let operation = request.operation();
    // Check the caller's target before this request writes pending, clears an
    // error or bumps the revision. A stale retry must not attach its error to
    // the newer companion.
    {
        let runtime = runtime()
            .lock()
            .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
        if let Some((code, message)) = target_conflict(
            runtime.pet_id.as_deref(),
            &runtime.session_id,
            runtime.revision,
            &request.target(),
        ) {
            return Err(format!("{code}: {message}"));
        }
    }
    let Some(before) = PreferenceSnapshot::capture() else {
        return Err("原生宠物状态锁已损坏".to_string());
    };
    match apply_preference(&request) {
        Ok(needs_persist) => {
            if needs_persist {
                if let Err(err) = persist_runtime_settings() {
                    before.restore();
                    record_error(operation, "SETTINGS_WRITE_FAILED", true);
                    emit_state_changed();
                    return Err(format!("设置没有保存：{err}"));
                }
            }
            clear_error(operation);
            emit_state_changed();
            Ok(state_snapshot())
        }
        Err((code, message)) => {
            before.restore();
            record_error(operation, &code, true);
            emit_state_changed();
            Err(message)
        }
    }
}

struct PreferenceSnapshot {
    visibility_mode: VisibilityMode,
    snooze_until_ms: Option<i64>,
    motion_preference: MotionPreference,
    autonomous: bool,
    click_through: bool,
    scale: f64,
    visible: bool,
    next_behavior_at: Option<Instant>,
}

impl PreferenceSnapshot {
    fn capture() -> Option<Self> {
        let runtime = runtime().lock().ok()?;
        Some(Self {
            visibility_mode: runtime.visibility_mode,
            snooze_until_ms: runtime.snooze_until_ms,
            motion_preference: runtime.motion_preference,
            autonomous: runtime.autonomous,
            click_through: runtime.click_through,
            scale: runtime.scale,
            visible: runtime.visible,
            next_behavior_at: runtime.next_behavior_at,
        })
    }

    fn restore(self) {
        if let Ok(mut runtime) = runtime().lock() {
            runtime.visibility_mode = self.visibility_mode;
            runtime.snooze_until_ms = self.snooze_until_ms;
            runtime.motion_preference = self.motion_preference;
            runtime.autonomous = self.autonomous;
            runtime.click_through = self.click_through;
            runtime.scale = self.scale;
            runtime.visible = self.visible;
            runtime.next_behavior_at = self.next_behavior_at;
            bump(&mut runtime);
        }
    }
}

fn apply_preference(request: &PreferencesRequest) -> Result<bool, (String, String)> {
    let unavailable = || ("NATIVE_STATE_UNAVAILABLE".to_string(), "原生宠物状态不可用".to_string());
    match request {
        PreferencesRequest::Show { .. } => {
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.visibility_mode = VisibilityMode::Shown;
            runtime.snooze_until_ms = None;
            recompute_visible(&mut runtime);
            runtime.action_revision += 1;
            schedule_behavior(&mut runtime, Duration::from_secs(5));
            bump(&mut runtime);
            Ok(true)
        }
        PreferencesRequest::Hide => {
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.visibility_mode = VisibilityMode::Hidden;
            runtime.snooze_until_ms = None;
            runtime.visible = false;
            runtime.next_behavior_at = None;
            bump(&mut runtime);
            Ok(true)
        }
        PreferencesRequest::Snooze {
            duration_minutes, ..
        } => {
            let minutes = (*duration_minutes).unwrap_or(DEFAULT_SNOOZE_MINUTES);
            let duration = state::snooze_duration_ms(minutes).ok_or_else(|| {
                (
                    "SNOOZE_DURATION_INVALID".to_string(),
                    format!(
                        "休息时长只能是 {}、{} 或 {} 分钟",
                        SNOOZE_DURATIONS_MINUTES[0],
                        SNOOZE_DURATIONS_MINUTES[1],
                        SNOOZE_DURATIONS_MINUTES[2]
                    ),
                )
            })?;
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.visibility_mode = VisibilityMode::Snoozed;
            runtime.snooze_until_ms = Some(state::now_ms().saturating_add(duration));
            runtime.visible = false;
            runtime.next_behavior_at = None;
            bump(&mut runtime);
            Ok(true)
        }
        PreferencesRequest::SetAnimationPaused { value } => {
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.animation_paused = *value;
            if *value {
                runtime.next_behavior_at = None;
            } else {
                schedule_behavior(&mut runtime, Duration::from_secs(2));
            }
            bump(&mut runtime);
            Ok(false)
        }
        PreferencesRequest::SetAutonomous { value } => {
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.autonomous = *value;
            schedule_behavior(&mut runtime, Duration::from_secs(5));
            bump(&mut runtime);
            Ok(true)
        }
        PreferencesRequest::SetScale { value } => {
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.scale = normalize_scale(*value);
            bump(&mut runtime);
            Ok(true)
        }
        PreferencesRequest::SetClickThrough { value } => {
            if !capabilities().click_through {
                return Err((
                    "UNSUPPORTED_CAPABILITY".to_string(),
                    "当前平台暂不支持透明区域穿透".to_string(),
                ));
            }
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.click_through = *value;
            bump(&mut runtime);
            Ok(true)
        }
        PreferencesRequest::SetMotionPreference { value } => {
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.motion_preference = *value;
            schedule_behavior(&mut runtime, Duration::from_secs(5));
            bump(&mut runtime);
            Ok(true)
        }
        PreferencesRequest::SetAutostart { value } => {
            crate::autostart::set_enabled(*value)
                .map_err(|err| ("AUTOSTART_FAILED".to_string(), err))?;
            let mut runtime = runtime().lock().map_err(|_| unavailable())?;
            runtime.autostart_enabled = *value;
            bump(&mut runtime);
            Ok(false)
        }
        PreferencesRequest::ResetPosition { .. } => {
            if !capabilities().reset_position {
                return Err((
                    "UNSUPPORTED_CAPABILITY".to_string(),
                    "当前平台暂不支持重置位置".to_string(),
                ));
            }
            reset_position().map_err(|err| ("RESET_POSITION_FAILED".to_string(), err))?;
            Ok(false)
        }
    }
}

pub fn interact(kind: InteractionKind, pet_id: Option<String>) -> InteractionResult {
    let mut accepted = false;
    let reason;
    let should_emit;
    {
        let Ok(mut runtime) = runtime().lock() else {
            return InteractionResult {
                accepted: false,
                reason: Some(InteractionReason::NotReady),
                state: state_snapshot(),
            };
        };
        let pet_matches = match (&runtime.pet_id, &pet_id) {
            (Some(current), Some(given)) => current == given,
            (Some(_), None) => true,
            _ => false,
        };
        let cooldown = runtime
            .last_interaction
            .map(|last| last.elapsed() < Duration::from_millis(1500))
            .unwrap_or(false);
        reason = interaction_rejection(
            pet_matches,
            runtime.visible,
            runtime.availability,
            runtime.animation_paused,
            cooldown,
        );
        should_emit = reason.is_none();
        if reason.is_none() {
            accepted = true;
            runtime.last_interaction = Some(Instant::now());
            if !reduced_motion(&runtime) {
                runtime.action = action_for_interaction(kind).to_string();
                runtime.action_revision += 1;
                runtime.next_behavior_at = Some(Instant::now() + Duration::from_secs(20));
            }
            bump(&mut runtime);
        }
    }
    if should_emit {
        emit_state_changed();
    }
    InteractionResult {
        accepted,
        reason,
        state: state_snapshot(),
    }
}

/// Handles snooze expiry from the platform tick. Returns true when the state
/// changed so the caller can keep drawing decisions in sync.
pub fn check_snooze_expiry(now_ms: i64) -> bool {
    let mut invalid = false;
    {
        let Ok(mut runtime) = runtime().lock() else {
            return false;
        };
        if runtime.visibility_mode != VisibilityMode::Snoozed {
            return false;
        }
        let expired = match runtime.snooze_until_ms {
            Some(until) if until > now_ms && state::valid_snooze_until(until, now_ms) => {
                return false;
            }
            Some(until) if until <= now_ms => true,
            _ => false,
        };
        if expired {
            runtime.visibility_mode = VisibilityMode::Shown;
            runtime.snooze_until_ms = None;
            recompute_visible(&mut runtime);
            runtime.action_revision += 1;
            schedule_behavior(&mut runtime, Duration::from_secs(5));
        } else {
            runtime.visibility_mode = VisibilityMode::Hidden;
            runtime.snooze_until_ms = None;
            runtime.visible = false;
            runtime.next_behavior_at = None;
            invalid = true;
        }
        bump(&mut runtime);
    }
    if invalid {
        record_error("loadSettings", "SETTINGS_SNOOZE_INVALID", true);
    }
    let _ = persist_runtime_settings();
    emit_state_changed();
    true
}

/// Re-reads the platform motion preference at most once per second.
pub fn refresh_system_reduced_motion() -> bool {
    let due = match runtime().lock() {
        Ok(mut runtime) => {
            let due = runtime
                .last_motion_check
                .map(|checked| checked.elapsed() >= Duration::from_secs(1))
                .unwrap_or(true);
            if due {
                runtime.last_motion_check = Some(Instant::now());
            }
            due
        }
        Err(_) => return false,
    };
    if !due {
        return false;
    }

    let next = platform::system_reduced_motion();
    let mut changed = false;
    if let Ok(mut runtime) = runtime().lock() {
        if runtime.system_reduced_motion != next {
            runtime.system_reduced_motion = next;
            if effective_paused(runtime.animation_paused, reduced_motion(&runtime)) {
                runtime.next_behavior_at = None;
            } else {
                schedule_behavior(&mut runtime, Duration::from_secs(2));
            }
            bump(&mut runtime);
            changed = true;
        }
    }
    if changed {
        emit_state_changed();
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_position_request_is_one_shot() {
        if !capabilities().reset_position {
            return;
        }
        reset_position().expect("reset position");
        assert!(take_position_reset_request());
        assert!(!take_position_reset_request());
    }

    #[test]
    fn invalid_pack_keeps_runtime_selection() {
        let previous = current_settings();
        let missing = tempfile::tempdir().unwrap();
        assert!(set_frame_root(
            missing.path().to_str().unwrap(),
            Some("invalid".into()),
            Some("invalid".into())
        )
        .is_err());
        assert_eq!(current_settings().frame_root, previous.frame_root);
    }
}
