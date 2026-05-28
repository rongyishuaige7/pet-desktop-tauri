use cairo::Operator;
use gdk::prelude::*;
use gdk_pixbuf::Pixbuf;
use glib::{ControlFlow, Propagation};
use gtk::prelude::*;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const DEFAULT_FRAME_ROOT: &str = "/data/大帅哥小项目/frame-slicer";
const ACTIONS: [(&str, &str); 6] = [
    ("idle", "待机"),
    ("sit", "坐下"),
    ("sleep", "睡觉"),
    ("happy", "开心"),
    ("walk", "走路"),
    ("jump", "跳跃"),
];
const LOOPING_ACTIONS: [&str; 3] = ["idle", "walk", "jump"];
const CANVAS_SIZE: i32 = 360;
const PET_SIZE: i32 = 320;

#[derive(Debug)]
struct NativePetRuntime {
    action: String,
    root_dir: PathBuf,
    reload_requested: bool,
    scale: f64,
    settings_path: Option<PathBuf>,
}

static RUNTIME: OnceLock<Arc<Mutex<NativePetRuntime>>> = OnceLock::new();

thread_local! {
    static NATIVE_WINDOW: RefCell<Option<gtk::Window>> = const { RefCell::new(None) };
}

pub fn init_runtime() {
    let _ = runtime();
}

pub fn set_action(action: &str) -> Result<(), String> {
    if !ACTIONS.iter().any(|(id, _)| *id == action) {
        return Err(format!("未知动作：{action}"));
    }

    let runtime_handle = runtime();
    let mut runtime = runtime_handle
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

    let runtime_handle = runtime();
    let mut runtime = runtime_handle
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.root_dir = PathBuf::from(root);
    runtime.reload_requested = true;
    Ok(())
}

pub fn set_scale(scale: f64) -> Result<(), String> {
    let scale = scale.clamp(0.5, 1.5);
    let runtime_handle = runtime();
    let mut runtime = runtime_handle
        .lock()
        .map_err(|_| "原生宠物状态锁已损坏".to_string())?;
    runtime.scale = scale;
    Ok(())
}

pub fn configure(root_dir: &str, scale: f64, action: &str, settings_path: Option<PathBuf>) {
    let root_dir = root_dir.trim();
    let action = if ACTIONS.iter().any(|(id, _)| *id == action) {
        action
    } else {
        "idle"
    };

    if let Ok(mut runtime) = runtime().lock() {
        if !root_dir.is_empty() {
            runtime.root_dir = PathBuf::from(root_dir);
        }
        runtime.scale = scale.clamp(0.5, 1.5);
        runtime.action = action.to_string();
        runtime.settings_path = settings_path;
    }
}

pub fn spawn_window(app_handle: AppHandle) {
    init_runtime();

    if !gtk::is_initialized() && gtk::init().is_err() {
        eprintln!("failed to initialize GTK native pet window");
        return;
    }

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title("桌面宠物");
    window.set_default_size(CANVAS_SIZE, CANVAS_SIZE);
    window.set_resizable(false);
    window.set_decorated(false);
    window.set_keep_above(true);
    window.set_skip_taskbar_hint(true);
    window.set_app_paintable(true);

    if let Some(screen) = gtk::prelude::WidgetExt::screen(&window) {
        if let Some(visual) = screen.rgba_visual() {
            window.set_visual(Some(&visual));
        }
    }

    let drawing_area = gtk::DrawingArea::new();
    drawing_area.set_size_request(CANVAS_SIZE, CANVAS_SIZE);
    drawing_area.set_app_paintable(true);
    drawing_area.add_events(gdk::EventMask::BUTTON_PRESS_MASK);
    window.add(&drawing_area);

    let frames = Rc::new(RefCell::new(load_frames(&current_root_dir())));
    let render_state = Rc::new(RefCell::new(RenderState::default()));

    setup_draw_handler(&drawing_area, Rc::clone(&frames), Rc::clone(&render_state));
    setup_mouse_handler(&window, &drawing_area, app_handle);
    setup_animation_timer(&window, &drawing_area, frames, render_state);

    window.show_all();
    NATIVE_WINDOW.with(|native_window| {
        *native_window.borrow_mut() = Some(window);
    });
}

fn runtime() -> Arc<Mutex<NativePetRuntime>> {
    RUNTIME
        .get_or_init(|| {
            Arc::new(Mutex::new(NativePetRuntime {
                action: "idle".to_string(),
                root_dir: PathBuf::from(DEFAULT_FRAME_ROOT),
                reload_requested: false,
                scale: 1.0,
                settings_path: None,
            }))
        })
        .clone()
}

fn current_root_dir() -> PathBuf {
    runtime()
        .lock()
        .map(|runtime| runtime.root_dir.clone())
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_FRAME_ROOT))
}

#[derive(Debug)]
struct RenderState {
    action: String,
    frame_index: usize,
}

impl Default for RenderState {
    fn default() -> Self {
        Self {
            action: "idle".to_string(),
            frame_index: 0,
        }
    }
}

fn setup_draw_handler(
    drawing_area: &gtk::DrawingArea,
    frames: Rc<RefCell<HashMap<String, Vec<Pixbuf>>>>,
    render_state: Rc<RefCell<RenderState>>,
) {
    drawing_area.connect_draw(move |_, context| {
        clear_context(context);

        let state = render_state.borrow();
        let frames = frames.borrow();
        let frame = frames
            .get(&state.action)
            .or_else(|| frames.get("idle"))
            .and_then(|action_frames| {
                if action_frames.is_empty() {
                    None
                } else {
                    action_frames.get(state.frame_index.min(action_frames.len() - 1))
                }
            })
            .cloned();

        if let Some(frame) = frame {
            let scale = runtime().lock().map(|runtime| runtime.scale).unwrap_or(1.0);
            paint_pixbuf_centered(context, &frame, scale);
        }

        Propagation::Stop
    });
}

fn setup_mouse_handler(window: &gtk::Window, drawing_area: &gtk::DrawingArea, app_handle: AppHandle) {
    let window = window.clone();
    let menu = build_action_menu(drawing_area, app_handle);

    drawing_area.connect_button_press_event(move |_, event| match event.button() {
        1 => {
            let (root_x, root_y) = event.root();
            window.begin_move_drag(1, root_x as i32, root_y as i32, event.time());
            Propagation::Stop
        }
        3 => {
            menu.popup_easy(event.button(), event.time());
            Propagation::Stop
        }
        _ => Propagation::Proceed,
    });
}

fn build_action_menu(drawing_area: &gtk::DrawingArea, app_handle: AppHandle) -> gtk::Menu {
    let menu = gtk::Menu::new();

    for (action, label) in ACTIONS {
        let item = gtk::MenuItem::with_label(label);
        let drawing_area = drawing_area.clone();
        let app_handle = app_handle.clone();
        item.connect_activate(move |_| {
            if let Err(err) = set_action(action) {
                eprintln!("failed to set native pet action: {err}");
            }
            persist_runtime_settings();
            if let Err(err) = app_handle.emit("native-pet-action-changed", action) {
                eprintln!("failed to emit native pet action change: {err}");
            }
            drawing_area.queue_draw();
        });
        menu.append(&item);
    }

    let close = gtk::MenuItem::with_label("收起菜单");
    menu.append(&close);
    menu.show_all();
    menu
}

fn setup_animation_timer(
    window: &gtk::Window,
    drawing_area: &gtk::DrawingArea,
    frames: Rc<RefCell<HashMap<String, Vec<Pixbuf>>>>,
    render_state: Rc<RefCell<RenderState>>,
) {
    let window = window.clone();
    let drawing_area = drawing_area.clone();
    let mut applied_scale = 1.0;

    glib::timeout_add_local(std::time::Duration::from_millis(150), move || {
        maybe_reload_frames(&frames);

        let (next_action, next_scale) = runtime()
            .lock()
            .map(|runtime| (runtime.action.clone(), runtime.scale))
            .unwrap_or_else(|_| ("idle".to_string(), 1.0));

        if (next_scale - applied_scale).abs() > f64::EPSILON {
            applied_scale = next_scale;
            let canvas_size = scaled_canvas_size(next_scale);
            drawing_area.set_size_request(canvas_size, canvas_size);
            window.resize(canvas_size, canvas_size);
        }

        let frame_count = {
            let frames = frames.borrow();
            frames
                .get(&next_action)
                .or_else(|| frames.get("idle"))
                .map(|frames| frames.len())
                .unwrap_or(0)
        };

        {
            let mut state = render_state.borrow_mut();
            if state.action != next_action {
                state.action = next_action;
                state.frame_index = 0;
            } else if frame_count > 0 {
                if LOOPING_ACTIONS.contains(&state.action.as_str()) {
                    state.frame_index = (state.frame_index + 1) % frame_count;
                } else {
                    state.frame_index = (state.frame_index + 1).min(frame_count - 1);
                }
            }
        }

        drawing_area.queue_draw();
        ControlFlow::Continue
    });
}

fn maybe_reload_frames(frames: &Rc<RefCell<HashMap<String, Vec<Pixbuf>>>>) {
    let root_dir = {
        let runtime_handle = runtime();
        let mut runtime = match runtime_handle.lock() {
            Ok(runtime) => runtime,
            Err(_) => return,
        };

        if !runtime.reload_requested {
            return;
        }

        runtime.reload_requested = false;
        runtime.root_dir.clone()
    };

    *frames.borrow_mut() = load_frames(&root_dir);
}

fn load_frames(root: &Path) -> HashMap<String, Vec<Pixbuf>> {
    let mut result = HashMap::new();

    for (action, _) in ACTIONS {
        let action_dir = root.join(action);
        let mut paths = match std::fs::read_dir(&action_dir) {
            Ok(entries) => entries
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
                .collect::<Vec<_>>(),
            Err(err) => {
                eprintln!(
                    "failed to read native pet frames {}: {err}",
                    action_dir.display()
                );
                Vec::new()
            }
        };

        paths.sort_by_key(|path| path.file_name().map(|name| name.to_os_string()));

        let pixbufs = paths
            .into_iter()
            .filter_map(|path| {
                Pixbuf::from_file(&path)
                    .map_err(|err| {
                        eprintln!("failed to load native pet frame {}: {err}", path.display());
                        err
                    })
                    .ok()
            })
            .collect::<Vec<_>>();

        result.insert(action.to_string(), pixbufs);
    }

    result
}

fn clear_context(context: &cairo::Context) {
    context.set_operator(Operator::Source);
    context.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    let _ = context.paint();
    context.set_operator(Operator::Over);
}

fn paint_pixbuf_centered(context: &cairo::Context, pixbuf: &Pixbuf, scale: f64) {
    let source_width = pixbuf.width() as f64;
    let source_height = pixbuf.height() as f64;

    if source_width <= 0.0 || source_height <= 0.0 {
        return;
    }

    let canvas_size = scaled_canvas_size(scale) as f64;
    let pet_size = PET_SIZE as f64 * scale;
    let image_scale = (pet_size / source_width).min(pet_size / source_height);
    let width = source_width * image_scale;
    let height = source_height * image_scale;
    let x = (canvas_size - width) / 2.0;
    let y = (canvas_size - height) / 2.0;

    let _ = context.save();
    context.translate(x, y);
    context.scale(image_scale, image_scale);
    context.set_source_pixbuf(pixbuf, 0.0, 0.0);
    let _ = context.paint();
    let _ = context.restore();
}

fn scaled_canvas_size(scale: f64) -> i32 {
    ((CANVAS_SIZE as f64 * scale.clamp(0.5, 1.5)).round() as i32).max(180)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedNativePetSettings {
    frame_root: String,
    scale: f64,
    current_action: String,
}

fn persist_runtime_settings() {
    let settings = match runtime().lock() {
        Ok(runtime) => {
            let Some(path) = runtime.settings_path.clone() else {
                return;
            };
            (
                path,
                PersistedNativePetSettings {
                    frame_root: runtime.root_dir.to_string_lossy().to_string(),
                    scale: runtime.scale,
                    current_action: runtime.action.clone(),
                },
            )
        }
        Err(_) => return,
    };

    if let Some(parent) = settings.0.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!("failed to create native pet settings directory {}: {err}", parent.display());
            return;
        }
    }

    match serde_json::to_vec_pretty(&settings.1) {
        Ok(data) => {
            if let Err(err) = std::fs::write(&settings.0, data) {
                eprintln!("failed to write native pet settings {}: {err}", settings.0.display());
            }
        }
        Err(err) => eprintln!("failed to serialize native pet settings: {err}"),
    }
}
