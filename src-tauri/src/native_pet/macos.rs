use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{define_class, msg_send, sel, AnyThread, ClassType, MainThreadMarker};
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSEvent, NSEventMask, NSEventType, NSImage, NSImageView, NSMenu,
    NSMenuItem, NSPanel, NSScreen, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSTimer};
use tauri::{AppHandle, Emitter};

use super::{
    current_settings, emit_error, frame_interval_ms, is_looping, normalize_scale,
    persist_runtime_settings, runtime_action_scale, runtime_root, scaled_canvas_size,
    scan_action_frames, set_action, take_reload_request, update_position, PetPosition, ACTIONS,
    CANVAS_SIZE, MIN_FRAMES_PER_ACTION, PET_SIZE,
};

const COMMON_RUN_LOOP_MODE: &str = "kCFRunLoopCommonModes";
const FLOATING_WINDOW_LEVEL: isize = 3;

thread_local! {
    static UI: RefCell<Option<UiState>> = const { RefCell::new(None) };
}

#[allow(dead_code)]
struct UiState {
    panel: Retained<NSPanel>,
    image_view: Retained<PetImageView>,
    menu: Retained<NSMenu>,
    menu_target: Retained<PetMenuTarget>,
    timer: Retained<NSTimer>,
    monitor: Option<Retained<AnyObject>>,
    frames: HashMap<String, Vec<Retained<NSImage>>>,
    current_action: String,
    frame_index: usize,
    last_advance: Instant,
    applied_scale: f64,
    root: PathBuf,
}

define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    #[name = "PetMenuTarget"]
    #[ivars = ()]
    struct PetMenuTarget;

    impl PetMenuTarget {
        #[unsafe(method(selectAction:))]
        fn select_action(&self, sender: &NSMenuItem) {
            if let Some(action) = represented_action(sender) {
                handle_menu_action(&action);
            }
        }
    }
);

define_class!(
    #[unsafe(super(NSImageView))]
    #[name = "PetImageView"]
    #[ivars = ()]
    struct PetImageView;

    impl PetImageView {
        // Without this, the first click on an inactive app's panel is consumed
        // by activation and never reaches our drag/menu handling.
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }
    }
);

pub fn spawn_window(_app_handle: AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("native pet window must be created on the main thread");
        return;
    };

    let settings = current_settings();
    let scale = normalize_scale(settings.scale);
    let size = scaled_canvas_size(scale);
    let position = resolve_position(settings.position.as_ref(), size, mtm);

    let panel = create_panel(mtm, size, position);
    let image_view = create_image_view(mtm, scale);
    let menu_target = create_menu_target();
    let menu = create_menu(mtm, &menu_target);
    update_menu_states(&menu, &settings.current_action);

    unsafe {
        let _: () = msg_send![&*panel, setContentView: &*image_view];
        let _: () = msg_send![&*image_view, setMenu: &*menu];
        let _: () = msg_send![&*panel, orderFrontRegardless];
    }

    let monitor = install_mouse_monitor(&panel, &image_view, &menu);

    let timer = install_timer();

    UI.with(|slot| {
        *slot.borrow_mut() = Some(UiState {
            panel,
            image_view,
            menu,
            menu_target,
            timer,
            monitor,
            frames: HashMap::new(),
            current_action: String::new(),
            frame_index: 0,
            last_advance: Instant::now(),
            applied_scale: scale,
            root: runtime_root(),
        });
    });

    tick();
}

pub fn shutdown() {
    UI.with(|slot| {
        let Some(mut ui) = slot.borrow_mut().take() else {
            return;
        };

        unsafe {
            let _: () = msg_send![&*ui.timer, invalidate];
            if let Some(monitor) = ui.monitor.take() {
                let _: () = msg_send![NSEvent::class(), removeMonitor: &*monitor];
            }
            let _: () = msg_send![&*ui.panel, close];
        }

        // Dropping the retained AppKit objects happens here, on the main thread.
        let _ = &mut ui;
    });
}

fn create_panel(mtm: MainThreadMarker, size: f64, position: NSPoint) -> Retained<NSPanel> {
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size, size));
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        mtm.alloc::<NSPanel>(),
        rect,
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );

    let clear = NSColor::clearColor();
    unsafe {
        let _: () = msg_send![&*panel, setOpaque: Bool::NO];
        let _: () = msg_send![&*panel, setBackgroundColor: &*clear];
        let _: () = msg_send![&*panel, setHasShadow: Bool::NO];
        let _: () = msg_send![&*panel, setLevel: FLOATING_WINDOW_LEVEL];
        let _: () = msg_send![
            &*panel,
            setCollectionBehavior: NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle
        ];
        let _: () = msg_send![&*panel, setFloatingPanel: Bool::YES];
        let _: () = msg_send![&*panel, setBecomesKeyOnlyIfNeeded: Bool::YES];
        let _: () = msg_send![&*panel, setHidesOnDeactivate: Bool::NO];
        let _: () = msg_send![&*panel, setReleasedWhenClosed: Bool::NO];
        let _: () = msg_send![&*panel, setFrameOrigin: position];
    }

    panel
}

fn create_image_view(mtm: MainThreadMarker, scale: f64) -> Retained<PetImageView> {
    let inset = (CANVAS_SIZE - PET_SIZE) / 2.0 * scale;
    let frame = NSRect::new(
        NSPoint::new(inset, inset),
        NSSize::new(PET_SIZE * scale, PET_SIZE * scale),
    );

    let _ = mtm;
    let view: Retained<PetImageView> = unsafe {
        let pointer: *mut PetImageView = msg_send![PetImageView::class(), alloc];
        let pointer: *mut PetImageView = msg_send![pointer, initWithFrame: frame];
        Retained::from_raw(pointer).expect("failed to create PetImageView")
    };

    unsafe {
        // NSImageScaleProportionallyUpOrDown = 3, NSImageAlignCenter = 0.
        let _: () = msg_send![&*view, setImageScaling: 3usize];
        let _: () = msg_send![&*view, setImageAlignment: 0usize];
        let _: () = msg_send![&*view, setEditable: Bool::NO];
        let _: () = msg_send![&*view, setAnimates: Bool::NO];
    }

    view
}

fn create_menu_target() -> Retained<PetMenuTarget> {
    unsafe {
        let pointer: *mut PetMenuTarget = msg_send![PetMenuTarget::class(), alloc];
        let pointer: *mut PetMenuTarget = msg_send![pointer, init];
        Retained::from_raw(pointer).expect("failed to create menu target")
    }
}

fn create_menu(mtm: MainThreadMarker, target: &PetMenuTarget) -> Retained<NSMenu> {
    let empty = NSString::from_str("");
    let menu = NSMenu::initWithTitle(mtm.alloc::<NSMenu>(), &empty);

    for (action, label) in ACTIONS {
        let title = NSString::from_str(label);
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc::<NSMenuItem>(),
                &title,
                Some(sel!(selectAction:)),
                &empty,
            )
        };
        let represented = NSString::from_str(action);

        unsafe {
            let _: () = msg_send![&*item, setTarget: target];
            let _: () = msg_send![&*item, setRepresentedObject: &*represented];
            let _: () = msg_send![&*menu, addItem: &*item];
        }
    }

    menu
}

fn represented_action(item: &NSMenuItem) -> Option<String> {
    let object: *mut AnyObject = unsafe { msg_send![item, representedObject] };
    if object.is_null() {
        return None;
    }

    let object = unsafe { Retained::retain(object) }?;
    object
        .downcast::<NSString>()
        .ok()
        .map(|value| value.to_string())
}

fn update_menu_states(menu: &NSMenu, action: &str) {
    let count: isize = unsafe { msg_send![menu, numberOfItems] };
    for index in 0..count {
        let item: *mut NSMenuItem = unsafe { msg_send![menu, itemAtIndex: index] };
        if item.is_null() {
            continue;
        }
        let item = unsafe { &*item };
        let state = if represented_action(item).as_deref() == Some(action) {
            1isize
        } else {
            0isize
        };
        let _: () = unsafe { msg_send![item, setState: state] };
    }
}

fn install_mouse_monitor(
    panel: &Retained<NSPanel>,
    image_view: &Retained<PetImageView>,
    menu: &Retained<NSMenu>,
) -> Option<Retained<AnyObject>> {
    let panel = panel.clone();
    let image_view = image_view.clone();
    let menu = menu.clone();

    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let event = unsafe { event.as_ref() };
        let event_window: *mut AnyObject = unsafe { msg_send![event, window] };
        if event_window.is_null() || event_window as *const NSPanel != Retained::as_ptr(&panel) {
            return event as *const NSEvent as *mut NSEvent;
        }

        match event.r#type() {
            NSEventType::LeftMouseDown => {
                let _: () = unsafe { msg_send![&*panel, performWindowDragWithEvent: event] };
                save_position(&panel);
                std::ptr::null_mut()
            }
            NSEventType::RightMouseDown => {
                let _: () = unsafe {
                    msg_send![
                        NSMenu::class(),
                        popUpContextMenu: &*menu,
                        withEvent: event,
                        forView: &*image_view
                    ]
                };
                std::ptr::null_mut()
            }
            _ => event as *const NSEvent as *mut NSEvent,
        }
    });

    let monitor: *mut AnyObject = unsafe {
        msg_send![
            NSEvent::class(),
            addLocalMonitorForEventsMatchingMask: NSEventMask::LeftMouseDown
                | NSEventMask::RightMouseDown,
            handler: &*block
        ]
    };

    unsafe { Retained::from_raw(monitor) }
}

fn install_timer() -> Retained<NSTimer> {
    let block = RcBlock::new(move |_timer: NonNull<NSTimer>| {
        tick();
    });

    let timer: Retained<NSTimer> = unsafe {
        let pointer: *mut NSTimer = msg_send![
            NSTimer::class(),
            timerWithTimeInterval: 0.1f64,
            repeats: Bool::YES,
            block: &*block
        ];
        Retained::from_raw(pointer).expect("failed to create NSTimer")
    };

    let run_loop = objc2_foundation::NSRunLoop::mainRunLoop();
    let mode = NSString::from_str(COMMON_RUN_LOOP_MODE);
    unsafe {
        let _: () = msg_send![&*run_loop, addTimer: &*timer, forMode: &*mode];
    }

    timer
}

fn tick() {
    let (action, scale) = runtime_action_scale();
    let reload_root = take_reload_request();

    UI.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else {
            return;
        };
        let Some(ui) = slot.as_mut() else {
            return;
        };

        if let Some(root) = reload_root {
            ui.frames.clear();
            ui.root = root;
            ui.current_action.clear();
        }

        if (scale - ui.applied_scale).abs() > f64::EPSILON {
            apply_scale(ui, scale);
        }

        if ui.current_action != action {
            ui.current_action = action.clone();
            ui.frame_index = 0;
            ui.last_advance = Instant::now();
            update_menu_states(&ui.menu, &action);
        }

        ensure_frames(ui, &action);

        let frame_count = ui
            .frames
            .get(&action)
            .map(|frames| frames.len())
            .unwrap_or(0);

        if frame_count > 0
            && ui.last_advance.elapsed() >= Duration::from_millis(frame_interval_ms(&action))
        {
            if is_looping(&action) {
                ui.frame_index = (ui.frame_index + 1) % frame_count;
            } else {
                ui.frame_index = (ui.frame_index + 1).min(frame_count - 1);
            }
            ui.last_advance = Instant::now();
        }

        update_image(ui);
    });
}

fn ensure_frames(ui: &mut UiState, action: &str) {
    if ui.frames.contains_key(action) {
        return;
    }

    match load_frames(&ui.root, action) {
        Ok(frames) => {
            ui.frames.insert(action.to_string(), frames);
        }
        Err(err) => {
            emit_error(&err);
            // Remember the failure so we do not retry on every tick.
            ui.frames.insert(action.to_string(), Vec::new());
        }
    }
}

fn load_frames(root: &Path, action: &str) -> Result<Vec<Retained<NSImage>>, String> {
    let paths = scan_action_frames(root, action)?;
    if paths.len() < MIN_FRAMES_PER_ACTION {
        return Err(format!(
            "{}/{} 至少需要 {} 帧，当前只有 {} 帧",
            root.display(),
            action,
            MIN_FRAMES_PER_ACTION,
            paths.len()
        ));
    }

    let _mtm = MainThreadMarker::new().ok_or_else(|| "帧图加载必须发生在主线程".to_string())?;
    let mut images = Vec::with_capacity(paths.len());

    for path in paths {
        let ns_path = NSString::from_str(&path.to_string_lossy());
        let image = NSImage::initWithContentsOfFile(NSImage::alloc(), &ns_path);

        match image {
            Some(image) => images.push(image),
            None => return Err(format!("无法读取帧图：{}", path.display())),
        }
    }

    Ok(images)
}

fn update_image(ui: &UiState) {
    let image = ui
        .frames
        .get(&ui.current_action)
        .and_then(|frames| {
            if frames.is_empty() {
                None
            } else {
                frames.get(ui.frame_index.min(frames.len() - 1))
            }
        })
        .map(|image| Retained::as_ptr(image) as *mut NSImage)
        .unwrap_or(std::ptr::null_mut());

    unsafe {
        let _: () = msg_send![&*ui.image_view, setImage: image];
    }
}

fn apply_scale(ui: &mut UiState, scale: f64) {
    let size = scaled_canvas_size(scale);
    let inset = (CANVAS_SIZE - PET_SIZE) / 2.0 * scale;
    let current: NSRect = unsafe { msg_send![&*ui.panel, frame] };
    let frame = NSRect::new(
        NSPoint::new(
            current.origin.x + (current.size.width - size) / 2.0,
            current.origin.y + (current.size.height - size) / 2.0,
        ),
        NSSize::new(size, size),
    );
    let image_frame = NSRect::new(
        NSPoint::new(inset, inset),
        NSSize::new(PET_SIZE * scale, PET_SIZE * scale),
    );

    unsafe {
        let _: () = msg_send![&*ui.panel, setFrame: frame, display: Bool::YES];
        let _: () = msg_send![&*ui.image_view, setFrame: image_frame];
    }
    ui.applied_scale = scale;
}

fn handle_menu_action(action: &str) {
    if let Err(err) = set_action(action) {
        eprintln!("failed to set native pet action: {err}");
        return;
    }
    if let Err(err) = persist_runtime_settings() {
        eprintln!("failed to persist native pet settings: {err}");
    }
    UI.with(|slot| {
        if let Ok(slot) = slot.try_borrow() {
            if let Some(ui) = slot.as_ref() {
                update_menu_states(&ui.menu, action);
            }
        }
    });
    if let Some(app) = super::app_handle() {
        let _ = app.emit("native-pet-action-changed", action);
    }
    tick();
}

fn save_position(panel: &NSPanel) {
    let frame: NSRect = unsafe { msg_send![panel, frame] };
    update_position(PetPosition {
        x: frame.origin.x,
        y: frame.origin.y,
        screen: None,
    });
    if let Err(err) = persist_runtime_settings() {
        eprintln!("failed to persist native pet position: {err}");
    }
}

fn resolve_position(saved: Option<&PetPosition>, size: f64, mtm: MainThreadMarker) -> NSPoint {
    if let Some(position) = saved {
        if position.x.is_finite() && position.y.is_finite() {
            let rect = NSRect::new(
                NSPoint::new(position.x, position.y),
                NSSize::new(size, size),
            );
            if intersects_any_screen(rect, mtm) {
                return NSPoint::new(position.x, position.y);
            }
        }
    }

    default_position(size, mtm)
}

fn default_position(size: f64, mtm: MainThreadMarker) -> NSPoint {
    if let Some(screen) = NSScreen::mainScreen(mtm) {
        let visible = screen.visibleFrame();
        NSPoint::new(
            visible.origin.x + visible.size.width - size - 40.0,
            visible.origin.y + 40.0,
        )
    } else {
        NSPoint::new(40.0, 40.0)
    }
}

fn intersects_any_screen(rect: NSRect, mtm: MainThreadMarker) -> bool {
    NSScreen::screens(mtm).iter().any(|screen| {
        let visible = screen.visibleFrame();
        rect.origin.x < visible.origin.x + visible.size.width
            && rect.origin.x + rect.size.width > visible.origin.x
            && rect.origin.y < visible.origin.y + visible.size.height
            && rect.origin.y + rect.size.height > visible.origin.y
    })
}
