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
  return {
    signature: "",
    referenceUrl: undefined,
    characterRaw: undefined,
    characterImage: undefined,
    characterUrl: undefined,
    sheets: {},
    rawFrames: emptyActions(),
    cleanedFrames: emptyActions(),
    actions: emptyActions(),
    frameRoot: undefined
  };
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
export interface GenerateCharacterOptions extends Omit<GenerateFramePackOptions, "petName"> {
  petName?: string;
  forceNewCharacter?: boolean;
}
export interface GeneratedCharacter {
  referenceUrl: string;
  characterImage: string;
  characterUrl: string;
}
export interface GeneratedFramePack { actions: ActionFrameSet; characterImage: string; frameRoot: string }
export interface GenerateActionPackOptions
  extends GenerateFramePackOptions,
    Omit<GeneratedCharacter, "referenceUrl"> {
  referenceUrl?: string;
  actionIds?: PetAction[];
  save?: boolean;
}
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

function validateBase(options: GenerateFramePackOptions) {
  const apiKey = options.apiKey.trim(), uploadUrl = options.uploadUrl.trim();
  if (!apiKey) throw new Error("请填写 Minimax API Key");
  if (!uploadUrl) throw new Error("请填写参考图上传服务地址");
  if (!options.referencePhoto) throw new Error("请先选择宠物照片");
  return { apiKey, uploadUrl };
}

function signatureFor(options: GenerateFramePackOptions) {
  const mode = options.mode ?? "sheet";
  const transparent = options.removeBackground ?? true;
  return JSON.stringify([
    options.uploadUrl,
    options.referencePhoto,
    options.species,
    options.appearanceNotes,
    mode,
    transparent
  ]);
}

function ensureCheckpoint(options: GenerateFramePackOptions) {
  const state = options.checkpoint ?? createGenerationCheckpoint();
  const signature = signatureFor(options);
  if (state.signature !== signature) {
    Object.assign(state, createGenerationCheckpoint(), { signature });
  }
  return state;
}

function contextFor(options: GenerateFramePackOptions, url: string) {
  return {
    species: options.species,
    petName: options.petName,
    appearanceNotes: options.appearanceNotes,
    referenceImageUrl: url,
    characterReferenceUrl: url,
    background: (options.removeBackground ?? true) ? "green" as const : "neutral" as const
  };
}

async function cleanImage(options: GenerateFramePackOptions, image: string) {
  ensureNotCancelled(options.isCancelled);
  const cleaned = (options.removeBackground ?? true)
    ? await removeBackgroundFromDataUrl(image)
    : image;
  ensureNotCancelled(options.isCancelled);
  return cleaned;
}

async function waitFrame(options: GenerateFramePackOptions) {
  ensureNotCancelled(options.isCancelled);
  if ((options.frameDelayMs ?? 200) > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.frameDelayMs ?? 200));
  }
  ensureNotCancelled(options.isCancelled);
}

export async function generateCharacter(options: GenerateCharacterOptions): Promise<GeneratedCharacter> {
  const { apiKey, uploadUrl } = validateBase(options as GenerateFramePackOptions);
  const progress = (message: string) => options.onProgress?.(message);
  const state = ensureCheckpoint(options as GenerateFramePackOptions);
  if (options.forceNewCharacter) {
    state.characterRaw = undefined;
    state.characterImage = undefined;
    state.characterUrl = undefined;
    state.sheets = {};
    state.rawFrames = emptyActions();
    state.cleanedFrames = emptyActions();
    state.actions = emptyActions();
    state.frameRoot = undefined;
  }
  ensureNotCancelled(options.isCancelled);
  if (!state.referenceUrl) {
    progress("上传参考照片...");
    state.referenceUrl = await uploadImage(
      uploadUrl,
      options.referencePhoto,
      `pet-reference-${Date.now()}.${extensionForDataUrl(options.referencePhoto)}`
    );
  } else {
    progress("复用已上传的参考照片...");
  }
  ensureNotCancelled(options.isCancelled);
  if (!state.characterRaw) {
    progress("生成角色设定图...");
    state.characterRaw = await generateImage(
      apiKey,
      buildCharacterPrompt(contextFor(options as GenerateFramePackOptions, state.referenceUrl)),
      state.referenceUrl
    );
  }
  ensureNotCancelled(options.isCancelled);
  if (!state.characterImage) {
    progress("处理并检查角色设定图...");
    try {
      state.characterImage = (
        await normalizeActionFrames(
          [await cleanImage(options as GenerateFramePackOptions, state.characterRaw)],
          "idle",
          options.removeBackground ?? true
        )
      )[0];
    } catch (error) {
      if (error instanceof FrameQualityError) state.characterRaw = undefined;
      throw error;
    }
  }
  ensureNotCancelled(options.isCancelled);
  if (!state.characterUrl) {
    progress("上传角色设定图，供动作帧引用...");
    state.characterUrl = await uploadImage(
      uploadUrl,
      state.characterImage,
      `pet-character-${Date.now()}.png`
    );
  }
  ensureNotCancelled(options.isCancelled);
  return {
    referenceUrl: state.referenceUrl,
    characterImage: state.characterImage,
    characterUrl: state.characterUrl
  };
}

export async function generateActionPack(
  options: GenerateActionPackOptions
): Promise<GeneratedFramePack> {
  const { apiKey, uploadUrl } = validateBase(options);
  const progress = (message: string) => options.onProgress?.(message);
  const state = ensureCheckpoint(options);
  if (state.signature !== signatureFor(options)) {
    throw new Error("角色版本已变化，请重新确认角色");
  }
  if (!options.characterUrl) throw new Error("请先生成并确认角色");
  if (state.characterUrl && state.characterUrl !== options.characterUrl) {
    throw new Error("角色版本已变化，请重新确认角色");
  }
  state.characterUrl = options.characterUrl;
  state.characterImage = options.characterImage;
  const mode = options.mode ?? "sheet";
  const transparent = options.removeBackground ?? true;
  ensureNotCancelled(options.isCancelled);
  const requested = new Set(options.actionIds ?? PET_ACTIONS.map(({ id }) => id));
  for (const { id } of PET_ACTIONS.filter(({ id }) => requested.has(id))) {
    if (state.actions[id].length === FRAMES_PER_ACTION) continue;
    try {
      const cleaned = state.cleanedFrames[id];
      if (mode === "sheet") {
        if (!state.sheets[id]) {
          ensureNotCancelled(options.isCancelled);
          progress(`生成「${actionLabel(id)}」动作序列图...`);
          state.sheets[id] = await generateImage(
            apiKey,
            buildSpriteSheetPrompt(contextFor(options, state.characterUrl), id),
            state.characterUrl,
            "3:2"
          );
        }
        ensureNotCancelled(options.isCancelled);
        const cells = await sliceSpriteSheet(state.sheets[id]!);
        if (cells.length !== FRAMES_PER_ACTION) throw new FrameQualityError("动作序列图拆分数量不正确");
        for (let index = cleaned.length; index < FRAMES_PER_ACTION; index += 1) {
          cleaned.push(await cleanImage(options, cells[index]));
        }
      } else {
        for (let index = cleaned.length; index < FRAMES_PER_ACTION; index += 1) {
          ensureNotCancelled(options.isCancelled);
          progress(`生成「${actionLabel(id)}」帧 ${index + 1}/${FRAMES_PER_ACTION}...`);
          if (!state.rawFrames[id][index]) {
            state.rawFrames[id][index] = await generateImage(
              apiKey,
              buildActionPrompt(contextFor(options, state.characterUrl), id, index),
              state.characterUrl
            );
          }
          ensureNotCancelled(options.isCancelled);
          cleaned.push(await cleanImage(options, state.rawFrames[id][index]));
          await waitFrame(options);
        }
      }
      ensureNotCancelled(options.isCancelled);
      state.actions[id] = await normalizeActionFrames(cleaned, id, transparent);
      ensureNotCancelled(options.isCancelled);
      state.cleanedFrames[id] = [];
      state.rawFrames[id] = [];
      delete state.sheets[id];
      progress(`已完成并检查「${actionLabel(id)}」${FRAMES_PER_ACTION} 帧。`);
      await waitFrame(options);
    } catch (error) {
      if (error instanceof FrameQualityError) {
        state.cleanedFrames[id] = [];
        state.rawFrames[id] = [];
        delete state.sheets[id];
        state.actions[id] = [];
      }
      throw error;
    }
  }
  ensureNotCancelled(options.isCancelled);
  if (options.save === false) {
    return {
      actions: state.actions,
      characterImage: options.characterImage,
      frameRoot: state.frameRoot ?? ""
    };
  }
  if (!state.frameRoot) {
    progress("写入本地帧包...");
    const saved = await invoke<SavedManualFramePack>("save_manual_frame_pack", {
      request: { actions: state.actions }
    });
    state.frameRoot = saved.frameRoot;
  }
  ensureNotCancelled(options.isCancelled);
  return {
    actions: state.actions,
    characterImage: options.characterImage,
    frameRoot: state.frameRoot
  };
}

export async function generateIdleSample(
  options: GenerateActionPackOptions
): Promise<GeneratedFramePack> {
  return generateActionPack({ ...options, actionIds: ["idle"], save: false });
}

export async function generateRemainingActions(
  options: GenerateActionPackOptions
): Promise<GeneratedFramePack> {
  return generateActionPack({
    ...options,
    actionIds: ["sit", "sleep", "happy", "walk", "jump"],
    save: true
  });
}

/** Legacy one-shot flow used by non-staged callers. */
export async function generatePetFramePack(options: GenerateFramePackOptions): Promise<GeneratedFramePack> {
  const character = await generateCharacter(options);
  return generateActionPack({ ...options, ...character });
}
