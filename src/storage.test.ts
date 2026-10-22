import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { claimAdoptionRecord, commitAdoptedPet, deletePet, isCollectionInitialized, loadAllPets, loadOnboardingRecord, loadPet, renamePet, saveOnboardingRecord, savePet, setActivePetId, updatePetAction } from "./storage";
import { createOnboardingRecord } from "./onboarding";
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


describe("adoption commit", () => {
  it("writes the profile, active pointer and onboarding record together", async () => {
    const record = createOnboardingRecord({
      step: "meet",
      phase: "committed",
      confirmedPetId: "A"
    });
    await commitAdoptedPet(pet("A"), record);

    expect((await loadPet())?.id).toBe("A");
    expect(await isCollectionInitialized()).toBe(true);
    const loaded = await loadOnboardingRecord();
    expect(loaded.corrupt).toBe(false);
    expect(loaded.record?.confirmedPetId).toBe("A");
    expect(loaded.record?.phase).toBe("committed");
  });

  it("is idempotent when a retry reuses the pending pet id", async () => {
    const record = createOnboardingRecord({ phase: "committed", confirmedPetId: "A" });
    await commitAdoptedPet(pet("A"), record);
    await commitAdoptedPet(pet("A"), record);
    expect(await loadAllPets()).toHaveLength(1);
    expect((await loadPet())?.id).toBe("A");
  });

  it("leaves no half-adopted profile when the transaction aborts", async () => {
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof put>
    ) {
      const req = put.apply(this, args);
      if (this.name === "pets_collection") queueMicrotask(() => this.transaction.abort());
      return req;
    });
    try {
      await expect(
        commitAdoptedPet(pet("A"), createOnboardingRecord({ phase: "committed" }))
      ).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect(await loadAllPets()).toEqual([]);
    expect((await loadOnboardingRecord()).record).toBeNull();
  });

  it("reports a corrupt onboarding record instead of treating it as absent", async () => {
    await saveOnboardingRecord({} as never);
    const loaded = await loadOnboardingRecord();
    expect(loaded.record).toBeNull();
    expect(loaded.corrupt).toBe(true);
  });
});

describe("onboarding record ordering", () => {
  it("ignores a stale write from a late blur or retry", async () => {
    const newer = createOnboardingRecord({
      state: "in_progress",
      step: "meet",
      phase: "committed",
      confirmedPetId: "A",
      updatedAt: "2026-10-22T00:00:02.000Z"
    });
    const older = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      phase: "prepared",
      updatedAt: "2026-10-22T00:00:01.000Z"
    });
    await saveOnboardingRecord(newer);
    await saveOnboardingRecord(older);
    const loaded = await loadOnboardingRecord();
    expect(loaded.record?.step).toBe("meet");
    expect(loaded.record?.confirmedPetId).toBe("A");
  });
});

describe("adoption claims", () => {
  it("reuses one pending id when two windows claim together", async () => {
    const base = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "窗口甲",
      phase: "draft"
    });
    let calls = 0;
    const factory = () => `id-${++calls}`;
    const [first, second] = await Promise.all([
      claimAdoptionRecord(base, "窗口甲", null, factory),
      claimAdoptionRecord(base, "窗口乙", null, factory)
    ]);
    expect(first.record.pendingPetId).toBe(second.record.pendingPetId);
    expect(first.record.adoptionId).toBe(second.record.adoptionId);
  });

  it("rejects a commit whose claim was superseded", async () => {
    const claim = await claimAdoptionRecord(
      createOnboardingRecord({ state: "in_progress", step: "name", phase: "draft" }),
      "团子",
      null,
      () => "pending-a"
    );
    const record = {
      ...claim.record,
      phase: "committed" as const,
      step: "meet" as const,
      confirmedPetId: claim.record.pendingPetId
    };
    await expect(
      commitAdoptedPet(pet("different"), record, claim.record.previousActivePetId)
    ).rejects.toThrow("其他窗口");
    expect(await loadAllPets()).toEqual([]);
  });

  it("does not replace a newer active selection", async () => {
    await savePet(pet("A"));
    await savePet(pet("B"));
    const claim = await claimAdoptionRecord(
      createOnboardingRecord({ state: "in_progress", step: "name", phase: "draft" }),
      "团子",
      "A",
      () => "pending-a"
    );
    await setActivePetId("B");
    const record = {
      ...claim.record,
      phase: "committed" as const,
      step: "meet" as const,
      confirmedPetId: "pending-a"
    };
    await expect(
      commitAdoptedPet(pet("pending-a"), record, claim.record.previousActivePetId)
    ).rejects.toThrow("当前伙伴已更新");
    expect((await loadPet())?.id).toBe("B");
  });
});
