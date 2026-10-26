import { invoke } from "@tauri-apps/api/core";

export interface GenerationActionState {
  status: string;
  version: number;
  frames: number;
}

export interface GenerationReceipt {
  attemptId: string;
  action: string;
  startedAt: string;
  status: string;
}

export interface GenerationTask {
  schemaVersion: number;
  taskId: string;
  revision: number;
  ownerSession: string | null;
  stage: string;
  pendingPetId: string;
  photoDigest: string;
  species: "cat" | "dog";
  appearanceNotes: string;
  promptVersion: string;
  characterRevision: number;
  confirmedCharacterRevision: number | null;
  actions: Record<string, GenerationActionState>;
  receipts: GenerationReceipt[];
  committedPetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationTaskSummary {
  taskId: string;
  revision: number;
  stage: string;
  pendingPetId: string;
  species: "cat" | "dog";
  completedActions: number;
  updatedAt: string;
}

export interface ClaimGenerationTaskResult {
  status: "claimed" | "interrupted";
  task: GenerationTask;
}

export const generationSessionId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `session-${Date.now()}`;

export function listGenerationTasks() {
  return invoke<GenerationTaskSummary[]>("list_generation_tasks");
}

export function createGenerationTask(task: GenerationTask) {
  return invoke<GenerationTask>("create_generation_task", { task });
}

export function loadGenerationTask(taskId: string) {
  return invoke<GenerationTask>("load_generation_task", { taskId });
}

export function updateGenerationTask(
  task: GenerationTask,
  expectedRevision: number,
  ownerSession = generationSessionId
) {
  return invoke<GenerationTask>("update_generation_task", {
    task,
    expectedRevision,
    ownerSession
  });
}

export function claimGenerationTask(taskId: string, resume = false) {
  return invoke<ClaimGenerationTaskResult>("claim_generation_task", {
    taskId,
    ownerSession: generationSessionId,
    resume
  });
}

export function releaseGenerationTask(taskId: string) {
  return invoke("release_generation_task", {
    taskId,
    ownerSession: generationSessionId
  });
}

export const GENERATION_STAGE_LABELS: Record<string, string> = {
  draft: "等待开始",
  characterGenerating: "正在生成角色",
  characterReview: "等待确认角色",
  sampleGenerating: "正在生成试动作",
  sampleReview: "等待确认试动作",
  actionsGenerating: "正在生成动作",
  readyToSave: "等待保存",
  committing: "正在保存",
  committed: "已完成",
  interrupted: "上次制作未完成",
  failed: "制作失败",
  uncertain: "上次请求待确认"
};
