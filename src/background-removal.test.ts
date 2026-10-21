import { describe, expect, it } from "vitest";
import { removeBackgroundFromPixels } from "./background-removal";

describe("background removal", () => {
  it("removes an edge-connected background and keeps the subject", () => {
    const width = 10;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const isSubject = x >= 3 && x <= 6 && y >= 3 && y <= 6;
        data[offset] = isSubject ? 220 : 0;
        data[offset + 1] = isSubject ? 40 : 255;
        data[offset + 2] = isSubject ? 40 : 0;
        data[offset + 3] = 255;
      }
    }

    const result = removeBackgroundFromPixels(data, width, height, 40);
    const cornerAlpha = result.data[3];
    const centerIndex = (5 * width + 5) * 4;
    expect(cornerAlpha).toBe(0);
    expect(result.data[centerIndex + 3]).toBe(255);
    expect(result.removedRatio).toBeGreaterThan(0.5);
  });

  it("reports full removal for a uniform image", () => {
    const width = 4;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const result = removeBackgroundFromPixels(data, width, height, 10);
    expect(result.removedRatio).toBe(1);
  });
});
