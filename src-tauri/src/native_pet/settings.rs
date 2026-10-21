use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::model::{normalize_action, normalize_frame_root, normalize_scale, SETTINGS_FILE_NAME};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPosition {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePetSettings {
    pub frame_root: String,
    pub scale: f64,
    pub current_action: String,
    #[serde(default = "default_autonomous")]
    pub visible: bool,
    #[serde(default = "default_autonomous")]
    pub autonomous: bool,
    #[serde(default = "default_click_through")]
    pub click_through: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<PetPosition>,
}

fn default_autonomous() -> bool {
    true
}

fn default_click_through() -> bool {
    true
}

impl Default for NativePetSettings {
    fn default() -> Self {
        Self {
            frame_root: "./frame-pack".to_string(),
            scale: 1.0,
            current_action: "idle".to_string(),
            visible: true,
            autonomous: true,
            click_through: true,
            position: None,
        }
    }
}

impl NativePetSettings {
    pub fn normalized(mut self) -> Self {
        self.frame_root = normalize_frame_root(Some(self.frame_root));
        self.scale = normalize_scale(self.scale);
        self.current_action = normalize_action(self.current_action);
        self.position = self
            .position
            .filter(|position| position.x.is_finite() && position.y.is_finite());
        self
    }
}

pub fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE_NAME))
        .map_err(|err| format!("获取应用配置目录失败：{err}"))
}

pub fn load_settings(app: &AppHandle) -> NativePetSettings {
    let path = match settings_file_path(app) {
        Ok(path) => path,
        Err(_) => return NativePetSettings::default(),
    };

    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return NativePetSettings::default(),
    };

    serde_json::from_slice::<NativePetSettings>(&bytes)
        .map(NativePetSettings::normalized)
        .unwrap_or_default()
}

pub fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建配置目录失败 {}：{err}", parent.display()))?;
    }

    let temp_path = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json"),
        std::process::id()
    ));

    if let Err(err) = std::fs::write(&temp_path, data) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("写入配置失败 {}：{err}", temp_path.display()));
    }

    std::fs::rename(&temp_path, path).map_err(|err| {
        let _ = std::fs::remove_file(&temp_path);
        format!("替换配置失败 {}：{err}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_invalid_settings() {
        let settings = NativePetSettings {
            frame_root: "  ".to_string(),
            scale: 9.0,
            current_action: "dance".to_string(),
            visible: true,
            autonomous: false,
            click_through: true,
            position: Some(PetPosition {
                x: f64::NAN,
                y: 10.0,
                screen: None,
            }),
        }
        .normalized();

        assert_eq!(settings.frame_root, "./frame-pack");
        assert_eq!(settings.scale, 1.5);
        assert_eq!(settings.current_action, "idle");
        assert!(settings.position.is_none());
    }

    #[test]
    fn writes_settings_atomically() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("native-pet-settings.json");

        write_atomic(&path, br#"{"scale":1.0}"#).expect("first write");
        write_atomic(&path, br#"{"scale":1.2}"#).expect("second write");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            r#"{"scale":1.2}"#
        );
    }
}
