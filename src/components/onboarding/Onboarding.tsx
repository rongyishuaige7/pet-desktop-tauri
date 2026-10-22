import React, { useEffect, useRef } from "react";
import type { OnboardingRecord } from "../../onboarding";
import { DEFAULT_PET_NAME, MAX_PET_NAME_LENGTH } from "../../onboarding";
import type { PetProfile } from "../../types";
import { DEFAULT_PRESET } from "../../presets";
import { useFocusTrap } from "../ui/useFocusTrap";

interface OnboardingProps {
  record: OnboardingRecord;
  pet: PetProfile | null;
  isTauri: boolean;
  busy: boolean;
  error: string | null;
  displayPending?: boolean;
  speech: string;
  onChangeName: (name: string) => void;
  onNameBlur: () => void;
  onNext: () => void;
  onBrowse: () => void;
  onAdopt: () => void;
  onUseDefault: () => void;
  onFinish: () => void;
  onMeetPet: () => void;
  onRetry: () => void;
}

export const Onboarding: React.FC<OnboardingProps> = ({
  record,
  pet,
  isTauri,
  busy,
  error,
  displayPending = false,
  speech,
  onChangeName,
  onNameBlur,
  onNext,
  onBrowse,
  onAdopt,
  onUseDefault,
  onFinish,
  onMeetPet,
  onRetry
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const petName = pet?.name || record.draftName || DEFAULT_PET_NAME;
  const portrait = pet?.actions?.idle?.[0] || DEFAULT_PRESET.thumbnail;
  const trimmed = record.draftName.trim();
  const escape = () => {
    if (busy) return;
    if (record.step === "meet") onFinish();
    else onBrowse();
  };
  useFocusTrap(dialogRef, escape, !busy);

  useEffect(() => {
    if (record.step === "name") {
      nameRef.current?.focus({ preventScroll: true });
      nameRef.current?.select();
      return;
    }
    // Keep keyboard focus inside the dialog after a step swap removes the
    // previously focused input or button.
    const target =
      dialogRef.current?.querySelector<HTMLElement>(".onboarding-actions .btn-primary") ??
      dialogRef.current?.querySelector<HTMLElement>(".onboarding-actions .btn-secondary") ??
      dialogRef.current?.querySelector<HTMLElement>(".onboarding-pet");
    target?.focus({ preventScroll: true });
  }, [record.step]);

  const steps = (
    <div
      className="onboarding-steps"
      aria-label={`第 ${record.step === "choose" ? 1 : record.step === "name" ? 2 : 3} 步，共 3 步`}
    >
      {[1, 2, 3].map((index) => (
        <span
          key={index}
          className={
            index <= (record.step === "choose" ? 1 : record.step === "name" ? 2 : 3)
              ? "current"
              : ""
          }
        />
      ))}
    </div>
  );

  return (
    <div className="onboarding-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-description"
        className="onboarding-dialog"
        tabIndex={-1}
      >
        <div className="onboarding-body">
          {displayPending ? (
            <>
              {steps}
              <h2 id="onboarding-title">资料已保存，等待显示</h2>
              <p id="onboarding-description" className="onboarding-lead">
                伙伴已经在你的伙伴列表里，但桌面窗口还没有确认显示。重试只会重新发送显示命令，不会再次领养。
              </p>
              {error && (
                <p className="onboarding-field-error" role="alert">
                  {error}
                </p>
              )}
              <div className="onboarding-actions">
                <button type="button" className="btn-primary" onClick={onRetry} disabled={busy}>
                  {busy ? "正在显示…" : "重试显示"}
                </button>
              </div>
            </>
          ) : record.step === "choose" ? (
            <>
              {steps}
              <h2 id="onboarding-title">给今天添一点陪伴</h2>
              <p id="onboarding-description" className="onboarding-lead">
                咕唧已经准备好了。选个名字，就可以把它带到桌面。
              </p>
              <img className="onboarding-portrait" src={DEFAULT_PRESET.thumbnail} alt="原创伙伴咕唧" />
              <p className="onboarding-hint">使用内置伙伴，无需照片和在线生成服务。</p>
              <div className="onboarding-actions">
                <button type="button" className="btn-secondary" onClick={onBrowse} disabled={busy}>
                  先浏览
                </button>
                <button type="button" className="btn-primary" onClick={onNext} disabled={busy}>
                  下一步
                </button>
              </div>
            </>
          ) : record.step === "name" ? (
            <>
              {steps}
              <h2 id="onboarding-title">想怎么称呼它？</h2>
              <p id="onboarding-description" className="onboarding-lead">
                熟悉的名字，会让每一次见面更亲切。
              </p>
              <label className="form-label" htmlFor="onboarding-name">
                伙伴名字
              </label>
              <input
                id="onboarding-name"
                ref={nameRef}
                className="onboarding-input"
                type="text"
                maxLength={MAX_PET_NAME_LENGTH}
                value={record.draftName}
                disabled={busy}
                autoComplete="off"
                onChange={(event) => onChangeName(event.target.value)}
                onBlur={onNameBlur}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && trimmed) {
                    event.preventDefault();
                    onAdopt();
                  }
                }}
                aria-describedby="onboarding-name-help"
                aria-invalid={!trimmed}
              />
              <p id="onboarding-name-help" className="onboarding-hint">
                最多 20 个字符，可以以后再改。
              </p>
              {!trimmed && (
                <p className="onboarding-field-error" role="alert">
                  给伙伴起个名字，或直接使用咕唧
                </p>
              )}
              <div className="onboarding-actions">
                <button type="button" className="btn-secondary" onClick={onUseDefault} disabled={busy}>
                  直接使用咕唧
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onAdopt}
                  disabled={busy || !trimmed}
                >
                  {busy ? "正在邀请…" : "领养并入住"}
                </button>
              </div>
            </>
          ) : record.step === "meet" ? (
            <>
              {steps}
              <h2 id="onboarding-title">{petName}，很高兴见到你</h2>
              <p id="onboarding-description" className="onboarding-lead">
                现在，它会在桌面安静陪着你。
              </p>
              <button
                type="button"
                className="onboarding-pet"
                onClick={onMeetPet}
                aria-label={`试着摸摸${petName}`}
                disabled={busy}
              >
                <img src={portrait} alt={petName} draggable={false} />
              </button>
              <p className="onboarding-speech" role="status" aria-live="polite">
                {speech || "摸摸它，看看回应。"}
              </p>
              <div className="walkthrough">
                <strong>摸摸它，看看回应</strong>
                拖动可以换位置，右键可以找到更多动作。
                <br />
                {isTauri
                  ? "关闭这个窗口后，我仍会在桌面。需要我时，从菜单栏 / 托盘打开。"
                  : "这是网页演示，桌面能力需在应用内体验。"}
              </div>
              <div className="onboarding-actions">
                <button type="button" className="btn-secondary" onClick={onFinish} disabled={busy}>
                  稍后熟悉
                </button>
                <button type="button" className="btn-primary" onClick={onFinish} disabled={busy}>
                  完成见面
                </button>
              </div>
            </>
          ) : null}

          {error && !displayPending && (
            <div className="onboarding-error" role="alert">
              <p>{error}</p>
              <button type="button" className="btn-secondary" onClick={onRetry} disabled={busy}>
                重试
              </button>
            </div>
          )}
          {busy && (
            <p className="onboarding-busy" role="status" aria-live="polite">
              正在保存名字和选择，请稍候…
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
