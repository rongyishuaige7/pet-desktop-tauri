import type { PetAction } from "./types";

export const DEFAULT_PRESET_FRAME_DIR = "/data/大帅哥小项目/frame-slicer";
export const PRESET_FRAME_DIR_STORAGE = "desktop-sticker-pet:preset-frame-dir";
export const PET_ZOOM_STORAGE = "desktop-sticker-pet:zoom";
export const LOOPING_ACTIONS = new Set<PetAction>(["idle", "walk", "jump"]);
