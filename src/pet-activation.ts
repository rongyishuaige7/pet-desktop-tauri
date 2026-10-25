import type { NativePetState, NativeStateVersion } from "./native-pet-types";
import type { PetProfile } from "./types";

/**
 * The outcome of selecting a profile. Saving, selecting and displaying are
 * separate confirmations: a failed display must never read as "not saved".
 */
export type ActivationResult =
  | { status: "displayed"; pet: PetProfile; state: NativePetState }
  | { status: "webPreview"; pet: PetProfile }
  | { status: "savedOnly"; pet: PetProfile }
  | {
      status: "displayPending";
      pet: PetProfile;
      retry: DisplayRetryContext;
      code: string;
    }
  | { status: "superseded"; currentPetId: string | null }
  | { status: "selection_unknown" };

export interface DisplayRetryContext {
  operationId: string;
  petId: string;
  petName: string;
  intentId?: string;
  selectionRevision: number;
  nativeVersion: NativeStateVersion | null;
  code: string;
}

/** Rust prefixes operation codes so the interface can react without parsing copy. */
export function parseNativeError(error: unknown): {
  code: string | null;
  message: string;
} {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
  const match = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]+)$/.exec(raw);
  if (!match) return { code: null, message: raw };
  return { code: match[1], message: match[2] };
}

export function nativeStateVersion(
  state: NativePetState | null | undefined
): NativeStateVersion | null {
  if (!state || !state.sessionId || state.sessionId === "pending") return null;
  return { sessionId: state.sessionId, revision: state.revision };
}

/**
 * A retry is only valid while the same profile is still selected under the
 * same explicit selection revision. The native target check runs again in
 * Rust at execution time; this is only the front-end pre-check.
 */
export function displayRetryStillValid(
  context: DisplayRetryContext,
  petIds: string[],
  activePetId: string | null,
  selectionRevision: number
): boolean {
  return (
    petIds.includes(context.petId) &&
    activePetId === context.petId &&
    selectionRevision === context.selectionRevision
  );
}
