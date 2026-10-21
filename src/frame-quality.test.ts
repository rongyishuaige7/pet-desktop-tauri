import { describe, expect, it } from "vitest";
import { frameTransforms, normalizeActionFrames, subjectBounds } from "./frame-quality";

function pixels(rect?: [number, number, number, number]) {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  if (rect) for (let y = rect[1]; y <= rect[3]; y++) for (let x = rect[0]; x <= rect[2]; x++) data[(y * 100 + x) * 4 + 3] = 255;
  return data;
}

describe("generated frame quality", () => {
  it("rejects empty, opaque, clipped and malformed images", () => {
    expect(() => subjectBounds(pixels(), 100, 100)).toThrow("为空");
    expect(() => subjectBounds(pixels([0, 0, 99, 99]), 100, 100)).toThrow("背景未去除");
    expect(() => subjectBounds(pixels([1, 10, 50, 80]), 100, 100)).toThrow("裁切");
    expect(() => subjectBounds(pixels(), 10, 10)).toThrow("像素尺寸无效");
    expect(() => frameTransforms([], "idle")).toThrow("范围无效");
  });

  it("aligns grounded poses to the same floor and center with a shared scale", () => {
    const poses = [{ left: 20, top: 10, right: 60, bottom: 80 }, { left: 25, top: 20, right: 65, bottom: 90 }];
    expect(subjectBounds(pixels([20, 10, 60, 80]), 100, 100)).toEqual(poses[0]);
    for (const action of ["idle", "walk", "sleep"] as const) {
      const transforms = frameTransforms(poses, action);
      expect(transforms[0].scale).toBe(transforms[1].scale);
      for (let i = 0; i < poses.length; i++) {
        const t = transforms[i], b = poses[i];
        expect(t.y + (b.bottom + 1) * t.scale).toBeCloseTo(475);
        expect(t.y + b.top * t.scale).toBeGreaterThanOrEqual(32);
        expect(t.x + (b.left + b.right + 1) / 2 * t.scale).toBeCloseTo(256);
      }
    }
  });

  it("preserves relative motion for airborne poses", () => {
    const poses = [{ left: 20, top: 30, right: 60, bottom: 90 }, { left: 25, top: 10, right: 65, bottom: 70 }];
    const transforms = frameTransforms(poses, "jump");
    expect(transforms[0]).toEqual(transforms[1]);
    expect((poses[0].bottom - poses[1].bottom) * transforms[0].scale).toBeGreaterThan(20);
  });

  it("refuses to normalize an empty action", async () => {
    await expect(normalizeActionFrames([], "idle", true)).rejects.toThrow("不能为空");
  });
});
