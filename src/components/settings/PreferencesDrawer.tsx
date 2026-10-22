import React, { useEffect, useRef, useState } from "react";
import type { NativePetState, PreferenceRequest } from "../../native-pet-types";
import { reducedMotion } from "../../native-pet-state";
import { useFocusTrap } from "../ui/useFocusTrap";

interface PreferencesDrawerProps {
  open: boolean;
  state: NativePetState;
  webMode: boolean;
  busy: boolean;
  onClose: () => void;
  onUpdate: (request: PreferenceRequest) => void;
  onResetPosition: () => void;
  onTutorial: () => void;
}

const CAPABILITY_LABELS: Array<{ key: keyof NativePetState["capabilities"]; label: string }> = [
  { key: "nativeWindow", label: "原生桌面窗口" },
  { key: "tapFeedback", label: "单击摸摸反馈" },
  { key: "clickThrough", label: "透明区域穿透" },
  { key: "resetPosition", label: "重置位置" },
  { key: "autostart", label: "开机自启" },
  { key: "systemReducedMotion", label: "读取系统减少动态" }
];

export const PreferencesDrawer: React.FC<PreferencesDrawerProps> = ({
  open,
  state,
  webMode,
  busy,
  onClose,
  onUpdate,
  onResetPosition,
  onTutorial
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(() => Math.round(state.scale * 100));
  useFocusTrap(dialogRef, onClose, open);

  useEffect(() => {
    setScale(Math.round(state.scale * 100));
  }, [state.scale]);

  useEffect(() => {
    if (!open) return;
    const target = scale / 100;
    if (Math.abs(target - state.scale) < 0.001) return;
    const timer = window.setTimeout(() => {
      onUpdate({ kind: "setScale", value: target });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [scale, open, state.scale, onUpdate]);

  if (!open) return null;

  const lowMotion = reducedMotion(state);
  const pending = busy || state.pending;

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={dialogRef}
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby="settings-description"
        tabIndex={-1}
      >
        <div className="drawer-head">
          <div>
            <h2 id="settings-title">偏好设置</h2>
            <p id="settings-description" className="drawer-subtitle">
              这里的设置与菜单栏 / 托盘保持一致。
            </p>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭偏好设置">
            ×
          </button>
        </div>

        <div className="drawer-body">
          <div className="setting-row">
            <label htmlFor="settings-paused">
              <strong>暂停桌宠动画</strong>
              <span>伙伴留在原处，画面停下来；本次会话有效</span>
            </label>
            <input
              id="settings-paused"
              type="checkbox"
              checked={state.animationPaused}
              disabled={pending}
              onChange={() => onUpdate({ kind: "setAnimationPaused", value: !state.animationPaused })}
            />
          </div>

          <div className="setting-row">
            <label htmlFor="settings-autonomous">
              <strong>自主活动</strong>
              <span>自动变换姿态，不移动桌面位置</span>
            </label>
            <input
              id="settings-autonomous"
              type="checkbox"
              checked={state.autonomous}
              disabled={pending}
              onChange={() => onUpdate({ kind: "setAutonomous", value: !state.autonomous })}
            />
          </div>

          <div className="setting-row setting-row-column">
            <label htmlFor="settings-scale">
              <strong>伙伴大小 · {scale}%</strong>
              <span>按你的屏幕选择舒适的比例</span>
            </label>
            <input
              id="settings-scale"
              type="range"
              min="50"
              max="150"
              step="5"
              value={scale}
              disabled={pending}
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </div>

          {!webMode && state.capabilities.clickThrough && (
            <div className="setting-row">
              <label htmlFor="settings-click-through">
                <strong>透明区域穿透</strong>
                <span>伙伴周围的空白不挡住鼠标</span>
              </label>
              <input
                id="settings-click-through"
                type="checkbox"
                checked={state.clickThrough}
                disabled={pending}
                onChange={() =>
                  onUpdate({ kind: "setClickThrough", value: !state.clickThrough })
                }
              />
            </div>
          )}

          {!webMode && state.capabilities.resetPosition && (
            <div className="setting-row">
              <label>
                <strong>屏幕位置</strong>
                <span>把伙伴叫回屏幕右下角</span>
              </label>
              <button type="button" className="btn-secondary" onClick={onResetPosition} disabled={pending}>
                重置位置
              </button>
            </div>
          )}

          {!webMode && state.capabilities.autostart && (
            <div className="setting-row">
              <label htmlFor="settings-autostart">
                <strong>开机启动</strong>
                <span>由你决定是否随系统启动</span>
              </label>
              <input
                id="settings-autostart"
                type="checkbox"
                checked={state.autostart.enabled}
                disabled={pending || state.autostart.pending}
                onChange={() =>
                  onUpdate({ kind: "setAutostart", value: !state.autostart.enabled })
                }
              />
            </div>
          )}

          <div className="setting-row">
            <label htmlFor="settings-motion">
              <strong>减少动态效果</strong>
              <span>静态画面，互动用文字回应；不改变你原来的暂停和自主活动选择</span>
            </label>
            <select
              id="settings-motion"
              value={state.motionPreference}
              disabled={pending}
              onChange={(event) =>
                onUpdate({
                  kind: "setMotionPreference",
                  value: event.target.value as "system" | "reduce"
                })
              }
            >
              <option value="system" disabled={!state.capabilities.systemReducedMotion}>
                跟随系统{state.capabilities.systemReducedMotion ? "" : "（当前系统不可读）"}
              </option>
              <option value="reduce">始终减少</option>
            </select>
          </div>

          {!state.capabilities.systemReducedMotion && (
            <p className="drawer-hint">
              当前系统无法可靠读取减少动态设置。默认不强制减少，你仍可以手动选择“始终减少”。
            </p>
          )}

          {lowMotion && (
            <p className="drawer-hint">
              低动态已生效。原来的播放和自主活动偏好仍为你保留，关闭低动态后会按原偏好恢复。
              {state.systemReducedMotion === true && state.motionPreference === "system"
                ? " 当前跟随系统设置。"
                : ""}
            </p>
          )}

          {webMode && (
            <p className="drawer-hint">
              这是网页演示。桌面窗口、透明穿透、开机启动和位置等系统能力需要在应用内体验。
            </p>
          )}

          <div className="setting-row">
            <label>
              <strong>重新认识彼此</strong>
              <span>查看点击、拖动和托盘教学</span>
            </label>
            <button type="button" className="btn-secondary" onClick={onTutorial} disabled={pending}>
              查看教学
            </button>
          </div>

          <section className="capability-list" aria-labelledby="capability-title">
            <h3 id="capability-title">当前系统支持情况</h3>
            <ul>
              {CAPABILITY_LABELS.map(({ key, label }) => (
                <li key={key}>
                  <span>{label}</span>
                  <span className={state.capabilities[key] ? "is-supported" : "is-unsupported"}>
                    {state.capabilities[key] ? "支持" : "暂不支持"}
                  </span>
                </li>
              ))}
            </ul>
            {!webMode && !state.capabilities.clickThrough && (
              <p className="drawer-hint">
                Linux 首版尚未提供透明区域穿透和位置重置；其余支持能力按实际运行结果显示。
              </p>
            )}
          </section>

          <p className="drawer-footnote">
            {pending ? "正在同步设置…" : "设置保存失败时会保留上一次确认值，并给出重试入口。"}
          </p>
        </div>
      </aside>
    </div>
  );
};
