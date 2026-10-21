import React, { useState } from "react";
import { DEFAULT_PRESET_FRAME_DIR } from "../../config";
import { PET_ACTIONS, type ActionFrameSet, type PetAction, type PetSpecies } from "../../types";

interface WorkshopProps {
  name: string;
  onChangeName: (val: string) => void;
  species: PetSpecies;
  onChangeSpecies: (val: PetSpecies) => void;
  presetDir: string;
  onChangePresetDir: (val: string) => void;
  onImportPreset: () => Promise<void>;
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
  aiLog: string[];
  onGenerateAI: () => Promise<void>;
  onCancelAI: () => void;
}

export const Workshop: React.FC<WorkshopProps> = ({
  name,
  onChangeName,
  species,
  onChangeSpecies,
  presetDir,
  onChangePresetDir,
  onImportPreset,
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
  aiLog,
  onGenerateAI,
  onCancelAI
}) => {
  const [activeTab, setActiveTab] = useState<"preset" | "frames" | "ai">("preset");
  const [activeInspectAction, setActiveInspectAction] = useState<PetAction>("idle");

  // Read frames for current action
  const currentActionFrames = manualFrames[activeInspectAction] ?? [];

  async function handleAddFrames(action: PetAction, files: FileList | null) {
    if (!files?.length) return;
    const readUrls = await Promise.all(
      Array.from(files)
        .filter((f) => f.type.startsWith("image/"))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((f) => readFileAsDataUrl(f))
    );

    const existing = manualFrames[action] ?? [];
    onChangeManualFrames({
      ...manualFrames,
      [action]: [...existing, ...readUrls]
    });
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
      <div className="segmented-tabs">
        <button
          type="button"
          className={`seg-tab-btn ${activeTab === "preset" ? "active" : ""}`}
          onClick={() => setActiveTab("preset")}
        >
          📁 本地帧包导入
        </button>
        <button
          type="button"
          className={`seg-tab-btn ${activeTab === "frames" ? "active" : ""}`}
          onClick={() => setActiveTab("frames")}
        >
          🎞️ 动作帧装配台
        </button>
        <button
          type="button"
          className={`seg-tab-btn ${activeTab === "ai" ? "active" : ""}`}
          onClick={() => setActiveTab("ai")}
        >
          ✨ AI 照片转宠物
        </button>
      </div>

      <div className="workshop-body">
        {/* Basic Pet Info */}
        <div className="input-row-2">
          <div className="input-group">
            <label>宠物名称</label>
            <input
              type="text"
              className="input-control"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="例如：糖宝、奶茶"
            />
          </div>
          <div className="input-group">
            <label>宠物种类</label>
            <select
              className="input-control"
              value={species}
              onChange={(e) => onChangeSpecies(e.target.value as PetSpecies)}
            >
              <option value="cat">猫咪 🐱</option>
              <option value="dog">小狗 🐶</option>
            </select>
          </div>
        </div>

        {/* Tab 1: Preset pack */}
        {activeTab === "preset" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6 }}>
              应用会自动读取目录内的 <code>idle/sit/sleep/happy/walk/jump</code> 6
              个动作子目录（每个动作至少 5 张透明 PNG 图片）。
            </p>

            <div className="input-group">
              <label>本地帧包目录</label>
              <input
                type="text"
                className="input-control"
                value={presetDir}
                onChange={(e) => onChangePresetDir(e.target.value)}
                placeholder={DEFAULT_PRESET_FRAME_DIR}
              />
            </div>

            <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
              <button
                type="button"
                className="btn-primary"
                onClick={onImportPreset}
                disabled={isLoading}
              >
                {isLoading ? "正在导入..." : "一键导入并保存到宠物架"}
              </button>
            </div>
          </div>
        )}

        {/* Tab 2: Filmstrip / Frame sequencer */}
        {activeTab === "frames" && (
          <div className="filmstrip-container">
            <div className="filmstrip-header">
              <div className="segmented-tabs" style={{ background: "rgba(45,35,25,0.03)" }}>
                {PET_ACTIONS.map((act) => {
                  const count = (manualFrames[act.id] ?? []).length;
                  return (
                    <button
                      key={act.id}
                      type="button"
                      className={`seg-tab-btn ${activeInspectAction === act.id ? "active" : ""}`}
                      onClick={() => setActiveInspectAction(act.id)}
                    >
                      {act.label} ({count}/5)
                    </button>
                  );
                })}
              </div>
            </div>

            <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
              正在检视「{PET_ACTIONS.find((a) => a.id === activeInspectAction)?.label}
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
                    onClick={() => handleDeleteFrame(activeInspectAction, idx)}
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
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => handleAddFrames(activeInspectAction, e.target.files)}
                />
              </label>
            </div>

            <div style={{ marginTop: "12px" }}>
              <button
                type="button"
                className="btn-primary"
                onClick={onSaveManualFrames}
                disabled={isLoading}
              >
                {isLoading ? "正在保存..." : "保存全套动作并应用到桌面"}
              </button>
            </div>
          </div>
        )}

        {/* Tab 3: AI Generation */}
        {activeTab === "ai" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6 }}>
              基于 Minimax 图生图模型，上传真实宠物照片生成 Q 版角色模型图及 30 帧连续动作帧包。
            </p>

            <div className="input-row-2">
              <div className="input-group">
                <label>Minimax API Key</label>
                <input
                  type="password"
                  className="input-control"
                  value={apiKey}
                  onChange={(e) => onChangeApiKey(e.target.value)}
                  placeholder="sk-..."
                />
              </div>
              <div className="input-group">
                <label>公网参考图上传服务地址</label>
                <input
                  type="text"
                  className="input-control"
                  value={uploadUrl}
                  onChange={(e) => onChangeUploadUrl(e.target.value)}
                  placeholder="https://your-domain.example/upload"
                />
              </div>
            </div>

            <div className="input-group">
              <label>宠物照片</label>
              <input
                type="file"
                accept="image/*"
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
              <label>特征描述（可选）</label>
              <textarea
                className="input-control"
                style={{ height: "64px", paddingTop: "8px" }}
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
                disabled={aiRunning || !isTauri}
              >
                {aiRunning ? "AI 生成中（请耐心等待）..." : "开始 AI 自动生成全套帧包"}
              </button>
              {aiRunning && (
                <button type="button" className="btn-secondary" onClick={onCancelAI}>
                  取消
                </button>
              )}
            </div>

            {aiLog.length > 0 && (
              <div
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

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}
