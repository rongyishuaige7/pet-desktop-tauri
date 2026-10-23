import React, { useEffect, useId, useRef, useState } from "react";
import type { SnoozeMinutes } from "../../native-pet-types";

interface SnoozeMenuProps {
  snoozed: boolean;
  busy?: boolean;
  compact?: boolean;
  onSnooze: (minutes: SnoozeMinutes) => void;
  onKeepHidden: () => void;
}

const DURATIONS: SnoozeMinutes[] = [15, 30, 60];

/**
 * Non-modal duration picker. Opening or closing it sends nothing; only a named
 * duration (or the explicit keep-hidden choice) calls back.
 */
export const SnoozeMenu: React.FC<SnoozeMenuProps> = ({
  snoozed,
  busy = false,
  compact = false,
  onSnooze,
  onKeepHidden
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const focusFirst = () => {
      const first = menuRef.current?.querySelector<HTMLButtonElement>("button");
      first?.focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []
      );
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex =
        event.key === "ArrowDown"
          ? (index + 1 + items.length) % items.length
          : (index - 1 + items.length) % items.length;
      event.preventDefault();
      items[nextIndex].focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function choose(minutes: SnoozeMinutes) {
    setOpen(false);
    onSnooze(minutes);
  }

  function keepHidden() {
    setOpen(false);
    onKeepHidden();
  }

  return (
    <div className={`snooze-menu ${compact ? "is-compact" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn-secondary ${compact ? "pet-card-action" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        {snoozed ? "调整休息…" : "休息…"}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="snooze-menu-popover"
          role="menu"
          aria-label={snoozed ? "调整休息时长" : "选择休息时长"}
        >
          <p className="snooze-menu-title">
            {snoozed ? "从现在重新计时" : "休息多久？"}
          </p>
          {DURATIONS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              role="menuitem"
              onClick={() => choose(minutes)}
            >
              {minutes} 分钟
            </button>
          ))}
          {snoozed && (
            <>
              <div className="snooze-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="snooze-menu-keep"
                onClick={keepHidden}
              >
                保持收起
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
