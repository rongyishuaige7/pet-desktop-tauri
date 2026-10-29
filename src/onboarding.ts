import type { PetProfile } from "./types";

export type OnboardingState = "in_progress" | "completed" | "dismissed";
export type OnboardingStep = "choose" | "name" | "meet";
export type AdoptionPhase = "draft" | "prepared" | "committed";

export const ONBOARDING_KEY = "onboarding_v1";
export const ONBOARDING_VERSION = 1;
export const DEFAULT_PET_NAME = "奶蛙";
export const BUILTIN_PRESET_ID = "naiwa";
export const MAX_PET_NAME_LENGTH = 20;

export interface OnboardingRecord {
  version: number;
  state: OnboardingState;
  step: OnboardingStep;
  draftName: string;
  presetId: string;
  confirmedPetId: string | null;
  adoptionId: string | null;
  pendingPetId: string | null;
  previousActivePetId: string | null;
  phase: AdoptionPhase | null;
  /** One explicit adoption intent; stale windows keep the intent they loaded. */
  intentId: string | null;
  /** False until the native window confirms the committed pet is visible. */
  displayConfirmed: boolean;
  /** Monotonic version for progress writes within one adoption intent. */
  progressRevision: number;
  updatedAt: string;
}

export interface OnboardingStart {
  kind: "show" | "complete" | "clean";
  record: OnboardingRecord;
  step: OnboardingStep;
}

export function createOnboardingRecord(
  overrides: Partial<OnboardingRecord> = {}
): OnboardingRecord {
  return {
    version: ONBOARDING_VERSION,
    state: "in_progress",
    step: "choose",
    draftName: DEFAULT_PET_NAME,
    presetId: BUILTIN_PRESET_ID,
    confirmedPetId: null,
    adoptionId: null,
    pendingPetId: null,
    previousActivePetId: null,
    phase: null,
    intentId: crypto.randomUUID(),
    displayConfirmed: true,
    progressRevision: 0,
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function isState(value: unknown): value is OnboardingState {
  return value === "in_progress" || value === "completed" || value === "dismissed";
}

function isStep(value: unknown): value is OnboardingStep {
  return value === "choose" || value === "name" || value === "meet";
}

function isPhase(value: unknown): value is AdoptionPhase {
  return value === "draft" || value === "prepared" || value === "committed";
}

function idOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Returns null for records that cannot be trusted; callers must not treat that as a clean install. */
export function normalizeOnboardingRecord(value: unknown): OnboardingRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isState(record.state) || !isStep(record.step)) return null;
  const draftName =
    typeof record.draftName === "string"
      ? record.draftName.slice(0, MAX_PET_NAME_LENGTH)
      : DEFAULT_PET_NAME;
  return {
    version: ONBOARDING_VERSION,
    state: record.state,
    step: record.step,
    draftName,
    presetId: typeof record.presetId === "string" && record.presetId ? record.presetId : BUILTIN_PRESET_ID,
    confirmedPetId: idOrNull(record.confirmedPetId),
    adoptionId: idOrNull(record.adoptionId),
    pendingPetId: idOrNull(record.pendingPetId),
    previousActivePetId: idOrNull(record.previousActivePetId),
    phase: isPhase(record.phase) ? record.phase : null,
    intentId: idOrNull(record.intentId),
    // Records written before this field existed are treated as confirmed; only
    // a committed adoption can write false.
    displayConfirmed:
      typeof record.displayConfirmed === "boolean" ? record.displayConfirmed : true,
    progressRevision:
      typeof record.progressRevision === "number" &&
      Number.isFinite(record.progressRevision) &&
      record.progressRevision >= 0
        ? Math.floor(record.progressRevision)
        : 0,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
  };
}

/**
 * Decides the first screen from persisted facts, never from "the list is empty".
 * An initialized collection or any existing profile is an existing user, even
 * when the user deliberately removed every pet.
 */
export function decideOnboardingStart({
  record,
  initialized,
  pets,
  activePetId
}: {
  record: OnboardingRecord | null;
  initialized: boolean;
  pets: PetProfile[];
  activePetId: string | null;
}): OnboardingStart {
  if (record) {
    if (record.state !== "in_progress") {
      return { kind: "complete", record, step: "meet" };
    }

    // While an adoption is prepared or committed, the pending profile is the
    // draft. A previous confirmed pet must not turn a new draft into its meet
    // screen (for example after starting a second adoption and refreshing).
    const pending =
      record.phase === "prepared" || record.phase === "committed"
        ? record.pendingPetId ?? record.confirmedPetId
        : record.confirmedPetId;
    if (pending && pets.some((pet) => pet.id === pending)) {
      return {
        kind: "show",
        record: { ...record, confirmedPetId: pending, step: "meet" },
        step: "meet"
      };
    }

    if (record.phase === "committed") {
      // The confirmed pet was deleted on purpose: finish without recreating it.
      return {
        kind: "complete",
        record: {
          ...record,
          state: "completed",
          step: "meet",
          confirmedPetId: null
        },
        step: "meet"
      };
    }

    return {
      kind: "show",
      record: { ...record, step: record.step === "choose" ? "choose" : "name" },
      step: record.step === "choose" ? "choose" : "name"
    };
  }

  if (initialized || pets.length > 0) {
    return {
      kind: "complete",
      record: createOnboardingRecord({
        state: "completed",
        step: "meet",
        confirmedPetId: activePetId
      }),
      step: "meet"
    };
  }

  return {
    kind: "clean",
    record: createOnboardingRecord({ state: "in_progress", step: "choose" }),
    step: "choose"
  };
}

export interface AdoptionPlan {
  record: OnboardingRecord;
  adoptionId: string;
  pendingPetId: string;
  previousActivePetId: string | null;
  name: string;
}

/**
 * Reuses the adoption id and pending pet id from a prepared record so retries,
 * refreshes and a second window all converge on one profile.
 */
export function prepareAdoption(
  record: OnboardingRecord,
  name: string,
  previousActivePetId: string | null,
  idFactory: () => string = () => crypto.randomUUID()
): AdoptionPlan {
  const trimmed = name.trim().slice(0, MAX_PET_NAME_LENGTH);
  if (!trimmed) {
    throw new Error("给伙伴起个名字，或直接使用奶蛙");
  }
  const adoptionId = record.adoptionId ?? idFactory();
  const pendingPetId = record.pendingPetId ?? idFactory();
  return {
    adoptionId,
    pendingPetId,
    previousActivePetId: record.previousActivePetId ?? previousActivePetId,
    name: trimmed,
    record: {
      ...record,
      state: "in_progress",
      step: "name",
      draftName: trimmed,
      adoptionId,
      pendingPetId,
      previousActivePetId: record.previousActivePetId ?? previousActivePetId,
      phase: "prepared",
      displayConfirmed: true,
      updatedAt: new Date().toISOString()
    }
  };
}

export function markAdoptionCommitted(
  record: OnboardingRecord,
  petId: string
): OnboardingRecord {
  return {
    ...record,
    state: "in_progress",
    step: "meet",
    confirmedPetId: petId,
    phase: "committed",
    displayConfirmed: false,
    updatedAt: new Date().toISOString()
  };
}

export function completeOnboarding(
  record: OnboardingRecord,
  petId: string | null
): OnboardingRecord {
  return {
    ...record,
    state: "completed",
    step: "meet",
    confirmedPetId: petId ?? record.confirmedPetId,
    phase: record.phase ?? "committed",
    displayConfirmed: true,
    updatedAt: new Date().toISOString()
  };
}

/**
 * A save reply may only replace the form when the name was not edited while
 * the write was in flight. The record's intent must still match as well.
 */
export function keepNewerDraftName(
  saved: OnboardingRecord,
  current: OnboardingRecord | null,
  editSeqAtCall: number,
  editSeqNow: number
): OnboardingRecord {
  if (
    editSeqNow !== editSeqAtCall &&
    current &&
    current.intentId === saved.intentId
  ) {
    return { ...saved, draftName: current.draftName };
  }
  return saved;
}
