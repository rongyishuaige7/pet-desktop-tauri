import type { PetAction, PetProfile } from "./types";
import type {
  InteractionKind,
  InteractionReason,
  NativePetState,
  PreferenceRequest,
  VisibilityMode
} from "./native-pet-types";

export const WEB_SESSION_ID = "web-demo";
export const SNOOZE_DURATION_MS = 60 * 60 * 1000;

/** Newest event wins; a different session id always replaces an older process. */
export function mergeStateEvent(
  current: NativePetState | null,
  incoming: NativePetState
): NativePetState {
  if (!current) return incoming;
  if (incoming.sessionId !== current.sessionId) return incoming;
  return incoming.revision >= current.revision ? incoming : current;
}

/**
 * Reconciles the first snapshot with events that arrived while it was loading.
 * Events from a later process session beat the snapshot; within one session the
 * highest revision wins.
 */
export function pickNewestState(
  snapshot: NativePetState,
  buffered: NativePetState[]
): NativePetState {
  if (buffered.length === 0) return snapshot;
  const last = buffered[buffered.length - 1];
  const candidates =
    last.sessionId === snapshot.sessionId
      ? [...buffered, snapshot]
      : buffered.filter((event) => event.sessionId === last.sessionId);
  return candidates.reduce((newest, candidate) =>
    candidate.revision >= newest.revision ? candidate : newest
  );
}

function reducedMotionActive(state: Pick<NativePetState, "motionPreference" | "systemReducedMotion">) {
  return (
    state.motionPreference === "reduce" ||
    (state.motionPreference === "system" && state.systemReducedMotion === true)
  );
}

function recompute(state: NativePetState): NativePetState {
  const paused = state.animationPaused || reducedMotionActive(state);
  return {
    ...state,
    effectivePaused: paused,
    effectiveAutonomous:
      state.autonomous &&
      !paused &&
      state.visible &&
      state.availability === "ready"
  };
}

export interface WebCapabilities {
  systemReducedMotion?: boolean;
}

export function createWebState(
  pet: PetProfile | null,
  systemReducedMotion = false,
  autonomous = true
): NativePetState {
  const state: NativePetState = {
    sessionId: WEB_SESSION_ID,
    revision: 1,
    petId: pet?.id ?? null,
    petName: pet?.name ?? null,
    availability: pet ? "ready" : "absent",
    visibilityMode: "shown",
    snoozeUntilMs: null,
    visible: Boolean(pet),
    action: pet?.currentAction ?? "idle",
    actionRevision: 0,
    animationPaused: false,
    autonomous,
    motionPreference: "system",
    systemReducedMotion,
    effectivePaused: false,
    effectiveAutonomous: Boolean(pet),
    scale: 1,
    clickThrough: false,
    pending: false,
    autostart: { enabled: false, pending: false },
    lastOperationError: null,
    capabilities: {
      nativeWindow: false,
      tapFeedback: false,
      clickThrough: false,
      resetPosition: false,
      autostart: false,
      systemReducedMotion: true
    }
  };
  return recompute(state);
}

/** Keeps the demo state's pet fields aligned with IndexedDB without losing preferences. */
export function syncWebPet(
  state: NativePetState,
  pet: PetProfile | null,
  systemReducedMotion = state.systemReducedMotion ?? false
): NativePetState {
  const availability = pet ? "ready" : "absent";
  const action = pet?.currentAction ?? "idle";
  const actionChanged = action !== state.action;
  const next: NativePetState = {
    ...state,
    revision: state.revision + 1,
    petId: pet?.id ?? null,
    petName: pet?.name ?? null,
    availability,
    action,
    actionRevision: state.actionRevision + (actionChanged ? 1 : 0),
    systemReducedMotion,
    visible: Boolean(pet) && state.visibilityMode === "shown"
  };
  return recompute(next);
}

export function applyWebPreference(
  state: NativePetState,
  request: PreferenceRequest,
  now = Date.now()
): NativePetState {
  let next = state;
  switch (request.kind) {
    case "show":
      next = {
        ...state,
        visibilityMode: "shown",
        snoozeUntilMs: null,
        actionRevision: state.actionRevision + 1
      };
      break;
    case "hide":
      next = { ...state, visibilityMode: "hidden", snoozeUntilMs: null };
      break;
    case "snooze":
      next = {
        ...state,
        visibilityMode: "snoozed",
        snoozeUntilMs: now + SNOOZE_DURATION_MS
      };
      break;
    case "setAnimationPaused":
      next = { ...state, animationPaused: request.value };
      break;
    case "setAutonomous":
      next = { ...state, autonomous: request.value };
      break;
    case "setScale":
      next = {
        ...state,
        scale: Math.min(1.5, Math.max(0.5, Number.isFinite(request.value) ? request.value : 1))
      };
      break;
    case "setMotionPreference":
      next = { ...state, motionPreference: request.value };
      break;
    // The browser has no system configuration to change.
    case "setClickThrough":
    case "setAutostart":
    case "resetPosition":
      return state;
  }

  next = {
    ...next,
    revision: state.revision + 1,
    pending: false,
    visible: Boolean(next.petId) && next.visibilityMode === "shown"
  };
  return recompute(next);
}

/** Returns the same object when nothing expired. */
export function expireWebSnooze(state: NativePetState, now = Date.now()): NativePetState {
  if (state.visibilityMode !== "snoozed") return state;
  if (state.snoozeUntilMs === null || now < state.snoozeUntilMs) return state;
  const next: NativePetState = {
    ...state,
    revision: state.revision + 1,
    visibilityMode: "shown",
    snoozeUntilMs: null,
    visible: Boolean(state.petId),
    actionRevision: state.actionRevision + 1
  };
  return recompute(next);
}

export interface WebInteraction {
  state: NativePetState;
  accepted: boolean;
  reason?: InteractionReason;
  lastInteractionMs: number;
}

export function webInteraction(
  state: NativePetState,
  kind: InteractionKind,
  lastInteractionMs: number,
  now = Date.now()
): WebInteraction {
  const petMatches = Boolean(state.petId);
  const cooldown = now - lastInteractionMs < 1500;
  const reason: InteractionReason | undefined = !petMatches
    ? "stalePet"
    : !state.visible
      ? "hidden"
      : state.availability !== "ready"
        ? "notReady"
        : state.animationPaused
          ? "paused"
          : cooldown
            ? "cooldown"
            : undefined;

  if (reason) return { state, accepted: false, reason, lastInteractionMs };

  const reduced = reducedMotionActive(state);
  const action: PetAction = kind === "pet" ? "happy" : "jump";
  const next: NativePetState = {
    ...state,
    revision: state.revision + 1,
    actionRevision: state.actionRevision + (reduced ? 0 : 1),
    action: reduced ? state.action : action
  };
  return {
    state: recompute(next),
    accepted: true,
    lastInteractionMs: now
  };
}

export function reducedMotion(state: NativePetState): boolean {
  return reducedMotionActive(state);
}

export function canInteract(state: NativePetState): boolean {
  return state.visible && state.availability === "ready" && !state.animationPaused;
}

export function formatSnoozeTime(untilMs: number): string {
  return new Date(untilMs).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function statusText(state: NativePetState): string {
  if (!state.petId && state.availability === "absent") return "等待领养";
  if (state.availability === "error") return "需要帮助";
  if (state.availability === "loading") return "正在准备";
  if (state.pending) return "正在同步";
  if (state.visibilityMode === "snoozed") {
    return state.snoozeUntilMs
      ? `休息中，${formatSnoozeTime(state.snoozeUntilMs)}回来`
      : "休息中，稍后回来";
  }
  if (state.visibilityMode === "hidden") return "已收起，随时可以叫回来";
  if (!state.visible) return "正在准备";
  if (state.animationPaused) return "安静陪着你 · 动画已暂停";
  if (reducedMotion(state)) return "安静陪着你 · 低动态";
  if (!state.autonomous) return "在桌面陪着你 · 固定姿态";
  return "正在桌面陪着你";
}

export function interactionHelp(state: NativePetState, webMode: boolean): string {
  if (state.availability === "error") return "先恢复素材，再和伙伴互动";
  if (state.visibilityMode !== "shown" || !state.visible) return "先唤回伙伴，互动不会替你唤醒它";
  if (state.animationPaused) return "先恢复动画，再和伙伴互动";
  if (reducedMotion(state)) return "低动态已开启，互动会用文字回应";
  return webMode
    ? "网页演示中，点击伙伴试试看"
    : "点击伙伴，或试着向它打个招呼";
}

export function visibilityActionLabel(mode: VisibilityMode): string {
  return mode === "shown" ? "暂时收起" : "立即唤回";
}
