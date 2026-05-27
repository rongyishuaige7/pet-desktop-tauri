use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{
    menu::MenuBuilder,
    tray::TrayIconBuilder,
    Manager, PhysicalSize, Size, WindowEvent,
};

mod native_pet;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn start_pet_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|err| err.to_string())
}

#[tauri::command]
fn force_pet_repaint(window: tauri::Window) -> Result<(), String> {
    let size = window.inner_size().map_err(|err| err.to_string())?;
    let nudged = PhysicalSize::new(size.width.saturating_add(1), size.height.saturating_add(1));

    window
        .set_size(Size::Physical(nudged))
        .map_err(|err| err.to_string())?;
    std::thread::sleep(Duration::from_millis(8));
    window
        .set_size(Size::Physical(size))
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn set_native_pet_action(action: String) -> Result<(), String> {
    native_pet::set_action(&action)
}

#[tauri::command]
fn set_native_pet_frame_root(root_dir: String) -> Result<(), String> {
    native_pet::set_frame_root(&root_dir)
}

#[tauri::command]
fn set_native_pet_scale(scale: f64) -> Result<(), String> {
    native_pet::set_scale(scale)
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
        .post(request.upload_url.trim())
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
    let root_dir = request
        .root_dir
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/data/大帅哥小项目/frame-slicer".to_string());
    let root = PathBuf::from(root_dir);
    let action_names = ["idle", "sit", "sleep", "happy", "walk", "jump"];
    let mut actions = HashMap::new();

    for action in action_names {
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
    let payload = format!("{label}\n\n{body}");
    let _ = std::fs::write("/tmp/pet-desktop-minimax-last-response.txt", payload);
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

pub fn run() {
    native_pet::init_runtime();

    tauri::Builder::default()
        .setup(|app| {
            native_pet::spawn_window();
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
            start_pet_drag,
            force_pet_repaint,
            set_native_pet_action,
            set_native_pet_frame_root,
            set_native_pet_scale,
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
