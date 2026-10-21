import React, { useEffect, useState } from "react";
import { LOOPING_ACTIONS } from "../../config";
import { PET_ACTIONS, type PetAction, type PetProfile } from "../../types";

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
  onGoToWorkshop
}) => {
  const currentAction = pet?.currentAction ?? "idle";
  const frames = pet?.actions[currentAction] ?? pet?.actions.idle ?? [];
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    setFrameIndex(0);
  }, [currentAction, frames.length, pet?.actionStartedAt]);

  useEffect(() => {
    if (!isPlaying || frames.length === 0) return;
    const shouldLoop = LOOPING_ACTIONS.has(currentAction);
    const interval = currentAction === "sleep" ? 420 : 150;

    const timer = window.setInterval(() => {
      setFrameIndex((prev) => {
        if (shouldLoop) return (prev + 1) % frames.length;
        return Math.min(prev + 1, frames.length - 1);
      });
    }, interval);

    return () => window.clearInterval(timer);
  }, [currentAction, frames.length, isPlaying, pet?.actionStartedAt]);

  const activeIndex = frames.length === 0 ? 0 : Math.min(frameIndex, frames.length - 1);

  return (
    <div className="stage-view-grid">
      <div className="stage-main-card">
        <div className="stage-canvas">
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
