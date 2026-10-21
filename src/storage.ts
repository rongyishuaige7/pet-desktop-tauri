import { invoke } from "@tauri-apps/api/core";
import { PET_CHANNEL, STORAGE_KEY, type PetAction, type PetProfile } from "./types";

const DB_NAME = "desktop-sticker-pet-db";
const DB_VERSION = 2;
const STORE_NAME = "pet";
const STORE_COLLECTION = "pets_collection";
const STORE_META = "metadata";
const SINGLETON_KEY = "current";
const ACTIVE_ID_KEY = "active_pet_id";

export async function loadPet(): Promise<PetProfile | null> {
  const db = await openDatabase();

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_META, STORE_COLLECTION, STORE_NAME], "readonly");
      const metaStore = tx.objectStore(STORE_META);
      const getActiveReq = metaStore.get(ACTIVE_ID_KEY);

      getActiveReq.onsuccess = () => {
        const activeId = getActiveReq.result as string | undefined;
        if (activeId) {
          const colStore = tx.objectStore(STORE_COLLECTION);
          const getPetReq = colStore.get(activeId);
          getPetReq.onsuccess = () => {
            if (getPetReq.result) {
              resolve(getPetReq.result as PetProfile);
              return;
            }
            fallbackToLegacy(tx, resolve);
          };
          getPetReq.onerror = () => fallbackToLegacy(tx, resolve);
        } else {
          fallbackToLegacy(tx, resolve);
        }
      };

      getActiveReq.onerror = () => fallbackToLegacy(tx, resolve);
    } catch {
      resolve(null);
    }
  });
}

function fallbackToLegacy(tx: IDBTransaction, resolve: (pet: PetProfile | null) => void) {
  const legacyStore = tx.objectStore(STORE_NAME);
  const req = legacyStore.get(SINGLETON_KEY);
  req.onsuccess = () => resolve((req.result as PetProfile | undefined) ?? null);
  req.onerror = () => resolve(null);
}

export async function loadAllPets(): Promise<PetProfile[]> {
  const db = await openDatabase();

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_COLLECTION, STORE_NAME], "readonly");
      const colStore = tx.objectStore(STORE_COLLECTION);
      const req = colStore.getAll();

      req.onsuccess = () => {
        const pets = (req.result as PetProfile[] | undefined) ?? [];
        if (pets.length > 0) {
          resolve(pets);
          return;
        }

        // Fallback to legacy single pet if collection is empty
        const legacyStore = tx.objectStore(STORE_NAME);
        const legacyReq = legacyStore.get(SINGLETON_KEY);
        legacyReq.onsuccess = () => {
          const single = legacyReq.result as PetProfile | undefined;
          resolve(single ? [single] : []);
        };
        legacyReq.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function savePet(pet: PetProfile, broadcastPet: PetProfile = pet) {
  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, STORE_COLLECTION, STORE_META], "readwrite");
    tx.objectStore(STORE_NAME).put(pet, SINGLETON_KEY);
    tx.objectStore(STORE_COLLECTION).put(pet);
    tx.objectStore(STORE_META).put(pet.id, ACTIVE_ID_KEY);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  localStorage.removeItem(STORAGE_KEY);
  notifyPetChanged(broadcastPet);
}

export async function setActivePetId(id: string): Promise<PetProfile | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_COLLECTION, STORE_NAME, STORE_META], "readwrite");
    const colStore = tx.objectStore(STORE_COLLECTION);
    const getReq = colStore.get(id);

    getReq.onsuccess = () => {
      const pet = getReq.result as PetProfile | undefined;
      if (!pet) {
        resolve(null);
        return;
      }
      tx.objectStore(STORE_META).put(id, ACTIVE_ID_KEY);
      tx.objectStore(STORE_NAME).put(pet, SINGLETON_KEY);
      tx.oncomplete = () => {
        notifyPetChanged(pet);
        resolve(pet);
      };
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deletePet(id: string): Promise<PetProfile | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_COLLECTION, STORE_NAME, STORE_META], "readwrite");
    const colStore = tx.objectStore(STORE_COLLECTION);
    colStore.delete(id);

    const metaStore = tx.objectStore(STORE_META);
    const getActiveReq = metaStore.get(ACTIVE_ID_KEY);

    getActiveReq.onsuccess = () => {
      const activeId = getActiveReq.result as string | undefined;
      if (activeId === id) {
        // Need to switch active pet to another one
        const getAllReq = colStore.getAll();
        getAllReq.onsuccess = () => {
          const remaining = (getAllReq.result as PetProfile[] | undefined) ?? [];
          const nextActive = remaining[0] ?? null;
          if (nextActive) {
            metaStore.put(nextActive.id, ACTIVE_ID_KEY);
            tx.objectStore(STORE_NAME).put(nextActive, SINGLETON_KEY);
            tx.oncomplete = () => {
              notifyPetChanged(nextActive);
              resolve(nextActive);
            };
          } else {
            metaStore.delete(ACTIVE_ID_KEY);
            tx.objectStore(STORE_NAME).delete(SINGLETON_KEY);
            tx.oncomplete = () => resolve(null);
          }
        };
      } else {
        tx.oncomplete = () => resolve(null);
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function setCurrentAction(action: PetAction, syncNative = true) {
  const pet = await loadPet();
  if (!pet) return;
  await savePet({ ...pet, currentAction: action, actionStartedAt: new Date().toISOString() });
  if (syncNative) {
    await invoke("set_native_pet_action", { action }).catch(() => undefined);
  }
}

export function notifyPetChanged(pet: PetProfile) {
  window.dispatchEvent(new CustomEvent("pet-updated", { detail: pet }));

  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(PET_CHANNEL);
    channel.postMessage({ type: "pet-updated", pet });
    channel.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_COLLECTION)) {
        db.createObjectStore(STORE_COLLECTION, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
