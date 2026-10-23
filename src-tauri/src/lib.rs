use ai_transport::{
    decode_base64_bytes, http_client, image_data_url, read_limited, MAX_GENERATION_RESPONSE,
    MAX_IMAGE_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, MenuBuilder, MenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

mod ai_transport;
mod autostart;
mod native_pet;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn get_native_pet_state() -> native_pet::NativePetState {
    native_pet::state_snapshot()
}

#[tauri::command]
fn update_native_pet_preferences(
    request: native_pet::PreferencesRequest,
) -> Result<native_pet::NativePetState, String> {
    native_pet::update_preferences(request)
}

#[tauri::command]
fn interact_native_pet(
    kind: native_pet::InteractionKind,
    pet_id: Option<String>,
) -> native_pet::InteractionResult {
    native_pet::interact(kind, pet_id)
}

#[tauri::command]
fn set_native_pet_action(action: String) -> Result<native_pet::NativeActionEvent, String> {
    native_pet::apply_action(&action)?;
    native_pet::action_event()
}

#[tauri::command]
async fn set_native_pet_frame_root(
    root_dir: String,
    pet_id: Option<String>,
    pet_name: Option<String>,
) -> Result<native_pet::NativePetState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        native_pet::set_frame_root(&root_dir, pet_id, pet_name)
    })
    .await
    .map_err(|err| format!("加载帧包任务失败：{err}"))??;
    Ok(native_pet::state_snapshot())
}

#[tauri::command]
fn set_native_pet_name(name: String) -> Result<(), String> {
    native_pet::set_pet_name(&name)
}

#[tauri::command]
fn detach_native_pet(expected_pet_id: Option<String>) -> Result<(), String> {
    native_pet::detach_native_pet(expected_pet_id)
}

#[tauri::command]
fn set_native_pet_visible(visible: bool) -> Result<native_pet::NativePetState, String> {
    native_pet::set_visible(visible)?;
    Ok(native_pet::state_snapshot())
}

#[tauri::command]
fn set_native_pet_scale(scale: f64) -> Result<native_pet::NativePetState, String> {
    native_pet::set_scale(scale)?;
    Ok(native_pet::state_snapshot())
}

#[tauri::command]
fn hide_studio_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("studio") else {
        return Err("主窗口不可用".to_string());
    };
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
fn get_native_pet_settings() -> native_pet::NativePetSettings {
    native_pet::current_settings()
}

#[tauri::command]
fn reset_native_pet_position() -> Result<(), String> {
    native_pet::update_preferences(native_pet::PreferencesRequest::ResetPosition {
        expected_pet_id: None,
    })
    .map(|_| ())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MinimaxImageRequest {
    api_key: Option<String>,
    model: Option<String>,
    prompt: String,
    reference_image_url: Option<String>,
    aspect_ratio: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadReferenceImageRequest {
    upload_url: String,
    data_url: String,
    filename: Option<String>,
}

#[derive(Debug, Serialize)]
struct UploadReferenceImagePayload {
    filename: String,
    content_type: String,
    base64: String,
}

#[derive(Debug, Deserialize)]
struct UploadReferenceImageResponse {
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadPresetFramePackRequest {
    root_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresetFramePack {
    source_image: String,
    actions: HashMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveManualFramePackRequest {
    actions: HashMap<String, Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedManualFramePack {
    frame_root: String,
    source_image: String,
}

#[derive(Debug, Serialize)]
struct MinimaxSubjectReference {
    #[serde(rename = "type")]
    reference_type: String,
    image_file: String,
}

#[derive(Debug, Serialize)]
struct MinimaxPayload {
    model: String,
    prompt: String,
    response_format: String,
    aspect_ratio: String,
    n: u8,
    prompt_optimizer: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject_reference: Option<Vec<MinimaxSubjectReference>>,
}

#[derive(Debug, Deserialize)]
struct MinimaxData {
    #[serde(default)]
    image_base64: Vec<String>,
    #[serde(default)]
    image_urls: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MinimaxResponse {
    data: Option<MinimaxData>,
    base_resp: Option<serde_json::Value>,
}

#[tauri::command]
async fn generate_minimax_image(request: MinimaxImageRequest) -> Result<String, String> {
    let api_key = request
        .api_key
        .filter(|key| !key.trim().is_empty())
        .or_else(|| std::env::var("MINIMAX_API_KEY").ok())
        .ok_or_else(|| {
            "缺少 Minimax API Key。请在界面输入，或设置 MINIMAX_API_KEY。".to_string()
        })?;

    let subject_reference = request
        .reference_image_url
        .filter(|url| !url.trim().is_empty())
        .map(|url| {
            vec![MinimaxSubjectReference {
                reference_type: "character".to_string(),
                image_file: url,
            }]
        });

    let payload = MinimaxPayload {
        model: request.model.unwrap_or_else(|| "image-01".to_string()),
        prompt: request.prompt,
        response_format: "url".to_string(),
        aspect_ratio: normalize_aspect_ratio(request.aspect_ratio),
        n: 1,
        prompt_optimizer: true,
        subject_reference,
    };

    let client = http_client()?;
    let response = client
        .post("https://api.minimaxi.com/v1/image_generation")
        .bearer_auth(api_key.trim())
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("Minimax 请求失败：{}", err.without_url()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Minimax HTTP {status}，请检查密钥、额度与服务状态"));
    }
    let body = read_limited(response, MAX_GENERATION_RESPONSE).await?;
    let parsed: MinimaxResponse =
        serde_json::from_slice(&body).map_err(|_| "Minimax 返回了无效 JSON".to_string())?;
    if let Some(code) = parsed
        .base_resp
        .as_ref()
        .and_then(|r| r.get("status_code"))
        .and_then(|c| c.as_i64())
        .filter(|c| *c != 0)
    {
        return Err(format!(
            "Minimax 服务返回错误代码 {code}，请检查密钥、额度与请求参数"
        ));
    }

    if let Some(data) = parsed.data {
        if let Some(image_base64) = data.image_base64.into_iter().next() {
            return tauri::async_runtime::spawn_blocking(move || {
                image_data_url(&decode_base64_bytes(&image_base64)?)
            })
            .await
            .map_err(|_| "检查图片任务失败".to_string())?;
        }

        if let Some(image_url) = data.image_urls.into_iter().next() {
            return download_image_as_data_url(&client, &image_url).await;
        }
    }

    Err("Minimax 响应里没有图片".into())
}

#[tauri::command]
async fn upload_reference_image(request: UploadReferenceImageRequest) -> Result<String, String> {
    let upload_url = validate_http_url(&request.upload_url)?;
    let (content_type, base64) =
        tauri::async_runtime::spawn_blocking(move || split_data_url(&request.data_url))
            .await
            .map_err(|_| "检查参考图任务失败".to_string())??;
    let payload = UploadReferenceImagePayload {
        filename: request
            .filename
            .unwrap_or_else(|| format!("pet-reference-{}.png", current_timestamp_ms())),
        content_type,
        base64,
    };

    let client = http_client()?;
    let response = client
        .post(upload_url)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("上传参考图失败：{}", err.without_url()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("上传参考图失败：HTTP {status}"));
    }
    let body = read_limited(response, 64 * 1024).await?;
    let parsed: UploadReferenceImageResponse =
        serde_json::from_slice(&body).map_err(|_| "上传接口未返回有效的图片 URL".to_string())?;
    validate_http_url(&parsed.url)
}

#[tauri::command]
fn save_manual_frame_pack(
    app: tauri::AppHandle,
    request: SaveManualFramePackRequest,
) -> Result<SavedManualFramePack, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("获取应用数据目录失败：{err}"))?
        .join("manual-frame-packs");
    let frame_root = base_dir.join(format!(
        "pack-{}-{}",
        current_timestamp_ms(),
        std::process::id()
    ));

    native_pet::write_manual_frame_pack(&frame_root, &request.actions)?;

    let source_image = request
        .actions
        .get("idle")
        .and_then(|frames| frames.first())
        .cloned()
        .unwrap_or_default();

    Ok(SavedManualFramePack {
        frame_root: frame_root.to_string_lossy().to_string(),
        source_image,
    })
}

#[tauri::command]
fn load_preset_frame_pack(request: LoadPresetFramePackRequest) -> Result<PresetFramePack, String> {
    let root_dir = native_pet::normalize_frame_root(request.root_dir);
    let root = native_pet::resolve_frame_root(&root_dir);
    let paths = native_pet::scan_pack(&root)?;
    let mut actions = HashMap::new();

    for (action, frames) in paths {
        let encoded = frames
            .iter()
            .map(|path| native_pet::encode_image_as_data_url(path))
            .collect::<Result<Vec<_>, _>>()?;
        actions.insert(action, encoded);
    }

    let source_image = actions
        .get("idle")
        .and_then(|frames| frames.first())
        .cloned()
        .ok_or_else(|| "预置帧包缺少 idle 帧".to_string())?;

    Ok(PresetFramePack {
        source_image,
        actions,
    })
}

async fn download_image_as_data_url(
    client: &reqwest::Client,
    image_url: &str,
) -> Result<String, String> {
    let response = client
        .get(validate_http_url(image_url)?)
        .send()
        .await
        .map_err(|err| format!("下载 Minimax 图片失败：{}", err.without_url()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载 Minimax 图片失败：HTTP {status}"));
    }

    let bytes = read_limited(response, MAX_IMAGE_BYTES).await?;
    tauri::async_runtime::spawn_blocking(move || image_data_url(&bytes))
        .await
        .map_err(|_| "检查图片任务失败".to_string())?
}

fn validate_http_url(url: &str) -> Result<String, String> {
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|_| "图片服务地址不是有效 URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("图片服务必须是有效的 http:// 或 https:// URL".into());
    }
    Ok(parsed.to_string())
}

fn split_data_url(data_url: &str) -> Result<(String, String), String> {
    let (header, base64) = data_url
        .split_once(',')
        .ok_or_else(|| "上传图片不是有效 data URL".to_string())?;
    if !matches!(
        header,
        "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
    ) {
        return Err("参考图必须是 PNG、JPEG 或 WebP base64 图片".into());
    }
    let canonical = image_data_url(&decode_base64_bytes(base64)?)?;
    let (header, base64) = canonical.split_once(',').unwrap();
    Ok((
        header
            .strip_prefix("data:")
            .unwrap()
            .strip_suffix(";base64")
            .unwrap()
            .into(),
        base64.into(),
    ))
}

fn normalize_aspect_ratio(value: Option<String>) -> String {
    match value.as_deref() {
        Some("1:1" | "16:9" | "4:3" | "3:2" | "2:3" | "3:4" | "9:16") => value.unwrap(),
        _ => "1:1".to_string(),
    }
}

fn current_timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub fn run() {
    native_pet::init_runtime();

    let app = tauri::Builder::default()
        .setup(|app| {
            native_pet::set_bundled_frame_root(app.handle());
            let (settings, issue) = native_pet::load_settings_with_issue(app.handle());
            let settings_path = native_pet::settings_file_path(app.handle()).ok();
            native_pet::configure(&settings, settings_path, issue);
            native_pet::spawn_window(app.handle().clone());
            setup_tray(app)?;
            sync_tray(app.handle());
            show_studio_window(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "studio" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            get_native_pet_state,
            update_native_pet_preferences,
            interact_native_pet,
            set_native_pet_action,
            set_native_pet_frame_root,
            set_native_pet_name,
            detach_native_pet,
            set_native_pet_scale,
            set_native_pet_visible,
            get_native_pet_settings,
            hide_studio_window,
            reset_native_pet_position,
            generate_minimax_image,
            upload_reference_image,
            load_preset_frame_pack,
            save_manual_frame_pack
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::Ready => show_studio_window(app_handle),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_studio_window(app_handle),
        tauri::RunEvent::ExitRequested { .. } => {
            let _ = native_pet::persist_runtime_settings();
        }
        tauri::RunEvent::Exit => native_pet::shutdown(),
        _ => {}
    });
}

#[derive(Clone)]
struct TrayHandles {
    status: MenuItem<tauri::Wry>,
    visibility: MenuItem<tauri::Wry>,
    snooze: MenuItem<tauri::Wry>,
    snooze_15: MenuItem<tauri::Wry>,
    snooze_30: MenuItem<tauri::Wry>,
    snooze_60: MenuItem<tauri::Wry>,
    animation: CheckMenuItem<tauri::Wry>,
    autonomous: CheckMenuItem<tauri::Wry>,
    reset: MenuItem<tauri::Wry>,
    autostart: CheckMenuItem<tauri::Wry>,
}

static TRAY: Mutex<Option<TrayHandles>> = Mutex::new(None);

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(app, "status", "贴贴宠物 · 正在准备", false, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show_studio", "打开主界面", true, None::<&str>)?;
    let visibility_item = MenuItem::with_id(app, "toggle_visibility", "暂时收起", true, None::<&str>)?;
    let snooze_item = MenuItem::with_id(app, "toggle_snooze", "休息一小时", true, None::<&str>)?;
    let snooze_15_item = MenuItem::with_id(app, "snooze_15", "15 分钟", true, None::<&str>)?;
    let snooze_30_item = MenuItem::with_id(app, "snooze_30", "30 分钟", true, None::<&str>)?;
    let snooze_60_item = MenuItem::with_id(app, "snooze_60", "60 分钟", true, None::<&str>)?;
    let snooze_menu = SubmenuBuilder::new(app, "休息")
        .item(&snooze_15_item)
        .item(&snooze_30_item)
        .item(&snooze_60_item)
        .build()?;
    let autonomous_item = CheckMenuItem::with_id(
        app,
        "toggle_autonomous",
        "自主活动",
        true,
        native_pet::autonomous_enabled(),
        None::<&str>,
    )?;
    let animation_item = CheckMenuItem::with_id(
        app,
        "toggle_animation",
        "播放动画",
        true,
        !native_pet::user_animation_paused(),
        None::<&str>,
    )?;
    let idle_item = MenuItem::with_id(app, "action_idle", "待机", true, None::<&str>)?;
    let sit_item = MenuItem::with_id(app, "action_sit", "坐下", true, None::<&str>)?;
    let sleep_item = MenuItem::with_id(app, "action_sleep", "睡觉", true, None::<&str>)?;
    let happy_item = MenuItem::with_id(app, "action_happy", "开心", true, None::<&str>)?;
    let walk_item = MenuItem::with_id(app, "action_walk", "走路", true, None::<&str>)?;
    let jump_item = MenuItem::with_id(app, "action_jump", "跳跃", true, None::<&str>)?;
    let reset_item = MenuItem::with_id(app, "reset_position", "重置位置", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "toggle_autostart",
        "开机自启",
        true,
        autostart::is_enabled(),
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit_app", "退出应用", true, None::<&str>)?;

    let more_actions = SubmenuBuilder::new(app, "更多动作")
        .item(&idle_item)
        .item(&sit_item)
        .item(&sleep_item)
        .item(&happy_item)
        .item(&walk_item)
        .item(&jump_item)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&status_item)
        .separator()
        .item(&show_item)
        .item(&visibility_item)
        .item(&snooze_item)
        .item(&snooze_menu)
        .separator()
        .item(&animation_item)
        .item(&autonomous_item)
        .item(&more_actions)
        .separator()
        .item(&reset_item)
        .item(&autostart_item)
        .separator()
        .item(&quit_item)
        .build()?;

    if let Ok(mut tray) = TRAY.lock() {
        *tray = Some(TrayHandles {
            status: status_item,
            visibility: visibility_item,
            snooze: snooze_item,
            snooze_15: snooze_15_item,
            snooze_30: snooze_30_item,
            snooze_60: snooze_60_item,
            animation: animation_item,
            autonomous: autonomous_item,
            reset: reset_item,
            autostart: autostart_item,
        });
    }

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("桌面贴贴宠物")
        .on_menu_event(move |app, event| handle_tray_event(app, event.id().as_ref()));

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn status_text(state: &native_pet::NativePetState) -> &'static str {
    if state.pet_id.is_none() {
        "等待领养"
    } else if state.availability == native_pet::Availability::Error {
        "需要帮助"
    } else if state.visibility_mode == native_pet::VisibilityMode::Snoozed {
        "休息中"
    } else if state.visibility_mode == native_pet::VisibilityMode::Hidden {
        "已收起"
    } else if !state.visible {
        "正在准备"
    } else if state.animation_paused {
        "动画已暂停"
    } else if state.effective_paused {
        "低动态"
    } else if !state.autonomous {
        "固定姿态"
    } else {
        "正在桌面陪着你"
    }
}

fn sync_tray(app: &tauri::AppHandle) {
    let Some(handles) = TRAY.lock().ok().and_then(|tray| tray.clone()) else {
        return;
    };
    let state = native_pet::state_snapshot();
    let name = state
        .pet_name
        .clone()
        .unwrap_or_else(|| "贴贴宠物".to_string());
    let status = status_text(&state);
    let _ = handles.status.set_text(format!("{name} · {status}"));
    let _ = handles.visibility.set_text(if state.visibility_mode
        == native_pet::VisibilityMode::Shown
    {
        "暂时收起"
    } else {
        "立即唤回"
    });
    let _ = handles.snooze.set_text(if state.visibility_mode
        == native_pet::VisibilityMode::Snoozed
    {
        "立即唤回"
    } else {
        "休息一小时"
    });
    let has_pet = state.pet_id.is_some();
    let ready = state.availability == native_pet::Availability::Ready;
    let _ = handles.animation.set_checked(!state.animation_paused);
    let _ = handles.autonomous.set_checked(state.autonomous);
    let _ = handles.autostart.set_checked(state.autostart.enabled);
    let _ = handles.visibility.set_enabled(has_pet);
    let _ = handles.snooze.set_enabled(has_pet && ready);
    let _ = handles.snooze_15.set_enabled(has_pet && ready);
    let _ = handles.snooze_30.set_enabled(has_pet && ready);
    let _ = handles.snooze_60.set_enabled(has_pet && ready);
    let _ = handles.animation.set_enabled(has_pet);
    let _ = handles.autonomous.set_enabled(has_pet);
    let _ = handles.autostart.set_enabled(state.capabilities.autostart);
    let _ = handles.reset.set_enabled(state.capabilities.reset_position);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("{name} · {status}")));
    }
}

pub(crate) fn refresh_tray() {
    if let Some(app) = native_pet::app_handle() {
        let handle = app.clone();
        // Menu and tray updates must reach the platform main thread, including
        // when a background task (frame-pack loading) emitted the new state.
        let _ = app.run_on_main_thread(move || sync_tray(&handle));
    }
}

fn handle_tray_event(app: &tauri::AppHandle, id: &str) {
    let state = native_pet::state_snapshot();
    let result = match id {
        "show_studio" => {
            show_studio_window(app);
            Ok(())
        }
        "toggle_visibility" => {
            let request = if state.visibility_mode == native_pet::VisibilityMode::Shown {
                native_pet::PreferencesRequest::Hide
            } else {
                native_pet::PreferencesRequest::Show {
                    expected_pet_id: None,
                    expected_state: None,
                }
            };
            native_pet::update_preferences(request).map(|_| ())
        }
        "toggle_snooze" => {
            let request = if state.visibility_mode == native_pet::VisibilityMode::Snoozed {
                native_pet::PreferencesRequest::Show {
                    expected_pet_id: None,
                    expected_state: None,
                }
            } else {
                native_pet::PreferencesRequest::Snooze {
                    expected_pet_id: None,
                    duration_minutes: None,
                }
            };
            native_pet::update_preferences(request).map(|_| ())
        }
        "snooze_15" => native_pet::update_preferences(
            native_pet::PreferencesRequest::Snooze {
                expected_pet_id: None,
                duration_minutes: Some(15),
            },
        )
        .map(|_| ()),
        "snooze_30" => native_pet::update_preferences(
            native_pet::PreferencesRequest::Snooze {
                expected_pet_id: None,
                duration_minutes: Some(30),
            },
        )
        .map(|_| ()),
        "snooze_60" => native_pet::update_preferences(
            native_pet::PreferencesRequest::Snooze {
                expected_pet_id: None,
                duration_minutes: Some(60),
            },
        )
        .map(|_| ()),
        "toggle_animation" => native_pet::update_preferences(
            native_pet::PreferencesRequest::SetAnimationPaused {
                value: !state.animation_paused,
            },
        )
        .map(|_| ()),
        "toggle_autonomous" => native_pet::update_preferences(
            native_pet::PreferencesRequest::SetAutonomous {
                value: !state.autonomous,
            },
        )
        .map(|_| ()),
        "reset_position" => {
            native_pet::update_preferences(native_pet::PreferencesRequest::ResetPosition {
                expected_pet_id: None,
            })
            .map(|_| ())
        }
        "toggle_autostart" => native_pet::update_preferences(
            native_pet::PreferencesRequest::SetAutostart {
                value: !state.autostart.enabled,
            },
        )
        .map(|_| ()),
        "quit_app" => {
            app.exit(0);
            Ok(())
        }
        action if action.starts_with("action_") => {
            native_pet::apply_action(action.trim_start_matches("action_"))
        }
        _ => Ok(()),
    };

    if let Err(err) = result {
        native_pet::emit_error(&err);
    }
    sync_tray(app);
}

fn show_studio_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("studio") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
