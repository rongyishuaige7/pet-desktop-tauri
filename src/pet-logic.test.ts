import { describe, expect, it } from "vitest";
import { hasRenderableFrames, isPetAction, normalizeZoom, withCurrentAction } from "./pet-logic";
import type { ActionFrameSet, PetProfile } from "./types";

const completeFrames: ActionFrameSet = {
  idle: ["idle-1.png"],
  sit: ["sit-1.png"],
  sleep: ["sleep-1.png"],
  happy: ["happy-1.png"],
  walk: ["walk-1.png"],
  jump: ["jump-1.png"]
};

function pet(actions: ActionFrameSet = completeFrames): PetProfile {
  return {
    id: "pet-1",
    name: "奶茶",
    species: "cat",
    style: "q-sticker",
    createdAt: "2026-07-14T00:00:00.000Z",
    sourceImage: "source.png",
    actions,
    currentAction: "idle",
    scale: 1
  };
}

describe("pet display settings", () => {
  it("rounds valid zoom values and clamps the supported range", () => {
    expect(normalizeZoom(99.6)).toBe(100);
    expect(normalizeZoom(20)).toBe(50);
    expect(normalizeZoom(200)).toBe(150);
    expect(normalizeZoom(Number.NaN)).toBe(100);
  });
});

describe("pet actions", () => {
  it("recognizes only the six supported actions", () => {
    expect(isPetAction("jump")).toBe(true);
    expect(isPetAction("dance")).toBe(false);
    expect(isPetAction(null)).toBe(false);
  });

  it("requires at least one frame for every action", () => {
    expect(hasRenderableFrames(pet())).toBe(true);
    expect(hasRenderableFrames(pet({ ...completeFrames, sleep: [] }))).toBe(false);
  });

  it("switches action without mutating the original profile", () => {
    const original = pet();
    const changed = withCurrentAction(original, "walk", "2026-07-14T01:02:03.000Z");

    expect(changed.currentAction).toBe("walk");
    expect(changed.actionStartedAt).toBe("2026-07-14T01:02:03.000Z");
    expect(original.currentAction).toBe("idle");
  });
});
