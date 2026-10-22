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

    expect(received.at(-1)).toStrictEqual(newer);
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
    expect(received.at(-1)).toStrictEqual(next);
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
    expect(received.at(-1)).toStrictEqual(refreshed);
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
    expect(received.at(-1)).toStrictEqual(restarted);
    client.dispose();
  });
});

describe("native pet client recovery and races", () => {
  it("recovers a failed first query, marks the stream ready and replays buffered events", async () => {
    const initial = baseState({ revision: 3, visibilityMode: "hidden", visible: false });
    let handler: ((payload: NativePetState) => void) | null = null;
    let reads = 0;
    const client = createNativePetClient(
      deps(
        vi.fn(async (command: string) => {
          if (command !== "get_native_pet_state") throw new Error(`unexpected ${command}`);
          reads += 1;
          if (reads === 1) throw new Error("connection refused");
          return initial;
        }),
        vi.fn(async (_event: string, next: (payload: unknown) => void) => {
          handler = next as (payload: NativePetState) => void;
          return () => undefined;
        })
      )
    );
    const received: NativePetState[] = [];
    await expect(client.start((state) => received.push(state))).rejects.toThrow("connection refused");
    handler!({ ...initial, revision: 4, visibilityMode: "hidden" });
    const refreshed = await client.refresh();
    expect(refreshed.revision).toBe(4);
    expect(received.at(-1)?.revision).toBe(4);
    handler!({ ...initial, revision: 5, visibilityMode: "snoozed" });
    expect(received.at(-1)?.revision).toBe(5);
  });

  it("returns the merged state when a command reply is older than an event", async () => {
    const initial = baseState({ revision: 10 });
    let handler: ((payload: NativePetState) => void) | null = null;
    const client = createNativePetClient(
      deps(
        vi.fn(async (command: string) => {
          if (command === "get_native_pet_state") return initial;
          if (command === "update_native_pet_preferences") {
            handler!({ ...initial, revision: 12, visibilityMode: "hidden", visible: false });
            return { ...initial, revision: 11, visibilityMode: "shown", visible: true };
          }
          throw new Error(`unexpected ${command}`);
        }),
        vi.fn(async (_event: string, next: (payload: unknown) => void) => {
          handler = next as (payload: NativePetState) => void;
          return () => undefined;
        })
      )
    );
    const received: NativePetState[] = [];
    await client.start((state) => received.push(state));
    const result = await client.update({ kind: "hide" });
    expect(result.revision).toBe(12);
    expect(result.visibilityMode).toBe("hidden");
    expect(received.at(-1)?.revision).toBe(12);
  });

  it("forwards the retry target and snapshot version without rewriting them", async () => {
    const initial = baseState({ revision: 10, petId: "pet-b" });
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = createNativePetClient(
      deps(
        vi.fn(async (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          if (command === "get_native_pet_state") return initial;
          if (command === "update_native_pet_preferences") {
            return { ...initial, revision: 11, visible: true };
          }
          throw new Error(`unexpected ${command}`);
        }),
        vi.fn(async () => () => undefined)
      )
    );
    await client.start(() => undefined);
    await client.update({
      kind: "show",
      expectedPetId: "pet-b",
      expectedState: { sessionId: "mock-session", revision: 10 }
    });
    const request = calls.find(
      (call) => call.command === "update_native_pet_preferences"
    )?.args?.request;
    expect(request).toEqual({
      kind: "show",
      expectedPetId: "pet-b",
      expectedState: { sessionId: "mock-session", revision: 10 }
    });
  });

  it("targets detach and exposes the latest state to late retries", async () => {
    const initial = baseState({ revision: 10, petId: "pet-b" });
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = createNativePetClient(
      deps(
        vi.fn(async (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          if (command === "get_native_pet_state") return initial;
          if (command === "detach_native_pet") return;
          throw new Error(`unexpected ${command}`);
        }),
        vi.fn(async () => () => undefined)
      )
    );
    await client.start(() => undefined);
    expect(client.currentState()?.petId).toBe("pet-b");
    await client.detach("pet-b");
    expect(
      calls.find((call) => call.command === "detach_native_pet")?.args
    ).toEqual({ expectedPetId: "pet-b" });
    expect(client.currentState()?.petId).toBe("pet-b");
  });
});
