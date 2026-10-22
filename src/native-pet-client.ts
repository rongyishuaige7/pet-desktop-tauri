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

  function apply(next: NativePetState): NativePetState {
    // Copy snapshots: callers and test doubles may reuse one mutable object.
    const candidate = { ...next };
    const merged = mergeStateEvent(current, candidate);
    if (
      current &&
      merged.sessionId === current.sessionId &&
      merged.revision === current.revision
    ) {
      return current;
    }
    current = merged;
    onChange?.(merged);
    return merged;
  }

  function resolveSnapshot(snapshot: NativePetState): NativePetState {
    ready = true;
    const picked = pickNewestState(snapshot, buffered);
    buffered = [];
    const merged = current ? mergeStateEvent(current, { ...picked }) : { ...picked };
    current = merged;
    onChange?.(merged);
    return merged;
  }

  async function ensureSubscription() {
    if (unlisten) return;
    unlisten = await deps.listen<NativePetState>("native-pet-state-changed", (payload) => {
      if (disposed) return;
      if (!ready) {
        buffered.push(payload);
        return;
      }
      apply(payload);
    });
  }

  async function start(onState: (state: NativePetState) => void) {
    onChange = onState;
    await ensureSubscription();
    const snapshot = await deps.invoke<NativePetState>("get_native_pet_state");
    if (disposed) return;
    resolveSnapshot(snapshot);
  }

  async function refresh() {
    // A first query may have failed after the subscription was installed.
    // Reuse that subscription, replay buffered events and mark the stream ready.
    await ensureSubscription();
    const snapshot = await deps.invoke<NativePetState>("get_native_pet_state");
    if (disposed) throw new Error("原生桌宠连接已关闭");
    return resolveSnapshot(snapshot);
  }

  async function update(request: PreferenceRequest) {
    try {
      const next = await deps.invoke<NativePetState>("update_native_pet_preferences", {
        request
      });
      return apply(next);
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
    return { ...result, state: apply(result.state) };
  }

  async function attach(rootDir: string, petId: string | null, petName: string | null) {
    const next = await deps.invoke<NativePetState>("set_native_pet_frame_root", {
      rootDir,
      petId,
      petName
    });
    return apply(next);
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
