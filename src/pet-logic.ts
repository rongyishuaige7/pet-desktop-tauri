import { PET_ACTIONS, type PetAction, type PetProfile } from "./types";

export function normalizeZoom(value: number) {
  return Math.min(150, Math.max(50, Number.isFinite(value) ? Math.round(value) : 100));
}

export function isPetAction(value: unknown): value is PetAction {
  return typeof value === "string" && PET_ACTIONS.some((action) => action.id === value);
}

export function hasRenderableFrames(pet: PetProfile) {
  return PET_ACTIONS.every((action) => (pet.actions[action.id]?.length ?? 0) > 0);
}

export function withCurrentAction(
  pet: PetProfile,
  action: PetAction,
  startedAt = new Date().toISOString()
): PetProfile {
  return {
    ...pet,
    currentAction: action,
    actionStartedAt: startedAt
  };
}
