import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AUTONOMOUS_STORAGE,
  DEFAULT_PRESET_FRAME_DIR,
  PET_ZOOM_STORAGE,
  PRESET_FRAME_DIR_STORAGE,
  UPLOAD_URL_STORAGE
} from "./config";
import { createGenerationCheckpoint, generatePetFramePack, GenerationCancelled } from "./ai-generation";
import { hasRenderableFrames, isPetAction, normalizeZoom, withCurrentAction } from "./pet-logic";
import { actionDurationMs, chooseNextAction } from "./pet-behavior";
import { buildDefaultActionFrames, hydratePet, toPersistedPet as persistPet } from "./pet-resources";
import {
  loadPet,
  loadAllPets,
  savePet,
  setActivePetId,
  deletePet,
  renamePet,
  updatePetAction,
  subscribePetChanges,
  isCollectionInitialized
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

interface NativeActionEvent { action: PetAction; petId: string | null; revision: number }

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
  const [activePet, setActivePetState] = useState<PetProfile | null>(null);
  const [initialized, setInitialized] = useState(false);
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
  const [aiCommitting, setAiCommitting] = useState(false);
  const [canResumeAI, setCanResumeAI] = useState(false);
  const [aiLog, setAiLog] = useState<string[]>([]);
  const aiCancelRef = useRef<{ cancelled: boolean; committing: boolean } | null>(null);
  const aiCheckpointRef = useRef(createGenerationCheckpoint());

  useEffect(() => {
    if (!aiCancelRef.current) {
      aiCheckpointRef.current = createGenerationCheckpoint();
      setCanResumeAI(false);
    }
  }, [name, species, uploadUrl, referencePhoto, appearanceNotes]);

  // Zoom
  const [zoom, setZoom] = useState(() => {
    const stored = Number(localStorage.getItem(PET_ZOOM_STORAGE));
    return Number.isFinite(stored) && stored >= 50 && stored <= 150 ? stored : 100;
  });

  // Autonomous wandering (browser preview only; the desktop app drives its own).
  const [autonomous, setAutonomous] = useState(
    () => localStorage.getItem(AUTONOMOUS_STORAGE) !== "off"
  );

  const mutations = useRef<Promise<unknown>>(Promise.resolve());
  const transitioning = useRef(false);
  const nativeRevision = useRef(0);
  async function syncNativeAction(action: PetAction) {
    const reply = await invoke<NativeActionEvent | undefined>("set_native_pet_action", { action });
    if (reply) nativeRevision.current = Math.max(nativeRevision.current, reply.revision);
    return reply?.action ?? action;
  }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const task = mutations.current.then(work);
    mutations.current = task.catch(() => undefined);
    return task;
  }
  function setActivePet(pet: PetProfile | null) {
    activePetRef.current = pet;
    setActivePetState(pet);
  }
  async function refreshList() {
    const all = await loadAllPets();
    const current = activePetRef.current;
    setPets(all.map((p) => p.id === current?.id ? { ...p, sourceImage: current.sourceImage, actions: current.actions } : p));
  }
  async function activatePet(pet: PetProfile, create = false) {
    return serial(async () => {
      transitioning.current = true;
      const previous = activePetRef.current;
      let nativeChanged = false;
      try {
        const selected = create ? pet : (await loadAllPets()).find((p) => p.id === pet.id);
        if (!selected) throw new Error("该宠物已被移除");
        const full = await ensurePetHydrated(selected);
        if (isTauri && full.frameRoot) {
          nativeChanged = true;
          await invoke("set_native_pet_frame_root", { rootDir: full.frameRoot, petId: full.id });
          full.currentAction = await syncNativeAction(full.currentAction);
        }
        if (create) await savePet(toPersistedPet(full));
        else if (!await setActivePetId(full.id)) throw new Error("该宠物已被移除");
        setActivePet(full);
        await refreshList();
        return full;
      } catch (error) {
        if (nativeChanged && previous?.frameRoot) {
          try {
            await invoke("set_native_pet_frame_root", { rootDir: previous.frameRoot, petId: previous.id });
            await syncNativeAction(previous.currentAction);
          } catch (rollbackError) {
            showToast(`恢复原桌宠失败：${formatError(rollbackError)}`, "error");
          }
        }
        throw error;
      } finally { transitioning.current = false; }
    });
  }

  // Sync scale to Tauri
  useEffect(() => {
    if (!isTauri || !initialized) return;
    const timer = window.setTimeout(() => {
      invoke("set_native_pet_scale", { scale: zoom / 100 }).catch((err) => showToast(`调整大小失败：${formatError(err)}`, "error"));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [zoom, initialized, showToast]);

  // One ordered restore owns the initial profile and native settings.
  useEffect(() => {
    let cancelled = false;
    const init = serial(async () => {
      transitioning.current = true;
      try {
        const [all, stored, settings] = await Promise.all([
          loadAllPets(), loadPet(),
          isTauri ? invoke<NativePetSettings>("get_native_pet_settings") : Promise.resolve(null)
        ]);
        if (cancelled) return;
        setPets(all);
        let current = stored ?? all[0] ?? null;
        if (!current && !await isCollectionInitialized()) {
          const actions = buildDefaultActionFrames();
          current = createManualPet({ name: "咕唧 (萌宠小怪兽)", species: "dog",
            sourceImage: actions.idle[0], manualFrames: actions,
            frameRoot: DEFAULT_PRESET_FRAME_DIR, storageMode: "preset-root" });
          await savePet(toPersistedPet(current));
        }
        if (settings) {
          setPresetFrameDir(current?.frameRoot || DEFAULT_PRESET_FRAME_DIR);
          setZoom(normalizeZoom(settings.scale * 100));
        }
        if (current) {
          const full = await ensurePetHydrated(current, settings?.currentAction);
          if (cancelled) return;
          // The selected profile owns its assets; runtime settings supply the live action.
          if (isTauri && full.frameRoot) {
            await invoke("set_native_pet_frame_root", { rootDir: full.frameRoot, petId: full.id });
          }
          setActivePet(full);
          await refreshList();
        } else if (isTauri) {
          await invoke("set_native_pet_visible", { visible: false });
        }
      } finally {
        transitioning.current = false;
        if (!cancelled) setInitialized(true);
      }
    });
    init.catch((err) => { if (!cancelled) showToast(`加载宠物失败：${formatError(err)}`, "error"); });

    const unsubscribe = subscribePetChanges(() => {
      void serial(async () => {
        if (cancelled) return;
        const stored = await loadPet();
        const full = stored ? await ensurePetHydrated(stored) : null;
        if (!cancelled) { setActivePet(full); await refreshList(); }
      }).catch((err) => { if (!cancelled) showToast(`同步宠物失败：${formatError(err)}`, "error"); });
    });
    const unlistenAction = isTauri ? listen<PetAction | NativeActionEvent>("native-pet-action-changed", (event) => {
      const payload = event.payload;
      const action = typeof payload === "string" ? payload : payload.action;
      if (cancelled || transitioning.current || !isPetAction(action)) return;
      const id = activePetRef.current?.id;
      const revision = typeof payload === "string" ? null : payload.revision;
      if (typeof payload !== "string" && (payload.petId !== id || payload.revision <= nativeRevision.current)) return;
      if (revision !== null) nativeRevision.current = revision;
      void serial(async () => {
        const current = activePetRef.current;
        if (cancelled || !current || current.id !== id || (revision !== null && revision < nativeRevision.current)) return;
        const saved = await updatePetAction(current.id, action);
        if (saved && !cancelled) {
          const next = { ...current, currentAction: saved.currentAction, actionStartedAt: saved.actionStartedAt };
          setActivePet(next);
          setPets((prev) => prev.map((p) => p.id === next.id ? { ...p, currentAction: next.currentAction } : p));
        }
      }).catch((err) => { if (!cancelled) showToast(`保存动作失败：${formatError(err)}`, "error"); });
    }) : null;
    const unlistenError = isTauri ? listen<string>("native-pet-error", (event) => {
      if (!cancelled) showToast(`原生桌宠：${event.payload}`, "error");
    }) : null;
    return () => {
      cancelled = true;
      unsubscribe();
      unlistenAction?.then((fn) => fn()).catch(() => undefined);
      unlistenError?.then((fn) => fn()).catch(() => undefined);
    };
  }, [showToast]);

  async function handleSwitchAction(action: PetAction) {
    try {
      await serial(async () => {
        const current = activePetRef.current;
        if (!current || !hasRenderableFrames(current)) return;
        const confirmed = isTauri ? await syncNativeAction(action) : action;
        let saved;
        try { saved = await updatePetAction(current.id, confirmed); }
        catch (error) {
          if (isTauri) await syncNativeAction(current.currentAction);
          throw error;
        }
        if (!saved) throw new Error("该宠物已被移除");
        const next = withCurrentAction(current, confirmed, saved.actionStartedAt);
        setActivePet(next);
        setPets((prev) => prev.map((p) => p.id === next.id ? { ...p, currentAction: confirmed } : p));
      });
    } catch (err) { showToast(`切换动作失败：${formatError(err)}`, "error"); }
  }

  // Keep the latest handler reachable from the wandering timer without
  // rescheduling on every render.
  const switchActionRef = useRef(handleSwitchAction);
  useEffect(() => {
    switchActionRef.current = handleSwitchAction;
  });

  // Browser preview wanders on its own, mirroring the native runtime. In the
  // desktop app the Rust side owns this and pushes actions through events.
  useEffect(() => {
    if (isTauri || !autonomous) return;
    const pet = activePetRef.current;
    if (!pet || !hasRenderableFrames(pet)) return;

    const timer = window.setTimeout(() => {
      void switchActionRef.current(chooseNextAction(pet.currentAction));
    }, actionDurationMs(pet.currentAction));

    return () => window.clearTimeout(timer);
  }, [isTauri, autonomous, activePet?.id, activePet?.currentAction, activePet?.actionStartedAt]);

  function handleZoomChange(val: number) {
    const nextZoom = normalizeZoom(val);
    setZoom(nextZoom);
    localStorage.setItem(PET_ZOOM_STORAGE, String(nextZoom));
  }

  function handleToggleAutonomous(value: boolean) {
    setAutonomous(value);
    localStorage.setItem(AUTONOMOUS_STORAGE, value ? "on" : "off");
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
        await activatePet(newPet, true);
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

      await activatePet(newPet, true);
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
        await activatePet(newPet, true);
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
      await activatePet(newPet, true);
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
    if (aiCancelRef.current || isLoading) return;

    setAiLog([]);
    const cancelToken = { cancelled: false, committing: false };
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
        checkpoint: aiCheckpointRef.current,
        onProgress: (msg) => setAiLog((prev) => [...prev, msg]),
        isCancelled: () => cancelToken.cancelled
      });

      if (cancelToken.cancelled) throw new GenerationCancelled();
      cancelToken.committing = true;
      setAiCommitting(true);

      const newPet = createManualPet({
        name: name.trim() || "AI 宠物",
        species,
        sourceImage: result.characterImage,
        manualFrames: result.actions,
        frameRoot: result.frameRoot,
        storageMode: "preset-root"
      });

      await activatePet(newPet, true);
      aiCheckpointRef.current = createGenerationCheckpoint();
      setCanResumeAI(false);
      showToast(`AI 宠物「${newPet.name}」制作完成并已入住桌面！`, "success");
      setCurrentTab("stage");
    } catch (err) {
      setCanResumeAI(Boolean(aiCheckpointRef.current.referenceUrl));
      if (err instanceof GenerationCancelled) {
        showToast("AI 生成已取消，已完成的图片可在本次会话内继续使用", "info");
      } else {
        showToast(`AI 生成失败：${formatError(err)}`, "error");
      }
    } finally {
      setAiRunning(false);
      setAiCommitting(false);
      aiCancelRef.current = null;
    }
  }

  function handleCancelAI() {
    if (aiCancelRef.current && !aiCancelRef.current.committing) {
      aiCancelRef.current.cancelled = true;
      setAiLog((prev) => [...prev, "已请求取消，等待当前步骤返回后停止。"]);
    }
  }

  // UI mutations share a queue; stale native events never activate a profile.
  async function handleDeployPet(pet: PetProfile) {
    try {
      const latest = (await loadAllPets()).find((p) => p.id === pet.id);
      if (!latest) throw new Error("该宠物已被移除");
      const full = await activatePet(latest);
      showToast(`已将「${full.name}」派往桌面！🐾`, "success");
    } catch (err) { showToast(`切换宠物失败：${formatError(err)}`, "error"); }
  }

  async function handleDeletePet(id: string) {
    const pet = pets.find((p) => p.id === id);
    if (!pet || !confirm(`确定要从宠物架移除「${pet.name}」吗？`)) return;
    try {
      await serial(async () => {
        transitioning.current = true;
        try {
          const current = activePetRef.current;
          const remaining = (await loadAllPets()).filter((p) => p.id !== id);
          const candidate = current?.id === id ? remaining[0] ?? null : current;
          const full = candidate ? await ensurePetHydrated(candidate) : null;
          if (isTauri && current?.id === id && full?.frameRoot) {
            await invoke("set_native_pet_frame_root", { rootDir: full.frameRoot, petId: full.id });
            full.currentAction = await syncNativeAction(full.currentAction);
          }
          if (isTauri && remaining.length === 0) await invoke("set_native_pet_visible", { visible: false });
          const next = await deletePet(id);
          setActivePet(next && full?.id === next.id ? { ...full, name: next.name } : next ? await ensurePetHydrated(next) : null);
          await refreshList();
        } catch (error) {
          const previous = activePetRef.current;
          if (isTauri && previous?.frameRoot) {
            await invoke("set_native_pet_frame_root", { rootDir: previous.frameRoot, petId: previous.id });
            await syncNativeAction(previous.currentAction);
          }
          throw error;
        } finally { transitioning.current = false; }
      });
      showToast(`已移除「${pet.name}」`, "info");
    } catch (err) { showToast(`删除失败：${formatError(err)}`, "error"); }
  }

  async function handleRenamePet(id: string, newName: string) {
    try {
      await serial(async () => {
        const updated = await renamePet(id, newName);
        if (!updated) throw new Error("该宠物已被移除");
        setPets((prev) => prev.map((p) => p.id === id ? { ...p, name: updated.name } : p));
        const current = activePetRef.current;
        if (current?.id === id) setActivePet({ ...current, name: updated.name });
        showToast(`已重命名为「${updated.name}」`, "success");
      });
    } catch (err) { showToast(`重命名失败：${formatError(err)}`, "error"); }
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
            autonomous={autonomous}
            onToggleAutonomous={handleToggleAutonomous}
            onRenamePet={handleRenamePet}
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
              if (!file || aiCancelRef.current || isLoading) return;
              setIsLoading(true);
              try {
                if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 16 * 1024 * 1024) {
                  throw new Error("请选择不超过 16 MiB 的 PNG、JPEG 或 WebP 图片");
                }
                const dataUrl = await readFileAsDataUrl(file);
                setReferencePhoto(dataUrl);
              } catch (err) { showToast(formatError(err), "error"); }
              finally { setIsLoading(false); }
            }}
            appearanceNotes={appearanceNotes}
            onChangeAppearanceNotes={setAppearanceNotes}
            aiRunning={aiRunning}
            aiCommitting={aiCommitting}
            canResumeAI={canResumeAI}
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
            onRenamePet={handleRenamePet}
            onGoToWorkshop={() => setCurrentTab("workshop")}
          />
        )}
      </main>
    </div>
  );
}

function toPersistedPet(pet: PetProfile) { return persistPet(pet, isTauri); }
function ensurePetHydrated(pet: PetProfile, action?: PetAction) { return hydratePet(pet, isTauri, action); }

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
