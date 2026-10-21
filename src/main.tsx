import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DEFAULT_PRESET_FRAME_DIR,
  PET_ZOOM_STORAGE,
  PRESET_FRAME_DIR_STORAGE,
  UPLOAD_URL_STORAGE
} from "./config";
import { generatePetFramePack, GenerationCancelled } from "./ai-generation";
import { hasRenderableFrames, isPetAction, normalizeZoom, withCurrentAction } from "./pet-logic";
import {
  loadPet,
  loadAllPets,
  savePet,
  setActivePetId,
  deletePet,
  setCurrentAction
} from "./storage";
import {
  PET_ACTIONS,
  type ActionFrameSet,
  type PetAction,
  type PetProfile,
  type PetSpecies,
  type StudioTab
} from "./types";
import { ToastProvider, useToast } from "./components/ui/Toast";
import { AppSidebar } from "./components/shell/AppSidebar";
import { LiveStage } from "./components/stage/LiveStage";
import { Workshop } from "./components/workshop/Workshop";
import { PetShelf } from "./components/shelf/PetShelf";
import "./styles.css";

const isTauri = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;
const isMacOS = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

interface NativePetSettings {
  frameRoot: string;
  scale: number;
  currentAction: PetAction;
}

interface PresetFramePack {
  sourceImage: string;
  actions: ActionFrameSet;
}

interface SavedManualFramePack {
  frameRoot: string;
  sourceImage: string;
}

function StudioApp() {
  const { showToast } = useToast();
  const [currentTab, setCurrentTab] = useState<StudioTab>("stage");
  const [pets, setPets] = useState<PetProfile[]>([]);
  const [activePet, setActivePet] = useState<PetProfile | null>(null);
  const activePetRef = useRef<PetProfile | null>(null);

  // Workshop Form State
  const [name, setName] = useState("奶茶");
  const [species, setSpecies] = useState<PetSpecies>("cat");
  const [presetFrameDir, setPresetFrameDir] = useState(
    () => localStorage.getItem(PRESET_FRAME_DIR_STORAGE) ?? DEFAULT_PRESET_FRAME_DIR
  );
  const [manualFrames, setManualFrames] = useState<Partial<ActionFrameSet>>({});
  const [isLoading, setIsLoading] = useState(false);

  // AI Form State
  const [apiKey, setApiKey] = useState("");
  const [uploadUrl, setUploadUrl] = useState(() => localStorage.getItem(UPLOAD_URL_STORAGE) ?? "");
  const [referencePhoto, setReferencePhoto] = useState<string | null>(null);
  const [appearanceNotes, setAppearanceNotes] = useState("");
  const [aiRunning, setAiRunning] = useState(false);
  const [aiLog, setAiLog] = useState<string[]>([]);
  const aiCancelRef = useRef<{ cancelled: boolean } | null>(null);

  // Zoom
  const [zoom, setZoom] = useState(() => {
    const stored = Number(localStorage.getItem(PET_ZOOM_STORAGE));
    return Number.isFinite(stored) && stored >= 50 && stored <= 150 ? stored : 100;
  });

  useEffect(() => {
    activePetRef.current = activePet;
  }, [activePet]);

  // Sync scale to Tauri
  useEffect(() => {
    if (!isTauri) return;
    const timer = window.setTimeout(() => {
      invoke("set_native_pet_scale", { scale: zoom / 100 }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [zoom]);

  // Load pets on mount
  useEffect(() => {
    let cancelled = false;

    async function initPets() {
      const all = await loadAllPets();
      const current = await loadPet();
      if (cancelled) return;

      if (all.length === 0 && !current) {
        const ACTIONS: PetAction[] = ["idle", "sit", "sleep", "happy", "walk", "jump"];
        const defaultActions: ActionFrameSet = {} as ActionFrameSet;
        for (const act of ACTIONS) {
          defaultActions[act] = [0, 1, 2, 3, 4].map(
            (idx) => `/frame-pack/${act}/${String(idx).padStart(3, "0")}.png`
          );
        }
        const defaultPet = createManualPet({
          name: "咕唧 (萌宠小怪兽)",
          species: "dog",
          sourceImage: defaultActions.idle[0],
          manualFrames: defaultActions,
          frameRoot: DEFAULT_PRESET_FRAME_DIR,
          storageMode: "preset-root"
        });
        await savePet(defaultPet);
        setActivePet(defaultPet);
        setPets([defaultPet]);
        return;
      }

      setPets(all);
      setActivePet(current ?? all[0] ?? null);
    }

    initPets();

    if (isTauri) {
      invoke<NativePetSettings>("get_native_pet_settings")
        .then(async (settings) => {
          if (cancelled) return;
          const frameRoot = settings.frameRoot?.trim() || DEFAULT_PRESET_FRAME_DIR;
          const zoomPercent = normalizeZoom(settings.scale * 100);
          setPresetFrameDir(frameRoot);
          setZoom(zoomPercent);
          localStorage.setItem(PRESET_FRAME_DIR_STORAGE, frameRoot);
          localStorage.setItem(PET_ZOOM_STORAGE, String(zoomPercent));

          const stored = await loadPet();
          if (!cancelled && stored?.storageMode === "preset-root") {
            const hydrated = await hydratePresetPet(stored, frameRoot, settings.currentAction);
            if (!cancelled && hydrated) {
              setActivePet(hydrated);
              setPets((prev) => prev.map((p) => (p.id === hydrated.id ? hydrated : p)));
            }
          }
        })
        .catch((err) => {
          if (!cancelled) showToast(`读取设置失败：${formatError(err)}`, "error");
        });

      const unlistenAction = listen<PetAction>("native-pet-action-changed", async (event) => {
        if (!isPetAction(event.payload)) return;
        const current = activePetRef.current;
        if (current && hasRenderableFrames(current)) {
          const next = withCurrentAction(current, event.payload);
          await savePet(toPersistedPet(next), next);
          if (!cancelled) {
            setActivePet(next);
            setPets((prev) => prev.map((p) => (p.id === next.id ? next : p)));
          }
          return;
        }
        await setCurrentAction(event.payload, false);
      });

      const unlistenError = listen<string>("native-pet-error", (event) => {
        if (!cancelled) showToast(`原生桌宠：${event.payload}`, "error");
      });

      return () => {
        cancelled = true;
        unlistenAction.then((fn) => fn()).catch(() => undefined);
        unlistenError.then((fn) => fn()).catch(() => undefined);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [showToast]);

  // Actions
  async function handleSwitchAction(action: PetAction) {
    if (!activePet) return;
    if (hasRenderableFrames(activePet)) {
      const next = withCurrentAction(activePet, action);
      setActivePet(next);
      setPets((prev) => prev.map((p) => (p.id === next.id ? next : p)));
      await savePet(toPersistedPet(next), next);
      if (isTauri) {
        await invoke("set_native_pet_action", { action }).catch(() => undefined);
      }
      return;
    }
    await setCurrentAction(action);
  }

  function handleZoomChange(val: number) {
    const nextZoom = normalizeZoom(val);
    setZoom(nextZoom);
    localStorage.setItem(PET_ZOOM_STORAGE, String(nextZoom));
  }

  async function handleResetPosition() {
    if (!isTauri) return;
    try {
      await invoke("reset_native_pet_position");
      showToast("桌面宠物已唤回右下角 🎯", "success");
    } catch (err) {
      showToast(`唤回失败：${formatError(err)}`, "error");
    }
  }

  // Workshop - Import Preset
  async function handleImportPreset() {
    setIsLoading(true);
    try {
      const rootDir = presetFrameDir.trim() || DEFAULT_PRESET_FRAME_DIR;
      localStorage.setItem(PRESET_FRAME_DIR_STORAGE, rootDir);

      if (!isTauri) {
        const ACTIONS: PetAction[] = ["idle", "sit", "sleep", "happy", "walk", "jump"];
        const loadedActions: ActionFrameSet = {} as ActionFrameSet;
        for (const act of ACTIONS) {
          loadedActions[act] = [0, 1, 2, 3, 4].map(
            (idx) => `/frame-pack/${act}/${String(idx).padStart(3, "0")}.png`
          );
        }
        const newPet = createManualPet({
          name: name.trim() || "咕唧 (萌宠小怪兽)",
          species,
          sourceImage: loadedActions.idle[0],
          manualFrames: loadedActions,
          frameRoot: rootDir,
          storageMode: "preset-root"
        });
        await savePet(newPet);
        setActivePet(newPet);
        setPets(await loadAllPets());
        showToast("已导入真实预置帧包（小怪兽动画包）！", "success");
        setCurrentTab("stage");
        return;
      }

      const pack = await invoke<PresetFramePack>("load_preset_frame_pack", {
        request: { rootDir }
      });

      const newPet = createManualPet({
        name: name.trim() || (species === "cat" ? "糖宝" : "大黄"),
        species,
        sourceImage: pack.sourceImage,
        manualFrames: pack.actions,
        frameRoot: rootDir,
        storageMode: "preset-root"
      });

      await savePet(toPersistedPet(newPet), newPet);
      await invoke("set_native_pet_frame_root", { rootDir }).catch(() => undefined);

      setActivePet(newPet);
      setPets(await loadAllPets());
      showToast(`已成功导入「${newPet.name}」并同步至桌面！`, "success");
      setCurrentTab("stage");
    } catch (err) {
      showToast(`导入失败：${formatError(err)}`, "error");
    } finally {
      setIsLoading(false);
    }
  }

  // Workshop - Save Manual Frames
  async function handleSaveManualFrames() {
    setIsLoading(true);
    try {
      const actions = Object.fromEntries(
        PET_ACTIONS.map((a) => [a.id, manualFrames[a.id] ?? []])
      ) as ActionFrameSet;

      const fallbackImage =
        manualFrames.idle?.[0] || Object.values(manualFrames).find((f) => f?.[0])?.[0] || "";

      if (isTauri) {
        const saved = await invoke<SavedManualFramePack>("save_manual_frame_pack", {
          request: { actions }
        });
        const newPet = createManualPet({
          name: name.trim() || "我的宠物",
          species,
          sourceImage: saved.sourceImage || fallbackImage,
          manualFrames: actions,
          frameRoot: saved.frameRoot,
          storageMode: "preset-root"
        });
        await savePet(toPersistedPet(newPet), newPet);
        await invoke("set_native_pet_frame_root", { rootDir: saved.frameRoot }).catch(() => undefined);

        setActivePet(newPet);
        setPets(await loadAllPets());
        showToast(`已成功保存「${newPet.name}」并同步至桌面！`, "success");
        setCurrentTab("stage");
        return;
      }

      const newPet = createManualPet({
        name: name.trim() || "我的宠物",
        species,
        sourceImage: fallbackImage,
        manualFrames: actions
      });
      await savePet(newPet);
      setActivePet(newPet);
      setPets(await loadAllPets());
      showToast("已保存动作帧（网页预览模式）！", "success");
      setCurrentTab("stage");
    } catch (err) {
      showToast(`保存帧包失败：${formatError(err)}`, "error");
    } finally {
      setIsLoading(false);
    }
  }

  // Workshop - AI Generation
  async function handleGenerateAI() {
    if (!isTauri) {
      showToast("AI 生成需在桌面版环境中运行", "error");
      return;
    }
    if (aiRunning) return;

    setAiLog([]);
    const cancelToken = { cancelled: false };
    aiCancelRef.current = cancelToken;
    setAiRunning(true);

    try {
      const result = await generatePetFramePack({
        apiKey,
        uploadUrl,
        referencePhoto: referencePhoto ?? "",
        petName: name,
        species,
        appearanceNotes,
        onProgress: (msg) => setAiLog((prev) => [...prev, msg]),
        isCancelled: () => cancelToken.cancelled
      });

      const newPet = createManualPet({
        name: name.trim() || "AI 宠物",
        species,
        sourceImage: result.characterImage,
        manualFrames: result.actions,
        frameRoot: result.frameRoot,
        storageMode: "preset-root"
      });

      await savePet(toPersistedPet(newPet), newPet);
      await invoke("set_native_pet_frame_root", { rootDir: result.frameRoot }).catch(() => undefined);

      setActivePet(newPet);
      setPets(await loadAllPets());
      showToast(`AI 宠物「${newPet.name}」制作完成并已入住桌面！`, "success");
      setCurrentTab("stage");
    } catch (err) {
      if (err instanceof GenerationCancelled) {
        showToast("AI 生成已取消", "info");
      } else {
        showToast(`AI 生成失败：${formatError(err)}`, "error");
      }
    } finally {
      setAiRunning(false);
      aiCancelRef.current = null;
    }
  }

  function handleCancelAI() {
    if (aiCancelRef.current) {
      aiCancelRef.current.cancelled = true;
    }
  }

  // Pet Shelf - Deploy Pet
  async function handleDeployPet(petToDeploy: PetProfile) {
    try {
      const switched = await setActivePetId(petToDeploy.id);
      if (switched) {
        if (isTauri && switched.frameRoot) {
          await invoke("set_native_pet_frame_root", { rootDir: switched.frameRoot }).catch(
            () => undefined
          );
        }
        setActivePet(switched);
        showToast(`已将「${switched.name}」派往桌面！🐾`, "success");
      }
    } catch (err) {
      showToast(`切换宠物失败：${formatError(err)}`, "error");
    }
  }

  // Pet Shelf - Delete Pet
  async function handleDeletePet(id: string) {
    const petToDelete = pets.find((p) => p.id === id);
    if (!petToDelete) return;
    if (!confirm(`确定要从宠物架移除「${petToDelete.name}」吗？`)) return;

    try {
      const nextActive = await deletePet(id);
      const remaining = await loadAllPets();
      setPets(remaining);
      setActivePet(nextActive);
      if (isTauri && nextActive?.frameRoot) {
        await invoke("set_native_pet_frame_root", { rootDir: nextActive.frameRoot }).catch(
          () => undefined
        );
      }
      showToast(`已移除「${petToDelete.name}」`, "info");
    } catch (err) {
      showToast(`删除失败：${formatError(err)}`, "error");
    }
  }

  return (
    <div className="app-shell">
      <AppSidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        activePet={activePet}
        petCount={pets.length}
      />

      <main className="app-content">
        <header className="content-header">
          <div className="header-title-group">
            <h1 className="header-title">
              {currentTab === "stage" && "伴侣互动台"}
              {currentTab === "workshop" && "宠物工坊"}
              {currentTab === "shelf" && "我的宠物架"}
            </h1>
            <span className="header-subtitle">
              {currentTab === "stage" && "在桌面上陪伴你的毛孩子，随心换姿态与调控"}
              {currentTab === "workshop" && "导入本地帧包、装配动作帧或由 AI 自动生成"}
              {currentTab === "shelf" && "所有收藏的小宠物，一键随心换上桌面"}
            </span>
          </div>
        </header>

        {currentTab === "stage" && (
          <LiveStage
            pet={activePet}
            onSwitchAction={handleSwitchAction}
            zoom={zoom}
            onChangeZoom={handleZoomChange}
            onResetPosition={handleResetPosition}
            isTauri={isTauri}
            isMacOS={isMacOS}
            onGoToWorkshop={() => setCurrentTab("workshop")}
          />
        )}

        {currentTab === "workshop" && (
          <Workshop
            name={name}
            onChangeName={setName}
            species={species}
            onChangeSpecies={setSpecies}
            presetDir={presetFrameDir}
            onChangePresetDir={setPresetFrameDir}
            onImportPreset={handleImportPreset}
            manualFrames={manualFrames}
            onChangeManualFrames={setManualFrames}
            onSaveManualFrames={handleSaveManualFrames}
            isLoading={isLoading}
            isTauri={isTauri}
            apiKey={apiKey}
            onChangeApiKey={setApiKey}
            uploadUrl={uploadUrl}
            onChangeUploadUrl={(val) => {
              setUploadUrl(val);
              localStorage.setItem(UPLOAD_URL_STORAGE, val);
            }}
            referencePhoto={referencePhoto}
            onSelectReferencePhoto={async (files) => {
              const file = files?.[0];
              if (!file) return;
              try {
                const dataUrl = await readFileAsDataUrl(file);
                setReferencePhoto(dataUrl);
              } catch {
                showToast("读取图片失败", "error");
              }
            }}
            appearanceNotes={appearanceNotes}
            onChangeAppearanceNotes={setAppearanceNotes}
            aiRunning={aiRunning}
            aiLog={aiLog}
            onGenerateAI={handleGenerateAI}
            onCancelAI={handleCancelAI}
          />
        )}

        {currentTab === "shelf" && (
          <PetShelf
            pets={pets}
            activePetId={activePet?.id ?? null}
            onDeployPet={handleDeployPet}
            onDeletePet={handleDeletePet}
            onGoToWorkshop={() => setCurrentTab("workshop")}
          />
        )}
      </main>
    </div>
  );
}

function toPersistedPet(pet: PetProfile): PetProfile {
  if (pet.storageMode !== "preset-root") return pet;
  return {
    ...pet,
    sourceImage: "",
    actions: {
      idle: [],
      sit: [],
      sleep: [],
      happy: [],
      walk: [],
      jump: []
    }
  };
}

async function hydratePresetPet(pet: PetProfile, frameRoot: string, currentAction: PetAction) {
  const pack = await invoke<PresetFramePack>("load_preset_frame_pack", {
    request: { rootDir: frameRoot }
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
    throw new Error(
      `以下动作至少需要 5 帧图片：${missingActions.map((a) => a.label).join("、")}`
    );
  }
  if (!sourceImage) {
    throw new Error("没有可用的帧图。请先导入预置帧包或上传动作帧。");
  }

  const actions = Object.fromEntries(
    PET_ACTIONS.map((action) => [action.id, manualFrames[action.id]!.slice()])
  ) as ActionFrameSet;

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

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
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
    <ToastProvider>
      <StudioApp />
    </ToastProvider>
  </React.StrictMode>
);
