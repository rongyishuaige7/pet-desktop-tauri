import { DEFAULT_PRESET_FRAME_DIR } from "./config";
import type { PetSpecies } from "./types";

export interface BuiltinPreset {
  id: string;
  name: string;
  description: string;
  frameRoot: string;
  species: PetSpecies;
  thumbnail: string;
}

/**
 * The first release ships one complete role. New roles join this static list
 * only after their frames and action coverage are reviewed.
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "guji",
    name: "咕唧",
    description: "一个安静陪着你的桌面伙伴。圆圆的肚子，有一点好奇，也喜欢收到摸摸。",
    frameRoot: DEFAULT_PRESET_FRAME_DIR,
    species: "dog",
    thumbnail: "/frame-pack/idle/000.png"
  }
];

export const DEFAULT_PRESET = BUILTIN_PRESETS[0];

export function findPreset(id: string | null | undefined): BuiltinPreset {
  return BUILTIN_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET;
}
