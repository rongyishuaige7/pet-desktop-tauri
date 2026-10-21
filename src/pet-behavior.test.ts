import { describe, expect, it } from "vitest";
import { actionDurationMs, chooseNextAction } from "./pet-behavior";
import { PET_ACTIONS, type PetAction } from "./types";

const first = () => 0;
const last = () => 0.999999;

describe("autonomous behaviour", () => {
  it("never leaves a resting state without a sensible successor", () => {
    expect(chooseNextAction("sleep", first)).toBe("idle");
    expect(chooseNextAction("sleep", last)).toBe("idle");
    expect(chooseNextAction("happy", first)).toBe("idle");
    expect(chooseNextAction("jump", last)).toBe("idle");
  });

  it("lets idle wander through every action", () => {
    const seen = new Set<PetAction>();
    for (let i = 0; i < 6; i += 1) {
      seen.add(chooseNextAction("idle", () => i / 6));
    }
    expect([...seen].sort()).toEqual(["happy", "sit", "sleep", "walk"]);
  });

  it("only returns known actions", () => {
    const ids = new Set(PET_ACTIONS.map((action) => action.id));
    for (const action of PET_ACTIONS) {
      for (const random of [first, last, () => 0.5]) {
        expect(ids.has(chooseNextAction(action.id, random))).toBe(true);
      }
    }
  });

  it("keeps durations inside the ranges mirrored from Rust", () => {
    const ranges: Record<PetAction, [number, number]> = {
      idle: [6_000, 13_000],
      walk: [4_000, 9_000],
      sit: [5_000, 11_000],
      sleep: [15_000, 31_000],
      happy: [2_000, 4_000],
      jump: [6_000, 13_000]
    };

    for (const action of PET_ACTIONS) {
      const [min, max] = ranges[action.id];
      expect(actionDurationMs(action.id, first)).toBe(min);
      expect(actionDurationMs(action.id, last)).toBeLessThanOrEqual(max);
      expect(actionDurationMs(action.id, () => 0.5)).toBeGreaterThan(min);
    }
  });
});
