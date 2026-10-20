use tauri::AppHandle;

pub fn spawn_window(_app: AppHandle) {
    eprintln!("native pet window is not implemented on this platform");
}

pub fn shutdown() {}
