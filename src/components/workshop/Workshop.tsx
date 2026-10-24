import React, { useEffect, useRef, useState } from "react";
import { DEFAULT_PRESET_FRAME_DIR } from "../../config";
import { PET_ACTIONS, type ActionFrameSet, type FrameInspection, type PetAction, type PetSpecies } from "../../types";
import { useToast } from "../ui/Toast";

interface WorkshopProps {
  task: "import" | "frames" | "ai";
  repairPetName?: string | null;
  inspectAction: PetAction;
  onInspectActionChange: (action: PetAction) => void;
  name: string;
  onChangeName: (val: string) => void;
  species: PetSpecies;
  onChangeSpecies: (val: PetSpecies) => void;
  presetDir: string;
  onChangePresetDir: (val: string) => void;
  onImportPreset: () => Promise<void>;
  frameInspection: FrameInspection | null;
  inspectingFrames: boolean;
  onInspectFrames: () => Promise<void> | void;
  onChoosePresetDir: () => Promise<void> | void;
  onImportPetPackage: () => Promise<void> | void;
  keepExternalReference: boolean;
  onChangeKeepExternalReference: (value: boolean) => void;
  manualFrames: Partial<ActionFrameSet>;
  onChangeManualFrames: (frames: Partial<ActionFrameSet>) => void;
  onSaveManualFrames: () => Promise<void>;
  isLoading: boolean;
  isTauri: boolean;
  // AI props
  apiKey: string;
  onChangeApiKey: (val: string) => void;
  uploadUrl: string;
  onChangeUploadUrl: (val: string) => void;
  referencePhoto: string | null;
  onSelectReferencePhoto: (files: FileList | null) => void;
  appearanceNotes: string;
  onChangeAppearanceNotes: (val: string) => void;
  aiRunning: boolean;
  aiCommitting: boolean;
  canResumeAI: boolean;
  aiLog: string[];
  onGenerateAI: () => Promise<void>;
  onCancelAI: () => void;
}

export const Workshop: React.FC<WorkshopProps> = ({
  task,
  repairPetName,
  inspectAction,
  onInspectActionChange,
  name,
  onChangeName,
  species,
  onChangeSpecies,
  presetDir,
  onChangePresetDir,
  onImportPreset,
  frameInspection,
  inspectingFrames,
  onInspectFrames,
  onChoosePresetDir,
  onImportPetPackage,
  keepExternalReference,
  onChangeKeepExternalReference,
  manualFrames,
  onChangeManualFrames,
  onSaveManualFrames,
  isLoading,
  isTauri,
  apiKey,
  onChangeApiKey,
  uploadUrl,
  onChangeUploadUrl,
  referencePhoto,
  onSelectReferencePhoto,
  appearanceNotes,
  onChangeAppearanceNotes,
  aiRunning,
  aiCommitting,
  canResumeAI,
  aiLog,
  onGenerateAI,
  onCancelAI
}) => {
  const [readingFrames, setReadingFrames] = useState(false);
  const readingRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();
  const busy = aiRunning || isLoading || readingFrames;

  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
  }, [task]);

  // Read frames for current action
  const currentActionFrames = manualFrames[inspectAction] ?? [];

  async function handleAddFrames(action: PetAction, files: FileList | null) {
    if (!files?.length || busy || readingRef.current) return;
    readingRef.current = true;
    setReadingFrames(true);
    try {
      const selected = Array.from(files);
      const existing = manualFrames[action] ?? [];
      if (selected.length + existing.length > 60) throw new Error("每个动作最多 60 帧");
      if (selected.some(f => !["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 16 * 1024 * 1024)) {
        throw new Error("请选择不超过 16 MiB 的 PNG、JPEG 或 WebP 图片");
      }
      const loadedBytes = Object.values(manualFrames).flat().reduce((total, src) => total + (src.split(",")[1]?.length ?? 0) * 3 / 4, 0);
      if (loadedBytes + selected.reduce((total, file) => total + file.size, 0) > 128 * 1024 * 1024) {
        throw new Error("整套动作帧总量不能超过 128 MiB");
      }
      const readUrls = await Promise.all(selected
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((f) => readFileAsDataUrl(f))
      );
      onChangeManualFrames({ ...manualFrames, [action]: [...existing, ...readUrls] });
    } catch (err) {
      showToast(`读取动作帧失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally { readingRef.current = false; setReadingFrames(false); }
  }

  function handleDeleteFrame(action: PetAction, indexToDelete: number) {
    const existing = manualFrames[action] ?? [];
    onChangeManualFrames({
      ...manualFrames,
      [action]: existing.filter((_, idx) => idx !== indexToDelete)
    });
  }

  return (
    <div className="workshop-shell">
      <div className="workshop-body">
        {/* Basic Pet Info */}
        <div className="input-row-2">
          <div className="input-group">
            <label htmlFor="workshop-name">宠物名称</label>
            <input
              ref={nameRef}
              id="workshop-name"
              type="text"
              className="input-control"
              maxLength={20}
              disabled={busy}
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="例如：糖宝、奶茶"
            />
          </div>
          <div className="input-group">
            <label htmlFor="workshop-species">宠物种类</label>
            <select
              id="workshop-species"
              disabled={busy}
              className="input-control"
              value={species}
              onChange={(e) => onChangeSpecies(e.target.value as PetSpecies)}
            >
              <option value="cat">猫咪 🐱</option>
              <option value="dog">小狗 🐶</option>
            </select>
          </div>
        </div>

        {/* Task: import an existing frame pack */}
        {task === "import" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {repairPetName && (
              <div className="workshop-repair-note" role="status">
                正在修复「{repairPetName}」的素材。保存只会更新这一位，不会新建伙伴；
                名字、当前选择和显示/休息状态保持不变。
              </div>
            )}
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6 }}>
              应用会自动读取目录内的 <code>idle/sit/sleep/happy/walk/jump</code> 6
              个动作子目录（每个动作至少 5 张透明 PNG 图片，单图不超过 16 MiB / 2048×2048）。
            </p>

            <div className="input-group">
              <label htmlFor="workshop-preset-dir">本地帧包目录</label>
              <div className="preset-dir-row">
                <input
                  id="workshop-preset-dir"
                  type="text"
                  className="input-control"
                  value={presetDir}
                  onChange={(e) => onChangePresetDir(e.target.value)}
                  placeholder={DEFAULT_PRESET_FRAME_DIR}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void onChoosePresetDir()}
                  disabled={busy}
                >
                  选择目录…
                </button>
              </div>
              <p className="frame-inspection-note">
                也可以把帧包目录拖进窗口；选择和拖入都会走同一套只读预检。
              </p>
            </div>

            {isTauri && (
              <label className="frame-inspection-note" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={keepExternalReference}
                  onChange={(event) => onChangeKeepExternalReference(event.target.checked)}
                />
                继续引用外部目录（高级）
              </label>
            )}
            <p className="frame-inspection-note">
              {isTauri
                ? keepExternalReference
                  ? "只保存目录引用；移动或删除原目录后素材会失效。"
                  : "默认复制到应用管理目录，原目录不会被修改；复制失败不会创建伙伴。"
                : "网页预览不复制素材；桌面版默认由应用保管。"}
            </p>

            <div style={{ display: "flex", gap: "12px", marginTop: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void onImportPetPackage()}
                disabled={busy}
              >
                导入完整伙伴包…
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void onInspectFrames()}
                disabled={busy || inspectingFrames}
              >
                {inspectingFrames ? "正在预检..." : "预检目录（只读）"}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={onImportPreset}
                disabled={busy || Boolean(frameInspection && !frameInspection.valid)}
              >
                {isLoading
                  ? "正在导入..."
                  : repairPetName
                    ? "更新素材并保留当前伙伴"
                    : "一键导入并保存到宠物架"}
              </button>
            </div>

            {frameInspection && (
              <div
                className={`frame-inspection ${frameInspection.valid ? "is-valid" : "is-invalid"}`}
                role="status"
                aria-live="polite"
              >
                <div className="frame-inspection-head">
                  <strong>
                    {frameInspection.valid
                      ? "预检通过：六个动作完整"
                      : "预检发现需要修正的项目"}
                  </strong>
                  <span>
                    {formatBytes(frameInspection.totalBytes)} 文件 /{" "}
                    {formatBytes(frameInspection.decodedBytes)} 解码
                  </span>
                </div>
                {frameInspection.thumbnail && (
                  <img
                    className="frame-inspection-thumb"
                    src={frameInspection.thumbnail}
                    alt="预检缩略图"
                  />
                )}
                <div className="frame-inspection-actions">
                  {frameInspection.actions.map((action) => {
                    const label =
                      PET_ACTIONS.find((entry) => entry.id === action.action)?.label ??
                      action.action;
                    return (
                      <div
                        key={action.action}
                        className={`frame-inspection-action ${
                          action.issues.length > 0 ? "has-issue" : ""
                        }`}
                      >
                        <strong>{label}</strong>
                        <span>
                          {action.frames} / {action.minFrames}–{action.maxFrames} 帧
                        </span>
                        {action.issues.map((issue) => (
                          <small key={issue}>{issue}</small>
                        ))}
                      </div>
                    );
                  })}
                </div>
                {frameInspection.globalIssues.length > 0 && (
                  <div className="frame-inspection-global">
                    <strong>容量或全局限制</strong>
                    {frameInspection.globalIssues.map((issue) => (
                      <small key={issue}>{issue}</small>
                    ))}
                  </div>
                )}
                {frameInspection.missingActions.length > 0 && (
                  <p className="frame-inspection-note">
                    缺少动作：
                    {frameInspection.missingActions
                      .map(
                        (action) =>
                          PET_ACTIONS.find((entry) => entry.id === action)?.label ??
                          action
                      )
                      .join("、")}
                  </p>
                )}
                {!frameInspection.valid && (
                  <p className="frame-inspection-note">
                    修正后重新预检；预检本身不会创建资料、切换伙伴或显示到桌面。
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Task: assemble frames */}
        {task === "frames" && (
          <div className="filmstrip-container">
            <div className="filmstrip-header">
              <div className="segmented-tabs" style={{ background: "rgba(45,35,25,0.03)" }}>
                {PET_ACTIONS.map((act) => {
                  const count = (manualFrames[act.id] ?? []).length;
                  return (
                    <button
                      key={act.id}
                      type="button"
                      className={`seg-tab-btn ${inspectAction === act.id ? "active" : ""}`}
                      onClick={() => onInspectActionChange(act.id)}
                      aria-pressed={inspectAction === act.id}
                    >
                      {act.label} ({count}/5)
                    </button>
                  );
                })}
              </div>
            </div>

            <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
              正在检视「{PET_ACTIONS.find((a) => a.id === inspectAction)?.label}
              」动作的连续帧，可单帧删除或追加上传。每动作至少 5 帧。
            </p>

            <div className="filmstrip-track">
              {currentActionFrames.map((frameSrc, idx) => (
                <div key={idx} className="frame-thumb-card">
                  <div className="frame-thumb-img-wrap">
                    <img src={frameSrc} alt={`Frame ${idx + 1}`} className="frame-thumb-img" />
                  </div>
                  <span className="frame-num-label">#{idx + 1}</span>
                  <button
                    type="button"
                    className="frame-delete-btn"
                    onClick={() => handleDeleteFrame(inspectAction, idx)}
                    disabled={busy}
                    title="删除此帧"
                  >
                    ✕
                  </button>
                </div>
              ))}

              <label className="frame-add-card">
                <span style={{ fontSize: "20px" }}>➕</span>
                <span style={{ fontSize: "12px", fontWeight: 600 }}>添加帧</span>
                <input
                  type="file"
                  multiple
                  disabled={busy}
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => handleAddFrames(inspectAction, e.target.files)}
                />
              </label>
            </div>

            <div style={{ marginTop: "12px" }}>
              <button
                type="button"
                className="btn-primary"
                onClick={onSaveManualFrames}
                disabled={busy}
              >
                {isLoading ? "正在保存..." : "保存全套动作并应用到桌面"}
              </button>
            </div>
          </div>
        )}

        {/* Task: photo generation */}
        {task === "ai" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6 }}>
              基于 Minimax 图生图模型，上传真实宠物照片生成 Q 版角色模型图及 30 帧连续动作帧包。
            </p>

            <div className="input-row-2">
              <div className="input-group">
                <label htmlFor="workshop-api-key">Minimax API Key</label>
                <input
                  id="workshop-api-key"
                  type="password"
                  disabled={busy}
                  className="input-control"
                  value={apiKey}
                  onChange={(e) => onChangeApiKey(e.target.value)}
                  placeholder="sk-..."
                />
              </div>
              <div className="input-group">
                <label htmlFor="workshop-upload-url">公网参考图上传服务地址</label>
                <input
                  id="workshop-upload-url"
                  type="text"
                  className="input-control"
                  value={uploadUrl}
                  disabled={busy}
                  onChange={(e) => onChangeUploadUrl(e.target.value)}
                  placeholder="https://your-domain.example/upload"
                />
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="workshop-photo">宠物照片</label>
              <input
                id="workshop-photo"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                onChange={(e) => onSelectReferencePhoto(e.target.files)}
              />
              {referencePhoto && (
                <div style={{ marginTop: "8px" }}>
                  <img
                    src={referencePhoto}
                    alt="Reference"
                    style={{
                      width: "80px",
                      height: "80px",
                      objectFit: "cover",
                      borderRadius: "10px"
                    }}
                  />
                </div>
              )}
            </div>

            <div className="input-group">
              <label htmlFor="workshop-notes">特征描述（可选）</label>
              <textarea
                id="workshop-notes"
                className="input-control"
                style={{ height: "64px", paddingTop: "8px" }}
                maxLength={420}
                disabled={busy}
                value={appearanceNotes}
                onChange={(e) => onChangeAppearanceNotes(e.target.value)}
                placeholder="例如：白色加白短毛猫，右耳有一小块黑斑..."
              />
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
              <button
                type="button"
                className="btn-primary"
                onClick={onGenerateAI}
                disabled={busy || !isTauri}
              >
                {aiCommitting ? "完成入住中..." : aiRunning ? "AI 生成中（请耐心等待）..." : canResumeAI ? "继续上次生成" : "开始 AI 自动生成全套帧包"}
              </button>
              {aiRunning && !aiCommitting && (
                <button type="button" className="btn-secondary" onClick={onCancelAI}>
                  取消
                </button>
              )}
            </div>

            {(aiRunning || canResumeAI) && (
              <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                已完成的图片仅在本次打开期间保留。取消会在当前步骤返回后停止，继续时会复用已完成内容。
                切换页面不会取消本次生成，返回后仍可看到进度。
              </p>
            )}

            {aiLog.length > 0 && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  background: "rgba(0,0,0,0.03)",
                  padding: "12px",
                  borderRadius: "10px",
                  maxHeight: "140px",
                  overflowY: "auto",
                  fontFamily: "var(--font-family-mono)",
                  fontSize: "12px"
                }}
              >
                {aiLog.map((log, index) => (
                  <div key={index}>{log}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}
