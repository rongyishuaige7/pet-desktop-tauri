import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { claimAdoptionRecord, commitAdoptedPet, confirmAdoptionDisplay, deletePet, isCollectionInitialized, loadAllPets, loadOnboardingRecord, loadPet, renamePet, saveOnboardingRecord, savePet, setActivePetId, startNewAdoptionIntent, updatePetAction } from "./storage";
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

describe("adoption intent races", () => {
  it("joins a completed adoption from a stale window instead of minting a new one", async () => {
    const intent = "intent-old";
    const stale = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "窗口甲",
      phase: "draft",
      intentId: intent,
      updatedAt: "2026-10-22T00:00:01.000Z"
    });
    await saveOnboardingRecord(
      createOnboardingRecord({
        state: "completed",
        step: "meet",
        phase: "committed",
        confirmedPetId: "pet-a",
        adoptionId: "adoption-a",
        pendingPetId: "pet-a",
        intentId: intent,
        displayConfirmed: true,
        updatedAt: "2026-10-22T00:00:02.000Z"
      })
    );
    const claim = await claimAdoptionRecord(stale, "窗口乙", null);
    expect(claim.alreadyCommitted).toBe(true);
    expect(claim.record.confirmedPetId).toBe("pet-a");
    expect(claim.record.state).toBe("completed");
  });

  it("allows a newer explicit intent after the previous adoption completed", async () => {
    await saveOnboardingRecord(
      createOnboardingRecord({
        state: "completed",
        step: "meet",
        phase: "committed",
        confirmedPetId: "pet-a",
        adoptionId: "adoption-a",
        pendingPetId: "pet-a",
        intentId: "intent-old",
        displayConfirmed: true,
        updatedAt: "2026-10-22T00:00:01.000Z"
      })
    );
    const next = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "新伙伴",
      phase: "draft",
      intentId: "intent-new",
      updatedAt: "2026-10-22T00:00:03.000Z"
    });
    let calls = 0;
    const claim = await claimAdoptionRecord(next, "新伙伴", null, () => `new-${++calls}`);
    expect(claim.alreadyCommitted).toBe(false);
    expect(claim.record.pendingPetId).not.toBe("pet-a");
    expect(claim.record.intentId).toBe("intent-new");
  });

  it("updates the draft name while keeping the prepared ids", async () => {
    const base = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "旧名字",
      phase: "draft",
      intentId: "intent-a"
    });
    let calls = 0;
    const first = await claimAdoptionRecord(base, "旧名字", null, () => `id-${++calls}`);
    const second = await claimAdoptionRecord(
      { ...first.record, draftName: "旧名字" },
      "新名字",
      null
    );
    expect(second.record.pendingPetId).toBe(first.record.pendingPetId);
    expect(second.record.adoptionId).toBe(first.record.adoptionId);
    expect(second.record.draftName).toBe("新名字");
  });
});

describe("late onboarding writes", () => {
  it("does not let a stale step form replace a completed adoption", async () => {
    const intent = "intent-a";
    await saveOnboardingRecord(
      createOnboardingRecord({
        state: "completed",
        step: "meet",
        phase: "committed",
        confirmedPetId: "pet-a",
        pendingPetId: "pet-a",
        intentId: intent,
        displayConfirmed: true,
        updatedAt: "2026-10-22T00:00:02.000Z"
      })
    );
    await saveOnboardingRecord(
      createOnboardingRecord({
        state: "in_progress",
        step: "name",
        draftName: "旧窗口",
        phase: "draft",
        intentId: intent,
        updatedAt: "2026-10-22T00:00:03.000Z"
      })
    );
    const loaded = await loadOnboardingRecord();
    expect(loaded.record?.state).toBe("completed");
    expect(loaded.record?.confirmedPetId).toBe("pet-a");
  });

  it("does not let a stale step form replace a committed waiting record", async () => {
    const intent = "intent-b";
    await saveOnboardingRecord(
      createOnboardingRecord({
        state: "in_progress",
        step: "meet",
        phase: "committed",
        confirmedPetId: "pet-b",
        pendingPetId: "pet-b",
        intentId: intent,
        displayConfirmed: false,
        updatedAt: "2026-10-22T00:00:02.000Z"
      })
    );
    await saveOnboardingRecord(
      createOnboardingRecord({
        state: "in_progress",
        step: "name",
        draftName: "旧窗口",
        phase: "prepared",
        intentId: intent,
        updatedAt: "2026-10-22T00:00:03.000Z"
      })
    );
    const loaded = await loadOnboardingRecord();
    expect(loaded.record?.phase).toBe("committed");
    expect(loaded.record?.confirmedPetId).toBe("pet-b");
  });
});

describe("explicit intents and display confirmation", () => {
  it("lets a new intent replace an old completed record without an intent id", async () => {
    await saveOnboardingRecord(
      createOnboardingRecord({
        state: "completed",
        step: "meet",
        phase: "committed",
        confirmedPetId: "old-pet",
        pendingPetId: "old-pet",
        intentId: null,
        displayConfirmed: true,
        updatedAt: "2026-10-22T00:00:01.000Z"
      })
    );
    const next = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "新伙伴",
      phase: "draft",
      intentId: "intent-new",
      updatedAt: "2026-10-22T00:00:03.000Z"
    });
    const saved = await startNewAdoptionIntent(next);
    expect(saved.intentId).toBe("intent-new");
    const loaded = await loadOnboardingRecord();
    expect(loaded.record?.state).toBe("in_progress");
    expect(loaded.record?.intentId).toBe("intent-new");
  });

  it("refuses a display confirmation from a different intent", async () => {
    const current = createOnboardingRecord({
      state: "in_progress",
      step: "meet",
      phase: "committed",
      confirmedPetId: "pet-new",
      pendingPetId: "pet-new",
      intentId: "intent-new",
      displayConfirmed: false,
      updatedAt: "2026-10-22T00:00:03.000Z"
    });
    await saveOnboardingRecord(current);
    const stale = {
      ...current,
      confirmedPetId: "pet-old",
      pendingPetId: "pet-old",
      intentId: "intent-old"
    };
    await expect(confirmAdoptionDisplay(stale)).rejects.toThrow("未写入显示确认");
    const loaded = await loadOnboardingRecord();
    expect(loaded.record?.intentId).toBe("intent-new");
    expect(loaded.record?.displayConfirmed).toBe(false);
  });

  it("confirms display only for the matching committed intent", async () => {
    const current = createOnboardingRecord({
      state: "in_progress",
      step: "meet",
      phase: "committed",
      confirmedPetId: "pet-a",
      pendingPetId: "pet-a",
      intentId: "intent-a",
      displayConfirmed: false,
      updatedAt: "2026-10-22T00:00:03.000Z"
    });
    await saveOnboardingRecord(current);
    const confirmed = await confirmAdoptionDisplay(current);
    expect(confirmed.displayConfirmed).toBe(true);
    const loaded = await loadOnboardingRecord();
    expect(loaded.record?.displayConfirmed).toBe(true);
  });
});
