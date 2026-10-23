import { useEffect, useState } from "react";
import type { NativePetState } from "./native-pet-types";
import { snoozeRemainingMinutes } from "./native-pet-state";

/**
 * A minute-level label for the snooze expiry. It never writes native state and
 * stops updating while the page is hidden; the native side owns expiry.
 */
export function useSnoozeRemaining(state: NativePetState): number | null {
  const [minutes, setMinutes] = useState<number | null>(() =>
    snoozeRemainingMinutes(state.snoozeUntilMs)
  );

  useEffect(() => {
    if (state.visibilityMode !== "snoozed" || !state.snoozeUntilMs) {
      setMinutes(null);
      return;
    }
    const update = () => {
      if (document.visibilityState !== "visible") return;
      setMinutes(snoozeRemainingMinutes(state.snoozeUntilMs));
    };
    update();
    const timer = window.setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [state.visibilityMode, state.snoozeUntilMs]);

  return state.visibilityMode === "snoozed" ? minutes : null;
}
