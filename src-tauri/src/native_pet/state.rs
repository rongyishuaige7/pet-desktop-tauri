use serde::{Deserialize, Serialize};

/// The user's display intent. `visible` is the platform's actual result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VisibilityMode {
    Shown,
    Hidden,
    Snoozed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MotionPreference {
    System,
    Reduce,
}

impl Default for MotionPreference {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Absent,
    Loading,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InteractionKind {
    Pet,
    Greet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InteractionReason {
    Cooldown,
    Hidden,
    Paused,
    NotReady,
    StalePet,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreferencesRequest {
    Show,
    Hide,
    Snooze,
    SetAnimationPaused { value: bool },
    SetAutonomous { value: bool },
    SetScale { value: f64 },
    SetClickThrough { value: bool },
    SetMotionPreference { value: MotionPreference },
    SetAutostart { value: bool },
    ResetPosition,
}

impl PreferencesRequest {
    /// Stable operation name used for operation-level errors and retry matching.
    pub fn operation(&self) -> &'static str {
        match self {
            Self::Show => "show",
            Self::Hide => "hide",
            Self::Snooze => "snooze",
            Self::SetAnimationPaused { .. } => "setAnimationPaused",
            Self::SetAutonomous { .. } => "setAutonomous",
            Self::SetScale { .. } => "setScale",
            Self::SetClickThrough { .. } => "setClickThrough",
            Self::SetMotionPreference { .. } => "setMotionPreference",
            Self::SetAutostart { .. } => "setAutostart",
            Self::ResetPosition => "resetPosition",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub id: String,
    pub operation: String,
    /// Sanitised code only. User-facing copy is mapped by the interface.
    pub code: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartState {
    pub enabled: bool,
    pub pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub native_window: bool,
    pub tap_feedback: bool,
    pub click_through: bool,
    pub reset_position: bool,
    pub autostart: bool,
    pub system_reduced_motion: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePetState {
    /// Generated per process start; a new value invalidates old revisions.
    pub session_id: String,
    /// Monotonic for every visible control change in this process.
    pub revision: u64,
    pub pet_id: Option<String>,
    pub pet_name: Option<String>,
    pub availability: Availability,
    pub visibility_mode: VisibilityMode,
    pub snooze_until_ms: Option<i64>,
    pub visible: bool,
    pub action: String,
    pub action_revision: u64,
    pub animation_paused: bool,
    pub autonomous: bool,
    pub motion_preference: MotionPreference,
    pub system_reduced_motion: Option<bool>,
    pub effective_paused: bool,
    pub effective_autonomous: bool,
    pub scale: f64,
    pub click_through: bool,
    pub pending: bool,
    pub autostart: AutostartState,
    pub last_operation_error: Option<OperationError>,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionResult {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<InteractionReason>,
    pub state: NativePetState,
}

/// Snooze longer than a week is treated as a corrupt timestamp.
pub const MAX_SNOOZE_AHEAD_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const SNOOZE_DURATION_MS: i64 = 60 * 60 * 1000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

pub fn valid_snooze_until(until: i64, now: i64) -> bool {
    until > 0 && until <= now.saturating_add(MAX_SNOOZE_AHEAD_MS)
}

/// Reduced motion is active when the user asked for it, or when the platform
/// reports the system setting and the user kept following the system.
pub fn reduced_motion_active(preference: MotionPreference, system: Option<bool>) -> bool {
    match preference {
        MotionPreference::Reduce => true,
        MotionPreference::System => system == Some(true),
    }
}

pub fn effective_paused(user_paused: bool, reduced_motion: bool) -> bool {
    user_paused || reduced_motion
}

pub fn effective_autonomous(
    autonomous: bool,
    paused: bool,
    visible: bool,
    availability: Availability,
) -> bool {
    autonomous && !paused && visible && availability == Availability::Ready
}

/// Pure decision order shared by the native service and its tests.
pub fn interaction_rejection(
    pet_matches: bool,
    visible: bool,
    availability: Availability,
    user_paused: bool,
    cooldown_active: bool,
) -> Option<InteractionReason> {
    if !pet_matches {
        return Some(InteractionReason::StalePet);
    }
    if !visible {
        return Some(InteractionReason::Hidden);
    }
    if availability != Availability::Ready {
        return Some(InteractionReason::NotReady);
    }
    if user_paused {
        return Some(InteractionReason::Paused);
    }
    if cooldown_active {
        return Some(InteractionReason::Cooldown);
    }
    None
}

pub fn action_for_interaction(kind: InteractionKind) -> &'static str {
    match kind {
        InteractionKind::Pet => "happy",
        InteractionKind::Greet => "jump",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduced_motion_follows_system_until_user_overrides() {
        assert!(!reduced_motion_active(MotionPreference::System, None));
        assert!(!reduced_motion_active(MotionPreference::System, Some(false)));
        assert!(reduced_motion_active(MotionPreference::System, Some(true)));
        assert!(reduced_motion_active(MotionPreference::Reduce, None));
        assert!(reduced_motion_active(MotionPreference::Reduce, Some(false)));
    }

    #[test]
    fn effective_state_composes_user_preferences() {
        assert!(effective_paused(false, true));
        assert!(effective_paused(true, false));
        assert!(!effective_paused(false, false));
        assert!(effective_autonomous(
            true,
            false,
            true,
            Availability::Ready
        ));
        assert!(!effective_autonomous(
            true,
            true,
            true,
            Availability::Ready
        ));
        assert!(!effective_autonomous(
            true,
            false,
            false,
            Availability::Ready
        ));
        assert!(!effective_autonomous(
            true,
            false,
            true,
            Availability::Loading
        ));
    }

    #[test]
    fn interaction_rejection_uses_a_stable_order() {
        assert_eq!(
            interaction_rejection(false, false, Availability::Error, true, true),
            Some(InteractionReason::StalePet)
        );
        assert_eq!(
            interaction_rejection(true, false, Availability::Error, true, true),
            Some(InteractionReason::Hidden)
        );
        assert_eq!(
            interaction_rejection(true, true, Availability::Loading, true, true),
            Some(InteractionReason::NotReady)
        );
        assert_eq!(
            interaction_rejection(true, true, Availability::Ready, true, true),
            Some(InteractionReason::Paused)
        );
        assert_eq!(
            interaction_rejection(true, true, Availability::Ready, false, true),
            Some(InteractionReason::Cooldown)
        );
        assert_eq!(
            interaction_rejection(true, true, Availability::Ready, false, false),
            None
        );
    }

    #[test]
    fn snooze_timestamps_are_bounded() {
        let now = 1_700_000_000_000;
        assert!(valid_snooze_until(now + SNOOZE_DURATION_MS, now));
        // A past timestamp is structurally valid; the normalizer expires it.
        assert!(valid_snooze_until(now - 1, now));
        assert!(!valid_snooze_until(0, now));
        assert!(!valid_snooze_until(now + MAX_SNOOZE_AHEAD_MS + 1, now));
    }

    #[test]
    fn interaction_actions_are_the_existing_one_shots() {
        assert_eq!(action_for_interaction(InteractionKind::Pet), "happy");
        assert_eq!(action_for_interaction(InteractionKind::Greet), "jump");
    }

    #[test]
    fn preferences_deserialize_from_the_frontend_contract() {
        let show: PreferencesRequest = serde_json::from_str(r#"{"kind":"show"}"#).unwrap();
        assert_eq!(show.operation(), "show");
        let paused: PreferencesRequest =
            serde_json::from_str(r#"{"kind":"setAnimationPaused","value":true}"#).unwrap();
        assert!(matches!(
            paused,
            PreferencesRequest::SetAnimationPaused { value: true }
        ));
        let motion: PreferencesRequest =
            serde_json::from_str(r#"{"kind":"setMotionPreference","value":"reduce"}"#).unwrap();
        assert!(matches!(
            motion,
            PreferencesRequest::SetMotionPreference {
                value: MotionPreference::Reduce
            }
        ));
    }
}
