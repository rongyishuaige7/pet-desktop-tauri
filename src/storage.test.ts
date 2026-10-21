import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { deletePet, isCollectionInitialized, loadAllPets, loadPet, renamePet, savePet, setActivePetId, updatePetAction } from "./storage";
import { PET_ACTIONS, type ActionFrameSet, type PetProfile } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
function pet(id: string): PetProfile {
  return { id, name: id, species: "cat", style: "q-sticker", createdAt: "2026-10-21",
    sourceImage: "idle.png", scale: 1, currentAction: "idle",
    actions: Object.fromEntries(PET_ACTIONS.map(({ id }) => [id, ["frame.png"]])) as ActionFrameSet };
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", { removeItem: vi.fn() });
  vi.stubGlobal("BroadcastChannel", undefined);
});

describe("pet collection transactions", () => {
  it("keeps the selected pet when deleting a different profile", async () => {
    await savePet(pet("A")); await savePet(pet("B"));
    expect((await deletePet("A"))?.id).toBe("B");
    expect((await loadPet())?.id).toBe("B");
    expect(await loadAllPets()).toHaveLength(1);
  });
  it("does not reactivate an old pet when its action event arrives", async () => {
    await savePet(pet("A")); await savePet(pet("B"));
    await updatePetAction("A", "walk");
    expect((await loadPet())?.id).toBe("B");
    expect((await loadAllPets()).find((p) => p.id === "A")?.currentAction).toBe("walk");
  });
  it("preserves concurrent rename and action updates", async () => {
    await savePet(pet("A"));
    await Promise.all([renamePet("A", " 奶茶 "), updatePetAction("A", "sleep")]);
    expect(await loadPet()).toMatchObject({ name: "奶茶", currentAction: "sleep" });
  });
  it("does not resurrect deleted pets from delayed events", async () => {
    await savePet(pet("A")); await deletePet("A");
    expect(await updatePetAction("A", "walk")).toBeNull();
    expect(await loadPet()).toBeNull();
    expect(await loadAllPets()).toEqual([]);
    expect(await isCollectionInitialized()).toBe(true);
  });
  it("selects a remaining pet after deleting the active one", async () => {
    await savePet(pet("A")); await savePet(pet("B"));
    expect((await deletePet("B"))?.id).toBe("A");
    expect((await loadPet())?.id).toBe("A");
  });
  it("rejects an aborted activation instead of remaining pending", async () => {
    await savePet(pet("A")); await savePet(pet("B"));
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const req = put.apply(this, args);
      if (this.name === "metadata" && args[1] === "active_pet_id") queueMicrotask(() => this.transaction.abort());
      return req;
    });
    try { await expect(setActivePetId("A")).rejects.toBeTruthy(); }
    finally { spy.mockRestore(); }
    expect((await loadPet())?.id).toBe("B");
  });
});
