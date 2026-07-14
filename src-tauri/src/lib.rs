use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{
    menu::MenuBuilder,
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

mod native_pet;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn set_native_pet_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    native_pet::set_action(&action)?;
    let mut settings = load_settings(&app);
    settings.current_action = action;
    save_settings(&app, &settings)?;
    Ok(())
}

#[tauri::command]
fn set_native_pet_frame_root(app: tauri::AppHandle, root_dir: String) -> Result<(), String> {
    native_pet::set_frame_root(&root_dir)?;
    let mut settings = load_settings(&app);
    settings.frame_root = normalize_frame_root(Some(root_dir));
    save_settings(&app, &settings)?;
    Ok(())
}

#[tauri::command]
fn set_native_pet_scale(app: tauri::AppHandle, scale: f64) -> Result<(), String> {
    native_pet::set_scale(scale)?;
    let mut settings = load_settings(&app);
    settings.scale = normalize_scale(scale);
    save_settings(&app, &settings)?;
    Ok(())
}

#[tauri::command]
fn get_native_pet_settings(app: tauri::AppHandle) -> NativePetSettings {
    load_settings(&app)
}

const DEFAULT_FRAME_ROOT: &str = "./frame-pack";
const SETTINGS_FILE_NAME: &str = "native-pet-settings.json";
const ACTION_NAMES: [&str; 6] = ["idle", "sit", "sleep", "happy", "walk", "jump"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MinimaxImageRequest {
    api_key: Option<String>,
    model: Option<String>,
    prompt: String,
    reference_image_url: Option<String>,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePetSettings {
    frame_root: String,
    scale: f64,
    current_action: String,
}

impl Default for NativePetSettings {
    fn default() -> Self {
        Self {
            frame_root: DEFAULT_FRAME_ROOT.to_string(),
            scale: 1.0,
            current_action: "idle".to_string(),
        }
    }
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
        aspect_ratio: "1:1".to_string(),
        n: 1,
        prompt_optimizer: true,
        subject_reference,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.minimaxi.com/v1/image_generation")
        .bearer_auth(api_key.trim())
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("Minimax 请求失败：{err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取 Minimax 响应失败：{err}"))?;
    write_debug_response("minimax raw response", &body);

    if !status.is_success() {
        return Err(format!("Minimax HTTP {status}: {body}"));
    }

    let parsed: MinimaxResponse = serde_json::from_str(&body)
        .map_err(|err| format!("解析 Minimax 响应失败：{err}; 原始响应：{body}"))?;

    if let Some(data) = parsed.data {
        if let Some(image_base64) = data.image_base64.into_iter().next() {
            return Ok(format!("data:image/png;base64,{image_base64}"));
        }

        if let Some(image_url) = data.image_urls.into_iter().next() {
            return download_image_as_data_url(&client, &image_url).await;
        }
    }

    if let Some(base_resp) = parsed.base_resp {
        return Err(format!(
            "Minimax 没有返回图片，base_resp={base_resp}; 原始响应：{body}"
        ));
    }

    Err(format!("Minimax 响应里没有图片：{body}"))
}

#[tauri::command]
async fn upload_reference_image(request: UploadReferenceImageRequest) -> Result<String, String> {
    let upload_url = validate_http_url(&request.upload_url)?;
    let (content_type, base64) = split_data_url(&request.data_url)?;
    let payload = UploadReferenceImagePayload {
        filename: request
            .filename
            .unwrap_or_else(|| format!("pet-reference-{}.png", current_timestamp_ms())),
        content_type,
        base64,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(upload_url)
        .json(&payload)
        .send()
        .await
        .map_err(|err| format!("上传参考图失败：{err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取上传接口响应失败：{err}"))?;

    if !status.is_success() {
        return Err(format!("上传参考图失败：HTTP {status}: {body}"));
    }

    let parsed: UploadReferenceImageResponse = serde_json::from_str(&body)
        .map_err(|err| format!("解析上传接口响应失败：{err}; 原始响应：{body}"))?;

    if parsed.url.trim().is_empty() {
        return Err(format!("上传接口没有返回 url：{body}"));
    }

    Ok(parsed.url)
}

#[tauri::command]
fn load_preset_frame_pack(request: LoadPresetFramePackRequest) -> Result<PresetFramePack, String> {
    let root_dir = normalize_frame_root(request.root_dir);
    let root = PathBuf::from(root_dir);
    let mut actions = HashMap::new();

    for action in ACTION_NAMES {
        let frames = read_action_frames(&root, action)?;
        if frames.len() < 5 {
            return Err(format!(
                "{}/{} 至少需要 5 帧，当前只有 {} 帧",
                root.display(),
                action,
                frames.len()
            ));
        }
        actions.insert(action.to_string(), frames);
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

fn read_action_frames(root: &Path, action: &str) -> Result<Vec<String>, String> {
    let action_dir = root.join(action);
    let mut paths = std::fs::read_dir(&action_dir)
        .map_err(|err| format!("读取动作目录失败 {}：{err}", action_dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "png" | "jpg" | "jpeg" | "webp"
                    )
                })
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    paths.sort_by_key(|path| path.file_name().map(|name| name.to_os_string()));

    paths
        .into_iter()
        .map(|path| read_image_as_data_url(&path))
        .collect()
}

fn read_image_as_data_url(path: &Path) -> Result<String, String> {
    let bytes =
        std::fs::read(path).map_err(|err| format!("读取图片失败 {}：{err}", path.display()))?;
    let content_type = match path
        .extension()
        .and_then(|ext| ext.to_str())
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

async fn download_image_as_data_url(
    client: &reqwest::Client,
    image_url: &str,
) -> Result<String, String> {
    let response = client.get(image_url).send().await.map_err(|err| {
        let message = format!("下载 Minimax 图片失败：{err}; image_url={image_url}");
        write_debug_response("image download request failed", &message);
        message
    })?;

    let status = response.status();
    if !status.is_success() {
        let message = format!("下载 Minimax 图片失败：HTTP {status}; image_url={image_url}");
        write_debug_response("image download http failed", &message);
        return Err(message);
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = response.bytes().await.map_err(|err| {
        let message = format!("读取 Minimax 图片失败：{err}; image_url={image_url}");
        write_debug_response("image download body failed", &message);
        message
    })?;
    write_debug_response(
        "image download success",
        &format!(
            "content_type={content_type}\nbytes={}\nimage_url={image_url}",
            bytes.len()
        ),
    );
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(format!("data:{content_type};base64,{encoded}"))
}

fn write_debug_response(label: &str, body: &str) {
    if !cfg!(debug_assertions) {
        return;
    }

    let payload = format!("{label}\n\n{body}");
    let _ = std::fs::write("/tmp/pet-desktop-minimax-last-response.txt", payload);
}

fn validate_http_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Err("上传接口必须是 http:// 或 https:// URL".to_string())
    }
}

fn split_data_url(data_url: &str) -> Result<(String, String), String> {
    let (header, base64) = data_url
        .split_once(',')
        .ok_or_else(|| "上传图片不是有效 data URL".to_string())?;
    let content_type = header
        .strip_prefix("data:")
        .and_then(|value| value.split_once(';').map(|(mime, _)| mime.to_string()))
        .unwrap_or_else(|| "image/png".to_string());

    Ok((content_type, base64.to_string()))
}

fn current_timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn load_settings(app: &tauri::AppHandle) -> NativePetSettings {
    let path = match settings_file_path(app) {
        Ok(path) => path,
        Err(_) => return NativePetSettings::default(),
    };

    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return NativePetSettings::default(),
    };

    let mut settings = serde_json::from_slice::<NativePetSettings>(&bytes).unwrap_or_default();
    settings.frame_root = normalize_frame_root(Some(settings.frame_root));
    settings.scale = normalize_scale(settings.scale);
    settings.current_action = normalize_action(settings.current_action);
    settings
}

fn save_settings(app: &tauri::AppHandle, settings: &NativePetSettings) -> Result<(), String> {
    let path = settings_file_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建配置目录失败 {}：{err}", parent.display()))?;
    }

    let payload = NativePetSettings {
        frame_root: normalize_frame_root(Some(settings.frame_root.clone())),
        scale: normalize_scale(settings.scale),
        current_action: normalize_action(settings.current_action.clone()),
    };
    let data = serde_json::to_vec_pretty(&payload)
        .map_err(|err| format!("序列化原生宠物配置失败：{err}"))?;
    std::fs::write(&path, data).map_err(|err| format!("写入配置失败 {}：{err}", path.display()))
}

fn settings_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE_NAME))
        .map_err(|err| format!("获取应用配置目录失败：{err}"))
}

fn normalize_frame_root(root_dir: Option<String>) -> String {
    root_dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_FRAME_ROOT.to_string())
}

fn normalize_scale(scale: f64) -> f64 {
    if scale.is_finite() {
        scale.clamp(0.5, 1.5)
    } else {
        1.0
    }
}

fn normalize_action(action: String) -> String {
    if ACTION_NAMES.contains(&action.as_str()) {
        action
    } else {
        "idle".to_string()
    }
}

pub fn run() {
    native_pet::init_runtime();

    tauri::Builder::default()
        .setup(|app| {
            let settings = load_settings(app.handle());
            let settings_path = settings_file_path(app.handle()).ok();
            native_pet::configure(
                &settings.frame_root,
                settings.scale,
                &settings.current_action,
                settings_path,
            );
            native_pet::spawn_window(app.handle().clone());
            setup_tray(app)?;
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
            set_native_pet_action,
            set_native_pet_frame_root,
            set_native_pet_scale,
            get_native_pet_settings,
            generate_minimax_image,
            upload_reference_image,
            load_preset_frame_pack
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show_studio", "打开主界面")
        .separator()
        .text("quit_app", "退出应用")
        .build()?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("桌面贴贴宠物")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_studio" => show_studio_window(app),
            "quit_app" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn show_studio_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("studio") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
