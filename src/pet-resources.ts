import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_PRESET_FRAME_DIR } from "./config";
import { hasRenderableFrames } from "./pet-logic";
import { PET_ACTIONS, type ActionFrameSet, type PetAction, type PetProfile } from "./types";

export interface PresetFramePack { sourceImage: string; actions: ActionFrameSet }
const cache = new Map<string, Promise<PresetFramePack>>();

export function buildDefaultActionFrames(): ActionFrameSet {
  return Object.fromEntries(PET_ACTIONS.map(({ id }) => [id,
    Array.from({ length: 5 }, (_, i) => `/frame-pack/${id}/${String(i).padStart(3, "0")}.png`)
  ])) as ActionFrameSet;
}

export async function hydratePet(pet: PetProfile, desktop: boolean, preferredAction?: PetAction): Promise<PetProfile> {
  let full = pet;
  if (!hasRenderableFrames(pet) || !pet.sourceImage) {
    if (desktop && pet.storageMode === "preset-root") {
      const root = pet.frameRoot?.trim() || DEFAULT_PRESET_FRAME_DIR;
      let pack = cache.get(root);
      if (!pack) {
        pack = invoke<PresetFramePack>("load_preset_frame_pack", { request: { rootDir: root } });
        cache.set(root, pack);
        if (cache.size > 3) cache.delete(cache.keys().next().value!);
        pack.catch(() => { if (cache.get(root) === pack) cache.delete(root); });
      }
      const loaded = await pack;
      full = { ...pet, ...loaded, frameRoot: root };
    } else if (pet.storageMode === "preset-root" && pet.frameRoot === DEFAULT_PRESET_FRAME_DIR) {
      const actions = buildDefaultActionFrames();
      full = { ...pet, actions, sourceImage: actions.idle[0] };
    } else {
      throw new Error(`「${pet.name}」的动作素材缺失，请在工坊重新导入帧包`);
    }
  }
  return { ...full, currentAction: preferredAction ?? pet.currentAction };
}

export function toPersistedPet(pet: PetProfile, desktop: boolean): PetProfile {
  if (!desktop || pet.storageMode !== "preset-root") return pet;
  return { ...pet, thumbnailImage: pet.thumbnailImage || pet.sourceImage,
    sourceImage: "", actions: { idle: [], sit: [], sleep: [], happy: [], walk: [], jump: [] } };
}
