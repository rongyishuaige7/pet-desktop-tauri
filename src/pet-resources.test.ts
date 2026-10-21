import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildDefaultActionFrames, hydratePet, toPersistedPet } from "./pet-resources";
import type { PetProfile } from "./types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
function pet(): PetProfile {
  return { id: "A", name: "奶茶", species: "cat", style: "q-sticker", createdAt: "2026-10-21",
    sourceImage: "/frame-pack/idle/000.png", scale: 1, currentAction: "idle",
    storageMode: "preset-root", frameRoot: "/custom/A", actions: buildDefaultActionFrames() };
}
beforeEach(() => vi.mocked(invoke).mockReset());
describe("selected pet resources", () => {
  it("restores the native action even when frames are already available", async () => {
    expect((await hydratePet(pet(), true, "sleep")).currentAction).toBe("sleep");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("reports missing custom assets and permits retry", async () => {
    const stored = toPersistedPet(pet(), true);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("missing pack"));
    await expect(hydratePet(stored, true)).rejects.toThrow("missing pack");
    vi.mocked(invoke).mockResolvedValueOnce({ sourceImage: "ok.png", actions: buildDefaultActionFrames() });
    expect((await hydratePet(stored, true)).sourceImage).toBe("ok.png");
  });
  it("retains a shelf image without persisting thirty embedded frames", () => {
    const stored = toPersistedPet(pet(), true);
    expect(stored.thumbnailImage).toBe(pet().sourceImage);
    expect(stored.actions.idle).toEqual([]);
    expect(stored.sourceImage).toBe("");
  });
});
