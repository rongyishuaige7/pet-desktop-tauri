use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::model::{normalize_action, normalize_frame_root, normalize_scale, SETTINGS_FILE_NAME};
use super::state::{now_ms, valid_snooze_until, MotionPreference, VisibilityMode};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPosition {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsIssue {
    /// The stored snooze timestamp was unusable; the pet stays hidden.
    InvalidSnooze,
    /// The settings file could not be parsed; defaults are used.
    CorruptFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePetSettings {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub frame_root: String,
    pub scale: f64,
    pub current_action: String,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default = "default_true")]
    pub autonomous: bool,
    #[serde(default = "default_true")]
    pub click_through: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<PetPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility_mode: Option<VisibilityMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snooze_until_ms: Option<i64>,
    #[serde(default)]
    pub motion_preference: MotionPreference,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pet_id: Option<String>,
}

fn default_schema_version() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

impl Default for NativePetSettings {
    fn default() -> Self {
        Self {
            schema_version: 2,
            frame_root: "./frame-pack".to_string(),
            scale: 1.0,
            current_action: "idle".to_string(),
            visible: true,
            autonomous: true,
            click_through: true,
            position: None,
            visibility_mode: None,
            snooze_until_ms: None,
            motion_preference: MotionPreference::System,
            pet_id: None,
        }
    }
}

impl NativePetSettings {
    pub fn normalized(self) -> Self {
        self.normalized_with_issue(now_ms()).0
    }

    /// Migrates v1 files in place and repairs unusable snooze timestamps.
    ///
    /// `visible` stays a compatibility mirror: after normalization it can only
    /// be true when the intent is `shown`.
    pub fn normalized_with_issue(mut self, now: i64) -> (Self, Option<SettingsIssue>) {
        self.schema_version = 2;
        self.frame_root = normalize_frame_root(Some(self.frame_root));
        self.scale = normalize_scale(self.scale);
        self.current_action = normalize_action(self.current_action);
        self.position = self
            .position
            .filter(|position| position.x.is_finite() && position.y.is_finite());
        self.pet_id = self
            .pet_id
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty());

        let mut issue = None;
        let (mode, snooze) = match self.visibility_mode {
            Some(VisibilityMode::Shown) => (VisibilityMode::Shown, None),
            Some(VisibilityMode::Hidden) => (VisibilityMode::Hidden, None),
            Some(VisibilityMode::Snoozed) => match self.snooze_until_ms {
                Some(until) if valid_snooze_until(until, now) => {
                    if until <= now {
                        // The nap ended while the app was not running.
                        (VisibilityMode::Shown, None)
                    } else {
                        (VisibilityMode::Snoozed, Some(until))
                    }
                }
                _ => {
                    issue = Some(SettingsIssue::InvalidSnooze);
                    (VisibilityMode::Hidden, None)
                }
            },
            None => {
                // v1 files only had the visible mirror.
                let mode = if self.visible {
                    VisibilityMode::Shown
                } else {
                    VisibilityMode::Hidden
                };
                (mode, None)
            }
        };

        self.visibility_mode = Some(mode);
        self.snooze_until_ms = snooze;
        self.visible = self.visible && mode == VisibilityMode::Shown;
        (self, issue)
    }

    pub fn visibility_mode(&self) -> VisibilityMode {
        self.visibility_mode.unwrap_or(VisibilityMode::Hidden)
    }
}

pub fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE_NAME))
        .map_err(|err| format!("获取应用配置目录失败：{err}"))
}

pub fn load_settings_with_issue(app: &AppHandle) -> (NativePetSettings, Option<SettingsIssue>) {
    let path = match settings_file_path(app) {
        Ok(path) => path,
        Err(_) => return (NativePetSettings::default(), None),
    };

    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return (NativePetSettings::default(), None),
    };

    match serde_json::from_slice::<NativePetSettings>(&bytes) {
        Ok(settings) => settings.normalized_with_issue(now_ms()),
        Err(_) => (
            NativePetSettings::default(),
            Some(SettingsIssue::CorruptFile),
        ),
    }
}

#[allow(dead_code)]
pub fn load_settings(app: &AppHandle) -> NativePetSettings {
    load_settings_with_issue(app).0
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
    use crate::native_pet::state::SNOOZE_DURATION_MS;

    fn legacy(visible: bool) -> NativePetSettings {
        NativePetSettings {
            schema_version: 1,
            visible,
            visibility_mode: None,
            snooze_until_ms: None,
            ..Default::default()
        }
    }

    #[test]
    fn normalizes_invalid_settings() {
        let settings = NativePetSettings {
            schema_version: 1,
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
            visibility_mode: None,
            snooze_until_ms: None,
            motion_preference: MotionPreference::System,
            pet_id: Some("  ".into()),
        }
        .normalized();

        assert_eq!(settings.schema_version, 2);
        assert_eq!(settings.frame_root, "./frame-pack");
        assert_eq!(settings.scale, 1.5);
        assert_eq!(settings.current_action, "idle");
        assert!(settings.position.is_none());
        assert!(settings.pet_id.is_none());
        assert_eq!(settings.visibility_mode, Some(VisibilityMode::Shown));
    }

    #[test]
    fn migrates_legacy_visible_to_visibility_mode() {
        let shown = legacy(true).normalized();
        assert_eq!(shown.visibility_mode, Some(VisibilityMode::Shown));
        assert!(shown.visible);

        let hidden = legacy(false).normalized();
        assert_eq!(hidden.visibility_mode, Some(VisibilityMode::Hidden));
        assert!(!hidden.visible);
    }

    #[test]
    fn expired_snooze_becomes_shown_and_invalid_snooze_hides() {
        let now = 1_700_000_000_000;
        let expired = NativePetSettings {
            visibility_mode: Some(VisibilityMode::Snoozed),
            snooze_until_ms: Some(now - 1),
            visible: false,
            ..Default::default()
        }
        .normalized_with_issue(now);
        assert_eq!(expired.0.visibility_mode, Some(VisibilityMode::Shown));
        assert!(expired.0.snooze_until_ms.is_none());
        assert!(expired.1.is_none());

        let future = NativePetSettings {
            visibility_mode: Some(VisibilityMode::Snoozed),
            snooze_until_ms: Some(now + SNOOZE_DURATION_MS),
            visible: false,
            ..Default::default()
        }
        .normalized_with_issue(now);
        assert_eq!(future.0.visibility_mode, Some(VisibilityMode::Snoozed));
        assert_eq!(future.0.snooze_until_ms, Some(now + SNOOZE_DURATION_MS));

        let invalid = NativePetSettings {
            visibility_mode: Some(VisibilityMode::Snoozed),
            snooze_until_ms: None,
            visible: false,
            ..Default::default()
        }
        .normalized_with_issue(now);
        assert_eq!(invalid.0.visibility_mode, Some(VisibilityMode::Hidden));
        assert_eq!(invalid.1, Some(SettingsIssue::InvalidSnooze));
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
