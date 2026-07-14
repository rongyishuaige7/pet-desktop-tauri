import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_PRESET_FRAME_DIR, LOOPING_ACTIONS, PET_ZOOM_STORAGE, PRESET_FRAME_DIR_STORAGE } from "./config";
import { hasRenderableFrames, isPetAction, normalizeZoom, withCurrentAction } from "./pet-logic";
import { loadPet, savePet, setCurrentAction } from "./storage";
import { PET_ACTIONS, PET_CHANNEL, type ActionFrameSet, type PetAction, type PetProfile, type PetSpecies } from "./types";
import "./styles.css";

const isTauri = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;

interface NativePetSettings {
  frameRoot: string;
  scale: number;
  currentAction: PetAction;
}

function getMockFrames(species: PetSpecies, action: PetAction): string[] {
  const frames: string[] = [];
  for (let i = 0; i < 5; i++) {
    const isCat = species === "cat";
    const headColor = isCat ? "#ffb040" : "#d0a070";
    const bodyColor = isCat ? "#ffa030" : "#c09060";
    const earColor = isCat ? "#ffb040" : "#8a5a3a";
    const innerEarColor = "#ff8090";

    let yOffset = 0;
    let scaleY = 1;
    let scaleX = 1;
    let eyesClosed = false;
    let mouthOpen = false;
    let tailAngle = 0;
    let legOffset1 = 0;
    let legOffset2 = 0;
    let rotate = 0;

    if (action === "idle") {
      yOffset = i === 1 || i === 3 ? 2 : 0;
      eyesClosed = i === 2;
    } else if (action === "sit") {
      yOffset = 5;
      scaleY = 0.94;
      tailAngle = Math.sin(i * Math.PI / 2) * 12;
    } else if (action === "sleep") {
      yOffset = 8;
      scaleY = 0.88;
      eyesClosed = true;
    } else if (action === "happy") {
      yOffset = i % 2 === 0 ? -8 : 3;
      scaleY = i % 2 === 0 ? 1.05 : 0.95;
      rotate = i % 2 === 0 ? -3 : 3;
      mouthOpen = true;
    } else if (action === "walk") {
      yOffset = i % 2 === 0 ? -2 : 2;
      legOffset1 = Math.sin(i * Math.PI / 2) * 9;
      legOffset2 = -legOffset1;
      tailAngle = Math.sin(i * Math.PI / 2) * 18;
    } else if (action === "jump") {
      yOffset = i === 0 || i === 4 ? -2 : -24;
      scaleY = i === 0 || i === 4 ? 0.95 : 1.1;
      legOffset1 = i === 2 ? 8 : -2;
      legOffset2 = i === 2 ? 8 : -2;
    }

    const eyeElement = eyesClosed 
      ? `<path d="M 134,106 Q 140,111 146,106 M 174,106 Q 180,111 186,106" stroke="#3c291f" stroke-width="3" stroke-linecap="round" fill="none" />`
      : `<circle cx="140" cy="106" r="4.5" fill="#3c291f" />
         <circle cx="180" cy="106" r="4.5" fill="#3c291f" />
         <circle cx="138" cy="103" r="1.5" fill="#fff" />
         <circle cx="178" cy="103" r="1.5" fill="#fff" />`;

    const mouthElement = mouthOpen
      ? `<path d="M 155,114 Q 160,125 165,114 Z" fill="#ff6678" stroke="#3c291f" stroke-width="2.5" />`
      : `<path d="M 156,113 Q 160,116 164,113 Q 160,110 156,113" stroke="#3c291f" stroke-width="2.5" stroke-linecap="round" fill="none" />`;

    const cheeks = `<circle cx="130" cy="112" r="6" fill="#ff6678" opacity="0.45" />
                    <circle cx="190" cy="112" r="6" fill="#ff6678" opacity="0.45" />`;

    const ears = isCat 
      ? `<polygon points="120,95 108,60 142,82" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />
         <polygon points="123,92 114,68 138,82" fill="${innerEarColor}" />
         <polygon points="200,95 212,60 178,82" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />
         <polygon points="197,92 206,68 182,82" fill="${innerEarColor}" />`
      : `<path d="M 120,80 C 102,80 96,116 112,126 C 124,126 130,102 124,80 Z" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />
         <path d="M 200,80 C 218,80 224,116 208,126 C 196,126 190,102 196,80 Z" fill="${earColor}" stroke="#3c291f" stroke-width="3" stroke-linejoin="round" />`;

    const tailX = isCat ? 110 : 120;
    const tailPath = isCat
      ? `<path d="M 125,170 Q ${tailX - 25 + tailAngle},160 ${tailX - 15 + tailAngle},125" stroke="${bodyColor}" stroke-width="11" stroke-linecap="round" fill="none" />
         <path d="M 125,170 Q ${tailX - 25 + tailAngle},160 ${tailX - 15 + tailAngle},125" stroke="#3c291f" stroke-width="15" stroke-linecap="round" fill="none" style="z-index:-1" />`
      : `<path d="M 125,170 Q ${tailX - 10 + tailAngle},165 ${tailX + tailAngle},150" stroke="${earColor}" stroke-width="9" stroke-linecap="round" fill="none" />`;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" width="320" height="320">
        <g transform="translate(0, ${yOffset}) rotate(${rotate} 160 160)">
          <ellipse cx="160" cy="225" rx="${60 * scaleX}" ry="12" fill="rgba(60, 41, 31, 0.15)" />
          ${isCat ? tailPath : ""}
          <ellipse cx="160" cy="182" rx="${46 * scaleX}" ry="${38 * scaleY}" fill="${bodyColor}" stroke="#3c291f" stroke-width="3" />
          <rect x="135" y="${192 + legOffset1}" width="16" height="30" rx="8" fill="${bodyColor}" stroke="#3c291f" stroke-width="3" />
          <rect x="169" y="${192 + legOffset2}" width="16" height="30" rx="8" fill="${bodyColor}" stroke="#3c291f" stroke-width="3" />
          ${ears}
          <ellipse cx="160" cy="116" rx="${48 * scaleX}" ry="${42 * scaleY}" fill="${headColor}" stroke="#3c291f" stroke-width="3" />
          ${eyeElement}
          ${cheeks}
          ${!isCat ? `<ellipse cx="160" cy="116" rx="14" ry="10" fill="#fff" stroke="#3c291f" stroke-width="2" />
                      <ellipse cx="160" cy="111" rx="6" ry="4" fill="#3c291f" />` : ""}
          ${mouthElement}
          ${isCat ? `
            <path d="M 112,114 L 98,112 M 112,118 L 96,119 M 208,114 L 222,112 M 208,118 L 224,119" stroke="#3c291f" stroke-width="2" stroke-linecap="round" />
          ` : ""}
        </g>
      </svg>
    `;
    frames.push("data:image/svg+xml;utf8," + encodeURIComponent(svg.trim()));
  }
  return frames;
}

interface PresetFramePack {
  sourceImage: string;
  actions: ActionFrameSet;
}

function App() {
  return <StudioWindow />;
}

function StudioWindow() {
  const [pet, setPet] = usePetProfile();
  const petRef = useRef<PetProfile | null>(null);
  const [name, setName] = useState("奶茶");
  const [species, setSpecies] = useState<PetSpecies>("cat");
  const [manualFrames, setManualFrames] = useState<Partial<ActionFrameSet>>({});
  const [presetFrameDir, setPresetFrameDir] = useState(() => localStorage.getItem(PRESET_FRAME_DIR_STORAGE) ?? DEFAULT_PRESET_FRAME_DIR);
  const [presetStatus, setPresetStatus] = useState<string | null>(null);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"preset" | "manual">("preset");
  const [zoom, setZoom] = useState(() => {
    const stored = Number(localStorage.getItem(PET_ZOOM_STORAGE));
    return Number.isFinite(stored) && stored >= 50 && stored <= 150 ? stored : 100;
  });

  useEffect(() => {
    syncNativePetScale(zoom);
  }, [zoom]);

  useEffect(() => {
    petRef.current = pet;
  }, [pet]);

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    invoke<NativePetSettings>("get_native_pet_settings")
      .then(async (settings) => {
        if (cancelled) return;

        const frameRoot = settings.frameRoot?.trim() || DEFAULT_PRESET_FRAME_DIR;
        const zoomPercent = normalizeZoom(settings.scale * 100);
        setPresetFrameDir(frameRoot);
        setZoom(zoomPercent);
        localStorage.setItem(PRESET_FRAME_DIR_STORAGE, frameRoot);
        localStorage.setItem(PET_ZOOM_STORAGE, String(zoomPercent));

        const storedPet = await loadPet();
        if (!cancelled && storedPet?.storageMode === "preset-root") {
          const hydrated = await hydratePresetPet(storedPet, frameRoot, settings.currentAction);
          if (!cancelled && hydrated) setPet(hydrated);
        }
      })
      .catch(() => undefined);

    const unlistenPromise = listen<PetAction>("native-pet-action-changed", async (event) => {
      if (!isPetAction(event.payload)) return;
      const current = petRef.current;
      if (current && hasRenderableFrames(current)) {
        const next = withCurrentAction(current, event.payload);
        await savePet(toPersistedPet(next), next);
        if (!cancelled) setPet(next);
        return;
      }

      await setCurrentAction(event.payload, false);
      const storedPet = await loadPet();
      if (!cancelled && storedPet) setPet(storedPet);
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [setPet]);

  async function handleManualFrames(action: PetAction, files: FileList | null) {
    if (!files?.length) return;

    const images = await Promise.all(
      Array.from(files)
        .filter((file) => file.type.startsWith("image/"))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map(readFileAsDataUrl)
    );

    setManualFrames((current) => ({
      ...current,
      [action]: images
    }));
  }

  async function handleGenerate() {
    setIsGenerating(true);
    setError(null);
    try {
      const fallbackSourceImage = sourceImage ?? manualFrames.idle?.[0] ?? Object.values(manualFrames).find((frames) => frames?.[0])?.[0];
      const nextPet = createManualPet({ name, species, sourceImage: fallbackSourceImage ?? "", manualFrames });
      await savePet(nextPet);
      setPet(nextPet);
    } catch (err) {
      setError(`保存帧包失败：${formatError(err)}`);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleLoadPresetFrames() {
    setIsGenerating(true);
    setError(null);
    setPresetStatus(null);
    try {
      localStorage.setItem(PRESET_FRAME_DIR_STORAGE, presetFrameDir.trim() || DEFAULT_PRESET_FRAME_DIR);
      
      if (!isTauri) {
        setPresetStatus("正在模拟生成预置帧包...");
        await new Promise((r) => setTimeout(r, 600));
        const actions: ActionFrameSet = {
          idle: getMockFrames(species, "idle"),
          sit: getMockFrames(species, "sit"),
          sleep: getMockFrames(species, "sleep"),
          happy: getMockFrames(species, "happy"),
          walk: getMockFrames(species, "walk"),
          jump: getMockFrames(species, "jump"),
        };
        const nextPet = createManualPet({
          name: name || (species === "cat" ? "糖包" : "大黄"),
          species,
          sourceImage: actions.idle[0],
          manualFrames: actions,
        });
        setSourceImage(actions.idle[0]);
        setManualFrames(actions);
        await savePet(nextPet);
        setPet(nextPet);
        setPresetStatus("已在浏览器模式下成功加载模拟帧包！");
        return;
      }

      const pack = await invoke<PresetFramePack>("load_preset_frame_pack", {
        request: {
          rootDir: presetFrameDir.trim() || DEFAULT_PRESET_FRAME_DIR
        }
      });
      const nextPet = createManualPet({
        name,
        species,
        sourceImage: pack.sourceImage,
        manualFrames: pack.actions,
        frameRoot: presetFrameDir.trim() || DEFAULT_PRESET_FRAME_DIR,
        storageMode: "preset-root"
      });
      setSourceImage(pack.sourceImage);
      setManualFrames(pack.actions);
      await savePet(toPersistedPet(nextPet), nextPet);
      await invoke("set_native_pet_frame_root", {
        rootDir: presetFrameDir.trim() || DEFAULT_PRESET_FRAME_DIR
      }).catch(() => undefined);
      setPet(nextPet);
      setPresetStatus("已导入并保存本地预置帧包。");
    } catch (err) {
      setError(`预置帧包导入失败：${formatError(err)}`);
    } finally {
      setIsGenerating(false);
    }
  }

  async function switchAction(action: PetAction) {
    if (pet && hasRenderableFrames(pet)) {
      const next = withCurrentAction(pet, action);
      setPet(next);
      await savePet(toPersistedPet(next), next);
      await invoke("set_native_pet_action", { action }).catch(() => undefined);
      return;
    }

    await setCurrentAction(action);
    const next = await loadPet();
    if (next) setPet(next);
  }

  function handleZoomChange(value: number) {
    const nextZoom = normalizeZoom(value);
    setZoom(nextZoom);
    localStorage.setItem(PET_ZOOM_STORAGE, String(nextZoom));
  }

  return (
    <main className="studio-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">{isTauri ? "Tauri Desktop Environment" : "Browser Web Preview"}</p>
          <h1>把家里的毛孩子，做成桌面上的贴贴小宠物。</h1>
          <p className="hero-text">
            导入本地动作帧包，桌面宠物直接播放透明 PNG 帧；不再依赖生图模型。
          </p>
        </div>
        <div className="status-pill">
          <span className="pulse" />
          {pet ? `${pet.name} 已就位` : "等待创建宠物"}
        </div>
      </section>

      <section className="workspace-grid">
        <div className="control-panel">
          <div className="panel-header">
            <span>01</span>
            <h2>帧包导入</h2>
          </div>

          <div className="field-row">
            <label>
              宠物名字
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：奶茶" />
            </label>
            <label>
              类型
              <select value={species} onChange={(event) => setSpecies(event.target.value as PetSpecies)}>
                <option value="cat">小猫</option>
                <option value="dog">小狗</option>
              </select>
            </label>
          </div>

          <div className="import-tabs">
            <button
              type="button"
              className={activeTab === "preset" ? "tab-btn active" : "tab-btn"}
              onClick={() => setActiveTab("preset")}
            >
              📁 预置帧包
            </button>
            <button
              type="button"
              className={activeTab === "manual" ? "tab-btn active" : "tab-btn"}
              onClick={() => setActiveTab("manual")}
            >
              📤 手动上传
            </button>
          </div>

          <div className="manual-frame-panel">
            {activeTab === "preset" ? (
              <div className="preset-import-section">
                <p className="section-tip">
                  默认读取 <code>idle/sit/sleep/happy/walk/jump</code> 六个目录，每个动作至少 5 张透明 PNG。
                </p>
                <label className="preset-import-row">
                  预置帧包目录
                  <input value={presetFrameDir} onChange={(event) => setPresetFrameDir(event.target.value)} />
                </label>
                <button className="secondary-action" type="button" onClick={handleLoadPresetFrames} disabled={isGenerating}>
                  一键导入并保存预置帧包
                </button>
                {presetStatus && <p className="success-text">{presetStatus}</p>}
              </div>
            ) : (
              <div className="manual-upload-section">
                <p className="section-tip">
                  分别上传 6 个动作状态下的图片文件，每个动作需要至少 5 帧图片以生成平滑动画。
                </p>
                <div className="manual-frame-grid">
                  {PET_ACTIONS.map((action) => {
                    const frames = manualFrames[action.id];
                    const hasFrames = frames && frames.length > 0;
                    return (
                      <label key={action.id} className={`manual-frame-card ${hasFrames ? "has-frames" : ""}`}>
                        <div className="card-info">
                          <strong>{action.label}</strong>
                          <span>{frames?.length ?? 0} / 5 帧</span>
                        </div>
                        {hasFrames ? (
                          <div className="frames-preview-strip">
                            {frames.slice(0, 3).map((src, index) => (
                              <img key={index} src={src} className="thumb-frame" alt="preview" />
                            ))}
                            {frames.length > 3 && <span className="more-count">+{frames.length - 3}</span>}
                          </div>
                        ) : (
                          <div className="upload-placeholder">
                            <span className="upload-icon">➕</span>
                            <span>上传帧</span>
                          </div>
                        )}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          multiple
                          onChange={(event) => handleManualFrames(action.id, event.target.files)}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <button className="primary-action" onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? "正在保存..." : "保存当前帧包"}
          </button>

          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="preview-panel">
          <div className="panel-header">
            <span>02</span>
            <h2>动作控制</h2>
          </div>

          {pet ? (
            <PetPreviewStage pet={pet} action={pet.currentAction} zoom={zoom} />
          ) : (
            <div className="pet-stage">
              <div className="empty-pet">生成后这里会预览帧动画</div>
            </div>
          )}

          <div className="stage-controls">
            <div className="zoom-slider-container">
              <span className="zoom-icon">🔍</span>
              <span className="zoom-label">比例</span>
              <input
                type="range"
                min="50"
                max="150"
                value={zoom}
                onChange={(event) => handleZoomChange(Number(event.target.value))}
                className="zoom-slider"
              />
              <span className="zoom-value">{zoom}%</span>
            </div>
          </div>

          <div className="action-grid">
            {PET_ACTIONS.map((action) => (
              <button
                key={action.id}
                className={pet?.currentAction === action.id ? "action-card active" : "action-card"}
                onClick={() => switchAction(action.id)}
                disabled={!pet}
              >
                <strong>{action.label}</strong>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function syncNativePetScale(zoom: number) {
  if (!isTauri) return;
  invoke("set_native_pet_scale", { scale: zoom / 100 }).catch(() => undefined);
}

function emptyActionFrames(): ActionFrameSet {
  return {
    idle: [],
    sit: [],
    sleep: [],
    happy: [],
    walk: [],
    jump: []
  };
}

function toPersistedPet(pet: PetProfile): PetProfile {
  if (pet.storageMode !== "preset-root") return pet;

  return {
    ...pet,
    sourceImage: "",
    actions: emptyActionFrames()
  };
}

async function hydratePresetPet(pet: PetProfile, frameRoot: string, currentAction: PetAction) {
  const pack = await invoke<PresetFramePack>("load_preset_frame_pack", {
    request: {
      rootDir: frameRoot
    }
  });

  return {
    ...pet,
    frameRoot,
    sourceImage: pack.sourceImage,
    actions: pack.actions,
    currentAction: isPetAction(currentAction) ? currentAction : pet.currentAction,
    actionStartedAt: new Date().toISOString()
  };
}

function PetPreviewStage({ pet, action, zoom }: { pet: PetProfile; action: PetAction; zoom: number }) {
  const frames = pet.actions[action] ?? pet.actions.idle;
  const [frame, setFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    setFrame(0);
  }, [action, pet.actionStartedAt]);

  useEffect(() => {
    if (!isPlaying) return;
    const shouldLoop = LOOPING_ACTIONS.has(action);
    const timer = window.setInterval(() => {
      setFrame((value) => {
        if (shouldLoop) return (value + 1) % frames.length;
        return Math.min(value + 1, frames.length - 1);
      });
    }, action === "sleep" ? 420 : 150);
    return () => window.clearInterval(timer);
  }, [action, frames.length, isPlaying, pet.actionStartedAt]);

  if (frames.length === 0) {
    return (
      <div className="pet-stage">
        <div className="empty-pet">正在载入本地帧包</div>
      </div>
    );
  }

  return (
    <div className="preview-playground">
      <div className="pet-stage">
        <div
          className="pet-preview-image-layer"
          style={{
            transform: `scale(${zoom / 100})`
          }}
        >
          <div className="pet-display-wrapper">
            <img src={frames[frame]} alt={`${pet.name} ${action}`} className="pet-preview-image" draggable={false} />
            <span className="pet-tag-name">{pet.name}</span>
          </div>
        </div>
      </div>

      <div className="playback-panel">
        <button
          type="button"
          className="play-btn"
          onClick={() => setFrame((value) => (value - 1 + frames.length) % frames.length)}
          disabled={isPlaying}
          title="上一帧"
        >
          ⏮️
        </button>
        <button
          type="button"
          className={`play-btn play-pause ${isPlaying ? "playing" : "paused"}`}
          onClick={() => setIsPlaying(!isPlaying)}
          title={isPlaying ? "暂停" : "播放"}
        >
          {isPlaying ? "⏸️" : "▶️"}
        </button>
        <button
          type="button"
          className="play-btn"
          onClick={() => setFrame((value) => (value + 1) % frames.length)}
          disabled={isPlaying}
          title="下一帧"
        >
          ⏭️
        </button>
        <span className="frame-counter">
          帧 {frame + 1} / {frames.length}
        </span>
      </div>
    </div>
  );
}

function usePetProfile() {
  const [pet, setPet] = useState<PetProfile | null>(null);

  useEffect(() => {
    let alive = true;
    loadPet()
      .then((loadedPet) => {
        if (alive) setPet(loadedPet);
      })
      .catch(() => {
        if (alive) setPet(null);
      });

    function handleCustom(event: Event) {
      const customEvent = event as CustomEvent<PetProfile>;
      setPet(customEvent.detail);
    }

    window.addEventListener("pet-updated", handleCustom);

    let channel: BroadcastChannel | null = null;
    if ("BroadcastChannel" in window) {
      channel = new BroadcastChannel(PET_CHANNEL);
      channel.onmessage = (event: MessageEvent<{ type: string; pet: PetProfile }>) => {
        if (event.data.type === "pet-updated") setPet(event.data.pet);
      };
    }

    return () => {
      alive = false;
      window.removeEventListener("pet-updated", handleCustom);
      channel?.close();
    };
  }, []);

  return [pet, setPet] as const;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function createManualPet({
  name,
  species,
  sourceImage,
  manualFrames,
  frameRoot,
  storageMode = "embedded"
}: {
  name: string;
  species: PetSpecies;
  sourceImage: string;
  manualFrames: Partial<ActionFrameSet>;
  frameRoot?: string;
  storageMode?: PetProfile["storageMode"];
}): PetProfile {
  const missingActions = PET_ACTIONS.filter((action) => (manualFrames[action.id]?.length ?? 0) < 5);
  if (missingActions.length > 0) {
    throw new Error(`以下动作至少需要 5 帧：${missingActions.map((action) => action.label).join("、")}`);
  }
  if (!sourceImage) {
    throw new Error("没有可用的帧图。请先导入预置帧包，或手动上传动作帧。");
  }

  const actions = Object.fromEntries(PET_ACTIONS.map((action) => [action.id, manualFrames[action.id]!.slice()])) as ActionFrameSet;

  return {
    id: crypto.randomUUID(),
    name: name.trim() || (species === "cat" ? "小猫" : "小狗"),
    species,
    style: "q-sticker",
    storageMode,
    frameRoot,
    createdAt: new Date().toISOString(),
    sourceImage,
    actions,
    currentAction: "idle",
    actionStartedAt: new Date().toISOString(),
    scale: 1
  };
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
