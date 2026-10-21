use cairo::Operator;
use gdk::prelude::*;
use gdk_pixbuf::Pixbuf;
use glib::{ControlFlow, Propagation};
use gtk::prelude::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use super::{
    frame_interval_ms, is_looping, one_shot_next, persist_runtime_settings, runtime,
    runtime_action_scale, runtime_root, scaled_canvas_size, scan_action_frames, set_action,
    take_reload_request, ACTIONS, CANVAS_SIZE, PET_SIZE,
};

thread_local! {
    static NATIVE_WINDOW: RefCell<Option<gtk::Window>> = const { RefCell::new(None) };
}

pub fn spawn_window(app_handle: AppHandle) {
    if !gtk::is_initialized() && gtk::init().is_err() {
        eprintln!("failed to initialize GTK native pet window");
        return;
    }

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title("桌面宠物");
    window.set_default_size(CANVAS_SIZE as i32, CANVAS_SIZE as i32);
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
    drawing_area.set_size_request(CANVAS_SIZE as i32, CANVAS_SIZE as i32);
    drawing_area.set_app_paintable(true);
    drawing_area.add_events(gdk::EventMask::BUTTON_PRESS_MASK);
    window.add(&drawing_area);

    let frames = Rc::new(RefCell::new(load_frames(&runtime_root())));
    let render_state = Rc::new(RefCell::new(RenderState::default()));

    setup_draw_handler(&drawing_area, Rc::clone(&frames), Rc::clone(&render_state));
    setup_mouse_handler(&window, &drawing_area, app_handle);
    setup_animation_timer(&window, &drawing_area, frames, render_state);

    window.show_all();
    NATIVE_WINDOW.with(|native_window| {
        *native_window.borrow_mut() = Some(window);
    });
}

pub fn shutdown() {
    NATIVE_WINDOW.with(|native_window| {
        if let Some(window) = native_window.borrow_mut().take() {
            // Use GTK's safe window-close path. No delete-event handler inhibits
            // closing this window; WidgetExtManual::destroy requires unsafe.
            window.close();
        }
    });
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

fn setup_mouse_handler(
    window: &gtk::Window,
    drawing_area: &gtk::DrawingArea,
    app_handle: AppHandle,
) {
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
            if let Err(err) = persist_runtime_settings() {
                eprintln!("failed to persist native pet settings: {err}");
            }
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
    let mut last_advance = Instant::now();

    glib::timeout_add_local(Duration::from_millis(100), move || {
        if let Some(action) = super::maybe_auto_advance(Instant::now()) {
            if let Some(app) = super::app_handle() {
                let _ = app.emit("native-pet-action-changed", action);
            }
        }
        maybe_reload_frames(&frames);

        let (next_action, next_scale) = runtime_action_scale();

        if (next_scale - applied_scale).abs() > f64::EPSILON {
            applied_scale = next_scale;
            let canvas_size = scaled_canvas_size(next_scale) as i32;
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

        let mut state = render_state.borrow_mut();
        let mut finished = false;
        if state.action != next_action {
            state.action = next_action.clone();
            state.frame_index = 0;
            last_advance = Instant::now();
        } else if !super::animation_paused()
            && frame_count > 0
            && last_advance.elapsed() >= Duration::from_millis(frame_interval_ms(&next_action))
        {
            if is_looping(&state.action) {
                state.frame_index = (state.frame_index + 1) % frame_count;
            } else {
                state.frame_index = (state.frame_index + 1).min(frame_count - 1);
            }
            last_advance = Instant::now();
        }

        // A finished one-shot (jump, happy) hands control back to idle instead of
        // freezing on its last frame.
        if frame_count > 0
            && state.frame_index + 1 >= frame_count
            && !is_looping(&state.action)
            && one_shot_next(&state.action).is_some()
            && last_advance.elapsed() >= Duration::from_millis(frame_interval_ms(&next_action))
        {
            finished = true;
        }
        drop(state);

        if finished {
            let _ = super::return_to_idle();
        }

        drawing_area.queue_draw();
        ControlFlow::Continue
    });
}

fn maybe_reload_frames(frames: &Rc<RefCell<HashMap<String, Vec<Pixbuf>>>>) {
    if let Some(root_dir) = take_reload_request() {
        *frames.borrow_mut() = load_frames(&root_dir);
    }
}

fn load_frames(root: &Path) -> HashMap<String, Vec<Pixbuf>> {
    let mut result = HashMap::new();

    for (action, _) in ACTIONS {
        let paths = match scan_action_frames(root, action) {
            Ok(paths) => paths,
            Err(err) => {
                eprintln!("failed to read native pet frames: {err}");
                Vec::new()
            }
        };

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

    let canvas_size = scaled_canvas_size(scale);
    let pet_size = PET_SIZE * scale;
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
