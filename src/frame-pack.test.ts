import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const ACTIONS = ["idle", "walk", "sit", "sleep", "happy", "jump"] as const;
const FRAMES_PER_ACTION = 5;
const CANVAS = 512;
const MIN_TOP_MARGIN = 16;
const MIN_BOTTOM_MARGIN = 8;

const ROOT = process.cwd();
const PACK = join(ROOT, "frame-pack");
const PUBLIC_PACK = join(ROOT, "public", "frame-pack");

interface Decoded {
  width: number;
  height: number;
  /** Alpha values, one per pixel, row-major. */
  alpha: Uint8Array;
}

/**
 * Minimal PNG reader for 8-bit RGBA, non-interlaced images (the only format the
 * frame pack uses). Keeps the test dependency-free so it also guards the pack in
 * CI, where the Python tooling is not installed.
 */
function decodePng(file: string): Decoded {
  const data = readFileSync(file);
  expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }

  expect({ bitDepth, colorType, interlace }).toEqual({ bitDepth: 8, colorType: 6, interlace: 0 });

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const alpha = new Uint8Array(width * height);
  let previous = new Uint8Array(stride);
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Uint8Array.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? line[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[x] = (line[x] + left) & 0xff;
          break;
        case 2:
          line[x] = (line[x] + up) & 0xff;
          break;
        case 3:
          line[x] = (line[x] + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          line[x] = (line[x] + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter} in ${file}`);
      }
    }

    for (let x = 0; x < width; x += 1) {
      alpha[y * width + x] = line[x * 4 + 3];
    }
    previous = line;
  }

  return { width, height, alpha };
}

function opaqueBounds(decoded: Decoded) {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < decoded.height; y += 1) {
    let any = false;
    for (let x = 0; x < decoded.width; x += 1) {
      if (decoded.alpha[y * decoded.width + x] > 8) {
        any = true;
        break;
      }
    }
    if (any) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  return { top, bottom };
}

describe("frame pack", () => {
  it("ships five frames for each of the six actions", () => {
    for (const action of ACTIONS) {
      const dir = join(PACK, action);
      expect(existsSync(dir), `missing ${action}`).toBe(true);
      const files = readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
      expect(files).toEqual(
        Array.from({ length: FRAMES_PER_ACTION }, (_, index) => `${String(index).padStart(3, "0")}.png`)
      );
    }
  });

  it("keeps every frame clear of the canvas edge so no pose is sliced flat", () => {
    for (const action of ACTIONS) {
      for (let index = 0; index < FRAMES_PER_ACTION; index += 1) {
        const file = join(PACK, action, `${String(index).padStart(3, "0")}.png`);
        const decoded = decodePng(file);
        expect([decoded.width, decoded.height]).toEqual([CANVAS, CANVAS]);
        const { top, bottom } = opaqueBounds(decoded);
        expect(top, `${action}/${index} crown`).toBeGreaterThanOrEqual(MIN_TOP_MARGIN);
        expect(bottom, `${action}/${index} feet`).toBeLessThanOrEqual(CANVAS - MIN_BOTTOM_MARGIN);
      }
    }
  });

  it("plants the support foot for the grounded actions", () => {
    for (const action of ["idle", "walk"] as const) {
      for (let index = 0; index < FRAMES_PER_ACTION; index += 1) {
        const file = join(PACK, action, `${String(index).padStart(3, "0")}.png`);
        const { bottom } = opaqueBounds(decodePng(file));
        expect(bottom, `${action}/${index} support foot`).toBe(474);
      }
    }
  });

  it("keeps the public copy byte-identical to the source pack", () => {
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    for (const action of ACTIONS) {
      for (let index = 0; index < FRAMES_PER_ACTION; index += 1) {
        const name = `${String(index).padStart(3, "0")}.png`;
        expect(hash(join(PUBLIC_PACK, action, name)), `${action}/${name}`).toBe(
          hash(join(PACK, action, name))
        );
      }
    }
  });
});
