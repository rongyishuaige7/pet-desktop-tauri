import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { hasRenderableFrames, normalizeZoom, withCurrentAction } from "./pet-logic";
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
  isCollectionInitialized,
  loadOnboardingRecord,
  saveOnboardingRecord,
  commitAdoptedPet
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
import { CompanionPage } from "./components/stage/CompanionPage";
import { Workshop } from "./components/workshop/Workshop";
import { PetShelf } from "./components/shelf/PetShelf";
import { PresetGallery } from "./components/workshop/PresetGallery";
import { PreferencesDrawer } from "./components/settings/PreferencesDrawer";
import { RecoveryNotice } from "./components/recovery/RecoveryNotice";
import { Onboarding } from "./components/onboarding/Onboarding";
import {
  DEFAULT_PET_NAME,
  MAX_PET_NAME_LENGTH,
  completeOnboarding,
  createOnboardingRecord,
  decideOnboardingStart,
  markAdoptionCommitted,
  prepareAdoption,
  type OnboardingRecord
} from "./onboarding";
import { findPreset } from "./presets";
import { formatSnoozeTime, statusText } from "./native-pet-state";
import { useNativePet } from "./use-native-pet";
import type { InteractionKind, PreferenceRequest } from "./native-pet-types";
import "./styles.css";

const isTauri = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;

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
  const [onboarding, setOnboarding] = useState<OnboardingRecord | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingSpeech, setOnboardingSpeech] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [companionSpeech, setCompanionSpeech] = useState("");
  const [localError, setLocalError] = useState<{
    id: string;
    title: string;
    body: string;
    operation?: string;
    code?: string;
  } | null>(null);
  const [dismissedRecovery, setDismissedRecovery] = useState<string | null>(null);
  const lastPreferenceRef = useRef<PreferenceRequest | null>(null);
  const speechTimerRef = useRef<number | null>(null);
  const scaleTimerRef = useRef<number | null>(null);
  const onboardingBusyRef = useRef(false);
  const adoptionCommittedRef = useRef(false);
  const activePetRef = useRef<PetProfile | null>(null);
  const native = useNativePet({ isTauri, pet: activePet });
  const lastNativeActionRevision = useRef(0);

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
  async function activatePet(pet: PetProfile, create = false, explicitShow = true) {
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
          await native.attach(full.frameRoot, full.id, full.name);
          full.currentAction = await syncNativeAction(full.currentAction);
          if (explicitShow) await native.update({ kind: "show" });
        }
        if (create) await savePet(toPersistedPet(full));
        else if (!await setActivePetId(full.id)) throw new Error("该宠物已被移除");
        setActivePet(full);
        await refreshList();
        return full;
      } catch (error) {
        if (nativeChanged && previous?.frameRoot) {
          try {
            await native.attach(previous.frameRoot, previous.id, previous.name);
            await syncNativeAction(previous.currentAction);
            await native.update({ kind: "show" });
          } catch (rollbackError) {
            showToast(`恢复原桌宠失败：${formatError(rollbackError)}`, "error");
          }
        }
        throw error;
      } finally { transitioning.current = false; }
    });
  }

  // Native action changes are authoritative; only the active profile is written.
  useEffect(() => {
    if (!isTauri || !initialized || transitioning.current) return;
    const current = activePetRef.current;
    const state = native.state;
    if (!current || state.petId !== current.id) return;
    if (state.actionRevision <= lastNativeActionRevision.current) return;
    lastNativeActionRevision.current = state.actionRevision;
    if (state.action === current.currentAction) return;
    void serial(async () => {
      const latest = activePetRef.current;
      if (!latest || latest.id !== current.id) return;
      const saved = await updatePetAction(latest.id, state.action);
      if (!saved) return;
      const next = { ...latest, currentAction: saved.currentAction, actionStartedAt: saved.actionStartedAt };
      setActivePet(next);
      setPets((prev) => prev.map((p) => p.id === next.id ? { ...p, currentAction: next.currentAction } : p));
    }).catch((err) => showToast(`保存动作失败：${formatError(err)}`, "error"));
  }, [isTauri, initialized, native.state.actionRevision, native.state.petId, native.state.action, showToast]);

  // One ordered restore owns the initial profile and native settings.
  useEffect(() => {
    let cancelled = false;
    const init = serial(async () => {
      transitioning.current = true;
      try {
        const [all, stored, settings, onboardingLoad, collectionInitialized] = await Promise.all([
          loadAllPets(), loadPet(),
          isTauri ? invoke<NativePetSettings>("get_native_pet_settings") : Promise.resolve(null),
          loadOnboardingRecord().catch(() => ({ record: null, corrupt: true })),
          isCollectionInitialized().catch(() => null)
        ]);
        if (cancelled) return;
        setPets(all);
        let current = stored ?? all[0] ?? null;

        if (onboardingLoad.corrupt || collectionInitialized === null) {
          // A failed read must never be mistaken for a clean install.
          setOnboardingError("资料读取失败，请重试。伙伴资料没有改动。");
          showToast("资料读取失败，请重试", "error");
        } else {
          const start = decideOnboardingStart({
            record: onboardingLoad.record,
            initialized: collectionInitialized,
            pets: all,
            activePetId: current?.id ?? null
          });
          setOnboarding(start.record);
          adoptionCommittedRef.current = start.record.phase === "committed";
          setOnboardingOpen(start.kind === "show" || start.kind === "clean");
          if (start.record.confirmedPetId) {
            const confirmed = all.find((pet) => pet.id === start.record.confirmedPetId);
            if (confirmed) current = confirmed;
          }
          if (start.kind === "clean" || start.record !== onboardingLoad.record) {
            try {
              await saveOnboardingRecord(start.record);
            } catch (err) {
              setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
            }
          }
        }

        if (settings) {
          setPresetFrameDir(current?.frameRoot || DEFAULT_PRESET_FRAME_DIR);
          setZoom(normalizeZoom(settings.scale * 100));
        }
        if (current) {
          let full: PetProfile;
          try {
            full = await ensurePetHydrated(current, settings?.currentAction);
          } catch (err) {
            setActivePet(current);
            setLocalError({
              id: `asset-${current.id}`,
              title: `暂时找不到${current.name}的动作素材，资料仍在`,
              body: "名字和选择都保留着。可以重试加载，或换一位已有伙伴。",
              operation: "set_frame_root",
              code: "ASSET_NOT_FOUND"
            });
            showToast(`加载宠物失败：${formatError(err)}`, "error");
            return;
          }
          if (cancelled) return;
          setActivePet(full);
          // Loading material is not a display intent; hidden/snoozed stays hidden.
          if (isTauri && full.frameRoot) {
            try {
              await native.attach(full.frameRoot, full.id, full.name);
              full.currentAction = await syncNativeAction(full.currentAction);
            } catch (err) {
              setLocalError({
                id: `native-${full.id}`,
                title: "暂时没能把伙伴带到桌面，原来的伙伴已保留",
                body: "名字、素材和选择都还在。可以重试连接，或先查看已有伙伴。",
                operation: "set_frame_root",
                code: "NATIVE_WINDOW_FAILED"
              });
              showToast(`原生桌宠失败：${formatError(err)}`, "error");
            }
          }
          await refreshList();
        } else if (isTauri) {
          await native.detach();
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
    const unlistenError = isTauri ? listen<string>("native-pet-error", (event) => {
      if (!cancelled) showToast(`原生桌宠：${event.payload}`, "error");
    }) : null;
    return () => {
      cancelled = true;
      unsubscribe();
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

  async function applyPreference(request: PreferenceRequest) {
    lastPreferenceRef.current = request;
    try {
      const next = await native.update(request);
      setDismissedRecovery(null);
      return next;
    } catch (err) {
      showToast(`设置没有保存：${formatError(err)}`, "error");
      throw err;
    }
  }

  const handlePreference = useCallback(
    (request: PreferenceRequest) => {
      void applyPreference(request).catch(() => {
        // The recovery panel lives in the page; do not leave it behind the drawer.
        setSettingsOpen(false);
      });
    },
    // `applyPreference` closes over the latest native controller and toast.
    [native.update, showToast]
  );

  function handleZoomChange(val: number) {
    const nextZoom = normalizeZoom(val);
    setZoom(nextZoom);
    localStorage.setItem(PET_ZOOM_STORAGE, String(nextZoom));
    if (!isTauri) return;
    if (scaleTimerRef.current !== null) window.clearTimeout(scaleTimerRef.current);
    scaleTimerRef.current = window.setTimeout(() => {
      void applyPreference({ kind: "setScale", value: nextZoom / 100 }).catch(() => undefined);
    }, 250);
  }

  function handleToggleAutonomous(value: boolean) {
    if (isTauri) {
      void applyPreference({ kind: "setAutonomous", value }).catch(() => undefined);
      return;
    }
    setAutonomous(value);
    localStorage.setItem(AUTONOMOUS_STORAGE, value ? "on" : "off");
  }

  async function handleToggleVisibility() {
    const hiding = native.state.visibilityMode === "shown";
    try {
      await applyPreference({ kind: hiding ? "hide" : "show" });
      showToast(hiding ? "伙伴已收起，随时可以叫回来。" : "伙伴回来了。", "success");
    } catch {
      // applyPreference already reported the failure; recovery keeps the retry.
    }
  }

  async function handleSnooze() {
    if (native.state.visibilityMode === "snoozed") {
      try {
        await applyPreference({ kind: "show" });
        showToast("已提前唤回伙伴。", "success");
      } catch {
        // Reported by applyPreference.
      }
      return;
    }
    try {
      const next = await applyPreference({ kind: "snooze" });
      const until = next?.snoozeUntilMs ?? Date.now() + 60 * 60 * 1000;
      showToast(`伙伴休息到 ${formatSnoozeTime(until)}，到时自动回来。`, "success");
    } catch {
      // Reported by applyPreference.
    }
  }

  async function handleToggleNativePaused() {
    try {
      await applyPreference({
        kind: "setAnimationPaused",
        value: !native.state.animationPaused
      });
    } catch {
      // Reported by applyPreference.
    }
  }

  async function handleResetPosition() {
    if (!isTauri) return;
    try {
      await applyPreference({ kind: "resetPosition" });
      showToast("桌面伙伴已唤回右下角 🎯", "success");
    } catch {
      // Reported by applyPreference.
    }
  }

  async function handleInteract(kind: InteractionKind) {
    const result = await native.interact(kind);
    if (!result) return;
    if (result.accepted) {
      setCompanionSpeech(kind === "pet" ? "收到你的摸摸了。" : "我在这里！");
      if (speechTimerRef.current !== null) window.clearTimeout(speechTimerRef.current);
      speechTimerRef.current = window.setTimeout(() => setCompanionSpeech(""), 4000);
      return;
    }
    if (result.reason === "cooldown") return;
    if (result.reason === "hidden") setCompanionSpeech("先唤回伙伴，互动不会替你唤醒它。");
    else if (result.reason === "paused") setCompanionSpeech("先恢复动画，再和伙伴互动。");
    else if (result.reason === "notReady") setCompanionSpeech("伙伴还在准备中，稍等一下。");
    else if (result.reason === "stalePet") setCompanionSpeech("伙伴已经切换，请再试一次。");
  }

  async function handleRetryAsset() {
    const current = activePetRef.current;
    if (!current?.frameRoot) {
      setCurrentTab("shelf");
      return;
    }
    try {
      const full = await ensurePetHydrated(current);
      if (isTauri) {
        await native.attach(full.frameRoot!, full.id, full.name);
        await native.update({ kind: "show" });
      }
      setActivePet(full);
      setLocalError(null);
      showToast("伙伴的动作素材已恢复。", "success");
    } catch (err) {
      setLocalError({
        id: `asset-${current.id}-${Date.now()}`,
        title: `暂时找不到${current.name}的动作素材，资料仍在`,
        body: "名字和选择都保留着。可以重试加载，或换一位已有伙伴。",
        operation: "set_frame_root",
        code: "ASSET_NOT_FOUND"
      });
      showToast(`重试加载失败：${formatError(err)}`, "error");
    }
  }

  function handleOpenSettings() {
    setSettingsOpen(true);
  }

  function handleTutorial() {
    setSettingsOpen(false);
    setOnboardingSpeech("");
    setTutorialOpen(true);
  }

  function handleRetryPreference() {
    const request = lastPreferenceRef.current;
    if (!request) {
      setSettingsOpen(true);
      return;
    }
    void applyPreference(request).catch(() => undefined);
  }

  useEffect(() => {
    if (!isTauri || !native.connected) return;
    const nextZoom = Math.round(native.state.scale * 100);
    setZoom((previous) => (previous === nextZoom ? previous : nextZoom));
  }, [isTauri, native.connected, native.state.scale]);

  useEffect(() => () => {
    if (speechTimerRef.current !== null) window.clearTimeout(speechTimerRef.current);
    if (scaleTimerRef.current !== null) window.clearTimeout(scaleTimerRef.current);
  }, []);

  async function rollbackAdoption(wasShown: boolean) {
    if (!isTauri) return;
    const previous = activePetRef.current;
    try {
      if (previous?.frameRoot) {
        await native.attach(previous.frameRoot, previous.id, previous.name);
        if (wasShown) await native.update({ kind: "show" });
      } else {
        await native.detach();
      }
    } catch (err) {
      showToast(`恢复原桌宠失败：${formatError(err)}`, "error");
    }
  }

  async function handleOnboardingNext() {
    if (!onboarding || onboardingBusyRef.current) return;
    const next: OnboardingRecord = {
      ...onboarding,
      step: "name",
      draftName: onboarding.draftName.trim() || DEFAULT_PET_NAME,
      updatedAt: new Date().toISOString()
    };
    setOnboarding(next);
    setOnboardingError(null);
    try {
      await saveOnboardingRecord(next);
    } catch (err) {
      setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
    }
  }

  function handleOnboardingName(name: string) {
    if (!onboarding) return;
    setOnboarding({ ...onboarding, draftName: name.slice(0, MAX_PET_NAME_LENGTH) });
    setOnboardingError(null);
  }

  function handleOnboardingNameBlur() {
    if (
      !onboarding ||
      onboarding.step !== "name" ||
      onboardingBusyRef.current ||
      adoptionCommittedRef.current ||
      onboarding.phase === "prepared" ||
      onboarding.phase === "committed"
    ) {
      return;
    }
    void saveOnboardingRecord(onboarding).catch(() => undefined);
  }

  async function handleOnboardingBrowse() {
    if (onboardingBusyRef.current) return;
    const base = onboarding ?? createOnboardingRecord();
    const next: OnboardingRecord = {
      ...base,
      state: "dismissed",
      step: "choose",
      updatedAt: new Date().toISOString()
    };
    setOnboarding(next);
    setOnboardingOpen(false);
    setOnboardingError(null);
    setCurrentTab("workshop");
    try {
      await saveOnboardingRecord(next);
    } catch (err) {
      setOnboardingError(`还没保存成功，可以稍后继续：${formatError(err)}`);
    }
  }

  function handleStartAdoption() {
    const base = onboarding ?? createOnboardingRecord();
    const next: OnboardingRecord = {
      ...base,
      state: "in_progress",
      step: "name",
      draftName: base.draftName.trim() || DEFAULT_PET_NAME,
      adoptionId: null,
      pendingPetId: null,
      previousActivePetId: null,
      phase: "draft",
      updatedAt: new Date().toISOString()
    };
    setOnboarding(next);
    setOnboardingOpen(true);
    setOnboardingError(null);
    setOnboardingSpeech("");
    adoptionCommittedRef.current = false;
    void saveOnboardingRecord(next).catch((err) => {
      setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
    });
  }

  async function handleAdopt(nameOverride?: string, recordOverride?: OnboardingRecord) {
    if (onboardingBusyRef.current || adoptionCommittedRef.current) return;
    const base = recordOverride ?? onboarding;
    if (!base) return;
    const name = (nameOverride ?? base.draftName).trim();
    if (!name) {
      setOnboardingError("给伙伴起个名字，或直接使用咕唧");
      return;
    }

    onboardingBusyRef.current = true;
    setOnboardingBusy(true);
    setOnboardingError(null);

    let plan;
    try {
      plan = prepareAdoption(base, name, activePetRef.current?.id ?? null);
    } catch (err) {
      setOnboardingError(formatError(err));
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }

    const preset = findPreset(plan.record.presetId);
    const actions = buildDefaultActionFrames();
    let fullPet: PetProfile;
    try {
      fullPet = createManualPet({
        id: plan.pendingPetId,
        name: plan.name,
        species: preset.species,
        sourceImage: actions.idle[0],
        manualFrames: actions,
        frameRoot: preset.frameRoot,
        storageMode: "preset-root"
      });
    } catch (err) {
      setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }

    try {
      await saveOnboardingRecord(plan.record);
      setOnboarding(plan.record);
    } catch (err) {
      setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }

    const wasShown = native.state.visibilityMode === "shown";
    if (isTauri) {
      try {
        await native.attach(preset.frameRoot, plan.pendingPetId, plan.name);
      } catch (err) {
        setOnboardingError(
          `暂时没能把伙伴带到桌面，原来的伙伴已保留。${formatError(err)}`
        );
        onboardingBusyRef.current = false;
        setOnboardingBusy(false);
        return;
      }
    }

    const committed = markAdoptionCommitted(plan.record, plan.pendingPetId);
    try {
      await commitAdoptedPet(toPersistedPet(fullPet), committed);
    } catch (err) {
      await rollbackAdoption(wasShown);
      setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }

    if (isTauri) {
      try {
        await native.update({ kind: "show" });
      } catch (err) {
        setOnboardingError(`伙伴资料已保存，但暂时没能显示到桌面：${formatError(err)}`);
      }
    }

    setActivePet(fullPet);
    setPets((prev) =>
      prev.some((pet) => pet.id === fullPet.id)
        ? prev.map((pet) => (pet.id === fullPet.id ? fullPet : pet))
        : [...prev, fullPet]
    );
    try {
      await refreshList();
    } catch {
      try {
        const saved = await loadPet();
        if (saved) setActivePet(await ensurePetHydrated(saved));
      } catch {
        // Keep the in-memory profile; a later refresh can recover.
      }
    }
    setOnboarding(committed);
    setOnboardingSpeech("");
    adoptionCommittedRef.current = true;
    onboardingBusyRef.current = false;
    setOnboardingBusy(false);
    showToast(`「${plan.name}」已经入住桌面。`, "success");
  }

  async function handleOnboardingFinish() {
    if (!onboarding) return;
    const completed = completeOnboarding(
      onboarding,
      activePetRef.current?.id ?? onboarding.confirmedPetId
    );
    try {
      await saveOnboardingRecord(completed);
      setOnboarding(completed);
      setOnboardingOpen(false);
      setOnboardingError(null);
      setOnboardingSpeech("");
      showToast("已经记住你们第一次见面。", "success");
    } catch (err) {
      setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
    }
  }

  async function handleOnboardingRetry() {
    if (!onboarding) {
      window.location.reload();
      return;
    }
    if (onboarding.step === "meet") await handleOnboardingFinish();
    else if (onboarding.step === "name") await handleAdopt();
    else await handleOnboardingNext();
  }

  function handleUseDefault() {
    if (!onboarding) return;
    const next = { ...onboarding, draftName: DEFAULT_PET_NAME };
    setOnboarding(next);
    void handleAdopt(DEFAULT_PET_NAME, next);
  }

  async function handleMeetPet() {
    const result = await native.interact("pet");
    if (result?.accepted) setOnboardingSpeech("收到你的摸摸了。");
    else if (result?.reason === "cooldown") setOnboardingSpeech("刚刚已经收到你的摸摸了。");
    else setOnboardingSpeech("伙伴暂时没有回应，可以先完成见面。");
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
            await native.attach(full.frameRoot, full.id, full.name);
            full.currentAction = await syncNativeAction(full.currentAction);
            await native.update({ kind: "show" });
          }
          if (isTauri && remaining.length === 0) await native.detach();
          const next = await deletePet(id);
          setActivePet(next && full?.id === next.id ? { ...full, name: next.name } : next ? await ensurePetHydrated(next) : null);
          await refreshList();
        } catch (error) {
          const previous = activePetRef.current;
          if (isTauri && previous?.frameRoot) {
            await native.attach(previous.frameRoot, previous.id, previous.name);
            await syncNativeAction(previous.currentAction);
            await native.update({ kind: "show" });
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
        if (current?.id === id) {
          setActivePet({ ...current, name: updated.name });
          if (isTauri) await native.setName(updated.name);
        }
        showToast(`已重命名为「${updated.name}」`, "success");
      });
    } catch (err) { showToast(`重命名失败：${formatError(err)}`, "error"); }
  }

  const companionStatus = isTauri ? statusText(native.state) : "网页演示";
  const operationError = native.state.lastOperationError;

  const assetRecovery = {
    title: `暂时找不到${activePet?.name ?? "伙伴"}的动作素材，资料仍在`,
    body: "名字和选择都保留着。可以重试加载，或换一位已有伙伴。",
    operation: "set_frame_root",
    code: "ASSET_NOT_FOUND",
    actions: [
      { label: "重试加载", primary: true, onClick: () => void handleRetryAsset() },
      { label: "选择已有伙伴", onClick: () => setCurrentTab("shelf") },
      { label: "打开制作", onClick: () => setCurrentTab("workshop") }
    ]
  };

  const recovery = (() => {
    if (localError) {
      return {
        id: localError.id,
        title: localError.title,
        body: localError.body,
        operation: localError.operation,
        code: localError.code,
        actions: assetRecovery.actions
      };
    }
    if (native.error) {
      return {
        id: "native-client",
        title: "暂时没能连接桌面伙伴",
        body: "原来的伙伴和资料都已保留。可以重试连接，或先查看已有伙伴。",
        operation: "connect",
        code: "NATIVE_CLIENT_UNAVAILABLE",
        actions: [
          { label: "重试连接", primary: true, onClick: () => void native.refresh() },
          { label: "查看已有伙伴", onClick: () => setCurrentTab("shelf") }
        ]
      };
    }
    if (onboardingError && !onboardingOpen) {
      return {
        id: "onboarding-read",
        title: "资料读取失败，请重试",
        body: "伙伴资料没有改动。读取成功后再继续领养或使用已有伙伴。",
        operation: "loadOnboarding",
        code: "ONBOARDING_READ_FAILED",
        actions: [
          { label: "重试读取", primary: true, onClick: () => window.location.reload() }
        ]
      };
    }
    if (!operationError) return null;
    const base = {
      id: operationError.id,
      operation: operationError.operation,
      code: operationError.code
    };
    if (operationError.code === "ASSET_NOT_FOUND") {
      return { ...base, ...assetRecovery };
    }
    if (operationError.code === "NATIVE_WINDOW_FAILED") {
      return {
        ...base,
        title: "暂时没能把伙伴带到桌面，原来的伙伴已保留",
        body: "名字、素材和选择都还在。可以重试连接，或先查看已有伙伴。",
        actions: [
          { label: "重试连接", primary: true, onClick: () => void handleRetryAsset() },
          { label: "查看已有伙伴", onClick: () => setCurrentTab("shelf") },
          { label: "打开制作", onClick: () => setCurrentTab("workshop") }
        ]
      };
    }
    if (operationError.code === "AUTOSTART_FAILED") {
      return {
        ...base,
        title: "未能开启开机启动，其他功能可以继续使用",
        body: "系统自启配置没有改变。可以重试，或稍后在偏好设置里再开启。",
        actions: [
          { label: "重试", primary: true, onClick: handleRetryPreference },
          { label: "偏好设置", onClick: handleOpenSettings }
        ]
      };
    }
    if (
      operationError.code === "SETTINGS_WRITE_FAILED" ||
      operationError.code === "RESET_POSITION_FAILED"
    ) {
      return {
        ...base,
        title: "这次设置没有保存，请再试一次",
        body: "已确认的值仍然保留。重试不会影响伙伴资料。",
        actions: [
          { label: "重试保存", primary: true, onClick: handleRetryPreference },
          { label: "偏好设置", onClick: handleOpenSettings }
        ]
      };
    }
    if (
      operationError.code === "SETTINGS_INVALID" ||
      operationError.code === "SETTINGS_SNOOZE_INVALID"
    ) {
      return {
        ...base,
        title: "设置文件需要修复，伙伴暂时保持收起",
        body: "没有自动补回伙伴。可以打开偏好设置重新确认显示和休息选项。",
        actions: [
          { label: "打开偏好设置", primary: true, onClick: handleOpenSettings },
          { label: "重试读取", onClick: () => void native.refresh() }
        ]
      };
    }
    if (operationError.code === "UNSUPPORTED_CAPABILITY") {
      return {
        ...base,
        title: "当前系统暂不支持这个设置",
        body: "其他功能可以继续使用。支持情况已列在偏好设置中。",
        actions: [{ label: "打开偏好设置", primary: true, onClick: handleOpenSettings }]
      };
    }
    return {
      ...base,
      title: "这个操作没有完成，资料仍在",
      body: "可以重试，或打开偏好设置检查当前状态。",
      actions: [
        { label: "重试", primary: true, onClick: handleRetryPreference },
        { label: "偏好设置", onClick: handleOpenSettings }
      ]
    };
  })();

  const recoveryNode = recovery ? (
    dismissedRecovery === recovery.id ? (
      <button
        type="button"
        className="recovery-reopen"
        onClick={() => setDismissedRecovery(null)}
      >
        需要帮助：{recovery.title}
      </button>
    ) : (
      <RecoveryNotice
        title={recovery.title}
        body={recovery.body}
        operation={recovery.operation}
        code={recovery.code}
        actions={recovery.actions}
        onDismiss={() => setDismissedRecovery(recovery.id)}
      />
    )
  ) : null;

  const tutorialRecord: OnboardingRecord | null = tutorialOpen
    ? {
        ...(onboarding ?? createOnboardingRecord()),
        state: "in_progress",
        step: "meet",
        confirmedPetId: activePet?.id ?? null
      }
    : null;

  return (
    <div className="app-shell">
      <AppSidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        activePet={activePet}
        petCount={pets.length}
        status={companionStatus}
        webMode={!isTauri}
        onOpenSettings={handleOpenSettings}
      />

      <main className="app-content">
        {currentTab !== "stage" && (
          <>
            <header className="content-header">
              <div className="header-title-group">
                <h1 className="header-title">
                  {currentTab === "workshop" && "领养与制作"}
                  {currentTab === "shelf" && "我的伙伴"}
                </h1>
                <span className="header-subtitle">
                  {currentTab === "workshop" && "选一位现成伙伴，或者慢慢制作自己的那一只"}
                  {currentTab === "shelf" && "收起桌宠不会移除资料，这里始终保留你的收藏"}
                </span>
              </div>
            </header>
            {recoveryNode}
          </>
        )}

        {currentTab === "stage" && (
          <CompanionPage
            pet={activePet}
            state={native.state}
            webMode={!isTauri}
            busy={isTauri && !native.connected}
            zoom={zoom}
            speech={companionSpeech}
            recovery={recoveryNode}
            onInteract={(kind) => void handleInteract(kind)}
            onSwitchAction={handleSwitchAction}
            onChangeZoom={handleZoomChange}
            onToggleVisibility={() => void handleToggleVisibility()}
            onSnooze={() => void handleSnooze()}
            onTogglePaused={() => void handleToggleNativePaused()}
            onToggleAutonomous={() => handleToggleAutonomous(!native.state.autonomous)}
            onOpenSettings={handleOpenSettings}
            onStartAdoption={handleStartAdoption}
            onGoToWorkshop={() => setCurrentTab("workshop")}
            onRenamePet={handleRenamePet}
          />
        )}

        {currentTab === "workshop" && (
          <>
            <PresetGallery
              activePet={activePet}
              onAdopt={handleStartAdoption}
              onViewCompanion={() => setCurrentTab("stage")}
            />
            <details className="advanced-maker" open>
              <summary>高级制作：本地导入、动作装配与照片定制</summary>
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
            </details>
          </>
        )}

        {onboardingOpen && onboarding && (
          <Onboarding
            record={onboarding}
            pet={activePet}
            isTauri={isTauri}
            busy={onboardingBusy}
            error={onboardingError}
            speech={onboardingSpeech}
            onChangeName={handleOnboardingName}
            onNameBlur={handleOnboardingNameBlur}
            onNext={handleOnboardingNext}
            onBrowse={handleOnboardingBrowse}
            onAdopt={() => void handleAdopt()}
            onUseDefault={handleUseDefault}
            onFinish={() => void handleOnboardingFinish()}
            onMeetPet={() => void handleMeetPet()}
            onRetry={() => void handleOnboardingRetry()}
          />
        )}

        {currentTab === "shelf" && (
          <PetShelf
            pets={pets}
            activePetId={activePet?.id ?? null}
            nativeState={native.state}
            onDeployPet={handleDeployPet}
            onDeletePet={handleDeletePet}
            onRenamePet={handleRenamePet}
            onStartAdoption={handleStartAdoption}
            onGoToWorkshop={() => setCurrentTab("workshop")}
          />
        )}

        {tutorialOpen && tutorialRecord && (
          <Onboarding
            record={tutorialRecord}
            pet={activePet}
            isTauri={isTauri}
            busy={false}
            error={null}
            speech={onboardingSpeech}
            onChangeName={() => undefined}
            onNameBlur={() => undefined}
            onNext={() => undefined}
            onBrowse={() => setTutorialOpen(false)}
            onAdopt={() => undefined}
            onUseDefault={() => undefined}
            onFinish={() => setTutorialOpen(false)}
            onMeetPet={() => void handleMeetPet()}
            onRetry={() => undefined}
          />
        )}

        <PreferencesDrawer
          open={settingsOpen}
          state={native.state}
          webMode={!isTauri}
          busy={isTauri && !native.connected}
          onClose={() => setSettingsOpen(false)}
          onUpdate={handlePreference}
          onResetPosition={() => void handleResetPosition()}
          onTutorial={handleTutorial}
        />
      </main>
    </div>
  );
}

function toPersistedPet(pet: PetProfile) { return persistPet(pet, isTauri); }
function ensurePetHydrated(pet: PetProfile, action?: PetAction) { return hydratePet(pet, isTauri, action); }

function createManualPet({
  id,
  name,
  species,
  sourceImage,
  manualFrames,
  frameRoot,
  storageMode = "embedded"
}: {
  id?: string;
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
    id: id ?? crypto.randomUUID(),
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
