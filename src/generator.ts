import { invoke } from "@tauri-apps/api/core";
import { PET_ACTIONS, type ActionFrameSet, type PetAction, type PetProfile, type PetSpecies } from "./types";

interface GenerateInput {
  name: string;
  species: PetSpecies;
  sourceImage: string;
  provider?: "local" | "minimax";
  minimaxApiKey?: string;
  minimaxModel?: "image-01" | "image-01-live";
  referenceImageUrl?: string;
  uploadEndpoint?: string;
  minimaxMode?: "character" | "per-action";
  appearanceNotes?: string;
}

interface FramePose {
  y: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  accent: "none" | "heart" | "spark" | "zzz" | "paws";
}

const actionPoses: Record<PetAction, FramePose[]> = {
  idle: [
    { y: 0, scaleX: 1, scaleY: 1, rotate: -1, accent: "spark" },
    { y: -3, scaleX: 0.995, scaleY: 1.005, rotate: 0, accent: "none" },
    { y: -6, scaleX: 0.99, scaleY: 1.01, rotate: 1, accent: "spark" },
    { y: -3, scaleX: 0.995, scaleY: 1.005, rotate: 0, accent: "none" }
  ],
  sit: [
    { y: 7, scaleX: 1.015, scaleY: 0.985, rotate: -1, accent: "none" },
    { y: 10, scaleX: 1.025, scaleY: 0.975, rotate: 0, accent: "spark" },
    { y: 8, scaleX: 1.018, scaleY: 0.982, rotate: 1, accent: "none" },
    { y: 10, scaleX: 1.025, scaleY: 0.975, rotate: 0, accent: "spark" }
  ],
  sleep: [
    { y: 8, scaleX: 1.02, scaleY: 0.98, rotate: -2, accent: "zzz" },
    { y: 10, scaleX: 1.025, scaleY: 0.975, rotate: -2.5, accent: "zzz" },
    { y: 8, scaleX: 1.02, scaleY: 0.98, rotate: -2, accent: "zzz" },
    { y: 9, scaleX: 1.022, scaleY: 0.978, rotate: -1.5, accent: "none" }
  ],
  happy: [
    { y: 1, scaleX: 1, scaleY: 1, rotate: -3, accent: "heart" },
    { y: -14, scaleX: 0.975, scaleY: 1.035, rotate: 4, accent: "spark" },
    { y: 3, scaleX: 1.025, scaleY: 0.975, rotate: -2, accent: "heart" },
    { y: -9, scaleX: 0.99, scaleY: 1.02, rotate: 3, accent: "spark" }
  ],
  walk: [
    { y: 3, scaleX: 1.01, scaleY: 0.99, rotate: -4, accent: "paws" },
    { y: -2, scaleX: 0.995, scaleY: 1.005, rotate: 3, accent: "none" },
    { y: 3, scaleX: 1.01, scaleY: 0.99, rotate: 4, accent: "paws" },
    { y: -2, scaleX: 0.995, scaleY: 1.005, rotate: -3, accent: "none" }
  ],
  jump: [
    { y: 10, scaleX: 1.025, scaleY: 0.975, rotate: 0, accent: "none" },
    { y: -24, scaleX: 0.965, scaleY: 1.045, rotate: -5, accent: "spark" },
    { y: -42, scaleX: 0.97, scaleY: 1.04, rotate: 6, accent: "heart" },
    { y: 12, scaleX: 1.035, scaleY: 0.965, rotate: 0, accent: "paws" }
  ]
};

export async function generateStickerPet(input: GenerateInput): Promise<PetProfile> {
  const keyImages =
    input.provider === "minimax" ? await generateMinimaxKeyImages(input) : await generateLocalKeyImages(input.sourceImage);

  const actions = {} as ActionFrameSet;

  for (const action of PET_ACTIONS) {
    const image = keyImages[action.id];
    actions[action.id] = actionPoses[action.id].map((pose, frameIndex) =>
      renderFrame(image, input.species, action.id, pose, frameIndex)
    );
    await waitForPaint();
  }

  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || (input.species === "cat" ? "小猫" : "小狗"),
    species: input.species,
    style: "q-sticker",
    createdAt: new Date().toISOString(),
    sourceImage: input.sourceImage,
    actions,
    currentAction: "idle",
    actionStartedAt: new Date().toISOString(),
    scale: 1
  };
}

async function generateLocalKeyImages(sourceImage: string) {
  const image = await loadImage(sourceImage);
  return Object.fromEntries(PET_ACTIONS.map((action) => [action.id, image])) as Record<PetAction, HTMLImageElement>;
}

async function generateMinimaxKeyImages(input: GenerateInput) {
  const referenceImageUrl = await resolveReferenceImageUrl(input);

  if (input.minimaxMode !== "per-action") {
    const generatedImage = await invoke<string>("generate_minimax_image", {
      request: {
        apiKey: input.minimaxApiKey,
        model: input.minimaxModel ?? "image-01",
        prompt: buildMinimaxPrompt(input.species, "idle", input.appearanceNotes),
        referenceImageUrl
      }
    });
    const image = await loadImage(generatedImage);
    return Object.fromEntries(PET_ACTIONS.map((action) => [action.id, image])) as Record<PetAction, HTMLImageElement>;
  }

  const entries: Array<[PetAction, HTMLImageElement]> = [];

  for (const action of PET_ACTIONS) {
    const prompt = buildMinimaxPrompt(input.species, action.id, input.appearanceNotes);
    const generatedImage = await invoke<string>("generate_minimax_image", {
      request: {
        apiKey: input.minimaxApiKey,
        model: input.minimaxModel ?? "image-01",
        prompt,
        referenceImageUrl
      }
    });
    entries.push([action.id, await loadImage(generatedImage)]);
    await delay(12_000);
  }

  return Object.fromEntries(entries) as Record<PetAction, HTMLImageElement>;
}

async function resolveReferenceImageUrl(input: GenerateInput) {
  const explicitUrl = input.referenceImageUrl?.trim();
  if (explicitUrl) return explicitUrl;

  const uploadEndpoint = input.uploadEndpoint?.trim();
  if (!uploadEndpoint) {
    throw new Error("Minimax 图生图需要公网参考图 URL；请填写角色设定图公网 URL，或配置本地图片上传接口。");
  }

  return invoke<string>("upload_reference_image", {
    request: {
      uploadUrl: uploadEndpoint,
      dataUrl: input.sourceImage,
      filename: `pet-reference-${Date.now()}.png`
    }
  });
}

function buildMinimaxPrompt(species: PetSpecies, action: PetAction, appearanceNotes?: string) {
  const speciesText = species === "cat" ? "the user's pet cat" : "the user's pet dog";
  const actionText: Record<PetAction, string> = {
    idle: "front-facing relaxed standing pose, same as model sheet",
    sit: "sitting down, cute calm expression",
    sleep: "sleeping curled up peacefully, closed eyes",
    happy: "happy excited pose, cheerful expression, small bounce energy",
    walk: "walking key pose, tiny steps, full body visible",
    jump: "mid-air jumping key pose, playful and energetic"
  };

  return [
    `Use the reference image as a finished character model sheet for ${speciesText}.`,
    "Do not redesign the character. Only redraw the exact same character in the requested action.",
    "Keep the same face shape, eye spacing, nose, mouth, muzzle, ear shape, ear placement, fur colors, coat pattern, facial markings, chest, paws and tail.",
    "The output must look like the same mascot character from the reference, not a new pet.",
    `Action: ${actionText[action]}.`,
    appearanceNotes?.trim() ? `Mandatory appearance notes: ${appearanceNotes.trim()}.` : "",
    "Do not change black/white/silver fur to orange, yellow, brown or ginger. Do not invent new markings.",
    "Full body, centered, clean silhouette, same sticker art style, thick white outline, simple light background.",
    "No text, watermark, extra animals, human, or face-covering props."
  ]
    .filter(Boolean)
    .join(" ");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function renderFrame(image: HTMLImageElement, _species: PetSpecies, action: PetAction, pose: FramePose, frameIndex: number) {
  const size = 420;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");

  ctx.clearRect(0, 0, size, size);
  drawStickerShadow(ctx, size, pose);
  drawGeneratedPet(ctx, image, size, pose);
  drawAccent(ctx, size, action, pose, frameIndex);

  return canvas.toDataURL("image/webp", 0.86);
}

function drawStickerShadow(ctx: CanvasRenderingContext2D, size: number, pose: FramePose) {
  ctx.save();
  ctx.translate(size / 2, size / 2 + 126);
  ctx.scale(1.05 + (1 - pose.scaleY) * 0.7, 0.2);
  const shadow = ctx.createRadialGradient(0, 0, 10, 0, 0, 120);
  shadow.addColorStop(0, "rgba(45, 34, 25, 0.26)");
  shadow.addColorStop(1, "rgba(45, 34, 25, 0)");
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(0, 0, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawGeneratedPet(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number, pose: FramePose) {
  ctx.save();
  ctx.translate(size / 2, size / 2 + pose.y);
  ctx.rotate((pose.rotate * Math.PI) / 180);
  ctx.scale(pose.scaleX, pose.scaleY);
  ctx.shadowColor = "rgba(55, 38, 18, 0.22)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 10;
  drawImageContain(ctx, image, -162, -178, 324, 344);
  ctx.restore();
}

function drawAccent(ctx: CanvasRenderingContext2D, size: number, action: PetAction, pose: FramePose, frameIndex: number) {
  ctx.save();
  ctx.translate(size / 2, size / 2 + pose.y);
  ctx.font = "700 32px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (pose.accent === "heart") {
    ctx.fillStyle = "#ff6678";
    ctx.fillText("♥", 104, -102 - frameIndex * 4);
    ctx.fillStyle = "#ffd05f";
    ctx.fillText("✦", -106, -92 + frameIndex * 3);
  }

  if (pose.accent === "spark") {
    ctx.fillStyle = "#ffcc4d";
    ctx.fillText("✦", 112, -86);
    ctx.fillStyle = "#7ddfc3";
    ctx.fillText("✧", -118, -68);
  }

  if (pose.accent === "zzz") {
    ctx.fillStyle = "#58738c";
    ctx.font = "800 28px serif";
    ctx.fillText("Z", 108, -94 - frameIndex * 4);
    ctx.font = "800 22px serif";
    ctx.fillText("z", 136, -120 - frameIndex * 5);
  }

  if (pose.accent === "paws" || action === "walk") {
    ctx.fillStyle = "rgba(67, 43, 31, 0.28)";
    ctx.beginPath();
    ctx.ellipse(-90 + frameIndex * 18, 130, 14, 8, -0.2, 0, Math.PI * 2);
    ctx.ellipse(80 - frameIndex * 18, 132, 14, 8, 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawImageContain(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = w / h;
  let targetWidth = w;
  let targetHeight = h;

  if (imageRatio > targetRatio) {
    targetHeight = w / imageRatio;
  } else {
    targetWidth = h * imageRatio;
  }

  ctx.drawImage(image, x + (w - targetWidth) / 2, y + (h - targetHeight) / 2, targetWidth, targetHeight);
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = src;
  });
}

function waitForPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
