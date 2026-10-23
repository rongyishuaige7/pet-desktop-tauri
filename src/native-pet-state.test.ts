import { describe, expect, it } from "vitest";
import type { PetProfile } from "./types";
import type { NativePetState } from "./native-pet-types";
import {
  applyWebPreference,
  createWebState,
  expireWebSnooze,
  animationStatusText,
  autonomousStatusText,
  formatSnoozeTime,
  isSnoozeMinutes,
  mergeStateEvent,
  motionPreferenceStatusText,
  snoozeDurationMs,
  snoozeRemainingMinutes,
  pickNewestState,
  statusText,
  syncWebPet,
  webInteraction,
  canInteract,
  interactionHelp
} from "./native-pet-state";

function pet(overrides: Partial<PetProfile> = {}): PetProfile {
  return {
    id: "pet-a",
    name: "咕唧",
    species: "dog",
    style: "q-sticker",
    createdAt: "2026-10-21T00:00:00Z",
    sourceImage: "/frame-pack/idle/000.png",
    actions: { idle: [], sit: [], sleep: [], happy: [], walk: [], jump: [] },
    currentAction: "idle",
    actionStartedAt: "2026-10-21T00:00:00Z",
    scale: 1,
    ...overrides
  };
}

function state(overrides: Partial<NativePetState> = {}): NativePetState {
  return { ...createWebState(pet()), ...overrides };
}

describe("native state merging", () => {
  it("keeps the newest revision within one session", () => {
    const current = state({ revision: 4, action: "idle" });
    const stale: NativePetState = { ...current, revision: 3, action: "walk" };
    const fresh: NativePetState = { ...current, revision: 5, action: "sleep" };
    expect(mergeStateEvent(current, stale)).toBe(current);
    expect(mergeStateEvent(current, fresh)).toBe(fresh);
  });

  it("accepts a new process session regardless of revision", () => {
    const current = state({ revision: 99 });
    const restarted = { ...current, sessionId: "new-process", revision: 1 };
    expect(mergeStateEvent(current, restarted)).toBe(restarted);
  });

  it("prefers buffered events from a later session over the snapshot", () => {
    const snapshot = state({ revision: 10, sessionId: "old" });
    const event = { ...snapshot, sessionId: "new", revision: 1 };
    expect(pickNewestState(snapshot, [event])).toBe(event);
  });

  it("uses the highest buffered revision when the session matches", () => {
    const snapshot = state({ revision: 10 });
    const lower = { ...snapshot, revision: 11 };
    const higher = { ...snapshot, revision: 12 };
    expect(pickNewestState(snapshot, [lower, higher])).toBe(higher);
    expect(pickNewestState(snapshot, [])).toBe(snapshot);
  });
});

describe("web preference composition", () => {
  it("hides and snoozes without losing the pet", () => {
    const hidden = applyWebPreference(state(), { kind: "hide" }, 1_000);
    expect(hidden.visibilityMode).toBe("hidden");
    expect(hidden.visible).toBe(false);
    expect(hidden.petId).toBe("pet-a");
    expect(canInteract(hidden)).toBe(false);

    const snoozed = applyWebPreference(hidden, { kind: "snooze" }, 1_000);
    expect(snoozed.visibilityMode).toBe("snoozed");
    expect(snoozed.snoozeUntilMs).toBe(1_000 + 3_600_000);
    expect(statusText(snoozed)).toContain("休息中");
    expect(statusText(snoozed)).toContain(formatSnoozeTime(snoozed.snoozeUntilMs!));
  });

  it("expires a snooze once and returns the same object afterwards", () => {
    const snoozed = applyWebPreference(state(), { kind: "snooze" }, 1_000);
    const early = expireWebSnooze(snoozed, 1_000 + 100);
    expect(early).toBe(snoozed);
    const expired = expireWebSnooze(snoozed, snoozed.snoozeUntilMs!);
    expect(expired.visibilityMode).toBe("shown");
    expect(expired.visible).toBe(true);
    expect(expired.snoozeUntilMs).toBeNull();
    expect(expireWebSnooze(expired, 9_999_999)).toBe(expired);
  });

  it("composes reduced motion without overwriting the user's pause preference", () => {
    const reduced = applyWebPreference(
      state(),
      { kind: "setMotionPreference", value: "reduce" },
      1_000
    );
    expect(reduced.effectivePaused).toBe(true);
    expect(reduced.effectiveAutonomous).toBe(false);
    expect(reduced.animationPaused).toBe(false);
    expect(statusText(reduced)).toContain("低动态");
    expect(interactionHelp(reduced, false)).toContain("文字回应");

    const userPaused = applyWebPreference(reduced, { kind: "setAnimationPaused", value: true }, 1_000);
    const resumed = applyWebPreference(userPaused, { kind: "setMotionPreference", value: "system" }, 1_000);
    expect(resumed.animationPaused).toBe(true);
    expect(resumed.effectivePaused).toBe(true);
    expect(statusText(resumed)).toContain("动画已暂停");
  });

  it("shows the reduced-motion status when following the system", () => {
    const following = { ...state(), systemReducedMotion: true };
    expect(statusText(following)).toContain("低动态");
  });

  it("keeps scale inside the supported range", () => {
    expect(applyWebPreference(state(), { kind: "setScale", value: 9 }, 1).scale).toBe(1.5);
    expect(applyWebPreference(state(), { kind: "setScale", value: 0.1 }, 1).scale).toBe(0.5);
  });

  it("does not fake browser support for native-only settings", () => {
    const before = state();
    expect(applyWebPreference(before, { kind: "setClickThrough", value: true }, 1)).toBe(before);
    expect(applyWebPreference(before, { kind: "setAutostart", value: true }, 1)).toBe(before);
    expect(applyWebPreference(before, { kind: "resetPosition" }, 1)).toBe(before);
  });

  it("syncs the active profile while preserving visibility preferences", () => {
    const hidden = applyWebPreference(state(), { kind: "hide" }, 1_000);
    const synced = syncWebPet(hidden, pet({ name: "新名字", currentAction: "walk" }), false);
    expect(synced.petName).toBe("新名字");
    expect(synced.action).toBe("walk");
    expect(synced.visibilityMode).toBe("hidden");
    expect(synced.visible).toBe(false);
    const empty = syncWebPet(synced, null);
    expect(empty.petId).toBeNull();
    expect(empty.availability).toBe("absent");
    expect(statusText(empty)).toBe("等待领养");
  });
});

describe("web interactions", () => {
  it("accepts one interaction and rejects the next inside 1.5 seconds", () => {
    const first = webInteraction(state(), "pet", -Infinity, 10_000);
    expect(first.accepted).toBe(true);
    expect(first.state.action).toBe("happy");
    const second = webInteraction(first.state, "greet", first.lastInteractionMs, 10_500);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("cooldown");
    expect(second.state).toBe(first.state);
    const later = webInteraction(first.state, "greet", first.lastInteractionMs, 11_500);
    expect(later.accepted).toBe(true);
    expect(later.state.action).toBe("jump");
  });

  it("never wakes a hidden or explicitly paused pet", () => {
    const hidden = applyWebPreference(state(), { kind: "hide" }, 1);
    expect(webInteraction(hidden, "pet", -Infinity, 10).reason).toBe("hidden");
    const paused = applyWebPreference(state(), { kind: "setAnimationPaused", value: true }, 1);
    expect(webInteraction(paused, "pet", -Infinity, 10).reason).toBe("paused");
  });

  it("accepts low-motion interactions without starting an action", () => {
    const reduced = applyWebPreference(
      state(),
      { kind: "setMotionPreference", value: "reduce" },
      1
    );
    const result = webInteraction(reduced, "pet", -Infinity, 10);
    expect(result.accepted).toBe(true);
    expect(result.state.action).toBe(reduced.action);
    expect(result.state.actionRevision).toBe(reduced.actionRevision);
  });
});

describe("status copy", () => {
  it("uses the documented priority order", () => {
    expect(statusText({ ...state(), availability: "error" })).toBe("需要帮助");
    expect(statusText({ ...state(), availability: "loading" })).toBe("正在准备");
    expect(statusText({ ...state(), pending: true })).toBe("正在同步");
    expect(statusText({ ...state(), visibilityMode: "hidden", visible: false })).toBe(
      "已收起，随时可以叫回来"
    );
    expect(statusText({ ...state(), autonomous: false })).toContain("固定姿态");
    expect(statusText(state())).toBe("正在桌面陪着你");
  });

  it("explains why an interaction is unavailable", () => {
    const hidden = applyWebPreference(state(), { kind: "hide" }, 1);
    expect(interactionHelp(hidden, false)).toContain("先唤回伙伴");
    expect(interactionHelp(state(), true)).toContain("网页演示");
  });
});

describe("snooze durations and preference explanations", () => {
  const now = 1_700_000_000_000;

  it("applies 15, 30 and 60 minutes and keeps the legacy default", () => {
    const base = state({ visibilityMode: "shown", snoozeUntilMs: null });
    expect(applyWebPreference(base, { kind: "snooze", durationMinutes: 15 }, now).snoozeUntilMs)
      .toBe(now + 15 * 60_000);
    expect(applyWebPreference(base, { kind: "snooze", durationMinutes: 30 }, now).snoozeUntilMs)
      .toBe(now + 30 * 60_000);
    expect(applyWebPreference(base, { kind: "snooze", durationMinutes: 60 }, now).snoozeUntilMs)
      .toBe(now + 60 * 60_000);
    expect(applyWebPreference(base, { kind: "snooze" }, now).snoozeUntilMs)
      .toBe(now + 60 * 60_000);
    expect(isSnoozeMinutes(15)).toBe(true);
    expect(isSnoozeMinutes(45)).toBe(false);
    expect(snoozeDurationMs(30)).toBe(30 * 60_000);
  });

  it("refuses an invalid duration without changing the confirmed state", () => {
    const base = state({ visibilityMode: "shown", snoozeUntilMs: null });
    const invalid = applyWebPreference(
      base,
      { kind: "snooze", durationMinutes: 45 as never },
      now
    );
    expect(invalid).toBe(base);
  });

  it("rounds remaining minutes up and reports zero after expiry", () => {
    expect(snoozeRemainingMinutes(now + 60_000, now)).toBe(1);
    expect(snoozeRemainingMinutes(now + 60_001, now)).toBe(2);
    expect(snoozeRemainingMinutes(now, now)).toBe(0);
    expect(snoozeRemainingMinutes(now - 1, now)).toBe(0);
    expect(snoozeRemainingMinutes(null, now)).toBeNull();
    const beforeMidnight = new Date("2026-10-22T23:50:00").getTime();
    const afterMidnight = new Date("2026-10-23T00:05:00").getTime();
    expect(snoozeRemainingMinutes(afterMidnight, beforeMidnight)).toBe(15);
  });

  it("explains the effective autonomous behaviour in priority order", () => {
    const ready = state({
      petId: "pet-a",
      availability: "ready",
      visible: true,
      visibilityMode: "shown",
      autonomous: true
    });
    expect(autonomousStatusText(ready)).toContain("会按节奏");
    expect(autonomousStatusText({ ...ready, visibilityMode: "hidden", visible: false }))
      .toBe("已开启，收起期间暂不切换姿态");
    expect(autonomousStatusText({ ...ready, animationPaused: true }))
      .toBe("已开启，动画暂停期间暂不切换姿态");
    expect(autonomousStatusText({ ...ready, motionPreference: "reduce" }))
      .toBe("已开启，当前因减少动态而暂停");
    expect(autonomousStatusText({ ...ready, autonomous: false }))
      .toBe("保持当前姿态，仍可手动互动");
    expect(autonomousStatusText({ ...ready, availability: "error" }))
      .toContain("等待素材或连接");
  });

  it("explains animation and motion preferences without rewriting them", () => {
    const ready = state({
      petId: "pet-a",
      availability: "ready",
      visible: true,
      visibilityMode: "shown",
      animationPaused: false,
      motionPreference: "system",
      systemReducedMotion: false
    });
    expect(animationStatusText(ready)).toBe("跟随系统，当前正常播放");
    expect(animationStatusText({ ...ready, animationPaused: true, motionPreference: "reduce" }))
      .toContain("关闭低动态不会自动恢复");
    expect(animationStatusText({ ...ready, visibilityMode: "snoozed", visible: false }))
      .toBe("收起或休息期间不播放动画");
    expect(motionPreferenceStatusText(ready)).toContain("跟随系统，当前正常播放");
    expect(motionPreferenceStatusText({ ...ready, motionPreference: "reduce" }))
      .toContain("始终减少动态");
    expect(motionPreferenceStatusText({ ...ready, systemReducedMotion: true }))
      .toContain("系统当前已开启");
  });
});
