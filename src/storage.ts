import { invoke } from "@tauri-apps/api/core";
import { withCurrentAction, withRenamedPet } from "./pet-logic";
import { PET_ACTIONS, PET_CHANNEL, STORAGE_KEY, type ActionFrameSet, type PetAction, type PetProfile } from "./types";
import {
  ONBOARDING_KEY,
  normalizeOnboardingRecord,
  prepareAdoption,
  type OnboardingRecord
} from "./onboarding";

const DB_NAME = "desktop-sticker-pet-db";
const DB_VERSION = 3;
const STORES = ["pet", "pets_collection", "metadata", "removed_pets"];
const ACTIVE_ID_KEY = "active_pet_id";
const SELECTION_REVISION_KEY = "selection_revision_v1";
const ONBOARDING_CHANNEL = "desktop-sticker-pet-onboarding";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const keyPath = name === "pets_collection" || name === "removed_pets" ? { keyPath: "id" } : undefined;
          db.createObjectStore(name, keyPath);
        }
      }
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("宠物数据库升级被其他窗口阻塞，请关闭旧窗口后重试"));
    };
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void) => void
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORES, mode);
      let value: T;
      let failure: Error | null = null;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error("宠物数据库事务已中止，请重试"));
      const fail = (error: Error) => {
        failure = error;
        try {
          tx.abort();
        } catch {
          reject(error);
        }
      };
      try {
        run(tx, (next) => { value = next; }, fail);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

function readActive(tx: IDBTransaction, done: (pet: PetProfile | null) => void) {
  const req = tx.objectStore("metadata").get(ACTIVE_ID_KEY);
  const legacy = () => {
    const old = tx.objectStore("pet").get("current");
    old.onsuccess = () => {
      if (!old.result) return done(null);
      // A legacy mirror must never resurrect a profile that is in the
      // recent-removal store.
      const removed = tx.objectStore("removed_pets").get(old.result.id);
      removed.onsuccess = () => done(removed.result ? null : old.result);
    };
  };
  req.onsuccess = () => {
    if (!req.result) return legacy();
    const pet = tx.objectStore("pets_collection").get(req.result);
    pet.onsuccess = () => pet.result ? done(pet.result) : legacy();
  };
}

export function loadPet(): Promise<PetProfile | null> {
  return transaction("readonly", readActive);
}

export function loadAllPets(): Promise<PetProfile[]> {
  return transaction("readonly", (tx, done) => {
    const req = tx.objectStore("pets_collection").getAll();
    req.onsuccess = () => {
      if (req.result.length) return done(req.result);
      readActive(tx, (pet) => done(pet ? [pet] : []));
    };
  });
}

export function isCollectionInitialized(): Promise<boolean> {
  return transaction("readonly", (tx, done) => {
    const req = tx.objectStore("metadata").get("collection_initialized");
    req.onsuccess = () => done(Boolean(req.result));
  });
}

function activate(tx: IDBTransaction, pet: PetProfile | null) {
  const meta = tx.objectStore("metadata");
  meta.put(true, "collection_initialized");
  if (pet) {
    meta.put(pet.id, ACTIVE_ID_KEY);
    tx.objectStore("pet").put(pet, "current");
  } else {
    meta.delete(ACTIVE_ID_KEY);
    tx.objectStore("pet").delete("current");
  }
}

/**
 * Bumped inside the same transaction as every explicit active-selection
 * change. Display retries compare it so an older intent cannot win over a
 * newer choice, even when the user selected the same profile again.
 */
function bumpSelectionRevision(tx: IDBTransaction) {
  const meta = tx.objectStore("metadata");
  const current = meta.get(SELECTION_REVISION_KEY);
  current.onsuccess = () => {
    const previous = Number(current.result);
    meta.put(Number.isFinite(previous) ? previous + 1 : 1, SELECTION_REVISION_KEY);
  };
}

export function loadSelectionRevision(): Promise<number> {
  return transaction<number>("readonly", (tx, done) => {
    const req = tx.objectStore("metadata").get(SELECTION_REVISION_KEY);
    req.onsuccess = () => {
      const value = Number(req.result);
      done(Number.isFinite(value) ? value : 0);
    };
  });
}

/** New/imported profiles are explicitly activated. Runtime updates never activate. */
export async function savePet(pet: PetProfile, _broadcastPet: PetProfile = pet) {
  await transaction<void>("readwrite", (tx, done, fail) => {
    const removed = tx.objectStore("removed_pets").get(pet.id);
    removed.onsuccess = () => {
      if (removed.result) {
        fail(new Error("该伙伴在最近移除中，请先恢复"));
        return;
      }
      tx.objectStore("pets_collection").put(pet);
      activate(tx, pet);
      bumpSelectionRevision(tx);
      done();
    };
  });
  localStorage.removeItem(STORAGE_KEY);
  notifyPetChanged();
}

export async function setActivePetId(id: string): Promise<PetProfile | null> {
  const pet = await transaction<PetProfile | null>("readwrite", (tx, done) => {
    const req = tx.objectStore("pets_collection").get(id);
    req.onsuccess = () => {
      if (req.result) {
        activate(tx, req.result);
        bumpSelectionRevision(tx);
      }
      done(req.result ?? null);
    };
  });
  if (pet) notifyPetChanged();
  return pet;
}

export async function deletePet(id: string): Promise<PetProfile | null> {
  const current = await transaction<PetProfile | null>("readwrite", (tx, done) => {
    const collection = tx.objectStore("pets_collection");
    collection.delete(id);
    readActive(tx, (active) => {
      if (active && active.id !== id) return done(active);
      const req = collection.getAll();
      req.onsuccess = () => {
        const next = req.result[0] ?? null;
        activate(tx, next);
        bumpSelectionRevision(tx);
        done(next);
      };
    });
  });
  notifyPetChanged();
  return current;
}

export interface RemovedPetRecord {
  id: string;
  removalId: string;
  pet: PetProfile;
  removedAt: string;
  wasActive: boolean;
  selectionRevisionAfterRemoval: number;
}

export interface RemovePetResult {
  removed: RemovedPetRecord;
  nextActive: PetProfile | null;
  selectionRevision: number;
}

export type RestoreRemovalMode = "undo" | "shelf";

export interface RestoreRemovedResult {
  restored: PetProfile;
  restoredActive: boolean;
  selectionRevision: number;
  alreadyRestored: boolean;
}

function comparePetOrder(a: PetProfile, b: PetProfile) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Soft-removes one profile in a single transaction. The profile and its files
 * stay intact in `removed_pets`; only an explicit restore moves it back.
 */
export async function softRemovePet(id: string): Promise<RemovePetResult> {
  const result = await transaction<RemovePetResult>("readwrite", (tx, done, fail) => {
    const collection = tx.objectStore("pets_collection");
    const petReq = collection.get(id);
    petReq.onsuccess = () => {
      const pet = petReq.result as PetProfile | undefined;
      if (!pet) {
        fail(new Error("该宠物已被移除"));
        return;
      }
      const meta = tx.objectStore("metadata");
      const activeReq = meta.get(ACTIVE_ID_KEY);
      activeReq.onsuccess = () => {
        const wasActive = activeReq.result === id;
        const allReq = collection.getAll();
        allReq.onsuccess = () => {
          const remaining = (allReq.result as PetProfile[])
            .filter((candidate) => candidate.id !== id)
            .sort(comparePetOrder);
          const nextActive = wasActive ? remaining[0] ?? null : null;
          const revisionReq = meta.get(SELECTION_REVISION_KEY);
          revisionReq.onsuccess = () => {
            const current = Number(revisionReq.result) || 0;
            const after = wasActive ? current + 1 : current;
            const removed: RemovedPetRecord = {
              id,
              removalId: crypto.randomUUID(),
              pet,
              removedAt: new Date().toISOString(),
              wasActive,
              selectionRevisionAfterRemoval: after
            };
            tx.objectStore("removed_pets").put(removed);
            collection.delete(id);
            if (wasActive) {
              activate(tx, nextActive);
              meta.put(after, SELECTION_REVISION_KEY);
            }
            done({ removed, nextActive, selectionRevision: after });
          };
        };
      };
    };
  });
  notifyPetChanged();
  return result;
}

export function loadRemovedPets(): Promise<RemovedPetRecord[]> {
  return transaction<RemovedPetRecord[]>("readonly", (tx, done) => {
    const req = tx.objectStore("removed_pets").getAll();
    req.onsuccess = () =>
      done(
        (req.result as RemovedPetRecord[]).sort(
          (a, b) =>
            b.removedAt.localeCompare(a.removedAt) || a.id.localeCompare(b.id)
        )
      );
  });
}

/**
 * `shelf` only puts the profile back; `undo` additionally restores the active
 * choice when no newer selection happened after the removal.
 */
export async function restoreRemovedPet(
  id: string,
  removalId: string,
  mode: RestoreRemovalMode
): Promise<RestoreRemovedResult> {
  const result = await transaction<RestoreRemovedResult>(
    "readwrite",
    (tx, done, fail) => {
      const removedStore = tx.objectStore("removed_pets");
      const removedReq = removedStore.get(id);
      removedReq.onsuccess = () => {
        const removed = removedReq.result as RemovedPetRecord | undefined;
        if (!removed) {
          const existing = tx.objectStore("pets_collection").get(id);
          existing.onsuccess = () => {
            if (existing.result) {
              done({
                restored: existing.result,
                restoredActive: false,
                selectionRevision: 0,
                alreadyRestored: true
              });
            } else {
              fail(new Error("该伙伴已不在最近移除"));
            }
          };
          return;
        }
        if (removed.removalId !== removalId) {
          fail(new Error("这次移除已更新，未恢复旧记录"));
          return;
        }
        const meta = tx.objectStore("metadata");
        const activeReq = meta.get(ACTIVE_ID_KEY);
        const revisionReq = meta.get(SELECTION_REVISION_KEY);
        activeReq.onsuccess = () => {
          revisionReq.onsuccess = () => {
            const revision = Number(revisionReq.result) || 0;
            const canUndo =
              mode === "undo" &&
              removed.wasActive &&
              revision === removed.selectionRevisionAfterRemoval;
            tx.objectStore("pets_collection").put(removed.pet);
            removedStore.delete(id);
            let restoredActive = false;
            let nextRevision = revision;
            if (canUndo) {
              activate(tx, removed.pet);
              nextRevision = revision + 1;
              meta.put(nextRevision, SELECTION_REVISION_KEY);
              restoredActive = true;
            }
            done({
              restored: removed.pet,
              restoredActive,
              selectionRevision: nextRevision,
              alreadyRestored: false
            });
          };
        };
      };
    }
  );
  notifyPetChanged();
  return result;
}

function emptyActionFrames(): ActionFrameSet {
  return Object.fromEntries(PET_ACTIONS.map(({ id }) => [id, []])) as unknown as ActionFrameSet;
}

async function updateExistingPet(
  id: string,
  update: (pet: PetProfile) => PetProfile,
  accept?: (pet: PetProfile) => boolean
): Promise<PetProfile | null> {
  const pet = await transaction<PetProfile | null>("readwrite", (tx, done) => {
    const collection = tx.objectStore("pets_collection");
    const req = collection.get(id);
    req.onsuccess = () => {
      if (!req.result || (accept && !accept(req.result))) return done(null);
      const next = update(req.result);
      collection.put(next);
      const active = tx.objectStore("metadata").get(ACTIVE_ID_KEY);
      active.onsuccess = () => {
        if (active.result === id) tx.objectStore("pet").put(next, "current");
        done(next);
      };
    };
  });
  if (pet) notifyPetChanged();
  return pet;
}

export function renamePet(id: string, name: string) {
  if (!name.trim()) return Promise.reject(new Error("宠物名字不能为空"));
  return updateExistingPet(id, (pet) => withRenamedPet(pet, name));
}

export function updatePetAction(id: string, action: PetAction) {
  return updateExistingPet(id, (pet) => withCurrentAction(pet, action));
}

/** Repair an existing profile's material without creating or activating one. */
export function replacePetAssets(
  id: string,
  frameRoot: string,
  sourceImage: string,
  actions: ActionFrameSet,
  thumbnailImage?: string,
  assetMode: PetProfile["assetMode"] = "external",
  assetId?: string
): Promise<PetProfile | null> {
  return updateExistingPet(id, (pet) => ({
    ...pet,
    frameRoot,
    storageMode: "preset-root",
    assetMode,
    assetId,
    sourceImage,
    thumbnailImage: thumbnailImage ?? sourceImage,
    actions
  }));
}

export function updatePetAssetReference(
  id: string,
  frameRoot: string,
  assetMode: "managed" | "external",
  assetId?: string,
  expected?: { frameRoot?: string; assetId?: string }
): Promise<PetProfile | null> {
  return updateExistingPet(
    id,
    (pet) => {
      const rootChanged = pet.frameRoot !== frameRoot;
      return {
        ...pet,
        frameRoot,
        storageMode: "preset-root",
        assetMode,
        assetId,
        ...(rootChanged
          ? {
              sourceImage: "",
              thumbnailImage: undefined,
              actions: emptyActionFrames()
            }
          : {})
      };
    },
    expected
      ? (pet) =>
          pet.frameRoot === expected.frameRoot && pet.assetId === expected.assetId
      : undefined
  );
}

export async function setCurrentAction(action: PetAction, syncNative = true) {
  const pet = await loadPet();
  if (!pet) return;
  await updatePetAction(pet.id, action);
  if (syncNative) await invoke("set_native_pet_action", { action });
}

export function notifyOnboardingChanged() {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(ONBOARDING_CHANNEL);
    channel.postMessage({ type: "onboarding-updated" });
    channel.close();
  }
}

export function subscribeOnboardingChanges(callback: () => void) {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(ONBOARDING_CHANNEL);
  channel.onmessage = (event) => {
    if (event.data?.type === "onboarding-updated") callback();
  };
  return () => channel.close();
}

export function notifyPetChanged() {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(PET_CHANNEL);
    channel.postMessage({ type: "pet-updated" });
    channel.close();
  }
}

export function subscribePetChanges(callback: () => void) {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(PET_CHANNEL);
  channel.onmessage = (event) => {
    if (event.data?.type === "pet-updated") callback();
  };
  return () => channel.close();
}


export interface OnboardingLoadResult {
  record: OnboardingRecord | null;
  corrupt: boolean;
}

/** A present but unreadable record is reported separately; it is not a clean install. */
export function loadOnboardingRecord(): Promise<OnboardingLoadResult> {
  return transaction<OnboardingLoadResult>("readonly", (tx, done) => {
    const req = tx.objectStore("metadata").get(ONBOARDING_KEY);
    req.onsuccess = () => {
      if (req.result === undefined) return done({ record: null, corrupt: false });
      const record = normalizeOnboardingRecord(req.result);
      done({ record, corrupt: record === null });
    };
  });
}

export async function saveOnboardingRecord(record: OnboardingRecord): Promise<void> {
  await transaction<void>("readwrite", (tx, done) => {
    const store = tx.objectStore("metadata");
    const current = store.get(ONBOARDING_KEY);
    current.onsuccess = () => {
      const existing = normalizeOnboardingRecord(current.result);
      if (existing) {
        const sameIntent =
          Boolean(existing.intentId) &&
          Boolean(record.intentId) &&
          existing.intentId === record.intentId;
        const sameOrUnknownIntent =
          sameIntent || !record.intentId || !existing.intentId;
        // A stale window must not replace a completed or committed adoption
        // with its older step form just because it clicked later.
        const lateStep =
          sameOrUnknownIntent &&
          existing.phase === "committed" &&
          record.phase !== "committed" &&
          record.state === "in_progress";
        const afterCompletion =
          sameOrUnknownIntent &&
          existing.state === "completed" &&
          record.state !== "completed";
        if (lateStep || afterCompletion) {
          done();
          return;
        }
        // A late blur/retry callback must not overwrite a newer prepared or
        // committed record. Equal timestamps are allowed to land.
        if (existing.updatedAt > record.updatedAt) {
          done();
          return;
        }
      }
      store.put(record, ONBOARDING_KEY);
      done();
    };
  });
  notifyOnboardingChanged();
}

export interface AdoptionClaim {
  record: OnboardingRecord;
  alreadyCommitted: boolean;
}

export type OnboardingProgressFailure = "INTENT_CHANGED" | "STALE";

/**
 * Progress writes fail for two very different reasons. The interface must not
 * report a storage failure as "expired", so the reason travels with the error.
 */
export class OnboardingProgressError extends Error {
  readonly code: OnboardingProgressFailure;

  constructor(code: OnboardingProgressFailure, message: string) {
    super(message);
    this.name = "OnboardingProgressError";
    this.code = code;
  }
}

/**
 * Progress writes (name, step, finish, dismiss) must belong to the intent that
 * is still current. A stale window reads the newer result instead of silently
 * reporting success.
 */
export async function saveOnboardingProgress(
  record: OnboardingRecord
): Promise<OnboardingRecord> {
  const saved = await transaction<OnboardingRecord>("readwrite", (tx, done, fail) => {
    const store = tx.objectStore("metadata");
    const current = store.get(ONBOARDING_KEY);
    current.onsuccess = () => {
      const existing = normalizeOnboardingRecord(current.result);
      if (existing) {
        const sameIntent =
          Boolean(existing.intentId) &&
          Boolean(record.intentId) &&
          existing.intentId === record.intentId;
        const legacySame = !existing.intentId && !record.intentId;
        if (!sameIntent && !legacySame) {
          fail(
            new OnboardingProgressError(
              "INTENT_CHANGED",
              "领养已更新，未保存这次进度"
            )
          );
          return;
        }
        const lateStep =
          existing.phase === "committed" &&
          record.phase !== "committed" &&
          record.state === "in_progress";
        const afterCompletion =
          existing.state === "completed" && record.state !== "completed";
        if (
          lateStep ||
          afterCompletion ||
          existing.updatedAt > record.updatedAt ||
          record.progressRevision !== existing.progressRevision
        ) {
          fail(new OnboardingProgressError("STALE", "这次进度已过期"));
          return;
        }
      }
      const next = {
        ...record,
        progressRevision: (existing?.progressRevision ?? 0) + 1
      };
      store.put(next, ONBOARDING_KEY);
      done(next);
    };
  });
  notifyOnboardingChanged();
  return saved;
}

/**
 * Explicit "adopt again" starts a new intent. This is intentionally separate
 * from progress writes so an old completed/committed record cannot suppress
 * the user's new adoption, and old records without an intent can migrate.
 */
export async function startNewAdoptionIntent(
  record: OnboardingRecord
): Promise<OnboardingRecord> {
  if (record.state !== "in_progress" || !record.intentId) {
    throw new Error("无效的新领养意图");
  }
  const intent = { ...record, progressRevision: 0 };
  await transaction<void>("readwrite", (tx, done) => {
    tx.objectStore("metadata").put(intent, ONBOARDING_KEY);
    done();
  });
  notifyOnboardingChanged();
  return intent;
}

/**
 * Confirms display only for the exact adoption intent and pet still stored.
 * A waiting window cannot write an older intent over a newer adoption.
 */
export async function confirmAdoptionDisplay(
  record: OnboardingRecord
): Promise<OnboardingRecord> {
  const confirmed = await transaction<OnboardingRecord>("readwrite", (tx, done, fail) => {
    const store = tx.objectStore("metadata");
    const current = store.get(ONBOARDING_KEY);
    current.onsuccess = () => {
      const existing = normalizeOnboardingRecord(current.result);
      const sameIntent =
        !record.intentId || (existing?.intentId ?? null) === record.intentId;
      if (
        !existing ||
        existing.confirmedPetId !== record.confirmedPetId ||
        !sameIntent ||
        existing.phase !== "committed"
      ) {
        fail(new Error("领养已更新，未写入显示确认"));
        return;
      }
      if (existing.displayConfirmed) {
        done(existing);
        return;
      }
      const next: OnboardingRecord = {
        ...existing,
        displayConfirmed: true,
        updatedAt: new Date().toISOString()
      };
      store.put(next, ONBOARDING_KEY);
      done(next);
    };
  });
  notifyOnboardingChanged();
  return confirmed;
}

/**
 * Claims one adoption inside a single readwrite transaction. Two windows that
 * start together reuse the same adoption/pending ids; the second window sees
 * the first prepared or committed record instead of minting new ids.
 */
export async function claimAdoptionRecord(
  fallback: OnboardingRecord,
  name: string,
  previousActivePetId: string | null,
  idFactory: () => string = () => crypto.randomUUID()
): Promise<AdoptionClaim> {
  const claim = await transaction<AdoptionClaim>("readwrite", (tx, done, fail) => {
    const store = tx.objectStore("metadata");
    const current = store.get(ONBOARDING_KEY);
    current.onsuccess = () => {
      const existing = normalizeOnboardingRecord(current.result);
      const sameIntent =
        Boolean(existing?.intentId) &&
        Boolean(fallback.intentId) &&
        existing?.intentId === fallback.intentId;
      const explicitNew =
        fallback.state === "in_progress" &&
        (!existing || fallback.updatedAt > existing.updatedAt) &&
        !sameIntent;

      if (existing && !explicitNew) {
        if (
          existing.state !== "in_progress" ||
          (existing.phase === "committed" && existing.confirmedPetId)
        ) {
          // A stale window joins the persisted adoption result instead of
          // minting another generation. Explicit "adopt again" writes a newer
          // in-progress intent first, which is handled above.
          done({ record: existing, alreadyCommitted: true });
          return;
        }
      }

      const base =
        explicitNew || existing?.state !== "in_progress" ? fallback : existing;
      // Preserve stable ids, but let the submitting form update the draft name
      // for the same intent. A stale window with a different intent cannot
      // rename a newer prepared draft.
      const canEditName =
        !existing ||
        !existing.intentId ||
        !fallback.intentId ||
        sameIntent ||
        existing.phase !== "prepared";
      const canonicalName = canEditName
        ? name.trim() || base.draftName
        : base.draftName;
      let prepared: OnboardingRecord;
      try {
        prepared = prepareAdoption(
          base,
          canonicalName,
          previousActivePetId,
          idFactory
        ).record;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      store.put(prepared, ONBOARDING_KEY);
      done({ record: prepared, alreadyCommitted: false });
    };
  });
  notifyOnboardingChanged();
  return claim;
}

/**
 * One transaction commits the profile, the active pointer and the onboarding
 * record after re-checking the claim. A superseded window cannot commit a
 * second profile or replace a newer active selection.
 */
export async function commitAdoptedPet(
  pet: PetProfile,
  record: OnboardingRecord,
  expectedPreviousActiveId?: string | null
): Promise<void> {
  await transaction<void>("readwrite", (tx, done, fail) => {
    const metadata = tx.objectStore("metadata");
    const current = metadata.get(ONBOARDING_KEY);
    current.onsuccess = () => {
      const existing = normalizeOnboardingRecord(current.result);
      if (existing?.pendingPetId && existing.pendingPetId !== pet.id) {
        fail(new Error("领养已在其他窗口更新，请重新读取"));
        return;
      }
      if (
        existing?.phase === "committed" &&
        existing.confirmedPetId &&
        existing.confirmedPetId !== pet.id
      ) {
        fail(new Error("领养已在其他窗口完成，请重新读取"));
        return;
      }
      const active = metadata.get(ACTIVE_ID_KEY);
      active.onsuccess = () => {
        const activeId = active.result ?? null;
        if (
          expectedPreviousActiveId !== undefined &&
          activeId !== expectedPreviousActiveId &&
          activeId !== pet.id
        ) {
          fail(new Error("当前伙伴已更新，未提交这次领养"));
          return;
        }
        const removed = tx.objectStore("removed_pets").get(pet.id);
        removed.onsuccess = () => {
          if (removed.result) {
            fail(new Error("该伙伴在最近移除中，请先恢复"));
            return;
          }
          tx.objectStore("pets_collection").put(pet);
          activate(tx, pet);
          bumpSelectionRevision(tx);
          metadata.put(record, ONBOARDING_KEY);
          done();
        };
      };
    };
  });
  localStorage.removeItem(STORAGE_KEY);
  notifyPetChanged();
  notifyOnboardingChanged();
}
