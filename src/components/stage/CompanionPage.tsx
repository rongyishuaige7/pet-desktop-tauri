import React, { useEffect, useMemo, useRef, useState } from "react";
import { ACTION_TIMING } from "../../config";
import {
  canInteract,
  interactionHelp,
  reducedMotion,
  statusText
} from "../../native-pet-state";
import type { InteractionKind, NativePetState } from "../../native-pet-types";
import { PET_ACTIONS, type PetAction, type PetProfile } from "../../types";
import { CompanionControls } from "./CompanionControls";

const ACTION_EMOJIS: Record<PetAction, string> = {
  idle: "😺",
  sit: "🪑",
  sleep: "💤",
  happy: "💖",
  walk: "🐾",
  jump: "🚀"
};

interface CompanionPageProps {
  pet: PetProfile | null;
  state: NativePetState;
  webMode: boolean;
  busy: boolean;
  zoom: number;
  speech: string;
  recovery?: React.ReactNode;
  onInteract: (kind: InteractionKind) => void;
  onSwitchAction: (action: PetAction) => void;
  onChangeZoom: (value: number) => void;
  onToggleVisibility: () => void;
  onSnooze: () => void;
  onTogglePaused: () => void;
  onToggleAutonomous: () => void;
  onOpenSettings: () => void;
  onStartAdoption: () => void;
  onGoToWorkshop: () => void;
  onRenamePet: (id: string, name: string) => void;
}

export const CompanionPage: React.FC<CompanionPageProps> = ({
  pet,
  state,
  webMode,
  busy,
  zoom,
  speech,
  recovery,
  onInteract,
  onSwitchAction,
  onChangeZoom,
  onToggleVisibility,
  onSnooze,
  onTogglePaused,
  onToggleAutonomous,
  onOpenSettings,
  onStartAdoption,
  onGoToWorkshop,
  onRenamePet
}) => {
  const action = pet?.currentAction ?? "idle";
  const frames = pet?.actions?.[action] ?? [];
  const timing = ACTION_TIMING[action] ?? ACTION_TIMING.idle;
  const [frameIndex, setFrameIndex] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(true);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const frozen = state.effectivePaused || !state.visible;
  const interactive = canInteract(state) && !busy;

  useEffect(() => {
    setFrameIndex(0);
  }, [pet?.id, action, pet?.actionStartedAt]);

  useEffect(() => {
    if (!pet) return;
    for (const entry of PET_ACTIONS) {
      for (const src of pet.actions[entry.id] ?? []) {
        const image = new Image();
        image.src = src;
      }
    }
  }, [pet?.id, pet?.actions]);

  useEffect(() => {
    if (!previewPlaying || frozen || frames.length === 0) return;
    const timer = window.setInterval(() => {
      setFrameIndex((previous) => {
        if (timing.loop) return (previous + 1) % frames.length;
        return Math.min(previous + 1, frames.length - 1);
      });
    }, timing.frameMs);
    return () => window.clearInterval(timer);
  }, [previewPlaying, frozen, frames.length, timing.frameMs, timing.loop, action]);

  const activeIndex = frames.length === 0 ? 0 : Math.min(frameIndex, frames.length - 1);
  const portrait = frames[activeIndex] || pet?.sourceImage || "";
  const scalePercent = zoom;
  const help = useMemo(() => interactionHelp(state, webMode), [state, webMode]);

  function commitRename() {
    const trimmed = draftName.trim();
    if (pet && trimmed) onRenamePet(pet.id, trimmed);
    setIsRenaming(false);
  }

  return (
    <div className="companion-page">
      <header className="companion-head">
        <div>
          <div className="eyebrow">一点点陪伴，刚刚好</div>
          <h1 className="companion-title">
            {pet ? `今天，${pet.name}陪着你` : "这里暂时没有伙伴"}
          </h1>
          <p className="companion-subtitle">
            {pet ? "留一点空间，给一位小伙伴。" : "可以领养咕唧，也可以带回你已经制作好的伙伴。"}
          </p>
        </div>
        <div className="companion-head-status">
          <span className={`status-chip ${state.visible ? "is-live" : ""}`}>
            <span className="status-dot" aria-hidden="true" />
            {webMode ? `网页演示 · ${statusText(state)}` : statusText(state)}
          </span>
        </div>
      </header>

      {recovery}

      {pet ? (
        <div className="companion-grid">
          <section className="companion-main">
            <div className="card companion-hero">
              <div className="companion-hero-top">
                <span className="companion-hero-label">伙伴预览</span>
                {state.effectivePaused && (
                  <span className="companion-hero-note">
                    {reducedMotion(state) ? "低动态：画面保持安静" : "动画已暂停"}
                  </span>
                )}
              </div>

              <div className="companion-pet-space">
                <button
                  type="button"
                  className={`companion-pet-button ${interactive ? "" : "is-resting"}`}
                  onClick={() => onInteract("pet")}
                  disabled={!interactive}
                  aria-label={`摸摸${pet.name}`}
                  title={help}
                >
                  {portrait ? (
                    <img
                      src={portrait}
                      alt={`${pet.name} ${action}`}
                      draggable={false}
                      style={{ transform: `scale(${zoom / 100})` }}
                    />
                  ) : (
                    <span className="companion-missing-art">🌱</span>
                  )}
                </button>
              </div>

              <p className="companion-speech" role="status" aria-live="polite">
                {speech || (state.visibilityMode === "shown" ? "你忙你的，我在这里。" : statusText(state))}
              </p>

              <div className="companion-primary-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => onInteract("pet")}
                  disabled={!interactive}
                >
                  摸摸头
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onInteract("greet")}
                  disabled={!interactive}
                >
                  打个招呼
                </button>
              </div>
              <p className="companion-help">{help}</p>

              <div className="companion-badge-row">
                {isRenaming ? (
                  <div className="companion-rename">
                    <label className="sr-only" htmlFor="companion-rename-input">
                      伙伴名字
                    </label>
                    <input
                      id="companion-rename-input"
                      className="companion-rename-input"
                      value={draftName}
                      maxLength={20}
                      autoFocus
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          commitRename();
                        }
                        if (event.key === "Escape") setIsRenaming(false);
                      }}
                    />
                    <button type="button" className="btn-icon-save" onClick={commitRename} title="保存名字">
                      ✓
                    </button>
                    <button
                      type="button"
                      className="btn-icon-cancel"
                      onClick={() => setIsRenaming(false)}
                      title="取消重命名"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="companion-name">{pet.name}</span>
                    <button
                      type="button"
                      className="btn-rename-trigger"
                      onClick={() => {
                        setDraftName(pet.name);
                        setIsRenaming(true);
                      }}
                      title="重命名当前伙伴"
                      aria-label="重命名当前伙伴"
                    >
                      ✏️
                    </button>
                  </>
                )}
              </div>
            </div>

            <details className="card companion-details">
              <summary>更多动作与预览工具</summary>
              <div className="companion-details-body">
                <div className="companion-action-grid">
                  {PET_ACTIONS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`action-pill-btn ${pet.currentAction === entry.id ? "active" : ""}`}
                      onClick={() => onSwitchAction(entry.id)}
                      disabled={!pet || state.availability !== "ready"}
                      aria-pressed={pet.currentAction === entry.id}
                    >
                      <span className="action-emoji">{ACTION_EMOJIS[entry.id]}</span>
                      <span>{entry.label}</span>
                    </button>
                  ))}
                </div>

                <div className="preview-tools" aria-label="预览工具">
                  <span className="preview-tools-label">仅影响此处预览</span>
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={() => setFrameIndex((prev) => (prev - 1 + frames.length) % frames.length)}
                    disabled={previewPlaying || frames.length === 0}
                    title="上一帧"
                  >
                    ⏮
                  </button>
                  <button
                    type="button"
                    className="tool-btn primary-tool"
                    onClick={() => setPreviewPlaying((playing) => !playing)}
                    disabled={frames.length === 0}
                    title={previewPlaying ? "暂停预览" : "播放预览"}
                  >
                    {previewPlaying ? "⏸" : "▶"}
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={() => setFrameIndex((prev) => (prev + 1) % frames.length)}
                    disabled={previewPlaying || frames.length === 0}
                    title="下一帧"
                  >
                    ⏭
                  </button>
                  <span className="frame-badge">
                    {activeIndex + 1} / {frames.length} 帧
                  </span>
                </div>
              </div>
            </details>
          </section>

          <aside className="companion-side">
            <CompanionControls
              state={state}
              webMode={webMode}
              busy={busy}
              showStatus={false}
              onToggleVisibility={onToggleVisibility}
              onSnooze={onSnooze}
              onOpenSettings={onOpenSettings}
            />

            <section className="card companion-toggles" aria-labelledby="companion-toggles-title">
              <h2 id="companion-toggles-title">按你的节奏陪伴</h2>
              <label className="toggle-row" htmlFor="companion-paused">
                <span>
                  <strong>暂停桌宠动画</strong>
                  <small>伙伴留在原处，画面停下来</small>
                </span>
                <input
                  id="companion-paused"
                  type="checkbox"
                  checked={state.animationPaused}
                  disabled={busy}
                  onChange={onTogglePaused}
                />
              </label>
              <label className="toggle-row" htmlFor="companion-autonomous">
                <span>
                  <strong>自主活动</strong>
                  <small>自动变换姿态，不移动桌面位置</small>
                </span>
                <input
                  id="companion-autonomous"
                  type="checkbox"
                  checked={state.autonomous}
                  disabled={busy}
                  onChange={onToggleAutonomous}
                />
              </label>
              <div className="companion-scale-row">
                <label htmlFor="companion-scale">伙伴大小 · {scalePercent}%</label>
                <input
                  id="companion-scale"
                  type="range"
                  min="50"
                  max="150"
                  step="5"
                  value={scalePercent}
                  disabled={busy}
                  onChange={(event) => onChangeZoom(Number(event.target.value))}
                />
              </div>
              <button type="button" className="btn-secondary" onClick={onOpenSettings}>
                ⚙️ 偏好设置
              </button>
              <p className="companion-control-note">
                收起不会移除伙伴。你随时可以从菜单栏 / 托盘找回它。
              </p>
            </section>
          </aside>
        </div>
      ) : (
        <section className="card companion-empty">
          <span className="companion-empty-icon" aria-hidden="true">🌱</span>
          <h2>为今天添一位小伙伴</h2>
          <p>可以领养咕唧，也可以带回你已经制作好的伙伴。</p>
          <div className="companion-empty-actions">
            <button type="button" className="btn-primary" onClick={onStartAdoption}>
              去领养
            </button>
            <button type="button" className="btn-secondary" onClick={onGoToWorkshop}>
              导入已有伙伴
            </button>
          </div>
        </section>
      )}
    </div>
  );
};
