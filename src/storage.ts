import { invoke } from "@tauri-apps/api/core";
import { withCurrentAction, withRenamedPet } from "./pet-logic";
import { PET_CHANNEL, STORAGE_KEY, type PetAction, type PetProfile } from "./types";

const DB_NAME = "desktop-sticker-pet-db";
const STORES = ["pet", "pets_collection", "metadata"];
const ACTIVE_ID_KEY = "active_pet_id";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, name === "pets_collection" ? { keyPath: "id" } : undefined);
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

async function transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORES, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("宠物数据库事务已中止，请重试"));
      try {
        run(tx, (next) => { value = next; });
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
    old.onsuccess = () => done(old.result ?? null);
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

/** New/imported profiles are explicitly activated. Runtime updates never activate. */
export async function savePet(pet: PetProfile, _broadcastPet: PetProfile = pet) {
  await transaction<void>("readwrite", (tx, done) => {
    tx.objectStore("pets_collection").put(pet);
    activate(tx, pet);
    done();
  });
  localStorage.removeItem(STORAGE_KEY);
  notifyPetChanged();
}

export async function setActivePetId(id: string): Promise<PetProfile | null> {
  const pet = await transaction<PetProfile | null>("readwrite", (tx, done) => {
    const req = tx.objectStore("pets_collection").get(id);
    req.onsuccess = () => {
      if (req.result) activate(tx, req.result);
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
        done(next);
      };
    });
  });
  notifyPetChanged();
  return current;
}

async function updateExistingPet(id: string, update: (pet: PetProfile) => PetProfile): Promise<PetProfile | null> {
  const pet = await transaction<PetProfile | null>("readwrite", (tx, done) => {
    const collection = tx.objectStore("pets_collection");
    const req = collection.get(id);
    req.onsuccess = () => {
      if (!req.result) return done(null);
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

export async function setCurrentAction(action: PetAction, syncNative = true) {
  const pet = await loadPet();
  if (!pet) return;
  await updatePetAction(pet.id, action);
  if (syncNative) await invoke("set_native_pet_action", { action });
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
