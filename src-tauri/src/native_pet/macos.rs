use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::time::Instant;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, sel, ClassType, MainThreadMarker};
use objc2_app_kit::{
    NSBackingStoreType, NSColor, NSEvent, NSEventMask, NSEventType, NSMenu, NSMenuItem, NSPanel,
    NSScreen, NSView, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_core_foundation::{
    kCFBooleanTrue, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFBoolean,
    CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CFURLPathStyle, CFURL,
};
use objc2_core_graphics::CGImage;
use objc2_foundation::{
    NSActivityOptions, NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize, NSString, NSTimer,
};
use objc2_image_io::{
    kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceShouldCacheImmediately, kCGImageSourceThumbnailMaxPixelSize, CGImageSource,
};
use objc2_quartz_core::{CALayer, CATransaction};
use tauri::AppHandle;

use super::{
    current_settings, emit_error, mark_position_dirty, normalize_scale, persist_runtime_settings,
    runtime_action_scale, runtime_root, scaled_canvas_size, scan_action_frames, set_action,
    take_position_dirty_request, take_position_reset_request, take_reload_request, update_position,
    PetPosition, ACTIONS, CANVAS_SIZE, MIN_FRAMES_PER_ACTION, PET_SIZE,
};

const COMMON_RUN_LOOP_MODE: &str = "kCFRunLoopCommonModes";
const FLOATING_WINDOW_LEVEL: isize = 3;
const MAX_THUMBNAIL_PIXEL: i32 = 640;

struct Frame {
    image: CFRetained<CGImage>,
    mask: AlphaMask,
}

struct AlphaMask {
    width: usize,
    height: usize,
    data: Vec<u8>,
    aspect: f64,
}

impl AlphaMask {
    fn opaque() -> Self {
        Self {
            width: 1,
            height: 1,
            data: vec![255],
            aspect: 1.0,
        }
    }

    fn from_path(path: &Path) -> Self {
        let Ok(image) = super::frame_pack::read_frame(path) else {
            return Self::opaque();
        };
        let rgba = image.to_rgba8();
        let (source_width, source_height) = rgba.dimensions();
        if source_width == 0 || source_height == 0 {
            return Self::opaque();
        }

        let width = 128usize;
        let height = 128usize;
        let mut data = vec![0u8; width * height];
        for y in 0..height {
            let source_y = (y as u32 * source_height / height as u32).min(source_height - 1);
            for x in 0..width {
                let source_x = (x as u32 * source_width / width as u32).min(source_width - 1);
                data[y * width + x] = rgba.get_pixel(source_x, source_y)[3];
            }
        }

        Self {
            width,
            height,
            data,
            aspect: source_width as f64 / source_height as f64,
        }
    }

    fn sample(&self, x: f64, y: f64) -> bool {
        if self.width == 0 || self.height == 0 {
            return true;
        }
        let x = (x.clamp(0.0, 1.0) * (self.width - 1) as f64).round() as usize;
        let y = (y.clamp(0.0, 1.0) * (self.height - 1) as f64).round() as usize;
        self.data[y * self.width + x] > 8
    }
}

#[derive(Clone, Copy)]
struct DragState {
    start_mouse: NSPoint,
    start_origin: NSPoint,
    dragging: bool,
}

thread_local! {
    static UI: RefCell<Option<UiState>> = const { RefCell::new(None) };
    static DRAG_STATE: RefCell<Option<DragState>> = const { RefCell::new(None) };
}

#[allow(dead_code)]
struct UiState {
    panel: Retained<NSPanel>,
    pet_view: Retained<PetView>,
    layer: Retained<CALayer>,
    menu: Retained<NSMenu>,
    menu_target: Retained<PetMenuTarget>,
    timer: Retained<NSTimer>,
    click_through_timer: Retained<NSTimer>,
    monitor: Option<Retained<AnyObject>>,
    activity: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    frames: HashMap<String, Vec<Frame>>,
    current_action: String,
    ignores_mouse: bool,
    frame_index: usize,
    playback: super::playback::Playback,
    applied_visible: bool,
    applied_scale: f64,
    applied_backing_scale: f64,
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
    #[unsafe(super(NSView))]
    #[name = "PetView"]
    #[ivars = ()]
    struct PetView;

    impl PetView {
        // Without this, the first click on an inactive app's panel is consumed
        // by activation and never reaches our drag/menu handling.
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            let Some(window) = self.window() else {
                return;
            };
            let frame: NSRect = unsafe { msg_send![&*window, frame] };
            let start_mouse = NSEvent::mouseLocation();
            DRAG_STATE.with(|state| {
                *state.borrow_mut() = Some(DragState {
                    start_mouse,
                    start_origin: frame.origin,
                    dragging: false,
                });
            });
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, _event: &NSEvent) {
            let Some(window) = self.window() else {
                return;
            };
            let current = NSEvent::mouseLocation();
            DRAG_STATE.with(|state| {
                let mut state = state.borrow_mut();
                let Some(state) = state.as_mut() else {
                    return;
                };
                let dx = current.x - state.start_mouse.x;
                let dy = current.y - state.start_mouse.y;
                if !state.dragging && (dx.abs() > 3.0 || dy.abs() > 3.0) {
                    state.dragging = true;
                }
                if state.dragging {
                    let origin = NSPoint::new(state.start_origin.x + dx, state.start_origin.y + dy);
                    let _: () = unsafe { msg_send![&*window, setFrameOrigin: origin] };
                }
            });
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {
            let dragging = DRAG_STATE.with(|state| {
                state
                    .borrow_mut()
                    .take()
                    .map(|state| state.dragging)
                    .unwrap_or(false)
            });
            if dragging {
                mark_position_dirty();
            } else {
                handle_menu_action("happy");
            }
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
    let (pet_view, layer) = create_pet_view(mtm, scale);
    let menu_target = create_menu_target();
    let menu = create_menu(mtm, &menu_target);
    update_menu_states(&menu, &settings.current_action);

    unsafe {
        let _: () = msg_send![&*panel, setContentView: &*pet_view];
        let _: () = msg_send![&*pet_view, setMenu: &*menu];
        if settings.visible {
            let _: () = msg_send![&*panel, orderFrontRegardless];
        }
    }

    let monitor = install_mouse_monitor(&panel, &pet_view, &menu);
    let timer = install_timer();
    let click_through_timer = install_click_through_timer();
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &NSString::from_str("Desktop pet animation"),
    );

    UI.with(|slot| {
        *slot.borrow_mut() = Some(UiState {
            panel,
            pet_view,
            layer,
            menu,
            menu_target,
            timer,
            click_through_timer,
            monitor,
            activity,
            frames: HashMap::new(),
            current_action: String::new(),
            frame_index: 0,
            ignores_mouse: false,
            playback: super::playback::Playback::default(),
            applied_visible: settings.visible,
            applied_scale: scale,
            applied_backing_scale: 1.0,
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
            let _: () = msg_send![&*ui.click_through_timer, invalidate];
            if let Some(monitor) = ui.monitor.take() {
                let _: () = msg_send![NSEvent::class(), removeMonitor: &*monitor];
            }
            let frame: NSRect = msg_send![&*ui.panel, frame];
            update_position(PetPosition {
                x: frame.origin.x,
                y: frame.origin.y,
                screen: None,
            });
            let _ = persist_runtime_settings();
            NSProcessInfo::processInfo().endActivity(&ui.activity);
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

fn create_pet_view(mtm: MainThreadMarker, scale: f64) -> (Retained<PetView>, Retained<CALayer>) {
    let inset = (CANVAS_SIZE - PET_SIZE) / 2.0 * scale;
    let frame = NSRect::new(
        NSPoint::new(inset, inset),
        NSSize::new(PET_SIZE * scale, PET_SIZE * scale),
    );

    let _ = mtm;
    let view: Retained<PetView> = unsafe {
        let pointer: *mut PetView = msg_send![PetView::class(), alloc];
        let pointer: *mut PetView = msg_send![pointer, initWithFrame: frame];
        Retained::from_raw(pointer).expect("failed to create PetView")
    };

    view.setWantsLayer(true);
    let layer = view.layer().expect("failed to create pet layer");
    layer.setContentsScale(1.0);

    unsafe {
        let _: () = msg_send![&*layer, setContentsGravity: &*NSString::from_str("resizeAspect")];
        let _: () = msg_send![
            &*layer,
            setMagnificationFilter: &*NSString::from_str("linear")
        ];
        let _: () = msg_send![
            &*layer,
            setMinificationFilter: &*NSString::from_str("linear")
        ];
        let _: () = msg_send![&*layer, setOpaque: Bool::NO];
    }

    (view, layer)
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
    pet_view: &Retained<PetView>,
    menu: &Retained<NSMenu>,
) -> Option<Retained<AnyObject>> {
    let panel = panel.clone();
    let pet_view = pet_view.clone();
    let menu = menu.clone();

    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let event = unsafe { event.as_ref() };
        let event_window: *mut AnyObject = unsafe { msg_send![event, window] };
        if event_window.is_null() || event_window as *const NSPanel != Retained::as_ptr(&panel) {
            return event as *const NSEvent as *mut NSEvent;
        }

        match event.r#type() {
            NSEventType::RightMouseDown => {
                let _: () = unsafe {
                    msg_send![
                        NSMenu::class(),
                        popUpContextMenu: &*menu,
                        withEvent: event,
                        forView: &*pet_view
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
            addLocalMonitorForEventsMatchingMask: NSEventMask::RightMouseDown,
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
            timerWithTimeInterval: 0.016f64,
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

fn install_click_through_timer() -> Retained<NSTimer> {
    let block = RcBlock::new(move |_timer: NonNull<NSTimer>| {
        update_click_through();
    });

    let timer: Retained<NSTimer> = unsafe {
        let pointer: *mut NSTimer = msg_send![
            NSTimer::class(),
            timerWithTimeInterval: 0.03f64,
            repeats: Bool::YES,
            block: &*block
        ];
        Retained::from_raw(pointer).expect("failed to create click-through timer")
    };

    let run_loop = objc2_foundation::NSRunLoop::mainRunLoop();
    let mode = NSString::from_str(COMMON_RUN_LOOP_MODE);
    unsafe {
        let _: () = msg_send![&*run_loop, addTimer: &*timer, forMode: &*mode];
    }

    timer
}

fn update_click_through() {
    UI.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else {
            return;
        };
        let Some(ui) = slot.as_mut() else {
            return;
        };

        // Do not change hit testing while the user is dragging or clicking.
        if DRAG_STATE.with(|state| state.borrow().is_some()) {
            return;
        }

        let ignore = if super::click_through_enabled() {
            let mouse = NSEvent::mouseLocation();
            let window_frame: NSRect = unsafe { msg_send![&*ui.panel, frame] };
            !point_is_opaque(ui, mouse, window_frame)
        } else {
            false
        };

        if ignore != ui.ignores_mouse {
            let _: () = unsafe { msg_send![&*ui.panel, setIgnoresMouseEvents: ignore] };
            ui.ignores_mouse = ignore;
        }
    });
}

fn current_frame(ui: &UiState) -> Option<&Frame> {
    ui.frames.get(&ui.current_action).and_then(|frames| {
        if frames.is_empty() {
            None
        } else {
            frames.get(ui.frame_index.min(frames.len() - 1))
        }
    })
}

fn point_is_opaque(ui: &UiState, mouse: NSPoint, window_frame: NSRect) -> bool {
    if mouse.x < window_frame.origin.x
        || mouse.y < window_frame.origin.y
        || mouse.x >= window_frame.origin.x + window_frame.size.width
        || mouse.y >= window_frame.origin.y + window_frame.size.height
    {
        return false;
    }

    let scale = ui.applied_scale;
    let pet_size = PET_SIZE * scale;
    let inset = (CANVAS_SIZE - PET_SIZE) / 2.0 * scale;
    let local_x = mouse.x - window_frame.origin.x - inset;
    let local_y = mouse.y - window_frame.origin.y - inset;
    if local_x < 0.0 || local_y < 0.0 || local_x >= pet_size || local_y >= pet_size {
        return false;
    }

    let Some(frame) = current_frame(ui) else {
        return false;
    };
    let mask = &frame.mask;
    if mask.width == 0 || mask.height == 0 {
        return false;
    }

    let aspect = mask.aspect;
    let (draw_width, draw_height) = if aspect >= 1.0 {
        (pet_size, pet_size / aspect)
    } else {
        (pet_size * aspect, pet_size)
    };
    let offset_x = (pet_size - draw_width) / 2.0;
    let offset_y = (pet_size - draw_height) / 2.0;
    if local_x < offset_x
        || local_y < offset_y
        || local_x >= offset_x + draw_width
        || local_y >= offset_y + draw_height
    {
        return false;
    }

    let nx = (local_x - offset_x) / draw_width;
    let ny = 1.0 - (local_y - offset_y) / draw_height;
    mask.sample(nx, ny)
}

fn tick() {
    if super::maybe_auto_advance(Instant::now()).is_some() {
        super::emit_action_changed();
    }
    let (action, scale, revision) = runtime_action_scale();
    let reload_root = if super::visible() {
        take_reload_request()
    } else {
        None
    };
    let reset_position = take_position_reset_request();
    let mut finished: Option<&'static str> = None;

    UI.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else {
            return;
        };
        let Some(ui) = slot.as_mut() else {
            return;
        };

        let mut image_dirty = false;
        let visible = super::visible();
        if ui.applied_visible != visible {
            unsafe {
                if visible {
                    let _: () = msg_send![&*ui.panel, orderFrontRegardless];
                } else {
                    let _: () = msg_send![&*ui.panel, orderOut: std::ptr::null::<AnyObject>()];
                }
            }
            ui.applied_visible = visible;
        }
        if let Some(root) = reload_root {
            let prepared = ACTIONS
                .iter()
                .map(|(id, _)| load_frames(&root, id).map(|frames| (id.to_string(), frames)))
                .collect::<Result<HashMap<_, _>, _>>();
            match prepared {
                Ok(frames) => {
                    ui.frames = frames;
                    ui.root = root;
                    ui.current_action.clear();
                    image_dirty = true;
                }
                Err(error) => {
                    emit_error(&error);
                    return;
                }
            }
        }
        if !visible {
            return;
        }

        if reset_position {
            if let Some(mtm) = MainThreadMarker::new() {
                let position = default_position(scaled_canvas_size(ui.applied_scale), mtm);
                unsafe {
                    let _: () = msg_send![&*ui.panel, setFrameOrigin: position];
                }
            }
        }

        if take_position_dirty_request() {
            save_position(&ui.panel);
        }

        if (scale - ui.applied_scale).abs() > f64::EPSILON {
            apply_scale(ui, scale);
        }

        let backing_scale: f64 = unsafe { msg_send![&*ui.panel, backingScaleFactor] };
        if (backing_scale - ui.applied_backing_scale).abs() > f64::EPSILON {
            ui.layer.setContentsScale(backing_scale);
            ui.applied_backing_scale = backing_scale;
        }

        if ui.current_action != action {
            image_dirty = true;
            ui.current_action = action.clone();
            ui.frame_index = 0;

            update_menu_states(&ui.menu, &action);
        }

        ensure_frames(ui, &action);

        let frame_count = ui
            .frames
            .get(&action)
            .map(|frames| frames.len())
            .unwrap_or(0);

        let previous_frame = ui.frame_index;
        finished = ui.playback.tick(
            &action,
            revision,
            frame_count,
            super::animation_paused(),
            Instant::now(),
        );
        ui.frame_index = ui.playback.frame_index;

        if image_dirty || previous_frame != ui.frame_index {
            update_image(ui);
        }
    });

    if finished.is_some() {
        if super::return_to_idle().is_ok() {
            super::emit_action_changed();
        }
    }
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

fn load_frames(root: &Path, action: &str) -> Result<Vec<Frame>, String> {
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

    let mut images = Vec::with_capacity(paths.len());
    for path in paths {
        images.push(Frame {
            image: decode_image(&path)?,
            mask: AlphaMask::from_path(&path),
        });
    }

    Ok(images)
}

fn decode_image(path: &Path) -> Result<CFRetained<CGImage>, String> {
    let ns_path = NSString::from_str(&path.to_string_lossy());
    let cf_path: &CFString = unsafe { &*(&*ns_path as *const NSString as *const CFString) };
    let url = CFURL::with_file_system_path(
        None,
        Some(cf_path),
        CFURLPathStyle::CFURLPOSIXPathStyle,
        false,
    )
    .ok_or_else(|| format!("无法创建文件 URL：{}", path.display()))?;

    let source = unsafe { CGImageSource::with_url(&url, None) }
        .ok_or_else(|| format!("无法读取图片：{}", path.display()))?;

    let options = thumbnail_options();
    let image = unsafe { source.thumbnail_at_index(0, options.as_deref()) }
        .or_else(|| unsafe { source.image_at_index(0, None) })
        .ok_or_else(|| format!("无法解码图片：{}", path.display()))?;

    Ok(image)
}

fn thumbnail_options() -> Option<CFRetained<CFDictionary>> {
    unsafe {
        let max_pixel = CFNumber::new(
            None,
            CFNumberType::IntType,
            &MAX_THUMBNAIL_PIXEL as *const i32 as *const c_void,
        )?;
        let true_value = kCFBooleanTrue?;

        let keys = [
            kCGImageSourceCreateThumbnailFromImageAlways as *const CFString as *const c_void,
            kCGImageSourceThumbnailMaxPixelSize as *const CFString as *const c_void,
            kCGImageSourceCreateThumbnailWithTransform as *const CFString as *const c_void,
            kCGImageSourceShouldCacheImmediately as *const CFString as *const c_void,
        ];
        let values = [
            true_value as *const CFBoolean as *const c_void,
            CFRetained::as_ptr(&max_pixel).as_ptr() as *const c_void,
            true_value as *const CFBoolean as *const c_void,
            true_value as *const CFBoolean as *const c_void,
        ];

        CFDictionary::new(
            None,
            keys.as_ptr() as *mut *const c_void,
            values.as_ptr() as *mut *const c_void,
            4,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    }
}

fn update_image(ui: &UiState) {
    let image = ui.frames.get(&ui.current_action).and_then(|frames| {
        if frames.is_empty() {
            None
        } else {
            frames.get(ui.frame_index.min(frames.len() - 1))
        }
    });

    CATransaction::begin();
    CATransaction::setDisableActions(true);
    unsafe {
        match image {
            Some(frame) => {
                let pointer = CFRetained::as_ptr(&frame.image).as_ptr() as *const AnyObject;
                ui.layer.setContents(Some(&*pointer));
            }
            None => ui.layer.setContents(None),
        }
    }
    CATransaction::commit();
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
    let pet_frame = NSRect::new(
        NSPoint::new(inset, inset),
        NSSize::new(PET_SIZE * scale, PET_SIZE * scale),
    );

    unsafe {
        let _: () = msg_send![&*ui.panel, setFrame: frame, display: Bool::YES];
        let _: () = msg_send![&*ui.pet_view, setFrame: pet_frame];
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
    super::emit_action_changed();
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn alpha_mask_retains_original_aspect_ratio() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.png");
        image::DynamicImage::new_rgba8(400, 200)
            .save(&path)
            .unwrap();
        let mask = AlphaMask::from_path(&path);
        assert_eq!(mask.aspect, 2.0);
    }
}
