import { loadFrameImage } from "./frame-quality";

export interface BackgroundRemovalResult {
  data: Uint8ClampedArray;
  removedRatio: number;
  background: [number, number, number];
}

function colorDistance(
  r: number,
  g: number,
  b: number,
  br: number,
  bg: number,
  bb: number
) {
  const dr = r - br;
  const dg = g - bg;
  const db = b - bb;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function sampleBorderColor(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  const sample = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    if (data[index + 3] === 0) return;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  };

  for (let x = 0; x < width; x++) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    sample(0, y);
    sample(width - 1, y);
  }

  let best = { count: 0, r: 0, g: 0, b: 0 };
  for (const bucket of buckets.values()) {
    if (bucket.count > best.count) best = bucket;
  }

  if (best.count === 0) return [0, 0, 0];
  return [
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count)
  ];
}

export function removeBackgroundFromPixels(
  input: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = 40
): BackgroundRemovalResult {
  const data = new Uint8ClampedArray(input);
  const background = sampleBorderColor(data, width, height);
  const [br, bg, bb] = background;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  const isBackground = (index: number) => {
    const offset = index * 4;
    return (
      data[offset + 3] > 0 &&
      colorDistance(data[offset], data[offset + 1], data[offset + 2], br, bg, bb) <= tolerance
    );
  };

  const push = (index: number) => {
    if (!visited[index] && isBackground(index)) {
      visited[index] = 1;
      stack.push(index);
    }
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  let removed = 0;
  while (stack.length > 0) {
    const index = stack.pop()!;
    if (!isBackground(index)) continue;
    data[index * 4 + 3] = 0;
    removed += 1;

    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) push(index - 1);
    if (x + 1 < width) push(index + 1);
    if (y > 0) push(index - width);
    if (y + 1 < height) push(index + width);
  }

  // Soften the cut edge and remove green spill when the model obeyed the green screen.
  const greenScreen = bg > br + 30 && bg > bb + 30;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const offset = index * 4;
      if (data[offset + 3] === 0) continue;

      const touchesTransparent =
        data[(index - 1) * 4 + 3] === 0 ||
        data[(index + 1) * 4 + 3] === 0 ||
        data[(index - width) * 4 + 3] === 0 ||
        data[(index + width) * 4 + 3] === 0;

      if (!touchesTransparent) continue;

      const distance = colorDistance(data[offset], data[offset + 1], data[offset + 2], br, bg, bb);
      if (distance < tolerance * 1.8) {
        data[offset + 3] = Math.min(data[offset + 3], 150);
      }
      if (greenScreen) {
        const maxRedBlue = Math.max(data[offset], data[offset + 2]);
        if (data[offset + 1] > maxRedBlue + 8) {
          data[offset + 1] = maxRedBlue;
        }
      }
    }
  }

  return {
    data,
    removedRatio: removed / (width * height),
    background
  };
}

export async function removeBackgroundFromDataUrl(dataUrl: string, tolerance = 40): Promise<string> {
  const image = await loadFrameImage(dataUrl);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建去背景画布");

  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, width, height);
  const result = removeBackgroundFromPixels(imageData.data, width, height, tolerance);

  if (result.removedRatio < 0.005 || result.removedRatio > 0.995) {
    return dataUrl;
  }

  const output = context.createImageData(width, height);
  output.data.set(result.data);
  context.putImageData(output, 0, 0);
  return canvas.toDataURL("image/png");
}
