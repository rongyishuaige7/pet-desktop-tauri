import type { PetAction } from "./types";

export class FrameQualityError extends Error {
  constructor(message: string) { super(message); this.name = "FrameQualityError"; }
}
export interface FrameBounds { left: number; top: number; right: number; bottom: number }

export function subjectBounds(data: Uint8ClampedArray, width: number, height: number): FrameBounds {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) {
    throw new FrameQualityError("动作帧像素尺寸无效");
  }
  let left = width, top = height, right = -1, bottom = -1, opaque = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] <= 8) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y); opaque++;
  }
  if (opaque < width * height * 0.002) throw new FrameQualityError("动作帧为空或主体过小，请重新生成此动作");
  if (opaque > width * height * 0.98) throw new FrameQualityError("动作帧背景未去除，请重新生成此动作");
  if (left < 2 || top < 2 || right >= width - 2 || bottom >= height - 2) {
    throw new FrameQualityError("动作帧主体碰到画布边缘，可能被裁切，请重新生成此动作");
  }
  return { left, top, right, bottom };
}

export function frameTransforms(bounds: FrameBounds[], action: PetAction) {
  if (!bounds.length || bounds.some(b => !Object.values(b).every(Number.isFinite) || b.right < b.left || b.bottom < b.top)) {
    throw new FrameQualityError("动作帧主体范围无效");
  }
  const union = { left: Math.min(...bounds.map(b => b.left)), right: Math.max(...bounds.map(b => b.right)),
    top: Math.min(...bounds.map(b => b.top)), bottom: Math.max(...bounds.map(b => b.bottom)) };
  const grounded = ["idle", "walk", "sleep"].includes(action);
  const width = grounded ? Math.max(...bounds.map(b => b.right - b.left + 1)) : union.right - union.left + 1;
  const height = grounded ? Math.max(...bounds.map(b => b.bottom - b.top + 1)) : union.bottom - union.top + 1;
  const scale = Math.min(456 / width, 442 / height);
  return bounds.map(b => {
    const anchor = grounded ? b : union;
    return { scale, x: 256 - (anchor.left + anchor.right + 1) / 2 * scale, y: 475 - (anchor.bottom + 1) * scale };
  });
}

export async function loadFrameImage(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  try {
    const ready = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; });
    image.src = source;
    await ready;
  } catch { throw new FrameQualityError("图片无法解码，请重新生成或选择有效图片"); }
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 2048 || image.naturalHeight > 2048) {
    throw new FrameQualityError("图片尺寸无效或超过 2048×2048");
  }
  return image;
}

/** Keep a shared scale per action; resting/grounded actions have a stable floor. */
export async function normalizeActionFrames(frames: string[], action: PetAction, transparent: boolean): Promise<string[]> {
  if (!frames.length) throw new FrameQualityError("动作帧不能为空");
  if (!transparent) return frames;
  const images = await Promise.all(frames.map(loadFrameImage));
  const bounds = images.map(image => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("无法读取动作帧像素");
    ctx.drawImage(image, 0, 0);
    return subjectBounds(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  });
  if (images.some(i => i.naturalWidth !== images[0].naturalWidth || i.naturalHeight !== images[0].naturalHeight)) {
    throw new FrameQualityError("同一动作的帧尺寸不一致，请重新生成此动作");
  }
  const transforms = frameTransforms(bounds, action);
  return images.map((image, index) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("无法创建动作帧画布");
    ctx.imageSmoothingQuality = "high";
    const t = transforms[index];
    ctx.drawImage(image, t.x, t.y, image.naturalWidth * t.scale, image.naturalHeight * t.scale);
    return canvas.toDataURL("image/png");
  });
}
