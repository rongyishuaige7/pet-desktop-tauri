import { describe, expect, it, vi } from "vitest";
import { createNativePetClient, type NativePetClientDeps } from "./native-pet-client";
import { createWebState } from "./native-pet-state";
import type { NativePetState } from "./native-pet-types";
import type { PetProfile } from "./types";

function pet(): PetProfile {
  return {
    id: "pet-a",
    name: "咕唧",
    species: "dog",
    style: "q-sticker",
    createdAt: "2026-10-21T00:00:00Z",
    sourceImage: "/frame-pack/idle/000.png",
    actions: { idle: [], sit: [], sleep: [], happy: [], walk: [], jump: [] },
    currentAction: "idle",
    actionStartedAt: "2026-10-21T00:00:00Z",
    scale: 1
  };
}

function baseState(overrides: Partial<NativePetState> = {}): NativePetState {
  return { ...createWebState(pet()), ...overrides };
}

function deps(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>
): NativePetClientDeps {
  return {
    invoke: invoke as NativePetClientDeps["invoke"],
    listen: listen as NativePetClientDeps["listen"]
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native pet client", () => {
  it("subscribes first and never lets a slow snapshot overwrite a newer event", async () => {
    const snapshot = deferred<NativePetState>();
    let handler: ((payload: NativePetState) => void) | null = null;
    const client = createNativePetClient(
      deps(
        vi.fn(async (command: string) => {
          if (command === "get_native_pet_state") return snapshot.promise;
          throw new Error(`unexpected ${command}`);
        }),
        vi.fn(async (_event: string, next: (payload: unknown) => void) => {
          handler = next as (payload: NativePetState) => void;
          return () => undefined;
        })
      )
    );

    const received: NativePetState[] = [];
    const started = client.start((state) => received.push(state));
    await Promise.resolve();
    const newer = baseState({ revision: 7, action: "sleep" });
    handler!(newer);
    snapshot.resolve(baseState({ revision: 5, action: "idle" }));
    await started;

    expect(received.at(-1)).toBe(newer);
    expect(received.at(-1)?.action).toBe("sleep");
  });

  it("applies command replies and ignores stale revisions", async () => {
    const initial = baseState({ revision: 10 });
    const client = createNativePetClient(
      deps(
        vi.fn(async (command: string) => {
          if (command === "get_native_pet_state") return initial;
          if (command === "update_native_pet_preferences") {
            return { ...initial, revision: 12, visibilityMode: "hidden", visible: false };
          }
          throw new Error(`unexpected ${command}`);
        }),
        vi.fn(async () => () => undefined)
      )
    );

    const received: NativePetState[] = [];
    await client.start((state) => received.push(state));
    const next = await client.update({ kind: "hide" });
    expect(next.visibilityMode).toBe("hidden");
    expect(received.at(-1)).toBe(next);
  });

  it("refreshes the authoritative state when a command fails", async () => {
    const initial = baseState({ revision: 20 });
    const refreshed = { ...initial, revision: 21, lastOperationError: {
      id: "err-1", operation: "setScale", code: "SETTINGS_WRITE_FAILED", recoverable: true
    } };
    let reads = 0;
    const client = createNativePetClient(
      deps(
        vi.fn(async (command: string) => {
          if (command === "get_native_pet_state") {
            reads += 1;
            return reads === 1 ? initial : refreshed;
          }
          if (command === "update_native_pet_preferences") throw new Error("disk full");
          throw new Error(`unexpected ${command}`);
        }),
        vi.fn(async () => () => undefined)
      )
    );

    const received: NativePetState[] = [];
    await client.start((state) => received.push(state));
    await expect(client.update({ kind: "setScale", value: 1.2 })).rejects.toThrow("disk full");
    expect(reads).toBe(2);
    expect(received.at(-1)).toBe(refreshed);
  });

  it("accepts a restarted process session", async () => {
    const initial = baseState({ revision: 99, sessionId: "old" });
    let handler: ((payload: NativePetState) => void) | null = null;
    const client = createNativePetClient(
      deps(
        vi.fn(async () => initial),
        vi.fn(async (_event: string, next: (payload: unknown) => void) => {
          handler = next as (payload: NativePetState) => void;
          return () => undefined;
        })
      )
    );
    const received: NativePetState[] = [];
    await client.start((state) => received.push(state));
    const restarted = baseState({ revision: 1, sessionId: "new", petId: null });
    handler!(restarted);
    expect(received.at(-1)).toBe(restarted);
    client.dispose();
  });
});
