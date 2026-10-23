import React, { useEffect, useRef, useState } from "react";

interface RemovalUndoProps {
  notice: {
    removalId: string;
    petName: string;
    replacementName: string | null;
    wasActive: boolean;
  };
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

/**
 * At least ten seconds of undo time. Hovering or focusing the banner pauses the
 * countdown; the recent-removal list remains available after it disappears.
 */
export const RemovalUndo: React.FC<RemovalUndoProps> = ({
  notice,
  onUndo,
  onDismiss,
  durationMs = 10_000
}) => {
  const [remaining, setRemaining] = useState(Math.ceil(durationMs / 1000));
  const pausedRef = useRef(false);
  const remainingMsRef = useRef(durationMs);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    remainingMsRef.current = durationMs;
    pausedRef.current = false;
    setRemaining(Math.ceil(durationMs / 1000));
    const timer = window.setInterval(() => {
      if (pausedRef.current) return;
      remainingMsRef.current = Math.max(0, remainingMsRef.current - 250);
      setRemaining(Math.max(0, Math.ceil(remainingMsRef.current / 1000)));
      if (remainingMsRef.current <= 0) {
        window.clearInterval(timer);
        dismissRef.current();
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [notice.removalId, durationMs]);

  return (
    <div
      className="removal-undo"
      role="status"
      aria-live="polite"
      data-remaining={remaining}
      onMouseEnter={() => { pausedRef.current = true; }}
      onMouseLeave={() => { pausedRef.current = false; }}
      onFocus={() => { pausedRef.current = true; }}
      onBlur={() => { pausedRef.current = false; }}
    >
      <div className="removal-undo-body">
        <strong>已把「{notice.petName}」移到最近移除</strong>
        <p>
          {notice.wasActive
            ? notice.replacementName
              ? `当前伙伴由「${notice.replacementName}」接替。`
              : "桌面暂时没有伙伴。"
            : "当前桌面伙伴保持不变。"}
          资料和素材仍在本机，也可以稍后从“最近移除”恢复。
        </p>
      </div>
      <button type="button" className="btn-primary removal-undo-action" onClick={onUndo}>
        撤销
      </button>
      <button
        type="button"
        className="removal-undo-close"
        onClick={onDismiss}
        aria-label="关闭撤销提示"
      >
        ×
      </button>
    </div>
  );
};
