import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AUTONOMOUS_STORAGE,
  DEFAULT_PRESET_FRAME_DIR,
  PET_ZOOM_STORAGE,
  PRESET_FRAME_DIR_STORAGE,
  UPLOAD_URL_STORAGE
} from "./config";
import {
  createGenerationCheckpoint,
  generateCharacter,
  generateIdleSample,
  generateRemainingActions,
  GenerationCancelled
} from "./ai-generation";
import {
  GENERATION_STAGE_LABELS,
  claimGenerationTask,
  createGenerationTask,
  generationSessionId,
  listGenerationTasks,
  releaseGenerationTask,
  updateGenerationTask,
  type GenerationTask,
  type GenerationTaskSummary
} from "./generation-tasks";
import { hasRenderableFrames, normalizeZoom, withCurrentAction } from "./pet-logic";
import { actionDurationMs, chooseNextAction } from "./pet-behavior";
import { buildDefaultActionFrames, hydratePet, toPersistedPet as persistPet } from "./pet-resources";
import {
  loadPet,
  loadAllPets,
  savePet,
  savePetProfile,
  setActivePetId,
  deletePet,
  renamePet,
  replacePetAssets,
  updatePetAssetReference,
  restoreRemovedPet,
  softRemovePet,
  updatePetAction,
  subscribePetChanges,
  subscribeOnboardingChanges,
  isCollectionInitialized,
  loadOnboardingRecord,
  loadRemovedPets,
  loadSelectionRevision,
  loadCreationDraft,
  saveCreationDraft,
  deleteCreationDraft,
  commitAssemblyDraftPet,
  saveOnboardingRecord,
  saveOnboardingProgress,
  startNewAdoptionIntent,
  claimAdoptionRecord,
  commitAdoptedPet,
  confirmAdoptionDisplay,
  OnboardingProgressError,
  type RemovedPetRecord
} from "./storage";
import {
  PET_ACTIONS,
  type ActionFrameSet,
  type CreationDraft,
  type PetAction,
  type PetProfile,
  type ExportedPetPackage,
  type FrameInspection,
  type ImportedPetPackage,
  type ManagedAsset,
  type PackageSummary,
  type PetSpecies,
  type StudioTab,
  type WorkshopTask
} from "./types";
import { ToastProvider, useToast } from "./components/ui/Toast";
import { AppSidebar } from "./components/shell/AppSidebar";
import { CompanionPage } from "./components/stage/CompanionPage";
import { Workshop } from "./components/workshop/Workshop";
import {
  WORKSHOP_TASK_LABELS,
  WorkshopTaskChooser,
  WorkshopTaskHeader
} from "./components/workshop/WorkshopTasks";
import { PetShelf } from "./components/shelf/PetShelf";
import { PresetGallery } from "./components/workshop/PresetGallery";
import { PreferencesDrawer } from "./components/settings/PreferencesDrawer";
import { RecoveryNotice } from "./components/recovery/RecoveryNotice";
import { RemovalUndo } from "./components/shelf/RemovalUndo";
import { Onboarding } from "./components/onboarding/Onboarding";
import {
  DEFAULT_PET_NAME,
  MAX_PET_NAME_LENGTH,
  completeOnboarding,
  createOnboardingRecord,
  decideOnboardingStart,
  keepNewerDraftName,
  markAdoptionCommitted,
  type OnboardingRecord
} from "./onboarding";
import { findPreset } from "./presets";
import { formatSnoozeTime, statusText } from "./native-pet-state";
import { useNativePet } from "./use-native-pet";
import {
  displayRetryStillValid,
  nativeStateVersion,
  parseNativeError,
  type ActivationResult,
  type DisplayRetryContext
} from "./pet-activation";
import type { InteractionKind, PreferenceRequest, SnoozeMinutes } from "./native-pet-types";
import "./styles.css";

const isTauri = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;

interface NativeActionEvent { action: PetAction; petId: string | null; revision: number }

interface RemovalNotice {
  removalId: string;
  petId: string;
  petName: string;
  replacementName: string | null;
  wasActive: boolean;
  selectionRevision: number;
}

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

const ASSEMBLY_DRAFT_ID = "manual-assembly";

function StudioApp() {
  const { showToast } = useToast();
  const [currentTab, setCurrentTab] = useState<StudioTab>("stage");
  const [workshopTask, setWorkshopTask] = useState<WorkshopTask>("choose");
  const [repairPetId, setRepairPetId] = useState<string | null>(null);
  const [inspectAction, setInspectAction] = useState<PetAction>("idle");
  const [frameInspection, setFrameInspection] = useState<FrameInspection | null>(null);
  const [inspectingFrames, setInspectingFrames] = useState(false);
  const [keepExternalReference, setKeepExternalReference] = useState(false);
  const inspectionRequestRef = useRef(0);

  useEffect(() => {
    if (
      !isTauri ||
      !(window as { __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } } })
        .__TAURI_INTERNALS__?.metadata?.currentWebview?.label
    ) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        if (event.payload.type !== "drop") return;
        if (currentTab !== "workshop" || workshopTask !== "import") return;
        const path = event.payload.paths.find((entry) => entry.trim());
        if (!path) return;
        inspectionRequestRef.current += 1;
        setPresetFrameDir(path);
        setFrameInspection(null);
        setInspectingFrames(false);
        showToast("已收到目录，点击“预检目录”检查六个动作。", "info");
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Drag and drop is an optional shortcut; the path input still works.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentTab, isTauri, workshopTask]);
  const [pets, setPets] = useState<PetProfile[]>([]);
  const [removedPets, setRemovedPets] = useState<RemovedPetRecord[]>([]);
  const [removalNotice, setRemovalNotice] = useState<RemovalNotice | null>(null);
  const [activePet, setActivePetState] = useState<PetProfile | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [onboarding, setOnboarding] = useState<OnboardingRecord | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [startingAdoption, setStartingAdoption] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingSpeech, setOnboardingSpeech] = useState("");
  const [adoptionDisplayPending, setAdoptionDisplayPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [companionSpeech, setCompanionSpeech] = useState("");
  const [localError, setLocalError] = useState<{
    id: string;
    petId?: string;
    title: string;
    body: string;
    operation?: string;
    code?: string;
  } | null>(null);
  const [dismissedRecovery, setDismissedRecovery] = useState<string | null>(null);
  const [displayRetry, setDisplayRetry] = useState<DisplayRetryContext | null>(null);
  const lastPreferenceRef = useRef<PreferenceRequest | null>(null);
  const displayConfirmRef = useRef<string | null>(null);
  const speechTimerRef = useRef<number | null>(null);
  const scaleTimerRef = useRef<number | null>(null);
  const onboardingBusyRef = useRef(false);
  const adoptionCommittedRef = useRef(false);
  const nameEditSeqRef = useRef(0);
  const intentWriteRef = useRef<Promise<unknown>>(Promise.resolve());
  const activePetRef = useRef<PetProfile | null>(null);
  const onboardingRef = useRef<OnboardingRecord | null>(null);
  const practicePendingRef = useRef(false);
  onboardingRef.current = onboarding;
  const native = useNativePet({
    isTauri,
    pet: activePet,
    initialAutonomous: localStorage.getItem(AUTONOMOUS_STORAGE) !== "off"
  });

  // A follow window that is waiting for display must leave the waiting state
  // when the matching native pet becomes visible and the persisted record is
  // confirmed (possibly by the other window).
  useEffect(() => {
    if (!adoptionDisplayPending || !onboarding?.confirmedPetId) return;
    const confirmedId = onboarding.confirmedPetId;
    if (!native.state.visible || native.state.petId !== confirmedId) return;
    const key = `${onboarding.intentId ?? "legacy"}:${confirmedId}:${native.state.revision}`;
    if (displayConfirmRef.current === key) return;
    displayConfirmRef.current = key;
    let cancelled = false;
    void (async () => {
      const latest = await loadOnboardingRecord().catch(() => null);
      if (cancelled) return;
      const current = latest?.record;
      if (current && current.intentId !== onboarding.intentId) {
        setOnboarding(current);
        setAdoptionDisplayPending(
          current.state === "in_progress" &&
            current.phase === "committed" &&
            !current.displayConfirmed
        );
        setOnboardingOpen(current.state !== "completed");
        setOnboardingError("这次等待显示已失效，已读取最新领养结果。");
        return;
      }
      if (current?.displayConfirmed && current.confirmedPetId === confirmedId) {
        setOnboarding(current);
        setAdoptionDisplayPending(false);
        return;
      }
      try {
        const confirmed = await confirmAdoptionDisplay(onboarding);
        if (cancelled) return;
        setOnboarding(confirmed);
        setAdoptionDisplayPending(false);
      } catch (err) {
        if (!cancelled) {
          setOnboardingError(
            `这次等待显示已失效，已读取最新领养结果：${formatError(err)}`
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    adoptionDisplayPending,
    native.state.visible,
    native.state.petId,
    native.state.revision,
    onboarding?.intentId,
    onboarding?.confirmedPetId
  ]);
  const lastNativeActionRevision = useRef(0);

  // Another window or the tray may have switched the native companion. A
  // retry prepared for the old one is no longer meaningful.
  useEffect(() => {
    if (!displayRetry) return;
    if (native.state.petId && native.state.petId !== displayRetry.petId) {
      setDisplayRetry(null);
    }
  }, [displayRetry, native.state.petId]);

  // Workshop Form State
  const [name, setName] = useState("奶茶");
  const [species, setSpecies] = useState<PetSpecies>("cat");
  const [presetFrameDir, setPresetFrameDir] = useState(
    () => localStorage.getItem(PRESET_FRAME_DIR_STORAGE) ?? DEFAULT_PRESET_FRAME_DIR
  );
  const [manualFrames, setManualFrames] = useState<Partial<ActionFrameSet>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [draftStatus, setDraftStatus] = useState<
    "idle" | "saving" | "saved" | "unsaved" | "conflict"
  >("idle");
  const draftRevisionRef = useRef<number | null>(null);
  const draftPendingPetIdRef = useRef<string>(crypto.randomUUID());
  const draftLoadedRef = useRef(false);
  const draftSaveTimerRef = useRef<number | null>(null);
  const persistDraftRef = useRef<() => Promise<boolean>>(async () => false);
  const suppressNextDraftSaveRef = useRef(false);
  const draftPausedRef = useRef(false);
  const wasFramesRef = useRef(false);
  const draftEditSeqRef = useRef(0);
  const draftSavingRef = useRef(false);
  const draftDirtyRef = useRef(false);
  const draftSaveInFlightRef = useRef<Promise<boolean> | null>(null);
  const draftFlushInFlightRef = useRef<Promise<void> | null>(null);
  const draftSubmitInProgressRef = useRef(false);
  const [draftLoading, setDraftLoading] = useState(true);
  const [draftReady, setDraftReady] = useState(false);
  const [draftSaveTick, setDraftSaveTick] = useState(0);

  // AI Form State
  const [apiKey, setApiKey] = useState("");
  const [uploadUrl, setUploadUrl] = useState(() => localStorage.getItem(UPLOAD_URL_STORAGE) ?? "");
  const [referencePhoto, setReferencePhoto] = useState<string | null>(null);
  const [appearanceNotes, setAppearanceNotes] = useState("");
  const [aiRunning, setAiRunning] = useState(false);
  const [aiCommitting, setAiCommitting] = useState(false);
  const [canResumeAI, setCanResumeAI] = useState(false);
  const [aiLog, setAiLog] = useState<string[]>([]);
  const [aiConsent, setAiConsent] = useState(false);
  const [generationTasks, setGenerationTasks] = useState<GenerationTaskSummary[]>([]);
  const [aiCharacterReview, setAiCharacterReview] = useState<{
    image: string;
    reference: string;
    revision: number;
    history: string[];
    inputSignature: string;
  } | null>(null);
  const [aiSampleReview, setAiSampleReview] = useState<{
    actions: ActionFrameSet;
    inputSignature: string;
  } | null>(null);
  const [aiUncertain, setAiUncertain] = useState(false);
  const [aiReceiptSyncPending, setAiReceiptSyncPending] = useState(false);
  const activeGenerationTaskRef = useRef<GenerationTask | null>(null);
  const aiCharacterUrlRef = useRef("");
  const aiCharacterImageRef = useRef("");
  const aiCandidateRef = useRef<{
    taskId: string;
    inputSignature: string;
    mode: "initial" | "regenerate";
    checkpoint: ReturnType<typeof createGenerationCheckpoint>;
    attemptIds: string[];
  } | null>(null);
  const aiCancelRef = useRef<{ cancelled: boolean; committing: boolean } | null>(null);
  const aiCheckpointRef = useRef(createGenerationCheckpoint());

  function persistAssemblyDraft(): Promise<boolean> {
    if (!draftLoadedRef.current) return Promise.resolve(false);
    if (draftSavingRef.current) {
      draftDirtyRef.current = true;
      return Promise.resolve(false);
    }
    draftSavingRef.current = true;
    const editSeq = draftEditSeqRef.current;
    const frames = Object.fromEntries(
      PET_ACTIONS.map(({ id }) => [id, manualFrames[id] ?? []])
    ) as ActionFrameSet;
    const draft: Omit<CreationDraft, "revision" | "updatedAt"> = {
      schemaVersion: 1,
      draftId: ASSEMBLY_DRAFT_ID,
      pendingPetId: draftPendingPetIdRef.current,
      name,
      species,
      manualFrames: frames
    };
    setDraftStatus("saving");
    const promise = (async () => {
      try {
        const result = await saveCreationDraft(
          draft,
          draftRevisionRef.current,
          draftPendingPetIdRef.current
        );
        if (result.status === "conflict") {
          if (editSeq === draftEditSeqRef.current) {
            setDraftStatus("conflict");
            showToast("其他窗口已更新草稿，当前输入未覆盖；可继续编辑或刷新恢复。", "info");
          }
          return false;
        }
        draftRevisionRef.current = result.draft.revision;
        if (editSeq === draftEditSeqRef.current) {
          setDraftStatus("saved");
        } else {
          setDraftStatus("unsaved");
        }
        return true;
      } catch {
        if (editSeq === draftEditSeqRef.current) {
          setDraftStatus("unsaved");
        }
        return false;
      } finally {
        draftSavingRef.current = false;
        draftSaveInFlightRef.current = null;
        if (draftDirtyRef.current) {
          draftDirtyRef.current = false;
          setDraftSaveTick((tick) => tick + 1);
        }
      }
    })();
    draftSaveInFlightRef.current = promise;
    return promise;
  }
  persistDraftRef.current = persistAssemblyDraft;

  async function flushDraftOnLeave() {
    if (
      !draftLoadedRef.current ||
      draftPausedRef.current ||
      draftSubmitInProgressRef.current
    ) {
      return;
    }
    const run = (async () => {
      if (draftSaveTimerRef.current) {
        window.clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      await waitForDraftIdle();
      if (draftPausedRef.current || draftSubmitInProgressRef.current) return;
      await persistDraftRef.current();
    })();
    draftFlushInFlightRef.current = run;
    try {
      await run;
    } finally {
      if (draftFlushInFlightRef.current === run) {
        draftFlushInFlightRef.current = null;
      }
    }
  }

  useEffect(() => {
    if (!initialized || draftLoadedRef.current) return;
    let cancelled = false;
    const restoreSeq = draftEditSeqRef.current;
    setDraftLoading(true);
    loadCreationDraft(ASSEMBLY_DRAFT_ID)
      .then((draft) => {
        if (cancelled || !draft) return;
        if (draftEditSeqRef.current === restoreSeq) {
          draftPausedRef.current = false;
          setName(draft.name);
          setSpecies(draft.species);
          setManualFrames(draft.manualFrames);
          setDraftStatus("saved");
        } else {
          setDraftStatus("unsaved");
        }
        draftRevisionRef.current = draft.revision;
        draftPendingPetIdRef.current = draft.pendingPetId;
      })
      .catch(() => {
        // A storage outage keeps the in-memory form; autosave will report it.
      })
      .finally(() => {
        if (!cancelled) {
          draftLoadedRef.current = true;
          setDraftLoading(false);
          setDraftReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialized]);

  useEffect(() => {
    if (currentTab !== "workshop" || workshopTask !== "frames") {
      suppressNextDraftSaveRef.current = false;
    }
  }, [currentTab, workshopTask]);

  useEffect(() => {
    if (
      !initialized ||
      !draftLoadedRef.current ||
      !draftReady ||
      draftSubmitInProgressRef.current ||
      currentTab !== "workshop" ||
      workshopTask !== "frames"
    ) {
      return;
    }
    if (draftPausedRef.current) return;
    if (suppressNextDraftSaveRef.current) {
      suppressNextDraftSaveRef.current = false;
      return;
    }
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
    }
    setDraftStatus("saving");
    draftSaveTimerRef.current = window.setTimeout(() => {
      void persistDraftRef.current();
    }, 800);
    return () => {
      if (draftSaveTimerRef.current) {
        window.clearTimeout(draftSaveTimerRef.current);
      }
    };
  }, [
    initialized,
    draftReady,
    draftSaveTick,
    currentTab,
    workshopTask,
    name,
    species,
    manualFrames
  ]);

  useEffect(() => {
    const isFrames = currentTab === "workshop" && workshopTask === "frames";
    if (wasFramesRef.current && !isFrames && !draftPausedRef.current) {
      if (draftSaveTimerRef.current) {
        window.clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      if (draftLoadedRef.current) {
        void flushDraftOnLeave();
      }
    }
    wasFramesRef.current = isFrames;
  }, [currentTab, workshopTask]);

  useEffect(() => {
    if (!aiCancelRef.current) {
      aiCheckpointRef.current = createGenerationCheckpoint();
      setCanResumeAI(false);
    }
    aiCharacterUrlRef.current = "";
    aiCharacterImageRef.current = "";
    void abandonCandidateReceipts();
    setAiCharacterReview(null);
    setAiSampleReview(null);
  }, [species, uploadUrl, referencePhoto, appearanceNotes]);

  useEffect(() => {
    if (!isTauri || currentTab !== "workshop" || workshopTask !== "ai") return;
    let cancelled = false;
    listGenerationTasks()
      .then((tasks) => {
        if (!cancelled) setGenerationTasks(tasks);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentTab, isTauri, workshopTask]);

  // Zoom
  const [zoom, setZoom] = useState(() => {
    const stored = Number(localStorage.getItem(PET_ZOOM_STORAGE));
    return Number.isFinite(stored) && stored >= 50 && stored <= 150 ? stored : 100;
  });

  // Autonomous wandering (browser preview only; the desktop app drives its own).
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
    const [all, removed] = await Promise.all([loadAllPets(), loadRemovedPets()]);
    const current = activePetRef.current;
    setPets(all.map((p) => p.id === current?.id ? { ...p, sourceImage: current.sourceImage, actions: current.actions } : p));
    setRemovedPets(removed);
  }
  async function activatePet(
    pet: PetProfile,
    create = false,
    explicitShow = true,
    options?: { skipActivate?: boolean; expectedSelectionRevision?: number }
  ): Promise<ActivationResult> {
    return serial(async (): Promise<ActivationResult> => {
      transitioning.current = true;
      const previous = activePetRef.current;
      let nativeChanged = false;
      let persisted = false;
      try {
        const selected = create ? pet : (await loadAllPets()).find((p) => p.id === pet.id);
        if (!selected) throw new Error("该宠物已被移除");
        const full = await ensurePetHydrated(selected);
        if (options?.expectedSelectionRevision !== undefined) {
          const [currentRevision, current] = await Promise.all([
            loadSelectionRevision(),
            loadPet()
          ]);
          if (
            currentRevision !== options.expectedSelectionRevision ||
            current?.id !== full.id
          ) {
            return { status: "superseded", currentPetId: current?.id ?? null };
          }
        }
        if (isTauri && full.frameRoot) {
          nativeChanged = true;
          await native.attach(full.frameRoot, full.id, full.name);
          full.currentAction = await syncNativeAction(full.currentAction);
        }
        if (create) await savePet(toPersistedPet(full));
        else if (!options?.skipActivate && !await setActivePetId(full.id)) {
          throw new Error("该宠物已被移除");
        }
        persisted = true;
        setActivePet(full);
        setDisplayRetry(null);
        const selectionRevision = await loadSelectionRevision().catch(() => 0);
        try {
          await refreshList();
        } catch {
          // A list refresh failure only needs a later re-read.
        }
        if (!isTauri) return { status: "webPreview", pet: full };
        if (!explicitShow) return { status: "savedOnly", pet: full };

        lastPreferenceRef.current = { kind: "show" };
        try {
          const shown = await native.update({ kind: "show", expectedPetId: full.id });
          if (shown?.visible && shown.petId === full.id) {
            return { status: "displayed", pet: full, state: shown };
          }
          // A different pet became visible while this command was in flight.
          const latest = await loadPet().catch(() => null);
          if (latest && latest.id !== full.id) {
            return { status: "superseded", currentPetId: latest.id };
          }
          const retry = createDisplayRetry(full, selectionRevision, "DISPLAY_UNCONFIRMED");
          setDisplayRetry(retry);
          return { status: "displayPending", pet: full, retry, code: retry.code };
        } catch (error) {
          const parsed = parseNativeError(error);
          if (parsed.code === "TARGET_CHANGED" || parsed.code === "STATE_CHANGED") {
            const latest = await loadPet().catch(() => null);
            return { status: "superseded", currentPetId: latest?.id ?? null };
          }
          // The profile is already saved and selected; keep it and leave only
          // the display retry. Never roll back into "not saved".
          const retry = createDisplayRetry(
            full,
            selectionRevision,
            parsed.code ?? "DISPLAY_FAILED"
          );
          setDisplayRetry(retry);
          return { status: "displayPending", pet: full, retry, code: retry.code };
        }
      } catch (error) {
        if (options?.expectedSelectionRevision !== undefined) {
          let currentRevision: number;
          let current: PetProfile | null;
          try {
            [currentRevision, current] = await Promise.all([
              loadSelectionRevision(),
              loadPet()
            ]);
          } catch {
            return { status: "selection_unknown" };
          }
          if (
            currentRevision !== options.expectedSelectionRevision ||
            current?.id !== pet.id
          ) {
            return { status: "superseded", currentPetId: current?.id ?? null };
          }
        }
        if (!persisted && nativeChanged && previous?.frameRoot) {
          try {
            await native.attach(previous.frameRoot, previous.id, previous.name);
            await syncNativeAction(previous.currentAction);
          } catch (rollbackError) {
            showToast(`恢复原桌宠失败：${formatError(rollbackError)}`, "error");
          }
        }
        throw error;
      } finally { transitioning.current = false; }
    });
  }

  function createDisplayRetry(
    pet: PetProfile,
    selectionRevision: number,
    code: string
  ): DisplayRetryContext {
    return {
      operationId: crypto.randomUUID(),
      petId: pet.id,
      petName: pet.name,
      selectionRevision,
      nativeVersion: nativeStateVersion(native.snapshot()),
      code
    };
  }

  /**
   * Retrying a display sends only `show`. It re-checks the stored selection
   * revision and asks Rust to check the pet and snapshot version again, so a
   * late retry cannot wake a newer companion or override a newer hide.
   */
  async function retryDisplay(context: DisplayRetryContext): Promise<void> {
    await serial(async () => {
      let petIds: string[];
      let activeId: string | null;
      let revision: number;
      try {
        const [all, active, storedRevision] = await Promise.all([
          loadAllPets(),
          loadPet(),
          loadSelectionRevision()
        ]);
        petIds = all.map((pet) => pet.id);
        activeId = active?.id ?? null;
        revision = storedRevision;
      } catch (error) {
        showToast(`读取伙伴资料失败：${formatError(error)}`, "error");
        return;
      }
      if (!displayRetryStillValid(context, petIds, activeId, revision)) {
        setDisplayRetry(null);
        showToast(
          "这次显示请求已失效：伙伴选择已经更新。请在陪伴页重新唤回当前伙伴。",
          "info"
        );
        return;
      }
      try {
        const shown = await native.update({
          kind: "show",
          expectedPetId: context.petId,
          expectedState: context.nativeVersion ?? undefined
        });
        if (shown?.visible && shown.petId === context.petId) {
          setDisplayRetry(null);
          showToast(`「${context.petName}」已在桌面陪着你。`, "success");
          return;
        }
        const retry = {
          ...context,
          operationId: crypto.randomUUID(),
          nativeVersion: nativeStateVersion(native.snapshot())
        };
        setDisplayRetry(retry);
        showToast(
          `还没能显示「${context.petName}」，资料仍然保留。可以稍后再试。`,
          "error"
        );
      } catch (error) {
        const parsed = parseNativeError(error);
        if (parsed.code === "TARGET_CHANGED" || parsed.code === "STATE_CHANGED") {
          setDisplayRetry(null);
          showToast(
            "这次显示请求已失效：桌面伙伴或状态已经更新。请在陪伴页重新唤回当前伙伴。",
            "info"
          );
          return;
        }
        const retry = {
          ...context,
          operationId: crypto.randomUUID(),
          nativeVersion: nativeStateVersion(native.snapshot())
        };
        setDisplayRetry(retry);
        showToast(`重试显示失败：${parsed.message}`, "error");
      }
    });
  }

  function announceActivation(result: ActivationResult, successMessage: string) {
    switch (result.status) {
      case "displayed":
        showToast(successMessage, "success");
        return;
      case "webPreview":
        showToast(`「${result.pet.name}」已保存，可在网页预览。`, "success");
        return;
      case "savedOnly":
        showToast(`「${result.pet.name}」已保存并切换。`, "success");
        return;
      case "displayPending":
        showToast(
          `「${result.pet.name}」已保存并切换，但暂时没能显示到桌面。重试只恢复显示。`,
          "error"
        );
        return;
      case "superseded":
        showToast("这次切换已被更新的伙伴选择取代，已读取最新状态。", "info");
        return;
      case "selection_unknown":
        showToast(
          "伙伴已保存，但暂时无法确认当前选择；桌面未切换，请稍后重试。",
          "info"
        );
        return;
    }
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
        const [all, stored, settings, onboardingLoad, collectionInitialized, removed] = await Promise.all([
          loadAllPets(), loadPet(),
          isTauri ? invoke<NativePetSettings>("get_native_pet_settings") : Promise.resolve(null),
          loadOnboardingRecord().catch(() => ({ record: null, corrupt: true })),
          isCollectionInitialized().catch(() => null),
          loadRemovedPets().catch(() => [])
        ]);
        if (cancelled) return;
        setPets(all);
        setRemovedPets(removed);
        let current = stored ?? all[0] ?? null;
        let pendingDisplayRecord: OnboardingRecord | null = null;

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
          if (start.record.confirmedPetId) {
            const confirmed = all.find((pet) => pet.id === start.record.confirmedPetId);
            if (confirmed) current = confirmed;
          }
          if (cancelled) return;
          let saveError: string | null = null;
          if (start.kind === "clean" || start.record !== onboardingLoad.record) {
            try {
              // Persist before opening the dialog so a first-run record cannot
              // race a test reset or a second window that is clearing storage.
              await saveOnboardingRecord(start.record);
            } catch (err) {
              saveError = `还没保存成功，名字和选择都保留着：${formatError(err)}`;
            }
          }
          const needsDisplay =
            start.record.state === "in_progress" &&
            start.record.phase === "committed" &&
            !start.record.displayConfirmed;
          if (needsDisplay) pendingDisplayRecord = start.record;
          setOnboarding(start.record);
          setAdoptionDisplayPending(needsDisplay);
          adoptionCommittedRef.current = start.record.phase === "committed";
          setOnboardingOpen(start.kind === "show" || start.kind === "clean");
          if (saveError) setOnboardingError(saveError);
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
              petId: current.id,
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
              const attached = await native.attach(full.frameRoot, full.id, full.name);
              full.currentAction = await syncNativeAction(full.currentAction);
              if (
                pendingDisplayRecord &&
                attached?.visible &&
                attached.petId === pendingDisplayRecord.confirmedPetId
              ) {
                try {
                  const confirmedRecord = await confirmAdoptionDisplay(
                    pendingDisplayRecord
                  );
                  setOnboarding(confirmedRecord);
                  setAdoptionDisplayPending(false);
                } catch (err) {
                  const latest = await loadOnboardingRecord().catch(() => null);
                  if (latest?.record) setOnboarding(latest.record);
                  setOnboardingError(
                    `显示已经确认，但记录没有保存成功：${formatError(err)}`
                  );
                }
              }
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

    const unsubscribeOnboarding = subscribeOnboardingChanges(() => {
      void serial(async () => {
        if (cancelled) return;
        const latest = await loadOnboardingRecord().catch(() => null);
        const record = latest?.record;
        const current = onboardingRef.current;
        if (!record || !current || record.intentId !== current.intentId) return;
        const finished =
          record.state === "completed" ||
          (record.phase === "committed" && record.displayConfirmed);
        if (!finished) return;
        setOnboarding(record);
        setAdoptionDisplayPending(false);
        setOnboardingOpen(record.state !== "completed");
      }).catch(() => undefined);
    });

    const unsubscribe = subscribePetChanges(() => {
      void serial(async () => {
        if (cancelled) return;
        const stored = await loadPet();
        const full = stored ? await ensurePetHydrated(stored) : null;
        if (!cancelled) {
          setActivePet(full);
          setDisplayRetry((current) =>
            current && full?.id !== current.petId ? null : current
          );
          await refreshList();
        }
      }).catch((err) => { if (!cancelled) showToast(`同步宠物失败：${formatError(err)}`, "error"); });
    });
    const unlistenError = isTauri ? listen<string>("native-pet-error", (event) => {
      if (!cancelled) showToast(`原生桌宠：${event.payload}`, "error");
    }) : null;
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeOnboarding();
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
  const nativeStateRef = useRef(native.state);
  nativeStateRef.current = native.state;
  useEffect(() => {
    switchActionRef.current = handleSwitchAction;
  });

  // Browser preview wanders on its own, mirroring the native runtime. In the
  // desktop app the Rust side owns this and pushes actions through events.
  useEffect(() => {
    if (isTauri || !native.state.effectiveAutonomous) return;
    const pet = activePetRef.current;
    if (!pet || !hasRenderableFrames(pet)) return;

    const timer = window.setTimeout(() => {
      // Re-check at fire time: hiding, pausing or reduced motion may have
      // changed after this timer was scheduled.
      if (!nativeStateRef.current.effectiveAutonomous) return;
      void switchActionRef.current(chooseNextAction(pet.currentAction));
    }, actionDurationMs(pet.currentAction));

    return () => window.clearTimeout(timer);
  }, [
    isTauri,
    native.state.effectiveAutonomous,
    activePet?.id,
    activePet?.currentAction,
    activePet?.actionStartedAt
  ]);

  async function applyPreference(request: PreferenceRequest) {
    lastPreferenceRef.current = request;
    // A hide or snooze replaces the earlier display intent immediately. Other
    // preferences (scale, motion, autostart) do not invalidate a display retry.
    if (request.kind === "hide" || request.kind === "snooze") setDisplayRetry(null);
    try {
      const next = await native.update(request);
      if (request.kind === "show") setDisplayRetry(null);
      setDismissedRecovery(null);
      return next;
    } catch (err) {
      const parsed = parseNativeError(err);
      if (parsed.code === "TARGET_CHANGED" || parsed.code === "STATE_CHANGED") {
        // The request named a profile or snapshot that is no longer current.
        // Do not attach a retry for it; the page shows the latest state.
        setDisplayRetry(null);
        showToast(
          "这次操作已失效：伙伴或状态已经更新，请按当前状态再试一次。",
          "info"
        );
        throw err;
      }
      if (request.kind === "show") {
        const pet = activePetRef.current;
        if (pet && isTauri) {
          const revision = await loadSelectionRevision().catch(() => 0);
          setDisplayRetry(createDisplayRetry(pet, revision, parsed.code ?? "DISPLAY_FAILED"));
        }
      }
      showToast(`设置没有保存：${parsed.message}`, "error");
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
    localStorage.setItem(AUTONOMOUS_STORAGE, value ? "on" : "off");
    void native.update({ kind: "setAutonomous", value }).catch((err) => {
      showToast(`切换自主活动失败：${formatError(err)}`, "error");
    });
  }

  async function handleToggleVisibility() {
    const hiding = native.state.visibilityMode === "shown";
    try {
      await applyPreference(
        hiding
          ? { kind: "hide" }
          : { kind: "show", expectedPetId: activePetRef.current?.id }
      );
      showToast(hiding ? "伙伴已收起，随时可以叫回来。" : "伙伴回来了。", "success");
    } catch {
      // applyPreference already reported the failure; recovery keeps the retry.
    }
  }

  async function handleSnooze(minutes: SnoozeMinutes = 60) {
    try {
      const next = await applyPreference({
        kind: "snooze",
        durationMinutes: minutes,
        expectedPetId: activePetRef.current?.id
      });
      const until = next?.snoozeUntilMs ?? Date.now() + minutes * 60 * 1000;
      showToast(`伙伴休息到 ${formatSnoozeTime(until)}，到时自动回来。`, "success");
    } catch {
      // Reported by applyPreference.
    }
  }

  async function handleKeepHidden() {
    try {
      await applyPreference({ kind: "hide" });
      showToast("已保持收起，休息到期已取消。", "success");
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
      await applyPreference({
        kind: "resetPosition",
        expectedPetId: activePetRef.current?.id
      });
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

  async function retryAssetFor(pet: PetProfile) {
    if (!pet.frameRoot) throw new Error("该伙伴没有可加载的素材目录");
    const full = await ensurePetHydrated(pet);
    if (isTauri) {
      // Attaching preserves the confirmed hidden/snoozed intent; restoring
      // material is not a request to wake the companion.
      await native.attach(full.frameRoot!, full.id, full.name);
    }
    setActivePet(full);
    setLocalError(null);
    showToast("伙伴的动作素材已恢复。", "success");
  }

  async function handleRetryAssetPet(petId: string) {
    const pet =
      activePetRef.current?.id === petId
        ? activePetRef.current
        : pets.find((candidate) => candidate.id === petId);
    if (!pet) throw new Error("该宠物已被移除");
    try {
      await retryAssetFor(pet);
    } catch (err) {
      setLocalError({
        id: `asset-${pet.id}-${Date.now()}`,
        petId: pet.id,
        title: `暂时找不到${pet.name}的动作素材，资料仍在`,
        body: "名字和选择都保留着。可以重试加载，或换一位已有伙伴。",
        operation: "set_frame_root",
        code: "ASSET_NOT_FOUND"
      });
      showToast(`重试加载失败：${formatError(err)}`, "error");
      throw err;
    }
  }

  async function handleRetryAsset() {
    const current = activePetRef.current;
    if (!current?.frameRoot) {
      setCurrentTab("shelf");
      return;
    }
    try {
      await handleRetryAssetPet(current.id);
    } catch {
      // handleRetryAssetPet already reported the failure.
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

  async function handlePracticeDesktop() {
    if (!isTauri) return;
    practicePendingRef.current = true;
    try {
      await invoke("hide_studio_window");
    } catch (err) {
      practicePendingRef.current = false;
      showToast(`暂时不能收起主窗口：${formatError(err)}`, "error");
    }
  }

  async function handleRetryConnection() {
    try {
      await native.refresh();
      showToast("已重新连接桌面伙伴。", "success");
    } catch (err) {
      showToast(`重新连接失败：${formatError(err)}`, "error");
    }
  }

  function handleRetryPreference() {
    const stored = lastPreferenceRef.current;
    if (!stored) {
      setSettingsOpen(true);
      return;
    }
    // A late retry still names the profile it was prepared for; Rust rejects
    // it if another window or the tray changed the target in the meantime.
    const request =
      (stored.kind === "show" || stored.kind === "resetPosition") &&
      activePetRef.current
        ? { ...stored, expectedPetId: stored.expectedPetId ?? activePetRef.current.id }
        : stored;
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

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || !practicePendingRef.current) return;
      practicePendingRef.current = false;
      setOnboardingSpeech("欢迎回来；伙伴仍在桌面。");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  async function rollbackAdoption() {
    if (!isTauri) return;
    const previous = activePetRef.current;
    try {
      if (previous?.frameRoot) {
        // Attach preserves the current hidden/snoozed intent; a failed
        // adoption must not wake the previous companion.
        await native.attach(previous.frameRoot, previous.id, previous.name);
      } else {
        await native.detach();
      }
    } catch (err) {
      showToast(`恢复原桌宠失败：${formatError(err)}`, "error");
    }
  }

  async function refreshOnboardingFromStorage(message?: string) {
    const latest = await loadOnboardingRecord().catch(() => null);
    if (latest?.record) {
      setOnboarding(latest.record);
      setAdoptionDisplayPending(
        latest.record.state === "in_progress" &&
          latest.record.phase === "committed" &&
          !latest.record.displayConfirmed
      );
      setOnboardingOpen(latest.record.state === "in_progress");
      adoptionCommittedRef.current = latest.record.phase === "committed";
    }
    if (message) setOnboardingError(message);
  }

  async function handleOnboardingNext() {
    if (!onboarding || onboardingBusyRef.current) return;
    const editSeq = nameEditSeqRef.current;
    const next: OnboardingRecord = {
      ...onboarding,
      step: "name",
      draftName: onboarding.draftName.trim() || DEFAULT_PET_NAME,
      updatedAt: new Date().toISOString()
    };
    setOnboarding(next);
    setOnboardingError(null);
    try {
      await intentWriteRef.current;
      const saved = await saveOnboardingProgress(next);
      setOnboarding((current) =>
        keepNewerDraftName(saved, current, editSeq, nameEditSeqRef.current)
      );
    } catch (error) {
      const failure = onboardingSaveFailure(error);
      if (failure.refresh) await refreshOnboardingFromStorage(failure.message);
      else setOnboardingError(failure.message);
    }
  }

  function handleOnboardingName(name: string) {
    nameEditSeqRef.current += 1;
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
    const editSeq = nameEditSeqRef.current;
    void intentWriteRef.current
      .then(() => saveOnboardingProgress(onboarding))
      .then((saved) => {
        // A reply must not replace a name typed while it was in flight.
        if (nameEditSeqRef.current !== editSeq) return;
        setOnboarding(saved);
      })
      .catch((error) => {
        const failure = onboardingSaveFailure(error);
        if (failure.refresh) {
          void refreshOnboardingFromStorage(failure.message);
        } else {
          setOnboardingError(failure.message);
        }
      });
  }

  async function handleOnboardingBrowse() {
    if (
      onboardingBusyRef.current ||
      adoptionDisplayPending ||
      (onboarding?.phase === "committed" && !onboarding.displayConfirmed)
    ) {
      return;
    }
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
      await intentWriteRef.current;
      const saved = await saveOnboardingProgress(next);
      setOnboarding(saved);
    } catch (error) {
      const failure = onboardingSaveFailure(error);
      if (failure.refresh) {
        await refreshOnboardingFromStorage(failure.message);
      } else {
        // The dialog was already closed optimistically; reopen it so the
        // unsaved draft and the reason stay visible.
        setOnboardingOpen(true);
        setOnboardingError(failure.message);
      }
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
      previousActivePetId: activePetRef.current?.id ?? null,
      confirmedPetId: null,
      phase: "draft",
      intentId: crypto.randomUUID(),
      displayConfirmed: true,
      updatedAt: new Date().toISOString()
    };
    setOnboarding(next);
    setOnboardingOpen(true);
    setOnboardingError(null);
    setOnboardingSpeech("");
    setAdoptionDisplayPending(false);
    adoptionCommittedRef.current = false;
    setStartingAdoption(true);
    const intentWrite = startNewAdoptionIntent(next)
      .then((saved) => {
        setOnboarding((current) => {
          if (!current || current.intentId !== saved.intentId) return saved;
          // Do not overwrite a name the user typed while the intent write was
          // in flight, and never regress a step that already advanced.
          if (current.step !== "name" || current.phase !== "draft") return current;
          return { ...saved, draftName: current.draftName };
        });
      })
      .catch((err) => {
        setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
      })
      .finally(() => setStartingAdoption(false));
    intentWriteRef.current = intentWrite.catch(() => undefined);
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

    const previousActivePetId = activePetRef.current?.id ?? null;
    let claim;
    try {
      claim = await claimAdoptionRecord(base, name, previousActivePetId);
    } catch (err) {
      setOnboardingError(`还没保存成功，名字和选择都保留着：${formatError(err)}`);
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }

    if (claim.alreadyCommitted) {
      // Another window finished this adoption first. Join its persisted result
      // instead of creating a second profile.
      const completed = claim.record.state === "completed";
      const needsDisplay =
        !completed &&
        claim.record.phase === "committed" &&
        !claim.record.displayConfirmed;
      setOnboarding(claim.record);
      setAdoptionDisplayPending(needsDisplay);
      setOnboardingOpen(!completed);
      const confirmedId = claim.record.confirmedPetId;
      if (confirmedId) {
        try {
          const stored = (await loadAllPets()).find((pet) => pet.id === confirmedId);
          if (stored) {
            const full = await ensurePetHydrated(stored);
            setActivePet(full);
            setDisplayRetry(null);
            if (isTauri && full.frameRoot) {
              // The following window may not have attached this profile yet;
              // attaching lets the shared native state confirm the display.
              try {
                await native.attach(full.frameRoot, full.id, full.name);
              } catch {
                // The recovery entry can retry the native attach.
              }
            }
          }
        } catch {
          // The record still points at the committed profile; a later read can recover.
        }
      }
      setOnboardingSpeech("");
      adoptionCommittedRef.current = true;
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      showToast(
        completed
          ? "这次领养已在另一个窗口完成。"
          : needsDisplay
            ? "这次领养已在另一个窗口完成，正在等待桌面显示。"
            : "这次领养已在另一个窗口完成，已为你打开见面。",
        "info"
      );
      return;
    }

    const plan = {
      record: claim.record,
      pendingPetId: claim.record.pendingPetId,
      name: claim.record.draftName.trim() || name,
      previousActivePetId: claim.record.previousActivePetId
    };
    if (!plan.pendingPetId) {
      setOnboardingError("还没保存成功，名字和选择都保留着：领养编号缺失，请重试");
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }
    setOnboarding(plan.record);

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
      await commitAdoptedPet(
        toPersistedPet(fullPet),
        committed,
        plan.previousActivePetId
      );
    } catch (err) {
      const message = formatError(err);
      const superseded =
        message.includes("其他窗口") || message.includes("当前伙伴已更新");
      if (superseded) {
        // Respect the newer window's result instead of rolling it back.
        const latest = await loadOnboardingRecord().catch(() => null);
        if (latest?.record?.phase === "committed" && latest.record.confirmedPetId) {
          try {
            const stored = (await loadAllPets()).find(
              (pet) => pet.id === latest.record!.confirmedPetId
            );
            if (stored) {
              const full = await ensurePetHydrated(stored);
              setActivePet(full);
              setDisplayRetry(null);
              if (isTauri && full.frameRoot) {
                try {
                  await native.attach(full.frameRoot, full.id, full.name);
                } catch {
                  // Keep the record; the recovery entry can retry.
                }
              }
            }
          } catch {
            // Keep the record; the list can be re-read later.
          }
          const completed = latest.record.state === "completed";
          const needsDisplay =
            !completed &&
            latest.record.phase === "committed" &&
            !latest.record.displayConfirmed;
          setOnboarding(latest.record);
          setAdoptionDisplayPending(needsDisplay);
          setOnboardingOpen(!completed);
          adoptionCommittedRef.current = true;
          onboardingBusyRef.current = false;
          setOnboardingBusy(false);
          showToast(
            completed
              ? "这次领养已在另一个窗口完成。"
              : "这次领养已在另一个窗口完成，已为你打开见面。",
            "info"
          );
          return;
        }
      }
      await rollbackAdoption();
      setOnboardingError(`还没保存成功，名字和选择都保留着：${message}`);
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }

    setActivePet(fullPet);
    setDisplayRetry(null);
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

    adoptionCommittedRef.current = true;
    setOnboardingSpeech("");

    if (isTauri) {
      let shown;
      try {
        lastPreferenceRef.current = { kind: "show" };
        shown = await native.update({
          kind: "show",
          expectedPetId: plan.pendingPetId
        });
      } catch {
        // The profile is committed; stay in a waiting state and retry the
        // display command, not the tutorial.
        setOnboarding(committed);
        setAdoptionDisplayPending(true);
        setOnboardingError("伙伴资料已经保存，但桌面还没有确认显示。请重试显示。");
        onboardingBusyRef.current = false;
        setOnboardingBusy(false);
        return;
      }
      if (!shown?.visible || shown.petId !== plan.pendingPetId) {
        // Another adoption may have become active while this command was in
        // flight. Never confirm a different pet or overwrite its record.
        const latest = await loadOnboardingRecord().catch(() => null);
        if (latest?.record) {
          setOnboarding(latest.record);
          setAdoptionDisplayPending(
            latest.record.state === "in_progress" &&
              latest.record.phase === "committed" &&
              !latest.record.displayConfirmed
          );
          setOnboardingOpen(latest.record.state !== "completed");
        } else {
          setOnboarding(committed);
          setAdoptionDisplayPending(true);
        }
        setOnboardingError("当前桌面伙伴已切换，这次显示没有确认。");
        onboardingBusyRef.current = false;
        setOnboardingBusy(false);
        return;
      }
    }

    let confirmedRecord: OnboardingRecord;
    try {
      confirmedRecord = await confirmAdoptionDisplay(committed);
      setOnboarding(confirmedRecord);
    } catch (err) {
      const latest = await loadOnboardingRecord().catch(() => null);
      if (latest?.record) {
        setOnboarding(latest.record);
        setAdoptionDisplayPending(
          latest.record.state === "in_progress" &&
            latest.record.phase === "committed" &&
            !latest.record.displayConfirmed
        );
        setOnboardingOpen(latest.record.state !== "completed");
      } else {
        setOnboarding(committed);
        setAdoptionDisplayPending(true);
      }
      setOnboardingError(
        `这次等待显示已失效，已读取最新领养结果：${formatError(err)}`
      );
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }

    setAdoptionDisplayPending(false);
    onboardingBusyRef.current = false;
    setOnboardingBusy(false);
    showToast(`「${plan.name}」已经入住桌面。`, "success");
  }

  async function retryAdoptionDisplay() {
    if (!onboarding?.confirmedPetId) {
      setOnboardingError("还没有可显示的伙伴，请重新领养");
      return;
    }
    onboardingBusyRef.current = true;
    setOnboardingBusy(true);
    setOnboardingError(null);
    let shown;
    try {
      lastPreferenceRef.current = { kind: "show" };
      shown = await native.update({
        kind: "show",
        expectedPetId: onboarding.confirmedPetId ?? undefined
      });
    } catch {
      setAdoptionDisplayPending(true);
      setOnboardingError("还没显示到桌面，资料已经保存。请重试显示。");
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }
    if (!shown?.visible || shown.petId !== onboarding.confirmedPetId) {
      const latest = await loadOnboardingRecord().catch(() => null);
      if (latest?.record) {
        setOnboarding(latest.record);
        setAdoptionDisplayPending(
          latest.record.state === "in_progress" &&
            latest.record.phase === "committed" &&
            !latest.record.displayConfirmed
        );
        setOnboardingOpen(latest.record.state !== "completed");
      }
      setOnboardingError("当前桌面伙伴已切换，这次等待显示已失效。");
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
      return;
    }
    try {
      const confirmedRecord = await confirmAdoptionDisplay(onboarding);
      setOnboarding(confirmedRecord);
      setAdoptionDisplayPending(false);
      setOnboardingSpeech("");
      showToast("伙伴已经显示到桌面。", "success");
    } catch (err) {
      const latest = await loadOnboardingRecord().catch(() => null);
      if (latest?.record) {
        setOnboarding(latest.record);
        setAdoptionDisplayPending(
          latest.record.state === "in_progress" &&
            latest.record.phase === "committed" &&
            !latest.record.displayConfirmed
        );
        setOnboardingOpen(latest.record.state !== "completed");
      } else {
        setAdoptionDisplayPending(true);
      }
      setOnboardingError(
        `这次等待显示已失效，已读取最新领养结果：${formatError(err)}`
      );
    } finally {
      onboardingBusyRef.current = false;
      setOnboardingBusy(false);
    }
  }

  async function handleOnboardingFinish() {
    if (!onboarding) return;
    if (
      adoptionDisplayPending ||
      (onboarding.phase === "committed" && !onboarding.displayConfirmed)
    ) {
      setOnboardingError("伙伴还没有显示到桌面，请先重试显示。");
      return;
    }
    const completed = completeOnboarding(
      onboarding,
      activePetRef.current?.id ?? onboarding.confirmedPetId
    );
    try {
      await intentWriteRef.current;
      const saved = await saveOnboardingProgress(completed);
      setOnboarding(saved);
      setOnboardingOpen(false);
      setOnboardingError(null);
      setOnboardingSpeech("");
      showToast("已经记住你们第一次见面。", "success");
    } catch (error) {
      const failure = onboardingSaveFailure(error);
      if (failure.refresh) await refreshOnboardingFromStorage(failure.message);
      else setOnboardingError(failure.message);
    }
  }

  async function handleOnboardingRetry() {
    if (!onboarding) {
      window.location.reload();
      return;
    }
    if (adoptionDisplayPending) {
      await retryAdoptionDisplay();
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
  async function handleChooseFrameDir() {
    if (!isTauri) {
      showToast("目录选择需要桌面版；网页模式请使用手动路径或文件选择。", "info");
      return;
    }
    try {
      const selected = await invoke<string | string[] | null>("plugin:dialog|open", {
        options: {
          directory: true,
          multiple: false,
          title: "选择帧包目录",
          defaultPath: presetFrameDir.trim() || undefined
        }
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) {
        showToast("已取消选择，目录和预检结果没有变化。", "info");
        return;
      }
      inspectionRequestRef.current += 1;
      setPresetFrameDir(path);
      setFrameInspection(null);
      setInspectingFrames(false);
    } catch (err) {
      showToast(`无法打开目录选择：${formatError(err)}`, "error");
    }
  }

  async function handleInspectFrames() {
    if (!isTauri) {
      showToast("目录预检需要桌面版；网页模式只提供实际支持的文件选择。", "info");
      return;
    }
    const requestId = ++inspectionRequestRef.current;
    setInspectingFrames(true);
    const rootDir = presetFrameDir.trim() || DEFAULT_PRESET_FRAME_DIR;
    try {
      const report = await invoke<FrameInspection>("inspect_frame_directory", {
        rootDir
      });
      if (requestId !== inspectionRequestRef.current) return;
      setFrameInspection(report);
      showToast(
        report.valid
          ? "预检通过：六个动作和容量都在限制内。"
          : "预检发现缺项或图片问题，请按清单修正。",
        report.valid ? "success" : "error"
      );
    } catch (err) {
      if (requestId !== inspectionRequestRef.current) return;
      setFrameInspection(null);
      showToast(`预检失败：${formatError(err)}`, "error");
    } finally {
      if (requestId === inspectionRequestRef.current) {
        setInspectingFrames(false);
      }
    }
  }

  async function cleanupUnreferencedManagedAsset(assetId: string) {
    if (!isTauri) return;
    try {
      const [pets, removed] = await Promise.all([loadAllPets(), loadRemovedPets()]);
      const referenced = [...pets, ...removed.map((record) => record.pet)].some(
        (entry) => entry.assetId === assetId
      );
      if (!referenced) {
        await invoke("delete_managed_asset", { assetId });
      }
    } catch {
      // Cleanup is best effort; an orphan can be collected later.
    }
  }

  async function handleManagePetAsset(pet: PetProfile) {
    if (!isTauri || pet.storageMode !== "preset-root" || !pet.frameRoot) {
      showToast("只有桌面版的外部目录伙伴可以交给应用保管。", "info");
      return;
    }
    let pendingAssetId: string | undefined;
    const originalRoot = pet.frameRoot;
    const originalAssetId = pet.assetId;
    try {
      const copyId = `${pet.id}-${Date.now()}`;
      const copied = await invoke<ManagedAsset>("copy_to_managed_asset", {
        sourceDir: pet.frameRoot,
        assetId: copyId
      });
      pendingAssetId = copied.assetId;
      const updated = await updatePetAssetReference(
        pet.id,
        copied.root,
        "managed",
        copied.assetId,
        { frameRoot: originalRoot, assetId: originalAssetId }
      );
      if (!updated) throw new Error("目标伙伴已被移除或素材已变化");
      pendingAssetId = undefined;
      await refreshList();
      if (activePetRef.current?.id === pet.id) {
        const full = await ensurePetHydrated(updated);
        setActivePet(full);
        try {
          if (full.frameRoot) {
            await native.attach(full.frameRoot, full.id, full.name);
          }
        } catch {
          setLocalError({
            id: `asset-${full.id}`,
            petId: full.id,
            title: "资料已交给应用保管，桌面尚未同步",
            body: "本机资料已安全复制；可以重试加载或稍后重新显示。",
            operation: "set_frame_root",
            code: "ASSET_NOT_FOUND"
          });
          showToast("资料已交给应用保管，但桌面尚未同步。", "info");
          return;
        }
      }
      showToast(`已把「${pet.name}」交给应用保管，原目录不再依赖。`, "success");
    } catch (err) {
      if (pendingAssetId) void cleanupUnreferencedManagedAsset(pendingAssetId);
      showToast(`交给应用保管失败：${formatError(err)}`, "error");
    }
  }

  async function handleRelocatePet(pet: PetProfile) {
    if (!isTauri || pet.storageMode !== "preset-root" || !pet.frameRoot) {
      showToast("只有桌面版的外部目录伙伴可以重新定位。", "info");
      return;
    }
    let pendingAssetId: string | undefined;
    try {
      const selected = await invoke<string | string[] | null>("plugin:dialog|open", {
        options: {
          directory: true,
          multiple: false,
          title: "选择新的帧包目录",
          defaultPath: pet.frameRoot
        }
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) {
        showToast("已取消重新定位，素材引用没有变化。", "info");
        return;
      }
      if (
        !window.confirm(
          `将用「${path}」替换「${pet.name}」的素材引用。原目录不会被修改，确认继续？`
        )
      ) {
        return;
      }
      const originalRoot = pet.frameRoot;
      const originalAssetId = pet.assetId;
      const copyId = `${pet.id}-${Date.now()}`;
      const copied = await invoke<ManagedAsset>("copy_to_managed_asset", {
        sourceDir: path,
        assetId: copyId
      });
      pendingAssetId = copied.assetId;
      const current = (await loadAllPets()).find((entry) => entry.id === pet.id);
      if (!current) {
        throw new Error("目标伙伴已被移除，未替换素材");
      }
      if (
        current.frameRoot !== originalRoot ||
        current.assetId !== originalAssetId
      ) {
        throw new Error("目标伙伴的素材已变化，未替换");
      }
      const updated = await updatePetAssetReference(
        pet.id,
        copied.root,
        "managed",
        copied.assetId,
        { frameRoot: originalRoot, assetId: originalAssetId }
      );
      if (!updated) throw new Error("目标伙伴已被移除或素材已变化");
      pendingAssetId = undefined;
      await refreshList();
      if (activePetRef.current?.id === pet.id) {
        const full = await ensurePetHydrated(updated);
        setActivePet(full);
        if (full.frameRoot) {
          try {
            await native.attach(full.frameRoot, full.id, full.name);
          } catch {
            setLocalError({
              id: `asset-${full.id}`,
              petId: full.id,
              title: "资料已更新，桌面待同步",
              body: "新的素材引用已经保存；桌面仍在用旧素材。可以只重试加载，不需要重新复制。",
              operation: "set_frame_root",
              code: "ASSET_NOT_FOUND"
            });
            showToast("资料已更新，桌面待同步。", "info");
            return;
          }
        }
      }
      showToast(`已重新定位「${pet.name}」的素材。`, "success");
    } catch (err) {
      if (pendingAssetId) void cleanupUnreferencedManagedAsset(pendingAssetId);
      showToast(`重新定位失败：${formatError(err)}`, "error");
    }
  }

  async function handleExportPetPackage(pet: PetProfile) {
    if (!isTauri || !pet.frameRoot) {
      showToast("只有带素材目录的桌面版伙伴可以导出完整包。", "info");
      return;
    }
    try {
      const selected = await invoke<string | string[] | null>("plugin:dialog|open", {
        options: {
          directory: true,
          multiple: false,
          title: "选择伙伴包导出位置"
        }
      });
      const parentDir = Array.isArray(selected) ? selected[0] : selected;
      if (!parentDir) {
        showToast("已取消导出，没有创建任何文件。", "info");
        return;
      }
      const exported = await invoke<ExportedPetPackage>("export_pet_package", {
        parentDir,
        name: pet.name,
        species: pet.species,
        style: pet.style,
        createdAt: pet.createdAt,
        frameRoot: pet.frameRoot
      });
      showToast(`已导出完整伙伴包：${exported.root}`, "success");
    } catch (err) {
      showToast(`导出伙伴包失败：${formatError(err)}`, "error");
    }
  }

  async function handleImportPetPackage() {
    if (!isTauri) {
      showToast("伙伴包导入需要桌面版。", "info");
      return;
    }
    setIsLoading(true);
    try {
      const selected = await invoke<string | string[] | null>("plugin:dialog|open", {
        options: {
          directory: true,
          multiple: false,
          title: "选择伙伴包目录"
        }
      });
      const packageDir = Array.isArray(selected) ? selected[0] : selected;
      if (!packageDir) {
        showToast("已取消导入，伙伴架没有变化。", "info");
        return;
      }
      const summary = await invoke<PackageSummary>("inspect_pet_package", {
        rootDir: packageDir
      });
      if (
        !window.confirm(
          `将把「${summary.name}」导入为一位新伙伴，分配本机新 id，不改变当前桌面伙伴。确认继续？`
        )
      ) {
        return;
      }
      const assetId = crypto.randomUUID();
      const imported = await invoke<ImportedPetPackage>("import_pet_package", {
        packageDir,
        assetId
      });
      try {
        const pack = await invoke<PresetFramePack>("load_preset_frame_pack", {
          request: { rootDir: imported.root }
        });
        const newPet = createManualPet({
          id: assetId,
          name: imported.name,
          species: imported.species,
          sourceImage: pack.sourceImage,
          manualFrames: pack.actions,
          frameRoot: imported.root,
          storageMode: "preset-root",
          assetMode: "managed",
          assetId: imported.assetId,
          createdAt: imported.createdAt
        });
        await savePetProfile(toPersistedPet(newPet));
        await refreshList();
        setCurrentTab("shelf");
        showToast(
          `已把「${newPet.name}」导入伙伴架，当前伙伴未改变。`,
          "success"
        );
      } catch (err) {
        await cleanupUnreferencedManagedAsset(assetId);
        throw err;
      }
    } catch (err) {
      showToast(`导入伙伴包失败：${formatError(err)}`, "error");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleImportPreset() {
    setIsLoading(true);
    let pendingAssetId: string | undefined;
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
        if (repairPetId) {
          const updated = await replacePetAssets(
            repairPetId,
            rootDir,
            loadedActions.idle[0],
            loadedActions
          );
          if (!updated) throw new Error("要修复的伙伴已被移除");
          if (activePetRef.current?.id === repairPetId) {
            setActivePet(await ensurePetHydrated(updated));
          }
          await refreshList();
          setLocalError(null);
          setDisplayRetry(null);
          setFrameInspection(null);
          setRepairPetId(null);
          setWorkshopTask("choose");
          showToast(`已更新「${updated.name}」的素材；显示/休息状态没有改变。`, "success");
          return;
        }
        const newPet = createManualPet({
          name: name.trim() || "咕唧 (萌宠小怪兽)",
          species,
          sourceImage: loadedActions.idle[0],
          manualFrames: loadedActions,
          frameRoot: rootDir,
          storageMode: "preset-root"
        });
        const result = await activatePet(newPet, true);
        announceActivation(result, "已导入真实预置帧包（小怪兽动画包）！");
        setCurrentTab("stage");
        return;
      }

      const petId = repairPetId ?? crypto.randomUUID();
      const useManaged = !keepExternalReference;
      let packRoot = rootDir;
      let assetMode: PetProfile["assetMode"] = "external";
      let managedAssetId: string | undefined;
      if (useManaged) {
        const copyId = repairPetId ? `${repairPetId}-${Date.now()}` : petId;
        const copied = await invoke<ManagedAsset>("copy_to_managed_asset", {
          sourceDir: rootDir,
          assetId: copyId
        });
        packRoot = copied.root;
        assetMode = "managed";
        managedAssetId = copied.assetId;
        pendingAssetId = copied.assetId;
      }
      const pack = await invoke<PresetFramePack>("load_preset_frame_pack", {
        request: { rootDir: packRoot }
      });

      if (repairPetId) {
        const updated = await replacePetAssets(
          repairPetId,
          packRoot,
          pack.sourceImage,
          pack.actions,
          undefined,
          assetMode,
          managedAssetId
        );
        if (!updated) throw new Error("要修复的伙伴已被移除");
        pendingAssetId = undefined;
        if (activePetRef.current?.id === repairPetId) {
          const full = await ensurePetHydrated(updated);
          setActivePet(full);
          if (full.frameRoot) {
            // Attaching preserves the confirmed hidden/snoozed intent.
            try {
              await native.attach(full.frameRoot, full.id, full.name);
            } catch {
              setLocalError({
                id: `asset-${full.id}`,
                petId: full.id,
                title: "资料已更新，桌面待同步",
                body: "新的素材引用已经保存；桌面仍在用旧素材。可以只重试加载，不需要重新复制。",
                operation: "set_frame_root",
                code: "ASSET_NOT_FOUND"
              });
              showToast("资料已更新，桌面待同步。", "info");
              return;
            }
          }
        }
        await refreshList();
        setLocalError(null);
        setDisplayRetry(null);
        setFrameInspection(null);
        setRepairPetId(null);
        setWorkshopTask("choose");
        showToast(`已更新「${updated.name}」的素材；显示/休息状态没有改变。`, "success");
        return;
      }

      const newPet = createManualPet({
        id: petId,
        name: name.trim() || (species === "cat" ? "糖宝" : "大黄"),
        species,
        sourceImage: pack.sourceImage,
        manualFrames: pack.actions,
        frameRoot: packRoot,
        storageMode: "preset-root",
        assetMode,
        assetId: managedAssetId
      });

      const result = await activatePet(newPet, true);
      pendingAssetId = undefined;
      announceActivation(result, `已成功导入「${newPet.name}」并同步至桌面！`);
      setCurrentTab("stage");
    } catch (err) {
      if (pendingAssetId) void cleanupUnreferencedManagedAsset(pendingAssetId);
      showToast(`导入失败：${formatError(err)}`, "error");
    } finally {
      setIsLoading(false);
    }
  }

  // Workshop - Save Manual Frames
  async function waitForDraftIdle() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (draftSaveInFlightRef.current) {
        await draftSaveInFlightRef.current.catch(() => false);
      }
      if (!draftSavingRef.current && !draftSaveInFlightRef.current) return;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
  }

  async function handleDiscardDraft() {
    if (!window.confirm("丢弃本次装配草稿？不会删除已保存伙伴或正式素材。")) {
      return;
    }
    draftSubmitInProgressRef.current = true;
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    try {
      if (draftFlushInFlightRef.current) {
        await draftFlushInFlightRef.current.catch(() => {});
      }
      await waitForDraftIdle();
      const current = await loadCreationDraft(ASSEMBLY_DRAFT_ID);
      if (
        current &&
        (draftRevisionRef.current === null ||
          current.revision !== draftRevisionRef.current ||
          current.pendingPetId !== draftPendingPetIdRef.current)
      ) {
        setDraftStatus("conflict");
        showToast("草稿已被其他窗口更新，未删除；当前输入仍保留。", "info");
        return;
      }
      const deleted = current
        ? await deleteCreationDraft(
            ASSEMBLY_DRAFT_ID,
            current.revision,
            current.pendingPetId
          )
        : true;
      if (!deleted) {
        setDraftStatus("conflict");
        showToast("草稿已被其他窗口更新，未删除；当前输入仍保留。", "info");
        return;
      }
      draftRevisionRef.current = null;
      draftPendingPetIdRef.current = crypto.randomUUID();
      draftPausedRef.current = true;
      suppressNextDraftSaveRef.current = true;
      setDraftStatus("idle");
      setManualFrames({});
      showToast("装配草稿已丢弃，已保存的伙伴和素材没有变化。", "info");
    } catch (err) {
      showToast(`丢弃草稿失败：${formatError(err)}`, "error");
    } finally {
      draftSubmitInProgressRef.current = false;
    }
  }

  async function handleSaveManualFrames() {
    setIsLoading(true);
    draftSubmitInProgressRef.current = true;
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    try {
      if (draftFlushInFlightRef.current) {
        await draftFlushInFlightRef.current.catch(() => {});
      }
      await waitForDraftIdle();
      const actions = Object.fromEntries(
        PET_ACTIONS.map((a) => [a.id, manualFrames[a.id] ?? []])
      ) as ActionFrameSet;

      const fallbackImage =
        manualFrames.idle?.[0] || Object.values(manualFrames).find((f) => f?.[0])?.[0] || "";

      let newPet: PetProfile;
      if (isTauri) {
        const saved = await invoke<SavedManualFramePack>("save_manual_frame_pack", {
          request: { actions }
        });
        newPet = createManualPet({
          id: draftPendingPetIdRef.current,
          name: name.trim() || "我的宠物",
          species,
          sourceImage: saved.sourceImage || fallbackImage,
          manualFrames: actions,
          frameRoot: saved.frameRoot,
          storageMode: "preset-root"
        });
      } else {
        newPet = createManualPet({
          id: draftPendingPetIdRef.current,
          name: name.trim() || "我的宠物",
          species,
          sourceImage: fallbackImage,
          manualFrames: actions
        });
      }

      const commit = await commitAssemblyDraftPet(
        toPersistedPet(newPet),
        ASSEMBLY_DRAFT_ID,
        draftRevisionRef.current,
        draftPendingPetIdRef.current
      );
      if (commit.status === "conflict") {
        setDraftStatus("conflict");
        showToast("草稿已被其他窗口更新，未提交；当前输入仍保留。", "info");
        return;
      }

      // The database commit is complete: end the draft submission state before
      // touching the native window. A later attach failure must not look like a
      // failed save or resurrect the deleted draft.
      draftRevisionRef.current = null;
      draftPendingPetIdRef.current = crypto.randomUUID();
      draftPausedRef.current = true;
      suppressNextDraftSaveRef.current = true;
      setDraftStatus("idle");
      setManualFrames({});

      if (commit.status === "already_committed") {
        await refreshList();
        showToast(
          "这次提交已在另一窗口完成，沿用已保存的伙伴；当前选择保持不变。",
          "info"
        );
        setCurrentTab("stage");
        return;
      }

      try {
        const selectionRevision = await loadSelectionRevision();
        const currentPet = await loadPet();
        if (
          selectionRevision !== commit.selectionRevision ||
          currentPet?.id !== commit.pet.id
        ) {
          await refreshList();
          showToast(
            "伙伴已保存；当前选择已由另一窗口更新，未切换桌面。",
            "info"
          );
          setCurrentTab("stage");
          return;
        }
        const result = await activatePet(commit.pet, false, true, {
          skipActivate: true,
          expectedSelectionRevision: commit.selectionRevision
        });
        if (result.status === "superseded") {
          await refreshList();
          showToast("伙伴已保存；选择已更新，未切换桌面。", "info");
          setCurrentTab("stage");
          return;
        }
        announceActivation(
          result,
          `已成功保存「${commit.pet.name}」并同步至桌面！`
        );
      } catch {
        const full = await ensurePetHydrated(commit.pet).catch(() => commit.pet);
        setActivePet(full);
        setLocalError({
          id: `asset-${commit.pet.id}`,
          petId: commit.pet.id,
          title: "已保存，桌面待同步",
          body: "资料和草稿已提交；桌面仍在用旧素材。可以只重试加载，不需要重新保存。",
          operation: "set_frame_root",
          code: "ASSET_NOT_FOUND"
        });
        showToast("已保存，桌面待同步。", "info");
        await refreshList().catch(() => {});
      }
      setCurrentTab("stage");
    } catch (err) {
      setDraftStatus("unsaved");
      showToast(`保存帧包失败：${formatError(err)}`, "error");
    } finally {
      draftSubmitInProgressRef.current = false;
      setIsLoading(false);
    }
  }

  // Workshop - AI Generation
  async function refreshGenerationTasks() {
    if (!isTauri) return;
    try {
      setGenerationTasks(await listGenerationTasks());
    } catch {
      // The generation flow still works if the task list cannot be read.
    }
  }

  function aiInputSignature() {
    return JSON.stringify([uploadUrl, referencePhoto, species, appearanceNotes]);
  }

  async function abandonCandidateReceipts() {
    const candidate = aiCandidateRef.current;
    aiCandidateRef.current = null;
    if (!candidate?.attemptIds.length) return;
    const task = activeGenerationTaskRef.current;
    if (!task) return;
    const receipts = task.receipts.map((receipt) =>
      candidate.attemptIds.includes(receipt.attemptId)
        ? { ...receipt, status: "abandoned" }
        : receipt
    );
    try {
      const updated = await updateGenerationTask(
        { ...task, receipts },
        task.revision
      );
      activeGenerationTaskRef.current = updated;
    } catch {
      // Keep the candidate receipts explicit as received; no success claim.
    }
  }

  async function recordRequestStart(attempt: { attemptId: string; action: string }) {
    const task = activeGenerationTaskRef.current;
    if (!task) throw new Error("当前制作任务已失效");
    const updated = await updateGenerationTask(
      {
        ...task,
        receipts: [
          ...task.receipts,
          {
            attemptId: attempt.attemptId,
            action: attempt.action,
            startedAt: new Date().toISOString(),
            status: "started"
          }
        ]
      },
      task.revision
    );
    activeGenerationTaskRef.current = updated;
    const candidate = aiCandidateRef.current;
    if (candidate && candidate.taskId === task.taskId) {
      candidate.attemptIds.push(attempt.attemptId);
    }
    await refreshGenerationTasks();
  }

  async function recordRequestEnd(result: { attemptId: string; status: string }) {
    const task = activeGenerationTaskRef.current;
    if (!task) return;
    const updated = await updateGenerationTask(
      {
        ...task,
        receipts: task.receipts.map((receipt) =>
          receipt.attemptId === result.attemptId
            ? { ...receipt, status: result.status }
            : receipt
        )
      },
      task.revision
    );
    activeGenerationTaskRef.current = updated;
  }

  async function markReceivedReceiptsSucceeded() {
    const task = activeGenerationTaskRef.current;
    if (!task) return;
    const receipts = task.receipts.map((receipt) =>
      receipt.status === "received"
        ? { ...receipt, status: "succeeded" }
        : receipt
    );
    if (receipts.every((receipt, index) => receipt.status === task.receipts[index]?.status)) {
      return;
    }
    const updated = await updateGenerationTask(
      { ...task, receipts },
      task.revision
    );
    activeGenerationTaskRef.current = updated;
  }

  function hasUnsettledReceipts(task: GenerationTask | null) {
    return Boolean(
      task?.receipts.some(
        (receipt) =>
          receipt.status !== "succeeded" &&
          receipt.status !== "cancelled" &&
          receipt.status !== "abandoned"
      )
    );
  }

  function generationCandidate(mode: "initial" | "regenerate") {
    const active = activeGenerationTaskRef.current;
    const existing = aiCandidateRef.current;
    const signature = aiInputSignature();
    if (
      existing &&
      active &&
      existing.taskId === active.taskId &&
      existing.inputSignature === signature &&
      existing.mode === mode
    ) {
      return { checkpoint: existing.checkpoint, forceNewCharacter: false };
    }
    const checkpoint = cloneGenerationCheckpoint(aiCheckpointRef.current);
    aiCandidateRef.current = {
      taskId: active?.taskId ?? "",
      inputSignature: signature,
      mode,
      checkpoint,
      attemptIds: []
    };
    return { checkpoint, forceNewCharacter: mode === "regenerate" };
  }

  async function ensureGenerationTask(): Promise<GenerationTask> {
    const existing = activeGenerationTaskRef.current;
    if (existing) return existing;
    if (!referencePhoto) throw new Error("请先选择宠物照片");
    const digest = await sha256Hex(referencePhoto);
    await abandonCandidateReceipts();
    setAiReceiptSyncPending(false);
    const created = await createGenerationTask({
      schemaVersion: 1,
      taskId: crypto.randomUUID(),
      revision: 0,
      ownerSession: null,
      stage: "draft",
      pendingPetId: crypto.randomUUID(),
      photoDigest: digest,
      species,
      appearanceNotes,
      promptVersion: "v1",
      characterRevision: 0,
      confirmedCharacterRevision: null,
      actions: {},
      receipts: [],
      committedPetId: null,
      createdAt: "",
      updatedAt: ""
    });
    const claimed = await claimGenerationTask(created.taskId, false);
    activeGenerationTaskRef.current = claimed.task;
    await refreshGenerationTasks();
    return claimed.task;
  }

  async function advanceGenerationTask(
    task: GenerationTask,
    stage: string,
    extra: Partial<GenerationTask> = {}
  ): Promise<GenerationTask> {
    const latest = activeGenerationTaskRef.current;
    const base = latest && latest.taskId === task.taskId ? latest : task;
    const updated = await updateGenerationTask(
      { ...base, stage, ...extra },
      base.revision
    );
    activeGenerationTaskRef.current = updated;
    await refreshGenerationTasks();
    return updated;
  }

  async function handleResumeGenerationTask(taskId: string) {
    try {
      const claimed = await claimGenerationTask(taskId, true);
      activeGenerationTaskRef.current = claimed.task;
      await refreshGenerationTasks();
      showToast(
        claimed.status === "interrupted"
          ? "任务已标记中断；再次继续可重新领取。"
          : "已领取上次制作任务，请继续生成当前阶段。",
        "info"
      );
    } catch (err) {
      showToast(`领取制作任务失败：${formatError(err)}`, "error");
    }
  }

  async function handleGenerateAI() {
    if (!isTauri) {
      showToast("AI 生成需在桌面版环境中运行", "error");
      return;
    }
    if (!aiConsent) {
      showToast("请先确认照片用途和可能产生的生成费用", "error");
      return;
    }
    if (aiCancelRef.current || isLoading) return;

    setAiLog([]);
    setAiUncertain(false);
    const cancelToken = { cancelled: false, committing: false };
    aiCancelRef.current = cancelToken;
    setAiRunning(true);
    let generationTask: GenerationTask | null = null;
    const inputSignature = aiInputSignature();

    try {
      generationTask = await ensureGenerationTask();
      generationTask = await advanceGenerationTask(
        generationTask,
        "characterGenerating"
      );
      const candidate = generationCandidate("initial");
      const character = await generateCharacter({
        apiKey,
        uploadUrl,
        referencePhoto: referencePhoto ?? "",
        species,
        appearanceNotes,
        checkpoint: candidate.checkpoint,
        forceNewCharacter: candidate.forceNewCharacter,
        onRequestStart: recordRequestStart,
        onRequestEnd: recordRequestEnd,
        onProgress: (msg) => setAiLog((prev) => [...prev, msg]),
        isCancelled: () => cancelToken.cancelled
      });
      if (cancelToken.cancelled) throw new GenerationCancelled();
      if (inputSignature !== aiInputSignature()) {
        throw new Error("照片或描述已变化，已丢弃本次角色结果，请重新生成");
      }
      const revision = generationTask.characterRevision + 1;
      generationTask = await advanceGenerationTask(
        generationTask,
        "characterReview",
        {
          characterRevision: revision,
          confirmedCharacterRevision: null
        }
      );
      aiCheckpointRef.current = candidate.checkpoint;
      aiCharacterUrlRef.current = character.characterUrl;
      aiCharacterImageRef.current = character.characterImage;
      aiCandidateRef.current = null;
      setAiSampleReview(null);
      setAiUncertain(false);
      setAiCharacterReview((previous) => ({
        image: character.characterImage,
        reference: referencePhoto ?? "",
        revision,
        history: previous ? [...previous.history, previous.image] : [],
        inputSignature
      }));
      setCanResumeAI(false);
    } catch (err) {
      if (generationTask) {
        const unsettled = hasUnsettledReceipts(
          activeGenerationTaskRef.current ?? generationTask
        );
        setAiUncertain(unsettled);
        await advanceGenerationTask(
          generationTask,
          err instanceof GenerationCancelled
            ? "interrupted"
            : unsettled
              ? "uncertain"
              : "failed"
        ).catch(() => {});
      }
      setCanResumeAI(Boolean(aiCheckpointRef.current.referenceUrl));
      if (err instanceof GenerationCancelled) {
        showToast("角色生成已取消，可以稍后重新生成。", "info");
      } else {
        showToast(`角色生成失败：${formatError(err)}`, "error");
      }
    } finally {
      setAiRunning(false);
      setAiCommitting(false);
      aiCancelRef.current = null;
    }
  }

  async function handleRegenerateAICharacter() {
    if (!aiConsent) {
      showToast("请先确认照片用途和可能产生的生成费用", "error");
      return;
    }
    if (aiCancelRef.current || isLoading || !aiCharacterReview) return;
    setAiLog([]);
    setAiUncertain(false);
    const cancelToken = { cancelled: false, committing: false };
    aiCancelRef.current = cancelToken;
    setAiRunning(true);
    let generationTask: GenerationTask | null = activeGenerationTaskRef.current;
    const inputSignature = aiInputSignature();

    try {
      if (!generationTask) throw new Error("当前制作任务已失效，请重新开始");
      generationTask = await advanceGenerationTask(
        generationTask,
        "characterGenerating"
      );
      const candidate = generationCandidate("regenerate");
      const character = await generateCharacter({
        apiKey,
        uploadUrl,
        referencePhoto: referencePhoto ?? "",
        species,
        appearanceNotes,
        checkpoint: candidate.checkpoint,
        forceNewCharacter: candidate.forceNewCharacter,
        onRequestStart: recordRequestStart,
        onRequestEnd: recordRequestEnd,
        onProgress: (msg) => setAiLog((prev) => [...prev, msg]),
        isCancelled: () => cancelToken.cancelled
      });
      if (cancelToken.cancelled) throw new GenerationCancelled();
      if (inputSignature !== aiInputSignature()) {
        throw new Error("照片或描述已变化，已丢弃本次角色结果，请重新生成");
      }
      const revision = generationTask.characterRevision + 1;
      generationTask = await advanceGenerationTask(
        generationTask,
        "characterReview",
        {
          characterRevision: revision,
          confirmedCharacterRevision: null
        }
      );
      aiCheckpointRef.current = candidate.checkpoint;
      aiCharacterUrlRef.current = character.characterUrl;
      aiCharacterImageRef.current = character.characterImage;
      aiCandidateRef.current = null;
      setAiSampleReview(null);
      setAiUncertain(false);
      setAiCharacterReview((previous) => ({
        image: character.characterImage,
        reference: referencePhoto ?? "",
        revision,
        history: previous ? [...previous.history, previous.image] : [],
        inputSignature
      }));
    } catch (err) {
      if (generationTask) {
        const unsettled = hasUnsettledReceipts(
          activeGenerationTaskRef.current ?? generationTask
        );
        setAiUncertain(unsettled);
        await advanceGenerationTask(
          generationTask,
          err instanceof GenerationCancelled
            ? "interrupted"
            : unsettled
              ? "uncertain"
              : "failed"
        ).catch(() => {});
      }
      if (err instanceof GenerationCancelled) {
        showToast("角色重新生成已取消，旧版本仍保留。", "info");
      } else {
        showToast(`角色重新生成失败：${formatError(err)}`, "error");
      }
    } finally {
      setAiRunning(false);
      setAiCommitting(false);
      aiCancelRef.current = null;
    }
  }

  async function handleConfirmAICharacter() {
    if (!aiConsent) {
      showToast("请先确认照片用途和可能产生的生成费用", "error");
      return;
    }
    if (
      !isTauri ||
      aiCancelRef.current ||
      isLoading ||
      !aiCharacterReview ||
      !aiCharacterUrlRef.current
    ) {
      return;
    }
    if (aiCharacterReview.inputSignature !== aiInputSignature()) {
      setAiCharacterReview(null);
      aiCharacterUrlRef.current = "";
      aiCharacterImageRef.current = "";
      aiCandidateRef.current = null;
      showToast("照片或描述已变化，请重新生成并确认角色", "error");
      return;
    }
    await abandonCandidateReceipts();
    setAiLog([]);
    setAiUncertain(false);
    const cancelToken = { cancelled: false, committing: false };
    aiCancelRef.current = cancelToken;
    setAiRunning(true);
    let generationTask: GenerationTask | null = activeGenerationTaskRef.current;
    const inputSignature = aiCharacterReview.inputSignature;

    try {
      if (!generationTask) throw new Error("当前制作任务已失效，请重新开始");
      generationTask = await advanceGenerationTask(
        generationTask,
        "sampleGenerating",
        { confirmedCharacterRevision: aiCharacterReview.revision }
      );
      const sample = await generateIdleSample({
        apiKey,
        uploadUrl,
        referencePhoto: referencePhoto ?? "",
        petName: name,
        species,
        appearanceNotes,
        characterUrl: aiCharacterUrlRef.current,
        characterImage: aiCharacterImageRef.current,
        checkpoint: aiCheckpointRef.current,
        onRequestStart: recordRequestStart,
        onRequestEnd: recordRequestEnd,
        onProgress: (msg) => setAiLog((prev) => [...prev, msg]),
        isCancelled: () => cancelToken.cancelled
      });
      if (cancelToken.cancelled) throw new GenerationCancelled();
      if (inputSignature !== aiInputSignature()) {
        throw new Error("照片或描述已变化，已丢弃本次试动作结果，请重新生成角色");
      }
      generationTask = await advanceGenerationTask(generationTask, "sampleReview");
      setAiUncertain(false);
      setAiSampleReview({ actions: sample.actions, inputSignature });
    } catch (err) {
      if (generationTask) {
        const unsettled = hasUnsettledReceipts(
          activeGenerationTaskRef.current ?? generationTask
        );
        setAiUncertain(unsettled);
        await advanceGenerationTask(
          generationTask,
          err instanceof GenerationCancelled
            ? "interrupted"
            : unsettled
              ? "uncertain"
              : "failed"
        ).catch(() => {});
      }
      setCanResumeAI(Boolean(aiCheckpointRef.current.referenceUrl));
      if (err instanceof GenerationCancelled) {
        showToast("试动作生成已取消，角色确认仍保留，可以再次生成。", "info");
      } else {
        showToast(`试动作生成失败：${formatError(err)}`, "error");
      }
    } finally {
      setAiRunning(false);
      setAiCommitting(false);
      aiCancelRef.current = null;
    }
  }

  async function handleConfirmAISample() {
    if (!aiConsent) {
      showToast("请先确认照片用途和可能产生的生成费用", "error");
      return;
    }
    if (
      !isTauri ||
      aiCancelRef.current ||
      isLoading ||
      !aiSampleReview ||
      !aiCharacterUrlRef.current ||
      !aiCharacterImageRef.current
    ) {
      return;
    }
    if (aiSampleReview.inputSignature !== aiInputSignature()) {
      setAiSampleReview(null);
      aiCharacterUrlRef.current = "";
      aiCharacterImageRef.current = "";
      showToast("照片或描述已变化，请重新生成角色和试动作", "error");
      return;
    }
    setAiLog([]);
    setAiUncertain(false);
    const cancelToken = { cancelled: false, committing: false };
    aiCancelRef.current = cancelToken;
    setAiRunning(true);
    let generationTask: GenerationTask | null = activeGenerationTaskRef.current;
    const inputSignature = aiSampleReview.inputSignature;

    try {
      if (!generationTask) throw new Error("当前制作任务已失效，请重新开始");
      generationTask = await advanceGenerationTask(generationTask, "actionsGenerating");
      const result = await generateRemainingActions({
        apiKey,
        uploadUrl,
        referencePhoto: referencePhoto ?? "",
        petName: name,
        species,
        appearanceNotes,
        characterUrl: aiCharacterUrlRef.current,
        characterImage: aiCharacterImageRef.current,
        checkpoint: aiCheckpointRef.current,
        onRequestStart: recordRequestStart,
        onRequestEnd: recordRequestEnd,
        onProgress: (msg) => setAiLog((prev) => [...prev, msg]),
        isCancelled: () => cancelToken.cancelled
      });
      if (cancelToken.cancelled) throw new GenerationCancelled();
      if (inputSignature !== aiInputSignature()) {
        throw new Error("照片或描述已变化，已丢弃本次动作结果，请重新生成角色");
      }
      let receiptSyncFailed = false;
      try {
        await markReceivedReceiptsSucceeded();
      } catch {
        receiptSyncFailed = true;
        setAiReceiptSyncPending(true);
      }
      generationTask = await advanceGenerationTask(generationTask, "readyToSave");
      cancelToken.committing = true;
      setAiCommitting(true);

      const newPet = createManualPet({
        id: generationTask.pendingPetId,
        name: name.trim() || "AI 宠物",
        species,
        sourceImage: result.characterImage,
        manualFrames: result.actions,
        frameRoot: result.frameRoot,
        storageMode: "preset-root"
      });

      const activation = await activatePet(newPet, true);
      try {
        generationTask = await advanceGenerationTask(generationTask, "committed", {
          committedPetId: newPet.id
        });
      } catch {
        showToast("伙伴已保存，但制作任务状态未能更新；桌面显示不受影响。", "info");
      }
      if (!receiptSyncFailed) {
        await releaseGenerationTask(generationTask.taskId).catch(() => {});
        activeGenerationTaskRef.current = null;
      }
      await refreshGenerationTasks();
      aiCheckpointRef.current = createGenerationCheckpoint();
      aiCharacterUrlRef.current = "";
      aiCharacterImageRef.current = "";
      setAiCharacterReview(null);
      setAiSampleReview(null);
      setCanResumeAI(false);
      announceActivation(activation, `AI 宠物「${newPet.name}」制作完成并已入住桌面！`);
      if (receiptSyncFailed) {
        showToast(
          "伙伴已保存，但制作任务回执待同步；补写只更新元数据，不会重新生成。",
          "info"
        );
      }
      setCurrentTab("stage");
    } catch (err) {
      if (generationTask) {
        const unsettled = hasUnsettledReceipts(
          activeGenerationTaskRef.current ?? generationTask
        );
        setAiUncertain(unsettled);
        await advanceGenerationTask(
          generationTask,
          err instanceof GenerationCancelled
            ? "interrupted"
            : unsettled
              ? "uncertain"
              : "failed"
        ).catch(() => {});
      }
      setCanResumeAI(Boolean(aiCheckpointRef.current.referenceUrl));
      if (err instanceof GenerationCancelled) {
        showToast("其余动作生成已取消，试动作确认仍保留，可以再次生成。", "info");
      } else {
        showToast(`其余动作生成失败：${formatError(err)}`, "error");
      }
    } finally {
      setAiRunning(false);
      setAiCommitting(false);
      aiCancelRef.current = null;
    }
  }

  async function handleSyncGenerationReceipts() {
    try {
      await markReceivedReceiptsSucceeded();
      setAiReceiptSyncPending(false);
      const task = activeGenerationTaskRef.current;
      if (task) {
        await releaseGenerationTask(task.taskId).catch(() => {});
        activeGenerationTaskRef.current = null;
      }
      await refreshGenerationTasks();
      showToast("制作任务回执已补写完成。", "success");
    } catch (err) {
      showToast(`回执补写失败，可稍后重试：${formatError(err)}`, "error");
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
      const result = await activatePet(latest);
      announceActivation(result, `已将「${latest.name}」派往桌面！🐾`);
    } catch (err) { showToast(`切换宠物失败：${formatError(err)}`, "error"); }
  }

  /**
   * A card recall stays on the shelf. When the native companion already
   * matches, only the display intent changes; a mismatch goes through the
   * normal attach/select path so the card can recover the right profile.
   */
  async function handleRecallPet(pet: PetProfile) {
    const nativeMatches = native.snapshot().petId === pet.id;
    if (activePetRef.current?.id === pet.id && nativeMatches) {
      await applyPreference({ kind: "show", expectedPetId: pet.id });
      showToast(`「${pet.name}」回来了。`, "success");
      return;
    }
    const result = await activatePet(pet);
    announceActivation(result, `已把「${pet.name}」带回桌面。`);
  }

  async function handleSnoozePet(pet: PetProfile, minutes: SnoozeMinutes) {
    const next = await applyPreference({
      kind: "snooze",
      durationMinutes: minutes,
      expectedPetId: pet.id
    });
    const until = next?.snoozeUntilMs ?? Date.now() + minutes * 60 * 1000;
    showToast(`「${pet.name}」休息到 ${formatSnoozeTime(until)}，到时自动回来。`, "success");
  }

  async function handleKeepHiddenPet(pet: PetProfile) {
    await applyPreference({ kind: "hide" });
    showToast(`「${pet.name}」已保持收起，休息到期已取消。`, "success");
  }

  async function handleResetPositionPet(pet: PetProfile) {
    await applyPreference({
      kind: "resetPosition",
      expectedPetId: pet.id
    });
    showToast("已把桌面伙伴移回右下角；显示或休息状态没有改变。", "success");
  }

  async function handleRetryDisplayPet(petId: string) {
    if (!displayRetry || displayRetry.petId !== petId) return;
    await retryDisplay(displayRetry);
  }

  function handleShowRecovery() {
    const node = document.querySelector<HTMLElement>(".recovery-notice, .recovery-reopen");
    if (!node) return;
    node.scrollIntoView({ block: "start" });
    node.focus({ preventScroll: true });
  }

  function handleGoToCompanion() {
    setCurrentTab("stage");
  }

  function openWorkshopTask(
    task: Exclude<WorkshopTask, "choose">,
    repairId: string | null = null
  ) {
    setWorkshopTask(task);
    setRepairPetId(repairId);
    setCurrentTab("workshop");
  }

  function openWorkshopChooser(repairId: string | null = null) {
    setWorkshopTask("choose");
    setRepairPetId(repairId);
    setCurrentTab("workshop");
  }

  async function handleRemovePet(pet: PetProfile) {
    const current = activePetRef.current;
    const removingActive = current?.id === pet.id;
    setDisplayRetry((value) => (value?.petId === pet.id ? null : value));
    try {
      if (removingActive) {
        // Check the replacement material before the transaction; a broken
        // replacement must not silently fall back to the default character.
        const all = await loadAllPets();
        const candidate = all
          .filter((entry) => entry.id !== pet.id)
          .sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
          )[0];
        if (candidate) {
          try {
            await ensurePetHydrated(candidate);
          } catch {
            showToast(
              "接替伙伴的素材暂时不可用，请先修复或选择另一只；这次没有移除。",
              "error"
            );
            return;
          }
        }
      }

      await serial(async () => {
        transitioning.current = true;
        try {
          const result = await softRemovePet(pet.id);
          await refreshList();
          let fullNext: PetProfile | null = null;
          if (result.nextActive) {
            try {
              fullNext = await ensurePetHydrated(result.nextActive);
            } catch {
              fullNext = result.nextActive;
            }
            setActivePet(fullNext);
          } else if (removingActive) {
            setActivePet(null);
          }
          setRemovalNotice({
            removalId: result.removed.removalId,
            petId: pet.id,
            petName: pet.name,
            replacementName: fullNext?.name ?? result.nextActive?.name ?? null,
            wasActive: result.removed.wasActive,
            selectionRevision: result.selectionRevision
          });

          if (isTauri && result.removed.wasActive) {
            try {
              if (fullNext?.frameRoot) {
                // Attaching preserves the confirmed hidden/snoozed intent.
                await native.attach(fullNext.frameRoot, fullNext.id, fullNext.name);
                fullNext.currentAction = await syncNativeAction(fullNext.currentAction);
                setActivePet(fullNext);
              } else {
                await native.detach(pet.id);
              }
            } catch (error) {
              const parsed = parseNativeError(error);
              if (parsed.code === "TARGET_CHANGED" && !fullNext) {
                // Already detached, or another window changed the target.
                await native.refresh().catch(() => undefined);
              } else {
                setLocalError({
                  id: `removal-sync-${pet.id}`,
                  petId: pet.id,
                  title: "资料已移除，桌面尚未同步",
                  body: "最近移除和新的伙伴选择已保存。可以重试把桌面同步到最新伙伴。",
                  operation: "set_frame_root",
                  code: "REMOVAL_SYNC_FAILED"
                });
                showToast(`桌面同步失败：${parsed.message}`, "error");
              }
            }
          }
        } finally {
          transitioning.current = false;
        }
      });
    } catch (err) {
      showToast(`移除失败：${formatError(err)}`, "error");
      await refreshList().catch(() => undefined);
    }
  }

  async function handleUndoRemoval(notice: RemovalNotice) {
    try {
      const result = await restoreRemovedPet(
        notice.petId,
        notice.removalId,
        "undo"
      );
      setRemovalNotice(null);
      await refreshList();
      if (result.alreadyRestored) {
        showToast("这位伙伴已经在伙伴架。", "info");
        return;
      }
      if (!result.restoredActive) {
        showToast("已恢复到伙伴架，当前伙伴保持不变。", "info");
        return;
      }
      let full: PetProfile;
      try {
        full = await ensurePetHydrated(result.restored);
      } catch {
        setActivePet(result.restored);
        setLocalError({
          id: `asset-${result.restored.id}`,
          petId: result.restored.id,
          title: `暂时找不到${result.restored.name}的动作素材，资料仍在`,
          body: "已经撤销移除，但素材暂时不可用。可以重试加载，或稍后重新定位素材。",
          operation: "set_frame_root",
          code: "ASSET_NOT_FOUND"
        });
        showToast(
          `已撤销移除，但「${result.restored.name}」的素材暂时不可用。`,
          "info"
        );
        return;
      }
      setActivePet(full);
      if (isTauri && full.frameRoot) {
        try {
          await native.attach(full.frameRoot, full.id, full.name);
        } catch (err) {
          setLocalError({
            id: `removal-sync-${full.id}`,
            petId: full.id,
            title: "已撤销移除，桌面尚未同步",
            body: "资料和活动选择已经恢复。可以重试把桌面同步到最新伙伴。",
            operation: "set_frame_root",
            code: "REMOVAL_SYNC_FAILED"
          });
          showToast(`桌面同步失败：${formatError(err)}`, "error");
          return;
        }
      }
      showToast(`已撤销移除，「${full.name}」重新成为当前伙伴。`, "success");
    } catch (err) {
      setRemovalNotice(null);
      await refreshList().catch(() => undefined);
      showToast(`撤销失败：${formatError(err)}`, "error");
    }
  }

  async function handleRestoreRemoved(
    id: string,
    removalId: string,
    mode: "shelf"
  ) {
    const result = await restoreRemovedPet(id, removalId, mode);
    await refreshList();
    if (result.alreadyRestored) {
      showToast("这位伙伴已经在伙伴架。", "success");
      return;
    }
    let assetWarning = false;
    try {
      await ensurePetHydrated(result.restored);
    } catch {
      assetWarning = true;
    }
    showToast(
      assetWarning
        ? `已把「${result.restored.name}」恢复到伙伴架，但素材暂时不可用，可稍后修复。`
        : `已把「${result.restored.name}」恢复到伙伴架。`,
      assetWarning ? "info" : "success"
    );
  }

  async function handleRetryRemovalSync() {
    const removedId = localError?.petId ?? null;
    try {
      const current = await loadPet();
      if (current?.frameRoot) {
        const full = await ensurePetHydrated(current);
        await native.attach(full.frameRoot!, full.id, full.name);
        setActivePet(full);
      } else {
        await native.detach(removedId);
        setActivePet(null);
      }
      setLocalError(null);
      await refreshList();
      showToast("桌面已同步到最新伙伴。", "success");
    } catch (err) {
      setLocalError({
        id: `removal-sync-${removedId ?? "unknown"}`,
        petId: removedId ?? undefined,
        title: "资料已移除，桌面尚未同步",
        body: "最近移除和新的伙伴选择已保存。可以重试把桌面同步到最新伙伴。",
        operation: "set_frame_root",
        code: "REMOVAL_SYNC_FAILED"
      });
      showToast(`同步失败：${formatError(err)}`, "error");
    }
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
  const assetErrorPetId =
    localError?.code === "ASSET_NOT_FOUND" ? localError.petId ?? null : null;
  const repairPet = repairPetId
    ? pets.find((pet) => pet.id === repairPetId) ??
      (activePet?.id === repairPetId ? activePet : null)
    : null;

  const assetRecovery = {
    title: `暂时找不到${activePet?.name ?? "伙伴"}的动作素材，资料仍在`,
    body: "名字和选择都保留着。可以重试加载，或换一位已有伙伴。",
    operation: "set_frame_root",
    code: "ASSET_NOT_FOUND",
    actions: [
      { label: "重试加载", primary: true, onClick: () => void handleRetryAsset() },
      { label: "选择已有伙伴", onClick: () => setCurrentTab("shelf") },
      {
        label: "修复素材",
        onClick: () =>
          openWorkshopTask("import", assetErrorPetId ?? activePet?.id ?? null)
      }
    ]
  };

  const recovery = (() => {
    if (localError?.code === "REMOVAL_SYNC_FAILED") {
      return {
        id: localError.id,
        title: localError.title,
        body: localError.body,
        operation: localError.operation,
        code: localError.code,
        actions: [
          {
            label: "重试同步",
            primary: true,
            onClick: () => void handleRetryRemovalSync()
          },
          { label: "查看已有伙伴", onClick: () => setCurrentTab("shelf") }
        ]
      };
    }
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
    if (displayRetry) {
      return {
        id: `display-${displayRetry.operationId}`,
        title: "伙伴已保存，但还没有显示到桌面",
        body: `「${displayRetry.petName}」的资料和选择都已保留。重试只会再次发送显示，不会重建资料或素材。`,
        operation: "show",
        code: displayRetry.code,
        actions: [
          {
            label: "重试显示",
            primary: true,
            onClick: () => void retryDisplay(displayRetry)
          },
          { label: "查看已有伙伴", onClick: () => setCurrentTab("shelf") }
        ]
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
          { label: "重试连接", primary: true, onClick: () => void handleRetryConnection() },
          { label: "查看已有伙伴", onClick: () => setCurrentTab("shelf") }
        ]
      };
    }
    if (onboardingError && !onboardingOpen) {
      return {
        id: "onboarding-read",
        title: "引导资料暂时不可用，请重试",
        body: "伙伴资料没有改动。重试成功后再继续领养或使用已有伙伴。",
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
          { label: "打开制作", onClick: () => openWorkshopChooser() }
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
          { label: "重试读取", onClick: () => void handleRetryConnection() }
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
            onSnooze={(minutes) => void handleSnooze(minutes)}
            onKeepHidden={() => void handleKeepHidden()}
            onTogglePaused={() => void handleToggleNativePaused()}
            onToggleAutonomous={() => handleToggleAutonomous(!native.state.autonomous)}
            onOpenSettings={handleOpenSettings}
            onStartAdoption={handleStartAdoption}
            onImportPet={() => openWorkshopTask("import")}
            onRenamePet={handleRenamePet}
          />
        )}

        {currentTab === "workshop" && (
          workshopTask === "choose" ? (
            <WorkshopTaskChooser
              activePetName={activePet?.name}
              repairPetName={repairPet?.name ?? null}
              onSelect={(task) =>
                openWorkshopTask(task, task === "import" ? repairPetId : null)
              }
              onCancelRepair={() => setRepairPetId(null)}
            />
          ) : (
            <>
              <WorkshopTaskHeader
                task={workshopTask}
                repairPetName={repairPet?.name ?? null}
                onBack={() => openWorkshopChooser(repairPetId)}
              />
              {workshopTask === "presets" ? (
                <PresetGallery
                  activePet={activePet}
                  onAdopt={handleStartAdoption}
                  onViewCompanion={() => setCurrentTab("stage")}
                />
              ) : (
                <Workshop
                  task={workshopTask}
                  repairPetName={repairPet?.name ?? null}
                  inspectAction={inspectAction}
                  onInspectActionChange={setInspectAction}
                  name={name}
                  onChangeName={(value) => {
                    draftPausedRef.current = false;
                    suppressNextDraftSaveRef.current = false;
                    draftEditSeqRef.current += 1;
                    setName(value);
                  }}
                  species={species}
                  onChangeSpecies={(value) => {
                    draftPausedRef.current = false;
                    suppressNextDraftSaveRef.current = false;
                    draftEditSeqRef.current += 1;
                    setSpecies(value);
                  }}
                  presetDir={presetFrameDir}
                  onChangePresetDir={(value) => {
                    inspectionRequestRef.current += 1;
                    setPresetFrameDir(value);
                    setFrameInspection(null);
                    setInspectingFrames(false);
                  }}
                  onImportPreset={handleImportPreset}
                  frameInspection={frameInspection}
                  inspectingFrames={inspectingFrames}
                  onInspectFrames={handleInspectFrames}
                  onChoosePresetDir={handleChooseFrameDir}
                  onImportPetPackage={handleImportPetPackage}
                  keepExternalReference={keepExternalReference}
                  onChangeKeepExternalReference={setKeepExternalReference}
                  manualFrames={manualFrames}
                  onChangeManualFrames={(frames) => {
                    draftPausedRef.current = false;
                    suppressNextDraftSaveRef.current = false;
                    draftEditSeqRef.current += 1;
                    setManualFrames(frames);
                  }}
                  onSaveManualFrames={handleSaveManualFrames}
                  draftStatus={draftStatus}
                  draftLoading={draftLoading}
                  onSaveDraft={() => void persistAssemblyDraft()}
                  onDiscardDraft={() => void handleDiscardDraft()}
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
                  aiConsent={aiConsent}
                  onChangeAiConsent={setAiConsent}
                  generationTasks={generationTasks}
                  onResumeGenerationTask={handleResumeGenerationTask}
                  aiCharacterReview={aiCharacterReview}
                  aiSampleReview={aiSampleReview}
                  aiUncertain={aiUncertain}
                  aiReceiptSyncPending={aiReceiptSyncPending}
                  onSyncGenerationReceipts={handleSyncGenerationReceipts}
                  onConfirmAICharacter={handleConfirmAICharacter}
                  onConfirmAISample={handleConfirmAISample}
                  onRegenerateAICharacter={handleRegenerateAICharacter}
                  onGenerateAI={handleGenerateAI}
                  onCancelAI={handleCancelAI}
                />
              )}
            </>
          )
        )}

        {onboardingOpen && onboarding && (
          <Onboarding
            record={onboarding}
            pet={activePet}
            isTauri={isTauri}
            busy={onboardingBusy}
            starting={startingAdoption}
            error={onboardingError}
            displayPending={adoptionDisplayPending}
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
            onPracticeDesktop={() => void handlePracticeDesktop()}
          />
        )}

        {currentTab === "shelf" && (
          <PetShelf
            pets={pets}
            activePetId={activePet?.id ?? null}
            nativeState={native.state}
            displayRetryPetId={displayRetry?.petId ?? null}
            assetErrorPetId={assetErrorPetId}
            hasRecovery={Boolean(recovery)}
            removedPets={removedPets}
            onDeployPet={handleDeployPet}
            onRemovePet={handleRemovePet}
            onManagePet={handleManagePetAsset}
            onExportPet={handleExportPetPackage}
            onRelocatePet={handleRelocatePet}
            onRestoreRemoved={handleRestoreRemoved}
            onRenamePet={handleRenamePet}
            onRecallPet={handleRecallPet}
            onSnoozePet={handleSnoozePet}
            onKeepHiddenPet={handleKeepHiddenPet}
            onRetryDisplayPet={handleRetryDisplayPet}
            onRetryAssetPet={handleRetryAssetPet}
            onResetPositionPet={handleResetPositionPet}
            onShowRecovery={handleShowRecovery}
            onGoToCompanion={handleGoToCompanion}
            onStartAdoption={handleStartAdoption}
            onCreatePet={() => openWorkshopChooser()}
            onImportPet={() => openWorkshopTask("import")}
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
            onPracticeDesktop={() => void handlePracticeDesktop()}
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
      {removalNotice && (
        <RemovalUndo
          notice={removalNotice}
          onUndo={() => void handleUndoRemoval(removalNotice)}
          onDismiss={() => setRemovalNotice(null)}
        />
      )}
    </div>
  );
}

function cloneGenerationCheckpoint(
  checkpoint: ReturnType<typeof createGenerationCheckpoint>
): ReturnType<typeof createGenerationCheckpoint> {
  return JSON.parse(JSON.stringify(checkpoint)) as ReturnType<typeof createGenerationCheckpoint>;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  storageMode = "embedded",
  assetMode,
  assetId,
  createdAt
}: {
  id?: string;
  name: string;
  species: PetSpecies;
  sourceImage: string;
  manualFrames: Partial<ActionFrameSet>;
  frameRoot?: string;
  storageMode?: PetProfile["storageMode"];
  assetMode?: PetProfile["assetMode"];
  assetId?: string;
  createdAt?: string;
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
    assetMode,
    assetId,
    frameRoot,
    createdAt: createdAt ?? new Date().toISOString(),
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

/**
 * A storage outage keeps the local draft and says so. Only an intent or
 * version conflict re-reads the persisted adoption and replaces the form.
 */
function onboardingSaveFailure(error: unknown): {
  message: string;
  refresh: boolean;
} {
  if (error instanceof OnboardingProgressError) {
    return {
      refresh: true,
      message:
        error.code === "INTENT_CHANGED"
          ? "领养已更新，已读取最新结果；刚才的输入没有写入旧记录。"
          : "这次进度已过期，已读取最新领养结果。"
    };
  }
  return {
    refresh: false,
    message: `资料暂时没能保存，输入还在：${formatError(error)}`
  };
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <StudioApp />
    </ToastProvider>
  </React.StrictMode>
);
