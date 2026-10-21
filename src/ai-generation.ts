import { invoke } from "@tauri-apps/api/core";
import { buildActionPrompt, buildCharacterPrompt, buildSpriteSheetPrompt, FRAMES_PER_ACTION, actionLabel } from "./prompt-builder";
import { removeBackgroundFromDataUrl } from "./background-removal";
import { sliceSpriteSheet } from "./sprite-sheet";
import { FrameQualityError, normalizeActionFrames } from "./frame-quality";
import { PET_ACTIONS, type ActionFrameSet, type PetAction, type PetSpecies } from "./types";

interface SavedManualFramePack { frameRoot: string; sourceImage: string }
const emptyActions = (): ActionFrameSet => ({ idle: [], sit: [], sleep: [], happy: [], walk: [], jump: [] });

/** Session-only working data; contains no API key and is never sent to a logger. */
export interface GenerationCheckpoint {
  signature: string;
  referenceUrl?: string;
  characterRaw?: string;
  characterImage?: string;
  characterUrl?: string;
  sheets: Partial<Record<PetAction, string>>;
  rawFrames: ActionFrameSet;
  cleanedFrames: ActionFrameSet;
  actions: ActionFrameSet;
  frameRoot?: string;
}
export function createGenerationCheckpoint(): GenerationCheckpoint {
  return { signature: "", sheets: {}, rawFrames: emptyActions(), cleanedFrames: emptyActions(), actions: emptyActions() };
}
export interface GenerateFramePackOptions {
  apiKey: string; uploadUrl: string; referencePhoto: string; petName: string; species: PetSpecies;
  appearanceNotes?: string;
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
  frameDelayMs?: number;
  removeBackground?: boolean;
  mode?: "sheet" | "frames";
  checkpoint?: GenerationCheckpoint;
}
export interface GeneratedFramePack { actions: ActionFrameSet; characterImage: string; frameRoot: string }
export class GenerationCancelled extends Error {
  constructor() { super("生成已取消"); this.name = "GenerationCancelled"; }
}
function ensureNotCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) throw new GenerationCancelled();
}
function extensionForDataUrl(dataUrl: string) {
  const mime = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? "image/png";
  return mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
}
async function uploadImage(uploadUrl: string, dataUrl: string, filename: string) {
  return invoke<string>("upload_reference_image", { request: { uploadUrl, dataUrl, filename } });
}
async function generateImage(apiKey: string, prompt: string, referenceImageUrl: string, aspectRatio: "1:1" | "3:2" = "1:1") {
  const image = await invoke<string>("generate_minimax_image", {
    request: { apiKey, model: "image-01", prompt, referenceImageUrl, aspectRatio }
  });
  if (!image) throw new Error("Minimax 没有返回图片");
  return image;
}

export async function generatePetFramePack(options: GenerateFramePackOptions): Promise<GeneratedFramePack> {
  const apiKey = options.apiKey.trim(), uploadUrl = options.uploadUrl.trim();
  if (!apiKey) throw new Error("请填写 Minimax API Key");
  if (!uploadUrl) throw new Error("请填写参考图上传服务地址");
  if (!options.referencePhoto) throw new Error("请先选择宠物照片");
  const check = () => ensureNotCancelled(options.isCancelled);
  const progress = (message: string) => options.onProgress?.(message);
  const mode = options.mode ?? "sheet", transparent = options.removeBackground ?? true;
  const state = options.checkpoint ?? createGenerationCheckpoint();
  const signature = JSON.stringify([uploadUrl, options.referencePhoto, options.petName, options.species, options.appearanceNotes, mode, transparent]);
  if (state.signature !== signature) {
    Object.assign(state, createGenerationCheckpoint(), { signature, referenceUrl: undefined,
      characterRaw: undefined, characterImage: undefined, characterUrl: undefined, frameRoot: undefined });
  }
  const context = (url: string) => ({ species: options.species, petName: options.petName,
    appearanceNotes: options.appearanceNotes, referenceImageUrl: url, characterReferenceUrl: url,
    background: transparent ? "green" as const : "neutral" as const });
  const clean = async (image: string) => {
    check();
    // A failed local cleanup is visible and retryable; never silently save the original green screen.
    const cleaned = transparent ? await removeBackgroundFromDataUrl(image) : image;
    check();
    return cleaned;
  };
  const wait = async () => {
    check();
    if ((options.frameDelayMs ?? 200) > 0) await new Promise(r => setTimeout(r, options.frameDelayMs ?? 200));
    check();
  };
  check();
  if (!state.referenceUrl) {
    progress("上传参考照片...");
    state.referenceUrl = await uploadImage(uploadUrl, options.referencePhoto, `pet-reference-${Date.now()}.${extensionForDataUrl(options.referencePhoto)}`);
  } else { progress("继续上次生成，复用已完成的图片..."); }
  check();
  if (!state.characterRaw) {
    progress("生成角色设定图...");
    state.characterRaw = await generateImage(apiKey, buildCharacterPrompt(context(state.referenceUrl)), state.referenceUrl);
  }
  check();
  if (!state.characterImage) {
    progress("处理并检查角色设定图...");
    try {
      state.characterImage = (await normalizeActionFrames([await clean(state.characterRaw)], "idle", transparent))[0];
    } catch (error) {
      if (error instanceof FrameQualityError) state.characterRaw = undefined;
      throw error;
    }
  }
  check();
  if (!state.characterUrl) {
    progress("上传角色设定图，供动作帧引用...");
    state.characterUrl = await uploadImage(uploadUrl, state.characterImage, `pet-character-${Date.now()}.png`);
  }
  check();
  for (const { id } of PET_ACTIONS) {
    if (state.actions[id].length === FRAMES_PER_ACTION) continue;
    try {
      const cleaned = state.cleanedFrames[id];
      if (mode === "sheet") {
        if (!state.sheets[id]) {
          check(); progress(`生成「${actionLabel(id)}」动作序列图...`);
          state.sheets[id] = await generateImage(apiKey, buildSpriteSheetPrompt(context(state.characterUrl), id), state.characterUrl, "3:2");
        }
        check();
        const cells = await sliceSpriteSheet(state.sheets[id]!);
        if (cells.length !== FRAMES_PER_ACTION) throw new FrameQualityError("动作序列图拆分数量不正确");
        for (let i = cleaned.length; i < FRAMES_PER_ACTION; i++) cleaned.push(await clean(cells[i]));
      } else {
        for (let i = cleaned.length; i < FRAMES_PER_ACTION; i++) {
          check(); progress(`生成「${actionLabel(id)}」帧 ${i + 1}/${FRAMES_PER_ACTION}...`);
          if (!state.rawFrames[id][i]) state.rawFrames[id][i] = await generateImage(apiKey, buildActionPrompt(context(state.characterUrl), id, i), state.characterUrl);
          check();
          cleaned.push(await clean(state.rawFrames[id][i]));
          await wait();
        }
      }
      check();
      state.actions[id] = await normalizeActionFrames(cleaned, id, transparent);
      check();
      state.cleanedFrames[id] = []; state.rawFrames[id] = []; delete state.sheets[id];
      progress(`已完成并检查「${actionLabel(id)}」${FRAMES_PER_ACTION} 帧。`);
      await wait();
    } catch (error) {
      // Retry only the rejected action; keep completed actions and the character reference.
      if (error instanceof FrameQualityError) {
        state.cleanedFrames[id] = []; state.rawFrames[id] = []; delete state.sheets[id]; state.actions[id] = [];
      }
      throw error;
    }
  }
  check();
  if (!state.frameRoot) {
    progress("写入本地帧包...");
    const saved = await invoke<SavedManualFramePack>("save_manual_frame_pack", { request: { actions: state.actions } });
    state.frameRoot = saved.frameRoot;
  }
  check();
  return { actions: state.actions, characterImage: state.characterImage, frameRoot: state.frameRoot };
}
