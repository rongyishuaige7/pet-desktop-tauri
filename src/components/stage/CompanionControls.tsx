import React from "react";
import type { NativePetState, SnoozeMinutes } from "../../native-pet-types";
import { formatSnoozeTime, statusText } from "../../native-pet-state";
import { useSnoozeRemaining } from "../../use-snooze-remaining";
import { SnoozeMenu } from "./SnoozeMenu";

interface CompanionControlsProps {
  state: NativePetState;
  webMode: boolean;
  busy?: boolean;
  onToggleVisibility: () => void;
  onSnooze: (minutes: SnoozeMinutes) => void;
  onKeepHidden: () => void;
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
  onKeepHidden,
  onOpenSettings,
  showStatus = true
}) => {
  const snoozed = state.visibilityMode === "snoozed";
  const shown = state.visibilityMode === "shown";
  const hasPet = Boolean(state.petId);
  const ready = state.availability === "ready";
  const disabled = busy || !hasPet || !ready;
  const remaining = useSnoozeRemaining(state);

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
          {snoozed ? "提前唤回" : shown ? "暂时收起" : "立即唤回"}
        </button>
        <SnoozeMenu
          snoozed={snoozed}
          busy={disabled}
          onSnooze={onSnooze}
          onKeepHidden={onKeepHidden}
        />
        {onOpenSettings && (
          <button type="button" className="btn-secondary" onClick={onOpenSettings}>
            ⚙️ 偏好设置
          </button>
        )}
      </div>

      <p className="companion-control-note">
        收起不会移除伙伴。你随时可以从菜单栏 / 托盘找回它。
      </p>
      {snoozed && state.snoozeUntilMs && (
        <p className="companion-control-note">
          到 {formatSnoozeTime(state.snoozeUntilMs)} 自动回来
          {remaining !== null ? ` · 约剩 ${remaining} 分钟` : ""}。到期由系统处理，不会自动恢复已暂停的动画。
        </p>
      )}
    </div>
  );
};
