import type { PetAction } from "./types";

export const DEFAULT_PRESET_FRAME_DIR = "./frame-pack";
export const PRESET_FRAME_DIR_STORAGE = "desktop-sticker-pet:preset-frame-dir";
export const PET_ZOOM_STORAGE = "desktop-sticker-pet:zoom";
export const UPLOAD_URL_STORAGE = "desktop-sticker-pet:upload-url";

export interface ActionTiming {
  /** Milliseconds each frame stays on screen. */
  frameMs: number;
  loop: boolean;
  /** After the last frame, hand control back to this action. */
  returnTo?: PetAction;
}

/**
 * Playback behaviour per action, mirrored by `frame_interval_ms` and
 * `one_shot_next` on the Rust side.
 *
 * `jump` and `happy` are one-shots: looping them made the pet hop forever.
 * `sit` and `sleep` are resting states and deliberately hold their last frame.
 */
export const ACTION_TIMING: Record<PetAction, ActionTiming> = {
  idle: { frameMs: 150, loop: true },
  walk: { frameMs: 150, loop: true },
  jump: { frameMs: 110, loop: false, returnTo: "idle" },
  happy: { frameMs: 130, loop: false, returnTo: "idle" },
  sit: { frameMs: 160, loop: false },
  sleep: { frameMs: 420, loop: false }
};
