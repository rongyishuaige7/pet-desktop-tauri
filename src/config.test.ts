import { describe, expect, it } from "vitest";
import { ACTION_TIMING } from "./config";
import { PET_ACTIONS } from "./types";

describe("action timing", () => {
  it("covers every action", () => {
    expect(Object.keys(ACTION_TIMING).sort()).toEqual(PET_ACTIONS.map((action) => action.id).sort());
  });

  it("loops only the ambling states", () => {
    const looping = PET_ACTIONS.filter((action) => ACTION_TIMING[action.id].loop).map(
      (action) => action.id
    );
    expect(looping).toEqual(["idle", "walk"]);
  });

  it("hands one-shots back to idle and holds the resting states", () => {
    expect(ACTION_TIMING.jump).toMatchObject({ loop: false, returnTo: "idle" });
    expect(ACTION_TIMING.happy).toMatchObject({ loop: false, returnTo: "idle" });
    expect(ACTION_TIMING.sit.returnTo).toBeUndefined();
    expect(ACTION_TIMING.sleep.returnTo).toBeUndefined();
  });

  it("keeps frame timings sane", () => {
    for (const action of PET_ACTIONS) {
      const { frameMs } = ACTION_TIMING[action.id];
      expect(frameMs).toBeGreaterThanOrEqual(60);
      expect(frameMs).toBeLessThanOrEqual(1000);
    }
  });
});
