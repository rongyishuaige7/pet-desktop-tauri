import { mergeStateEvent, pickNewestState } from "./native-pet-state";
import type {
  InteractionKind,
  InteractionResult,
  NativePetState,
  PreferenceRequest
} from "./native-pet-types";

export interface NativePetClientDeps {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;
}

export interface NativePetClient {
  start: (onState: (state: NativePetState) => void) => Promise<void>;
  dispose: () => void;
  refresh: () => Promise<NativePetState>;
  update: (request: PreferenceRequest) => Promise<NativePetState>;
  interact: (kind: InteractionKind, petId: string | null) => Promise<InteractionResult>;
  attach: (
    rootDir: string,
    petId: string | null,
    petName: string | null
  ) => Promise<NativePetState>;
  detach: () => Promise<void>;
  setName: (name: string) => Promise<void>;
  setAction: (action: string) => Promise<void>;
}

/**
 * Subscribes before the first snapshot and merges buffered events by
 * session/revision, so a slow read can never overwrite a newer event.
 */
export function createNativePetClient(deps: NativePetClientDeps): NativePetClient {
  let current: NativePetState | null = null;
  let buffered: NativePetState[] = [];
  let ready = false;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let onChange: ((state: NativePetState) => void) | null = null;

  function apply(next: NativePetState) {
    const merged = mergeStateEvent(current, next);
    if (merged === current) return;
    current = merged;
    onChange?.(merged);
  }

  async function start(onState: (state: NativePetState) => void) {
    onChange = onState;
    unlisten = await deps.listen<NativePetState>("native-pet-state-changed", (payload) => {
      if (disposed) return;
      if (!ready) {
        buffered.push(payload);
        return;
      }
      apply(payload);
    });
    const snapshot = await deps.invoke<NativePetState>("get_native_pet_state");
    if (disposed) return;
    ready = true;
    current = pickNewestState(snapshot, buffered);
    buffered = [];
    onChange?.(current);
  }

  async function refresh() {
    const snapshot = await deps.invoke<NativePetState>("get_native_pet_state");
    apply(snapshot);
    return current as NativePetState;
  }

  async function update(request: PreferenceRequest) {
    try {
      const next = await deps.invoke<NativePetState>("update_native_pet_preferences", {
        request
      });
      apply(next);
      return next;
    } catch (error) {
      await refresh().catch(() => undefined);
      throw error;
    }
  }

  async function interact(kind: InteractionKind, petId: string | null) {
    const result = await deps.invoke<InteractionResult>("interact_native_pet", {
      kind,
      petId
    });
    apply(result.state);
    return result;
  }

  async function attach(rootDir: string, petId: string | null, petName: string | null) {
    const next = await deps.invoke<NativePetState>("set_native_pet_frame_root", {
      rootDir,
      petId,
      petName
    });
    apply(next);
    return next;
  }

  async function detach() {
    await deps.invoke<void>("detach_native_pet");
    await refresh().catch(() => undefined);
  }

  async function setName(name: string) {
    await deps.invoke<void>("set_native_pet_name", { name });
  }

  async function setAction(action: string) {
    await deps.invoke("set_native_pet_action", { action });
  }

  function dispose() {
    disposed = true;
    unlisten?.();
    unlisten = null;
  }

  return { start, dispose, refresh, update, interact, attach, detach, setName, setAction };
}
