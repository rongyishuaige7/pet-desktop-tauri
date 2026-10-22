import React from "react";
import type { NativePetState } from "../../native-pet-types";
import { statusText } from "../../native-pet-state";

interface CompanionControlsProps {
  state: NativePetState;
  webMode: boolean;
  busy?: boolean;
  onToggleVisibility: () => void;
  onSnooze: () => void;
  onOpenSettings?: () => void;
  showStatus?: boolean;
}

/**
 * Visibility intent only. It never claims a result the native side has not
 * confirmed: the label follows `visibilityMode` from the latest snapshot.
 */
export const CompanionControls: React.FC<CompanionControlsProps> = ({
  state,
  webMode,
  busy = false,
  onToggleVisibility,
  onSnooze,
  onOpenSettings,
  showStatus = true
}) => {
  const shown = state.visibilityMode === "shown";
  const snoozed = state.visibilityMode === "snoozed";
  const hasPet = Boolean(state.petId);
  const ready = state.availability === "ready";
  const disabled = busy || !hasPet || !ready;

  return (
    <div className="section-card companion-controls" aria-label="陪伴控制">
      <div className="section-title">
        <span>陪伴控制</span>
        {showStatus && (
          <span className="companion-status" role="status">
            <span className="status-dot" aria-hidden="true" />
            {statusText(state)}
            {webMode && <span className="web-demo-tag">网页演示</span>}
          </span>
        )}
      </div>

      <div className="companion-control-buttons">
        <button
          type="button"
          className="btn-secondary"
          onClick={onToggleVisibility}
          disabled={disabled}
          title={shown ? "隐藏桌面伙伴，但保留资料" : "把当前伙伴叫回桌面"}
        >
          {shown ? "暂时收起" : "立即唤回"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onSnooze}
          disabled={disabled}
          title={snoozed ? "提前结束休息并唤回伙伴" : "休息一小时，到期自动回来"}
        >
          {snoozed ? "提前唤回" : "休息一小时"}
        </button>
        {onOpenSettings && (
          <button type="button" className="btn-secondary" onClick={onOpenSettings}>
            ⚙️ 偏好设置
          </button>
        )}
      </div>

      <p className="companion-control-note">
        收起不会移除伙伴。你随时可以从菜单栏 / 托盘找回它。
        {state.pending && " 正在同步…"}
      </p>
      {state.visibilityMode === "snoozed" && state.snoozeUntilMs && (
        <p className="companion-control-note">
          休息期间不播放动画，也不会自己醒来；到期后只恢复当前健康的伙伴。
        </p>
      )}
    </div>
  );
};
