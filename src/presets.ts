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
 *
 * `species` stays "dog" for the built-in role: the profile schema predates any
 * non-cat/dog character, and every surface that shows a species treats the
 * bundled pack as “原创伙伴” instead of naming an animal.
 */
export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "naiwa",
    name: "奶蛙",
    description: "夜市摊上的小奶蛙，也想陪你上班。圆眼睛、奶油肚皮，最喜欢被摸摸头。",
    frameRoot: DEFAULT_PRESET_FRAME_DIR,
    species: "dog",
    thumbnail: "/frame-pack/idle/000.png"
  }
];

export const DEFAULT_PRESET = BUILTIN_PRESETS[0];

export function findPreset(id: string | null | undefined): BuiltinPreset {
  return BUILTIN_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET;
}
