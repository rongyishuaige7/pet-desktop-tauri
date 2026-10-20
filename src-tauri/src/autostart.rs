#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;

#[cfg(target_os = "macos")]
const LAUNCH_AGENT_LABEL: &str = "local.pet.desktop.sticker";

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
    })
}

#[cfg(target_os = "linux")]
fn autostart_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".config/autostart")
            .join("desktop-sticker-pet.desktop")
    })
}

#[cfg(target_os = "macos")]
pub fn is_enabled() -> bool {
    launch_agent_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
pub fn is_enabled() -> bool {
    autostart_path().map(|path| path.exists()).unwrap_or(false)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = launch_agent_path().ok_or_else(|| "无法获取 HOME 目录".to_string())?;

    if !enabled {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|err| format!("移除开机自启配置失败 {}：{err}", path.display()))?;
        }
        return Ok(());
    }

    let executable =
        std::env::current_exe().map_err(|err| format!("获取应用可执行文件路径失败：{err}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建 LaunchAgents 目录失败 {}：{err}", parent.display()))?;
    }
    std::fs::write(&path, launch_agent_plist(&executable))
        .map_err(|err| format!("写入开机自启配置失败 {}：{err}", path.display()))
}

#[cfg(target_os = "linux")]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = autostart_path().ok_or_else(|| "无法获取 HOME 目录".to_string())?;

    if !enabled {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|err| format!("移除开机自启配置失败 {}：{err}", path.display()))?;
        }
        return Ok(());
    }

    let executable =
        std::env::current_exe().map_err(|err| format!("获取应用可执行文件路径失败：{err}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建 autostart 目录失败 {}：{err}", parent.display()))?;
    }
    let contents = format!(
        "[Desktop Entry]\nType=Application\nName=桌面贴贴宠物\nExec=\"{}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        executable.display()
    );
    std::fs::write(&path, contents)
        .map_err(|err| format!("写入开机自启配置失败 {}：{err}", path.display()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn set_enabled(_enabled: bool) -> Result<(), String> {
    Err("当前平台暂不支持开机自启".to_string())
}

#[cfg(target_os = "macos")]
fn launch_agent_plist(executable: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{executable}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
"#,
        label = LAUNCH_AGENT_LABEL,
        executable = xml_escape(&executable.to_string_lossy()),
    )
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn launch_agent_escapes_paths() {
        let plist = launch_agent_plist(Path::new("/tmp/a&b<pet>.app"));
        assert!(plist.contains("/tmp/a&amp;b&lt;pet&gt;.app"));
        assert!(plist.contains("local.pet.desktop.sticker"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
    }
}
