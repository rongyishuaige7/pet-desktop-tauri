use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{menu::MenuBuilder, tray::TrayIconBuilder, Manager, WindowEvent};

mod native_pet;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn set_native_pet_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    native_pet::set_action(&action)?;
    let mut settings = native_pet::load_settings(&app);
    settings.current_action = action;
    native_pet::save_settings(&app, &settings)?;
    Ok(())
}

#[tauri::command]
fn set_native_pet_frame_root(app: tauri::AppHandle, root_dir: String) -> Result<(), String> {
    native_pet::set_frame_root(&root_dir)?;
    let mut settings = native_pet::load_settings(&app);
    settings.frame_root = native_pet::normalize_frame_root(Some(root_dir));
    native_pet::save_settings(&app, &settings)?;
    Ok(())
}

#[tauri::command]
fn set_native_pet_scale(app: tauri::AppHandle, scale: f64) -> Result<(), String> {
    native_pet::set_scale(scale)?;
    let mut settings = native_pet::load_settings(&app);
    settings.scale = native_pet::normalize_scale(scale);
    native_pet::save_settings(&app, &settings)?;
    Ok(())
}

#[tauri::command]
fn get_native_pet_settings(app: tauri::AppHandle) -> native_pet::NativePetSettings {
    native_pet::load_settings(&app)
}

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
        aspect_ratio: "1:1".to_string(),
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

    let client = http_client()?;
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

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| format!("创建 HTTP 客户端失败：{err}"))
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
            let settings = native_pet::load_settings(app.handle());
            let settings_path = native_pet::settings_file_path(app.handle()).ok();
            native_pet::configure(&settings, settings_path);
            native_pet::spawn_window(app.handle().clone());
            setup_tray(app)?;
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
            set_native_pet_action,
            set_native_pet_frame_root,
            set_native_pet_scale,
            get_native_pet_settings,
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
