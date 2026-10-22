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
use tauri::AppHandle;

use super::{
    persist_runtime_settings, runtime, runtime_action_scale, runtime_root, scaled_canvas_size,
    take_reload_request, update_position, PetPosition, ACTIONS, CANVAS_SIZE, PET_SIZE,
};

thread_local! {
    static NATIVE_WINDOW: RefCell<Option<gtk::Window>> = const { RefCell::new(None) };
    static DRAG_STATE: RefCell<Option<DragState>> = const { RefCell::new(None) };
}

struct DragState {
    start_window: (i32, i32),
    start_root: (f64, f64),
    moved: bool,
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
    drawing_area.add_events(
        gdk::EventMask::BUTTON_PRESS_MASK
            | gdk::EventMask::BUTTON_RELEASE_MASK
            | gdk::EventMask::POINTER_MOTION_MASK,
    );
    window.add(&drawing_area);

    let frames = Rc::new(RefCell::new(if super::visible() {
        load_frames(&runtime_root())
    } else {
        HashMap::new()
    }));
    let render_state = Rc::new(RefCell::new(RenderState::default()));

    setup_draw_handler(&drawing_area, Rc::clone(&frames), Rc::clone(&render_state));
    setup_mouse_handler(&window, &drawing_area, app_handle);
    setup_animation_timer(&window, &drawing_area, frames, render_state);

    if super::visible() {
        window.show_all();
    }
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
    let menu = build_action_menu(drawing_area, app_handle);

    let press_window = window.clone();
    drawing_area.connect_button_press_event(move |_, event| match event.button() {
        1 => {
            let (x, y) = press_window.position();
            let start_root = event.root_coords().unwrap_or_else(|| event.position());
            DRAG_STATE.with(|state| {
                *state.borrow_mut() = Some(DragState {
                    start_window: (x, y),
                    start_root,
                    moved: false,
                });
            });
            Propagation::Stop
        }
        3 => {
            menu.popup_easy(event.button(), event.time());
            Propagation::Stop
        }
        _ => Propagation::Proceed,
    });

    let motion_window = window.clone();
    drawing_area.connect_motion_notify_event(move |_, event| {
        DRAG_STATE.with(|state| {
            let mut state = state.borrow_mut();
            let Some(drag) = state.as_mut() else {
                return;
            };
            let Some(current) = event.root_coords() else {
                return;
            };
            let dx = current.0 - drag.start_root.0;
            let dy = current.1 - drag.start_root.1;
            if !drag.moved && (dx.abs() > 3.0 || dy.abs() > 3.0) {
                drag.moved = true;
            }
            if drag.moved {
                motion_window.move_(
                    drag.start_window.0 + dx.round() as i32,
                    drag.start_window.1 + dy.round() as i32,
                );
            }
        });
        Propagation::Stop
    });

    let release_window = window.clone();
    drawing_area.connect_button_release_event(move |_, event| {
        if event.button() != 1 {
            return Propagation::Proceed;
        }
        let moved = DRAG_STATE.with(|state| {
            state
                .borrow_mut()
                .take()
                .map(|drag| drag.moved)
                .unwrap_or(false)
        });
        if moved {
            let (x, y) = release_window.position();
            update_position(PetPosition {
                x: x as f64,
                y: y as f64,
                screen: None,
            });
            if let Err(err) = persist_runtime_settings() {
                eprintln!("failed to persist native pet position: {err}");
            }
        } else {
            let _ = super::interact(super::InteractionKind::Pet, super::current_pet_id());
        }
        Propagation::Stop
    });
}

fn build_action_menu(drawing_area: &gtk::DrawingArea, _app_handle: AppHandle) -> gtk::Menu {
    let menu = gtk::Menu::new();

    for (action, label) in ACTIONS {
        let item = gtk::MenuItem::with_label(label);
        let drawing_area = drawing_area.clone();
        item.connect_activate(move |_| {
            if let Err(err) = super::apply_action(action) {
                eprintln!("failed to set native pet action: {err}");
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
    let mut playback = super::playback::Playback::default();
    let mut applied_visible = super::visible();

    glib::timeout_add_local(Duration::from_millis(16), move || {
        let _ = super::check_snooze_expiry(super::state::now_ms());
        let _ = super::refresh_system_reduced_motion();
        if super::maybe_auto_advance(Instant::now()).is_some() {
            super::emit_state_changed();
        }

        let (next_action, next_scale, revision) = runtime_action_scale();
        let visible = super::visible();
        if applied_visible != visible {
            if visible {
                window.show_all();
            } else {
                window.hide();
            }
            applied_visible = visible;
        }
        if !visible {
            return ControlFlow::Continue;
        }
        let reloaded = maybe_reload_frames(&frames);

        let scale_changed = (next_scale - applied_scale).abs() > f64::EPSILON;
        if scale_changed {
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
        let previous_frame = state.frame_index;
        let action_changed = state.action != next_action;
        state.action = next_action.clone();
        let finished = playback
            .tick(
                &next_action,
                revision,
                frame_count,
                super::animation_paused(),
                Instant::now(),
            )
            .is_some();
        state.frame_index = playback.frame_index;
        let redraw =
            reloaded || scale_changed || action_changed || previous_frame != state.frame_index;
        drop(state);
        if finished && super::return_to_idle().is_ok() {
            super::emit_state_changed();
        }

        if redraw {
            drawing_area.queue_draw();
        }
        ControlFlow::Continue
    });
}

fn maybe_reload_frames(frames: &Rc<RefCell<HashMap<String, Vec<Pixbuf>>>>) -> bool {
    if let Some(root_dir) = take_reload_request() {
        match try_load_frames(&root_dir) {
            Ok(prepared) => {
                *frames.borrow_mut() = prepared;
                return true;
            }
            Err(error) => super::emit_error(&error),
        }
    }
    false
}

fn load_frames(root: &Path) -> HashMap<String, Vec<Pixbuf>> {
    try_load_frames(root).unwrap_or_else(|error| {
        super::emit_error(&error);
        HashMap::new()
    })
}

fn try_load_frames(root: &Path) -> Result<HashMap<String, Vec<Pixbuf>>, String> {
    let paths = super::scan_pack(root)?;
    paths
        .into_iter()
        .map(|(action, paths)| {
            let frames = paths
                .into_iter()
                .map(|path| {
                    Pixbuf::from_file(&path)
                        .map_err(|err| format!("解码帧图失败 {}：{err}", path.display()))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok((action, frames))
        })
        .collect()
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

/// Reads GTK's animation preference (GNOME exposes "Reduce motion" through it).
pub fn system_reduced_motion() -> Option<bool> {
    let settings = gtk::Settings::default()?;
    Some(!settings.is_gtk_enable_animations())
}
