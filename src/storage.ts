import { invoke } from "@tauri-apps/api/core";
import { PET_CHANNEL, STORAGE_KEY, type PetAction, type PetProfile } from "./types";

const DB_NAME = "desktop-sticker-pet-db";
const DB_VERSION = 1;
const STORE_NAME = "pet";
const SINGLETON_KEY = "current";

export async function loadPet(): Promise<PetProfile | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(SINGLETON_KEY);
    request.onsuccess = () => resolve((request.result as PetProfile | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function savePet(pet: PetProfile, broadcastPet: PetProfile = pet) {
  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(pet, SINGLETON_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  localStorage.removeItem(STORAGE_KEY);
  notifyPetChanged(broadcastPet);
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
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
