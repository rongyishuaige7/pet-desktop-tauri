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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedState {
    pub session_id: String,
    pub revision: u64,
}

/// Optional execution-time guards for an operation that names one companion.
/// They are checked inside the serial control section before any mutation.
#[derive(Debug, Clone, Default)]
pub struct RequestTarget {
    pub expected_pet_id: Option<String>,
    pub expected_state: Option<ExpectedState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PreferencesRequest {
    Show {
        #[serde(default)]
        expected_pet_id: Option<String>,
        #[serde(default)]
        expected_state: Option<ExpectedState>,
    },
    Hide,
    Snooze {
        #[serde(default)]
        expected_pet_id: Option<String>,
    },
    SetAnimationPaused {
        value: bool,
    },
    SetAutonomous {
        value: bool,
    },
    SetScale {
        value: f64,
    },
    SetClickThrough {
        value: bool,
    },
    SetMotionPreference {
        value: MotionPreference,
    },
    SetAutostart {
        value: bool,
    },
    ResetPosition {
        #[serde(default)]
        expected_pet_id: Option<String>,
    },
}

impl PreferencesRequest {
    /// Stable operation name used for operation-level errors and retry matching.
    pub fn operation(&self) -> &'static str {
        match self {
            Self::Show { .. } => "show",
            Self::Hide => "hide",
            Self::Snooze { .. } => "snooze",
            Self::SetAnimationPaused { .. } => "setAnimationPaused",
            Self::SetAutonomous { .. } => "setAutonomous",
            Self::SetScale { .. } => "setScale",
            Self::SetClickThrough { .. } => "setClickThrough",
            Self::SetMotionPreference { .. } => "setMotionPreference",
            Self::SetAutostart { .. } => "setAutostart",
            Self::ResetPosition { .. } => "resetPosition",
        }
    }

    pub fn target(&self) -> RequestTarget {
        match self {
            Self::Show {
                expected_pet_id,
                expected_state,
            } => RequestTarget {
                expected_pet_id: expected_pet_id.clone(),
                expected_state: expected_state.clone(),
            },
            Self::Snooze { expected_pet_id } | Self::ResetPosition { expected_pet_id } => {
                RequestTarget {
                    expected_pet_id: expected_pet_id.clone(),
                    expected_state: None,
                }
            }
            _ => RequestTarget::default(),
        }
    }
}

/// A late operation must not act on a different companion or a newer native
/// snapshot. Returning a code lets the interface invalidate only that entry.
pub fn target_conflict(
    current_pet_id: Option<&str>,
    session_id: &str,
    revision: u64,
    target: &RequestTarget,
) -> Option<(String, String)> {
    if let Some(expected) = &target.expected_pet_id {
        if current_pet_id != Some(expected.as_str()) {
            return Some((
                "TARGET_CHANGED".to_string(),
                "当前伙伴已切换，未执行这次操作".to_string(),
            ));
        }
    }
    if let Some(expected) = &target.expected_state {
        if expected.session_id != session_id || expected.revision != revision {
            return Some((
                "STATE_CHANGED".to_string(),
                "伙伴状态已更新，未执行这次操作".to_string(),
            ));
        }
    }
    None
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
        assert!(!reduced_motion_active(
            MotionPreference::System,
            Some(false)
        ));
        assert!(reduced_motion_active(MotionPreference::System, Some(true)));
        assert!(reduced_motion_active(MotionPreference::Reduce, None));
        assert!(reduced_motion_active(MotionPreference::Reduce, Some(false)));
    }

    #[test]
    fn effective_state_composes_user_preferences() {
        assert!(effective_paused(false, true));
        assert!(effective_paused(true, false));
        assert!(!effective_paused(false, false));
        assert!(effective_autonomous(true, false, true, Availability::Ready));
        assert!(!effective_autonomous(true, true, true, Availability::Ready));
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

    #[test]
    fn target_checks_reject_a_different_pet_or_a_newer_snapshot() {
        let show: PreferencesRequest = serde_json::from_str(
            r#"{"kind":"show","expectedPetId":"pet-a","expectedState":{"sessionId":"s1","revision":7}}"#,
        )
        .unwrap();
        let target = show.target();
        assert_eq!(target.expected_pet_id.as_deref(), Some("pet-a"));
        assert_eq!(
            target.expected_state.as_ref().map(|state| state.revision),
            Some(7)
        );
        assert_eq!(target_conflict(Some("pet-a"), "s1", 7, &target), None);
        assert_eq!(
            target_conflict(Some("pet-b"), "s1", 7, &target)
                .expect("different pet")
                .0,
            "TARGET_CHANGED"
        );
        assert_eq!(
            target_conflict(Some("pet-a"), "s1", 8, &target)
                .expect("newer revision")
                .0,
            "STATE_CHANGED"
        );
        assert_eq!(
            target_conflict(Some("pet-a"), "s2", 7, &target)
                .expect("newer session")
                .0,
            "STATE_CHANGED"
        );
        assert_eq!(
            target_conflict(None, "s1", 7, &target)
                .expect("no current pet")
                .0,
            "TARGET_CHANGED"
        );
    }

    #[test]
    fn untargeted_and_targeted_requests_keep_their_existing_shape() {
        let snooze: PreferencesRequest = serde_json::from_str(r#"{"kind":"snooze"}"#).unwrap();
        assert_eq!(snooze.operation(), "snooze");
        assert_eq!(snooze.target().expected_pet_id, None);
        let reset: PreferencesRequest =
            serde_json::from_str(r#"{"kind":"resetPosition","expectedPetId":"pet-a"}"#).unwrap();
        assert_eq!(reset.target().expected_pet_id.as_deref(), Some("pet-a"));
        let hide: PreferencesRequest = serde_json::from_str(r#"{"kind":"hide"}"#).unwrap();
        assert_eq!(hide.target().expected_pet_id, None);
    }
}
