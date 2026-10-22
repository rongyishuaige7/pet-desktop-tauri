import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PetProfile } from "./types";
import {
  applyWebPreference,
  createWebState,
  expireWebSnooze,
  syncWebPet,
  webInteraction
} from "./native-pet-state";
import { createNativePetClient, type NativePetClient } from "./native-pet-client";
import type {
  InteractionKind,
  InteractionResult,
  NativePetState,
  PreferenceRequest
} from "./native-pet-types";

function useSystemReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

interface UseNativePetOptions {
  isTauri: boolean;
  pet: PetProfile | null;
  initialAutonomous?: boolean;
}

export interface NativePetController {
  state: NativePetState;
  connected: boolean;
  error: string | null;
  update: (request: PreferenceRequest) => Promise<NativePetState | null>;
  interact: (kind: InteractionKind) => Promise<InteractionResult | null>;
  attach: (
    rootDir: string,
    petId: string | null,
    petName: string | null
  ) => Promise<NativePetState | null>;
  detach: () => Promise<void>;
  setName: (name: string) => Promise<void>;
  setAction: (action: string) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

/**
 * One control surface for the real native service and the browser demo. The
 * desktop branch never invents state: every value comes from a native snapshot.
 */
export function useNativePet({
  isTauri,
  pet,
  initialAutonomous = true
}: UseNativePetOptions): NativePetController {
  const systemReduced = useSystemReducedMotion();
  const [state, setState] = useState<NativePetState>(() => {
    const initial = createWebState(pet, systemReduced, initialAutonomous);
    if (!isTauri) return initial;
    return {
      ...initial,
      sessionId: "pending",
      availability: pet ? "loading" : "absent",
      visible: false,
      effectiveAutonomous: false
    };
  });
  const [connected, setConnected] = useState(!isTauri);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<NativePetClient | null>(null);
  const lastInteractionRef = useRef(-Infinity);
  const petRef = useRef(pet);
  petRef.current = pet;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const client = createNativePetClient({
      invoke: (command, args) => invoke(command, args),
      listen: <T,>(event: string, handler: (payload: T) => void) =>
        listen<T>(event, (received) => handler(received.payload))
    });
    clientRef.current = client;
    client
      .start((next) => {
        if (cancelled) return;
        setState(next);
        setConnected(true);
      })
      .catch((err) => {
        if (!cancelled) setError(`连接桌面伙伴失败：${formatError(err)}`);
      });
    return () => {
      cancelled = true;
      client.dispose();
      clientRef.current = null;
    };
  }, [isTauri]);

  // Browser demo: keep the pet fields aligned with IndexedDB.
  useEffect(() => {
    if (isTauri) return;
    setState((previous) => syncWebPet(previous, pet, systemReduced));
  }, [isTauri, pet?.id, pet?.name, pet?.currentAction, pet?.actionStartedAt, systemReduced]);

  useEffect(() => {
    if (isTauri) return;
    const timer = window.setInterval(() => {
      setState((previous) => expireWebSnooze(previous));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isTauri]);

  const update = useCallback(
    async (request: PreferenceRequest) => {
      if (!isTauri) {
        setState((previous) => applyWebPreference(previous, request));
        return null;
      }
      const client = clientRef.current;
      if (!client) throw new Error("原生桌宠尚未连接");
      try {
        return await client.update(request);
      } catch (err) {
        // Command failures carry their own operation error in the refreshed
        // snapshot; only connection-level failures set the global error.
        throw err;
      }
    },
    [isTauri]
  );

  const interact = useCallback(
    async (kind: InteractionKind): Promise<InteractionResult | null> => {
      if (!isTauri) {
        const interaction = webInteraction(
          stateRef.current,
          kind,
          lastInteractionRef.current
        );
        lastInteractionRef.current = interaction.lastInteractionMs;
        setState(interaction.state);
        return {
          accepted: interaction.accepted,
          reason: interaction.reason,
          state: interaction.state
        };
      }
      const client = clientRef.current;
      if (!client) return null;
      try {
        return await client.interact(kind, petRef.current?.id ?? null);
      } catch (err) {
        setError(formatError(err));
        return null;
      }
    },
    [isTauri]
  );

  const attach = useCallback(
    async (rootDir: string, petId: string | null, petName: string | null) => {
      if (!isTauri) return null;
      const client = clientRef.current;
      if (!client) throw new Error("原生桌宠尚未连接");
      return await client.attach(rootDir, petId, petName);
    },
    [isTauri]
  );

  const detach = useCallback(async () => {
    if (!isTauri) {
      setState((previous) => syncWebPet(previous, null));
      return;
    }
    await clientRef.current?.detach();
  }, [isTauri]);

  const setName = useCallback(
    async (name: string) => {
      if (!isTauri) return;
      await clientRef.current?.setName(name);
    },
    [isTauri]
  );

  const setAction = useCallback(
    async (action: string) => {
      if (!isTauri) return;
      await clientRef.current?.setAction(action);
    },
    [isTauri]
  );

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    const client = clientRef.current;
    if (!client) throw new Error("原生桌宠尚未连接");
    try {
      await client.refresh();
      setError(null);
      setConnected(true);
    } catch (err) {
      setError(formatError(err));
      throw err;
    }
  }, [isTauri]);

  const clearError = useCallback(() => setError(null), []);

  return {
    state,
    connected,
    error,
    update,
    interact,
    attach,
    detach,
    setName,
    setAction,
    refresh,
    clearError
  };
}
