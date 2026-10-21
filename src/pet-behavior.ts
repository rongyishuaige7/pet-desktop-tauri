import type { PetAction } from "./types";

/**
 * Autonomous behaviour for the browser preview.
 *
 * Mirrors `choose_next_action` / `action_duration` in
 * `src-tauri/src/native_pet/mod.rs` so the web preview and the desktop pet
 * wander the same way. Keep the two tables in sync.
 */
const NEXT_ACTIONS: Record<PetAction, PetAction[]> = {
  idle: ["walk", "walk", "sit", "sit", "happy", "sleep"],
  walk: ["idle", "sit"],
  sit: ["idle", "sleep", "happy"],
  sleep: ["idle"],
  happy: ["idle"],
  jump: ["idle"]
};

const DURATION_RANGES: Record<PetAction, [number, number]> = {
  idle: [6_000, 13_000],
  walk: [4_000, 9_000],
  sit: [5_000, 11_000],
  sleep: [15_000, 31_000],
  happy: [2_000, 4_000],
  jump: [6_000, 13_000]
};

export type RandomSource = () => number;

export function chooseNextAction(current: PetAction, random: RandomSource = Math.random): PetAction {
  const choices = NEXT_ACTIONS[current] ?? ["idle"];
  const index = Math.min(choices.length - 1, Math.floor(random() * choices.length));
  return choices[Math.max(0, index)];
}

export function actionDurationMs(action: PetAction, random: RandomSource = Math.random): number {
  const [min, max] = DURATION_RANGES[action] ?? DURATION_RANGES.idle;
  return Math.round(min + random() * (max - min));
}
