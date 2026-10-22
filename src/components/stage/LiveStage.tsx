import React, { useEffect, useRef, useState } from "react";
import { ACTION_TIMING } from "../../config";
import { PET_ACTIONS, type PetAction, type PetProfile } from "../../types";
import type { NativePetState } from "../../native-pet-types";
import { CompanionControls } from "./CompanionControls";

const ACTION_EMOJIS: Record<PetAction, string> = {
  idle: "😺",
  sit: "🪑",
  sleep: "💤",
  happy: "💖",
  walk: "🐾",
  jump: "🚀"
};

interface LiveStageProps {
  pet: PetProfile | null;
  onSwitchAction: (action: PetAction) => void;
  zoom: number;
  onChangeZoom: (val: number) => void;
  onResetPosition?: () => void;
  isTauri: boolean;
  isMacOS: boolean;
  autonomous: boolean;
  onToggleAutonomous: (value: boolean) => void;
  desktopPaused: boolean;
  onToggleDesktopPaused: () => void;
  autonomousBusy?: boolean;
  nativeState: NativePetState;
  webMode: boolean;
  visibilityBusy?: boolean;
  onToggleVisibility: () => void;
  onSnooze: () => void;
  onOpenSettings?: () => void;
  onRenamePet?: (id: string, newName: string) => void;
  onGoToWorkshop: () => void;
}

export const LiveStage: React.FC<LiveStageProps> = ({
  pet,
  onSwitchAction,
  zoom,
  onChangeZoom,
  onResetPosition,
  isTauri,
  isMacOS,
  autonomous,
  onToggleAutonomous,
  desktopPaused,
  onToggleDesktopPaused,
  autonomousBusy = false,
  nativeState,
  webMode,
  visibilityBusy = false,
  onToggleVisibility,
  onSnooze,
  onOpenSettings,
  onRenamePet,
  onGoToWorkshop
}) => {
  const currentAction = pet?.currentAction ?? "idle";
  const rawFrames = pet?.actions?.[currentAction] ?? pet?.actions?.idle ?? [];
  const frames = rawFrames;
  const timing = ACTION_TIMING[currentAction];
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isRenaming, setIsRenaming] = useState(false);
  const [stageName, setStageName] = useState("");

  const handleConfirmRename = () => {
    if (!pet) return;
    const trimmed = stageName.trim();
    if (trimmed && onRenamePet) {
      onRenamePet(pet.id, trimmed);
    }
    setIsRenaming(false);
  };

  // The parent recreates its handler on every render; keep the timer stable.
  const switchRef = useRef(onSwitchAction);
  useEffect(() => {
    switchRef.current = onSwitchAction;
  }, [onSwitchAction]);

  useEffect(() => {
    setFrameIndex(0);
  }, [pet?.id, currentAction, frames.length, pet?.actionStartedAt]);

  // Warm the cache for every action so switching never flashes a blank frame.
  useEffect(() => {
    if (!pet) return;
    for (const action of PET_ACTIONS) {
      for (const src of pet.actions[action.id] ?? []) {
        const image = new Image();
        image.src = src;
      }
    }
  }, [pet?.id, pet?.actions]);

  useEffect(() => {
    if (!isPlaying || frames.length === 0) return;
    const { frameMs, loop } = timing;

    const timer = window.setInterval(() => {
      setFrameIndex((prev) => {
        if (loop) return (prev + 1) % frames.length;
        return Math.min(prev + 1, frames.length - 1);
      });
    }, frameMs);

    return () => window.clearInterval(timer);
  }, [currentAction, frames.length, isPlaying, pet?.actionStartedAt, timing]);

  const activeIndex = frames.length === 0 ? 0 : Math.min(frameIndex, frames.length - 1);

  // One-shots (jump, happy) return to idle instead of freezing on their last
  // frame; resting states (sit, sleep) intentionally stay where they are.
  useEffect(() => {
    const returnTo = timing.returnTo;
    if (isTauri || !isPlaying || !returnTo || frames.length === 0) return;
    if (activeIndex < frames.length - 1) return;

    const timer = window.setTimeout(() => switchRef.current(returnTo), timing.frameMs);
    return () => window.clearTimeout(timer);
  }, [isTauri, activeIndex, frames.length, isPlaying, timing]);

  return (
    <div className="stage-view-grid">
      <div className="stage-main-card">
        <div className="stage-canvas">
          {pet && (
            <div className="stage-pet-badge">
              {isRenaming ? (
                <div className="stage-rename-bar">
                  <input
                    type="text"
                    className="stage-rename-input"
                    value={stageName}
                    onChange={(e) => setStageName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) handleConfirmRename();
                      if (e.key === "Escape") setIsRenaming(false);
                    }}
                    autoFocus
                    maxLength={20}
                    placeholder="输入宠物名..."
                  />
                  <button type="button" className="btn-icon-save" onClick={handleConfirmRename} title="确定">✓</button>
                  <button type="button" className="btn-icon-cancel" onClick={() => setIsRenaming(false)} title="取消">✕</button>
                </div>
              ) : (
                <div className="stage-badge-content">
                  <span className="stage-badge-icon">{pet.species === "cat" ? "🐱" : "🐾"}</span>
                  <span className="stage-badge-name">{pet.name}</span>
                  {onRenamePet && (
                    <button
                      type="button"
                      className="stage-rename-btn"
                      onClick={() => {
                        setIsRenaming(true);
                        setStageName(pet.name);
                      }}
                      title="重命名当前宠物"
                    >
                      ✏️
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {pet && frames.length > 0 ? (
            <div
              className="canvas-pet-scaler"
              style={{
                transform: `scale(${zoom / 100})`
              }}
            >
              <img
                src={frames[activeIndex]}
                alt={`${pet.name} ${currentAction}`}
                className="stage-pet-image"
                draggable={false}
              />
            </div>
          ) : (
            <div className="stage-empty-state">
              <span className="stage-empty-icon">🐱</span>
              <p>还没有挑选入住的桌面宠物</p>
              <button
                type="button"
                className="btn-primary"
                style={{ marginTop: "8px", height: "38px" }}
                onClick={onGoToWorkshop}
              >
                前往工坊制作或导入
              </button>
            </div>
          )}
        </div>

        {pet && frames.length > 0 && (
          <div className="playback-bar">
            <button
              type="button"
              className="tool-btn"
              onClick={() => setFrameIndex((prev) => (prev - 1 + frames.length) % frames.length)}
              disabled={isPlaying}
              title="上一帧"
            >
              ⏮
            </button>
            <button
              type="button"
              className="tool-btn primary-tool"
              onClick={() => setIsPlaying(!isPlaying)}
              title={isPlaying ? "暂停动画" : "播放动画"}
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <button
              type="button"
              className="tool-btn"
              onClick={() => setFrameIndex((prev) => (prev + 1) % frames.length)}
              disabled={isPlaying}
              title="下一帧"
            >
              ⏭
            </button>
            <span className="frame-badge">
              {activeIndex + 1} / {frames.length} 帧
            </span>
          </div>
        )}
      </div>

      <div className="actions-panel">
        <CompanionControls
          state={nativeState}
          webMode={webMode}
          busy={visibilityBusy}
          onToggleVisibility={onToggleVisibility}
          onSnooze={onSnooze}
          onOpenSettings={onOpenSettings}
        />

        <div className="section-card">
          <div className="section-title">
            <span>动作自由点选</span>
            <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              {isTauri ? "即时联动桌面" : "网页预览"}
            </span>
          </div>

          <div className="actions-grid">
            {PET_ACTIONS.map((action) => {
              const isActive = pet?.currentAction === action.id;
              return (
                <button
                  key={action.id}
                  type="button"
                  className={`action-pill-btn ${isActive ? "active" : ""}`}
                  onClick={() => onSwitchAction(action.id)}
                  disabled={!pet}
                >
                  <span className="action-emoji">{ACTION_EMOJIS[action.id]}</span>
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="section-card">
          <div className="section-title">
            <span>显示与姿态</span>
          </div>

          <div className="quick-controls">
            <div className="control-row">
              <span>宠物比例</span>
              <div className="slider-container">
                <input
                  type="range"
                  min="50"
                  max="150"
                  value={zoom}
                  onChange={(e) => onChangeZoom(Number(e.target.value))}
                  className="slider-input"
                />
                <span className="slider-val">{zoom}%</span>
              </div>
            </div>

            {isTauri && (
              <div className="control-row" style={{ paddingTop: "6px" }}>
                <span>桌宠动画</span>
                <button
                  type="button"
                  className={`action-sub-btn ${desktopPaused ? "" : "is-on"}`}
                  onClick={onToggleDesktopPaused}
                  aria-pressed={!desktopPaused}
                  title={desktopPaused ? "恢复真实桌宠动画" : "暂停真实桌宠动画，伙伴仍留在桌面"}
                >
                  {desktopPaused ? "▶ 恢复动画" : "⏸ 暂停动画"}
                </button>
              </div>
            )}

            <div className="control-row" style={{ paddingTop: "6px" }}>
              <span>自主活动</span>
              <button
                type="button"
                className={`action-sub-btn ${autonomous ? "is-on" : ""}`}
                onClick={() => onToggleAutonomous(!autonomous)}
                aria-pressed={autonomous}
                disabled={autonomousBusy}
                title="开启后它会自动变换姿态，不移动桌面位置"
              >
                {autonomous ? "🧭 自动变换姿态" : "🧍 固定姿态"}
              </button>
            </div>

            {isTauri && isMacOS && onResetPosition && (
              <div className="control-row" style={{ paddingTop: "6px" }}>
                <span>屏幕位置</span>
                <button type="button" className="action-sub-btn" onClick={onResetPosition}>
                  🎯 叫回右下角
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
