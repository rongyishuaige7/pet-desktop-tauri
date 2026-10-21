import { invoke } from "@tauri-apps/api/core";
import { buildActionPrompt, buildCharacterPrompt, FRAMES_PER_ACTION, actionLabel } from "./prompt-builder";
import { PET_ACTIONS, type ActionFrameSet, type PetAction, type PetSpecies } from "./types";

interface SavedManualFramePack {
  frameRoot: string;
  sourceImage: string;
}

export interface GenerateFramePackOptions {
  apiKey: string;
  uploadUrl: string;
  referencePhoto: string;
  petName: string;
  species: PetSpecies;
  appearanceNotes?: string;
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
  frameDelayMs?: number;
}

export interface GeneratedFramePack {
  actions: ActionFrameSet;
  characterImage: string;
  frameRoot: string;
}

export class GenerationCancelled extends Error {
  constructor() {
    super("生成已取消");
    this.name = "GenerationCancelled";
  }
}

function ensureNotCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) throw new GenerationCancelled();
}

function extensionForDataUrl(dataUrl: string) {
  const mime = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? "image/png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

async function uploadImage(uploadUrl: string, dataUrl: string, filename: string) {
  return invoke<string>("upload_reference_image", {
    request: {
      uploadUrl,
      dataUrl,
      filename
    }
  });
}

async function generateImage(apiKey: string, prompt: string, referenceImageUrl: string) {
  const image = await invoke<string>("generate_minimax_image", {
    request: {
      apiKey,
      model: "image-01",
      prompt,
      referenceImageUrl
    }
  });

  if (!image) throw new Error("Minimax 没有返回图片");
  return image;
}

export async function generatePetFramePack(options: GenerateFramePackOptions): Promise<GeneratedFramePack> {
  const apiKey = options.apiKey.trim();
  const uploadUrl = options.uploadUrl.trim();
  if (!apiKey) throw new Error("请填写 Minimax API Key");
  if (!uploadUrl) throw new Error("请填写参考图上传服务地址");
  if (!options.referencePhoto) throw new Error("请先选择宠物照片");

  const progress = (message: string) => options.onProgress?.(message);
  ensureNotCancelled(options.isCancelled);

  progress("上传参考照片...");
  const referenceUrl = await uploadImage(
    uploadUrl,
    options.referencePhoto,
    `pet-reference-${Date.now()}.${extensionForDataUrl(options.referencePhoto)}`
  );

  ensureNotCancelled(options.isCancelled);
  progress("生成角色设定图...");
  const characterImage = await generateImage(
    apiKey,
    buildCharacterPrompt({
      species: options.species,
      petName: options.petName,
      referenceImageUrl: referenceUrl,
      characterReferenceUrl: referenceUrl,
      appearanceNotes: options.appearanceNotes
    }),
    referenceUrl
  );

  ensureNotCancelled(options.isCancelled);
  progress("上传角色设定图，供动作帧引用...");
  const characterUrl = await uploadImage(
    uploadUrl,
    characterImage,
    `pet-character-${Date.now()}.${extensionForDataUrl(characterImage)}`
  );

  const actions: ActionFrameSet = {
    idle: [],
    sit: [],
    sleep: [],
    happy: [],
    walk: [],
    jump: []
  };
  const totalFrames = PET_ACTIONS.length * FRAMES_PER_ACTION;
  let completedFrames = 0;

  for (const action of PET_ACTIONS) {
    const frames: string[] = [];
    for (let frameIndex = 0; frameIndex < FRAMES_PER_ACTION; frameIndex++) {
      ensureNotCancelled(options.isCancelled);
      progress(
        `生成「${actionLabel(action.id)}」帧 ${frameIndex + 1}/${FRAMES_PER_ACTION}（总计 ${
          completedFrames + 1
        }/${totalFrames}）...`
      );

      const image = await generateImage(
        apiKey,
        buildActionPrompt(
          {
            species: options.species,
            petName: options.petName,
            referenceImageUrl: characterUrl,
            characterReferenceUrl: characterUrl,
            appearanceNotes: options.appearanceNotes
          },
          action.id,
          frameIndex
        ),
        characterUrl
      );
      frames.push(image);
      completedFrames += 1;

      // Keep the API calls sequential and leave a little room for rate limits.
      const delay = options.frameDelayMs ?? 200;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    actions[action.id] = frames;
  }

  ensureNotCancelled(options.isCancelled);
  progress("写入本地帧包...");
  const saved = await invoke<SavedManualFramePack>("save_manual_frame_pack", {
    request: { actions }
  });

  return {
    actions,
    characterImage,
    frameRoot: saved.frameRoot
  };
}
