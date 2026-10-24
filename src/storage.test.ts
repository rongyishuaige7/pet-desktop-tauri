import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { claimAdoptionRecord, commitAdoptedPet, confirmAdoptionDisplay, deletePet, isCollectionInitialized, loadAllPets, loadOnboardingRecord, loadPet, loadRemovedPets, loadSelectionRevision, renamePet, restoreRemovedPet, saveOnboardingProgress, saveOnboardingRecord, savePet, setActivePetId, softRemovePet, startNewAdoptionIntent, updatePetAction, updatePetAssetReference, savePetProfile, loadCreationDraft, saveCreationDraft, deleteCreationDraft } from "./storage";
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

describe("intent-matched progress writes", () => {
  it("refuses an old meet completion over a newer draft", async () => {
    const newer = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "乙",
      phase: "draft",
      intentId: "intent-new",
      updatedAt: "2026-10-22T00:00:03.000Z"
    });
    await startNewAdoptionIntent(newer);
    const stale = createOnboardingRecord({
      state: "completed",
      step: "meet",
      phase: "committed",
      confirmedPetId: "pet-old",
      pendingPetId: "pet-old",
      intentId: "intent-old",
      displayConfirmed: true,
      updatedAt: "2026-10-22T00:00:04.000Z"
    });
    await expect(saveOnboardingProgress(stale)).rejects.toThrow("领养已更新");
    const loaded = await loadOnboardingRecord();
    expect(loaded.record?.intentId).toBe("intent-new");
    expect(loaded.record?.draftName).toBe("乙");
    expect(loaded.record?.state).toBe("in_progress");
  });

  it("allows progress within the same intent", async () => {
    const base = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "咕唧",
      phase: "draft",
      intentId: "intent-a",
      updatedAt: "2026-10-22T00:00:03.000Z"
    });
    await startNewAdoptionIntent(base);
    const next = {
      ...base,
      draftName: "新名字",
      updatedAt: "2026-10-22T00:00:04.000Z"
    };
    const saved = await saveOnboardingProgress(next);
    expect(saved.draftName).toBe("新名字");
    expect((await loadOnboardingRecord()).record?.draftName).toBe("新名字");
  });
});

describe("selection revision", () => {
  it("bumps only for explicit selection changes", async () => {
    expect(await loadSelectionRevision()).toBe(0);
    await savePet(pet("A"));
    await savePet(pet("B"));
    expect(await loadSelectionRevision()).toBe(2);
    await setActivePetId("A");
    expect(await loadSelectionRevision()).toBe(3);
    await renamePet("A", "奶茶");
    await updatePetAction("A", "walk");
    expect(await loadSelectionRevision()).toBe(3);
    await deletePet("B");
    expect(await loadSelectionRevision()).toBe(3);
    await deletePet("A");
    expect(await loadSelectionRevision()).toBe(4);
  });

  it("bumps when an adoption commits the active profile", async () => {
    const record = createOnboardingRecord({
      step: "meet",
      phase: "committed",
      confirmedPetId: "A"
    });
    await commitAdoptedPet(pet("A"), record);
    expect(await loadSelectionRevision()).toBe(1);
  });
});

describe("progress failure reasons", () => {
  it("separates a changed intent from an outdated step", async () => {
    const first = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "甲",
      intentId: "intent-a",
      updatedAt: "2026-10-22T00:00:03.000Z"
    });
    await startNewAdoptionIntent(first);
    await expect(
      saveOnboardingProgress({ ...first, intentId: "intent-b" })
    ).rejects.toMatchObject({ code: "INTENT_CHANGED" });
    await expect(
      saveOnboardingProgress({
        ...first,
        draftName: "迟到的名字",
        updatedAt: "2026-10-22T00:00:02.000Z"
      })
    ).rejects.toMatchObject({ code: "STALE" });
  });

  it("rejects a progress write based on an older revision", async () => {
    const base = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "甲",
      intentId: "intent-a"
    });
    await startNewAdoptionIntent(base);
    const first = await saveOnboardingProgress({ ...base, draftName: "乙" });
    expect(first.progressRevision).toBe(1);
    await expect(
      saveOnboardingProgress({ ...base, draftName: "丙" })
    ).rejects.toMatchObject({ code: "STALE" });
    const second = await saveOnboardingProgress({ ...first, draftName: "丁" });
    expect(second.progressRevision).toBe(2);
    expect((await loadOnboardingRecord()).record?.draftName).toBe("丁");
  });

  it("keeps a storage abort as a plain error, not a progress conflict", async () => {
    const record = createOnboardingRecord({
      state: "in_progress",
      step: "name",
      draftName: "甲",
      intentId: "intent-a"
    });
    await startNewAdoptionIntent(record);
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof put>
      ) {
        const req = put.apply(this, args);
        if (this.name === "metadata" && args[1] === "onboarding_v1") {
          queueMicrotask(() => this.transaction.abort());
        }
        return req;
      });
    try {
      const error = await saveOnboardingProgress({
        ...record,
        draftName: "新名字"
      }).catch((err) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("code");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("recent removals", () => {
  function datedPet(id: string, createdAt: string): PetProfile {
    return { ...pet(id), createdAt };
  }

  async function openV2Database() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("desktop-sticker-pet-db", 2);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains("pet")) database.createObjectStore("pet");
        if (!database.objectStoreNames.contains("pets_collection")) {
          database.createObjectStore("pets_collection", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("metadata")) database.createObjectStore("metadata");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return db;
  }

  it("upgrades a v2 database without changing profiles, active pointer or onboarding", async () => {
    const db = await openV2Database();
    const record = createOnboardingRecord({
      state: "completed",
      step: "meet",
      phase: "committed",
      confirmedPetId: "A",
      intentId: "intent-a"
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["pet", "pets_collection", "metadata"], "readwrite");
      tx.objectStore("pets_collection").put(pet("A"));
      tx.objectStore("pets_collection").put(pet("B"));
      tx.objectStore("metadata").put("A", "active_pet_id");
      tx.objectStore("metadata").put(true, "collection_initialized");
      tx.objectStore("metadata").put(record, "onboarding_v1");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    expect((await loadAllPets()).map((entry) => entry.id).sort()).toEqual(["A", "B"]);
    expect((await loadPet())?.id).toBe("A");
    expect(await loadRemovedPets()).toEqual([]);
    expect((await loadOnboardingRecord()).record?.intentId).toBe("intent-a");
  });

  it("reports a blocked upgrade and succeeds after the old connection closes", async () => {
    const legacy = await openV2Database();
    await expect(loadAllPets()).rejects.toThrow("阻塞");
    legacy.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await loadAllPets()).toEqual([]);
    expect(await loadRemovedPets()).toEqual([]);
  });

  it("soft-removes a non-active profile without changing the active choice", async () => {
    await savePet(pet("A"));
    await savePet(pet("B"));
    const revision = await loadSelectionRevision();
    const result = await softRemovePet("A");

    expect(result.nextActive).toBeNull();
    expect(result.removed).toMatchObject({ id: "A", wasActive: false });
    expect((await loadPet())?.id).toBe("B");
    expect((await loadAllPets()).map((entry) => entry.id)).toEqual(["B"]);
    expect((await loadRemovedPets())[0].pet.name).toBe("A");
    expect(await loadSelectionRevision()).toBe(revision);
  });

  it("removes the active profile and selects the oldest remaining profile", async () => {
    await savePet(datedPet("A", "2026-01-02T00:00:00.000Z"));
    await savePet(datedPet("B", "2026-01-01T00:00:00.000Z"));
    await savePet(datedPet("C", "2026-01-03T00:00:00.000Z"));
    await setActivePetId("A");
    const result = await softRemovePet("A");

    expect(result.nextActive?.id).toBe("B");
    expect((await loadPet())?.id).toBe("B");
    expect(result.removed.wasActive).toBe(true);
    expect(result.selectionRevision).toBe(await loadSelectionRevision());
    expect(result.removed.selectionRevisionAfterRemoval).toBe(result.selectionRevision);
  });

  it("removes the last profile, keeps the collection initialized and detaches the pointer", async () => {
    await savePet(pet("A"));
    const result = await softRemovePet("A");

    expect(result.nextActive).toBeNull();
    expect(await loadPet()).toBeNull();
    expect(await loadAllPets()).toEqual([]);
    expect(await isCollectionInitialized()).toBe(true);
    expect((await loadRemovedPets()).map((entry) => entry.id)).toEqual(["A"]);
  });

  it("undoes an active removal while the selection revision still matches", async () => {
    await savePet(pet("A"));
    await savePet(pet("B"));
    const removed = await softRemovePet("B");
    const restored = await restoreRemovedPet("B", removed.removed.removalId, "undo");

    expect(restored.restoredActive).toBe(true);
    expect((await loadPet())?.id).toBe("B");
    expect(await loadRemovedPets()).toEqual([]);
    expect(await loadSelectionRevision()).toBe(removed.selectionRevision + 1);
  });

  it("does not let undo take over a newer explicit selection", async () => {
    await savePet(pet("A"));
    await savePet(pet("B"));
    const removed = await softRemovePet("B");
    await setActivePetId("A");
    const revision = await loadSelectionRevision();
    const restored = await restoreRemovedPet("B", removed.removed.removalId, "undo");

    expect(restored.restoredActive).toBe(false);
    expect((await loadPet())?.id).toBe("A");
    expect((await loadAllPets()).map((entry) => entry.id).sort()).toEqual(["A", "B"]);
    expect(await loadSelectionRevision()).toBe(revision);
  });

  it("restores to the shelf without changing the active profile", async () => {
    await savePet(pet("A"));
    await savePet(pet("B"));
    const removed = await softRemovePet("A");
    const revision = await loadSelectionRevision();
    const restored = await restoreRemovedPet("A", removed.removed.removalId, "shelf");

    expect(restored.restoredActive).toBe(false);
    expect((await loadPet())?.id).toBe("B");
    expect((await loadAllPets()).map((entry) => entry.id).sort()).toEqual(["A", "B"]);
    expect(await loadSelectionRevision()).toBe(revision);
    const again = await restoreRemovedPet("A", removed.removed.removalId, "shelf");
    expect(again.alreadyRestored).toBe(true);
    expect((await loadAllPets()).length).toBe(2);
  });

  it("does not let an old removalId restore a newer removal", async () => {
    await savePet(pet("A"));
    const first = await softRemovePet("A");
    await restoreRemovedPet("A", first.removed.removalId, "shelf");
    const second = await softRemovePet("A");
    await expect(
      restoreRemovedPet("A", first.removed.removalId, "shelf")
    ).rejects.toThrow("移除已更新");
    expect((await loadRemovedPets())[0].removalId).toBe(second.removed.removalId);
    expect(await loadAllPets()).toEqual([]);
  });

  it("does not resurrect a removed profile from the legacy current mirror", async () => {
    await savePet(pet("A"));
    const removed = await softRemovePet("A");
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("desktop-sticker-pet-db", 4);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["pet"], "readwrite");
        tx.objectStore("pet").put(removed.removed.pet, "current");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    expect(await loadPet()).toBeNull();
    expect(await loadAllPets()).toEqual([]);
  });

  it("leaves profiles, pointer and revision untouched when the removal aborts", async () => {
    await savePet(pet("A"));
    await savePet(pet("B"));
    const revision = await loadSelectionRevision();
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof put>
      ) {
        const req = put.apply(this, args);
        if (this.name === "removed_pets") {
          queueMicrotask(() => this.transaction.abort());
        }
        return req;
      });
    try {
      await expect(softRemovePet("B")).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect((await loadPet())?.id).toBe("B");
    expect((await loadAllPets()).map((entry) => entry.id).sort()).toEqual(["A", "B"]);
    expect(await loadRemovedPets()).toEqual([]);
    expect(await loadSelectionRevision()).toBe(revision);
  });

  it("updates a managed asset reference without changing selection", async () => {
    await savePet(pet("A"));
    await savePet(pet("B"));
    const revision = await loadSelectionRevision();
    const before = (await loadPet())?.id;

    const updated = await updatePetAssetReference("A", "/managed/A", "managed", "A-1");

    expect(updated?.frameRoot).toBe("/managed/A");
    expect(updated?.assetMode).toBe("managed");
    expect(updated?.assetId).toBe("A-1");
    expect(updated?.sourceImage).toBe("");
    expect(updated?.thumbnailImage).toBeUndefined();
    expect(updated?.actions.idle).toEqual([]);
    expect((await loadPet())?.id).toBe(before);
    expect(await loadSelectionRevision()).toBe(revision);
    expect((await loadAllPets()).length).toBe(2);

    const stale = await updatePetAssetReference(
      "A",
      "/managed/A2",
      "managed",
      "A-2",
      { frameRoot: "/managed/not-A", assetId: "not-A" }
    );
    expect(stale).toBeNull();
    expect((await loadAllPets()).find((entry) => entry.id === "A")?.frameRoot).toBe(
      "/managed/A"
    );
  });

  it("keeps the old asset reference when the update transaction aborts", async () => {
    await savePet({
      ...pet("A"),
      storageMode: "preset-root",
      frameRoot: "/review/A",
      assetMode: "external"
    });
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<typeof put>
      ) {
        const req = put.apply(this, args);
        if (this.name === "pets_collection") {
          queueMicrotask(() => this.transaction.abort());
        }
        return req;
      });
    try {
      await expect(
        updatePetAssetReference("A", "/managed/A", "managed", "A-1")
      ).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    const current = await loadPet();
    expect(current?.frameRoot).toBe("/review/A");
    expect(current?.assetMode).toBe("external");
    expect(current?.assetId).toBeUndefined();
  });

  it("saves drafts with revision checks and deletes them", async () => {
    const base = {
      schemaVersion: 1 as const,
      draftId: "manual-assembly",
      pendingPetId: "pending-1",
      name: "草稿甲",
      species: "cat" as const,
      manualFrames: Object.fromEntries(PET_ACTIONS.map(({ id }) => [id, ["frame.png"]])) as ActionFrameSet
    };
    const first = await saveCreationDraft(base, null);
    expect(first.status).toBe("saved");
    if (first.status !== "saved") return;
    expect(first.draft.revision).toBe(1);

    const second = await saveCreationDraft(
      { ...base, name: "草稿乙" },
      first.draft.revision
    );
    expect(second.status).toBe("saved");
    if (second.status !== "saved") return;
    expect(second.draft.revision).toBe(2);

    const stale = await saveCreationDraft({ ...base, name: "迟到草稿" }, 1);
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.draft?.name).toBe("草稿乙");
    expect((await loadCreationDraft("manual-assembly"))?.name).toBe("草稿乙");

    await deleteCreationDraft("manual-assembly");
    expect(await loadCreationDraft("manual-assembly")).toBeNull();
  });

  it("saves a profile without changing the active selection", async () => {
    await savePet(pet("A"));
    const revision = await loadSelectionRevision();
    await savePetProfile({ ...pet("B"), name: "乙" });
    expect((await loadPet())?.id).toBe("A");
    expect((await loadAllPets()).length).toBe(2);
    expect(await loadSelectionRevision()).toBe(revision);
  });

  it("does not let a late rename or action update rebuild a removed profile", async () => {
    await savePet(pet("A"));
    await softRemovePet("A");
    expect(await renamePet("A", "迟到的名字")).toBeNull();
    expect(await updatePetAction("A", "walk")).toBeNull();
    expect(await loadAllPets()).toEqual([]);
    expect((await loadRemovedPets()).length).toBe(1);
    expect((await loadRemovedPets())[0].pet.name).toBe("A");
  });

  it("refuses to save or adopt a profile that is in recent removals", async () => {
    await savePet(pet("A"));
    const removed = await softRemovePet("A");
    await expect(savePet(pet("A"))).rejects.toThrow("最近移除");
    const record = createOnboardingRecord({
      step: "meet",
      phase: "committed",
      confirmedPetId: "A",
      pendingPetId: "A"
    });
    await expect(commitAdoptedPet(pet("A"), record)).rejects.toThrow("最近移除");
    expect((await loadRemovedPets())[0].removalId).toBe(removed.removed.removalId);
    expect(await loadAllPets()).toEqual([]);
  });
});
