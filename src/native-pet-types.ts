import type { PetAction } from "./types";

export type VisibilityMode = "shown" | "hidden" | "snoozed";
export type SnoozeMinutes = 15 | 30 | 60;
export type MotionPreference = "system" | "reduce";
export type Availability = "absent" | "loading" | "ready" | "error";
export type InteractionKind = "pet" | "greet";
export type InteractionReason = "cooldown" | "hidden" | "paused" | "notReady" | "stalePet";

export interface OperationError {
  id: string;
  operation: string;
  /** Sanitised code only; user-facing copy lives in the interface. */
  code: string;
  recoverable: boolean;
}

export interface NativePetCapabilities {
  nativeWindow: boolean;
  tapFeedback: boolean;
  clickThrough: boolean;
  resetPosition: boolean;
  autostart: boolean;
  systemReducedMotion: boolean;
}

export interface NativePetState {
  sessionId: string;
  revision: number;
  petId: string | null;
  petName: string | null;
  availability: Availability;
  visibilityMode: VisibilityMode;
  snoozeUntilMs: number | null;
  visible: boolean;
  action: PetAction;
  actionRevision: number;
  animationPaused: boolean;
  autonomous: boolean;
  motionPreference: MotionPreference;
  systemReducedMotion: boolean | null;
  effectivePaused: boolean;
  effectiveAutonomous: boolean;
  scale: number;
  clickThrough: boolean;
  pending: boolean;
  autostart: { enabled: boolean; pending: boolean };
  lastOperationError: OperationError | null;
  capabilities: NativePetCapabilities;
}

export interface InteractionResult {
  accepted: boolean;
  reason?: InteractionReason;
  state: NativePetState;
}

/** The native snapshot a late retry was prepared against. */
export interface NativeStateVersion {
  sessionId: string;
  revision: number;
}

export type PreferenceRequest =
  | { kind: "show"; expectedPetId?: string; expectedState?: NativeStateVersion }
  | { kind: "hide" }
  | { kind: "snooze"; durationMinutes?: SnoozeMinutes; expectedPetId?: string }
  | { kind: "setAnimationPaused"; value: boolean }
  | { kind: "setAutonomous"; value: boolean }
  | { kind: "setScale"; value: number }
  | { kind: "setClickThrough"; value: boolean }
  | { kind: "setMotionPreference"; value: MotionPreference }
  | { kind: "setAutostart"; value: boolean }
  | { kind: "resetPosition"; expectedPetId?: string };

export function preferenceOperation(request: PreferenceRequest): string {
  return request.kind;
}
