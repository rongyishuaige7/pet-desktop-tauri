import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createGenerationCheckpoint, generatePetFramePack, GenerationCancelled } from "./ai-generation";
import { FRAMES_PER_ACTION } from "./prompt-builder";
import { sliceSpriteSheet } from "./sprite-sheet";
import { removeBackgroundFromDataUrl } from "./background-removal";
import { normalizeActionFrames, FrameQualityError } from "./frame-quality";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

vi.mock("./background-removal", () => ({ removeBackgroundFromDataUrl: vi.fn(async (image: string) => image) }));
vi.mock("./frame-quality", async (original) => ({
  ...await original<typeof import("./frame-quality")>(),
  normalizeActionFrames: vi.fn(async (frames: string[]) => frames)
}));

vi.mock("./sprite-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sprite-sheet")>();
  return {
    ...actual,
    sliceSpriteSheet: vi.fn(async () =>
      Array.from({ length: FRAMES_PER_ACTION }, (_, index) => `data:image/png;base64,CELL${index}`)
    )
  };
});

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(removeBackgroundFromDataUrl).mockReset().mockImplementation(async image => image);
  vi.mocked(normalizeActionFrames).mockReset().mockImplementation(async frames => frames);
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "upload_reference_image") return "https://example.com/uploaded.png";
    if (command === "generate_minimax_image") return "data:image/png;base64,AAAA";
    if (command === "save_manual_frame_pack") {
      return { frameRoot: "/tmp/pet-pack", sourceImage: "data:image/png;base64,AAAA" };
    }
    throw new Error(`unexpected command: ${command}`);
  });
});

const options = {
  apiKey: "test-key",
  uploadUrl: "https://example.com/upload",
  referencePhoto: "data:image/png;base64,BBBB",
  petName: "奶茶",
  species: "cat" as const,
  frameDelayMs: 0,
  removeBackground: false,
  mode: "frames" as const
};

describe("AI frame pack generation", () => {
  it("uploads references, generates six actions, and saves a pack", async () => {
    const progress: string[] = [];
    const result = await generatePetFramePack({
      ...options,
      onProgress: (message) => progress.push(message)
    });

    expect(result.frameRoot).toBe("/tmp/pet-pack");
    expect(Object.keys(result.actions)).toHaveLength(6);
    for (const frames of Object.values(result.actions)) {
      expect(frames).toHaveLength(FRAMES_PER_ACTION);
    }
    expect(progress.some((message) => message.includes("角色设定图"))).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "save_manual_frame_pack",
      expect.objectContaining({ request: expect.objectContaining({ actions: expect.any(Object) }) })
    );
  });

  it("uses one sprite sheet request per action in sheet mode", async () => {
    const result = await generatePetFramePack({ ...options, mode: "sheet" });
    expect(result.actions.idle).toHaveLength(FRAMES_PER_ACTION);
    expect(vi.mocked(sliceSpriteSheet)).toHaveBeenCalledTimes(6);
    expect(invokeMock.mock.calls.filter(([command]) => command === "generate_minimax_image")).toHaveLength(7);
  });

  it("stops when cancelled", async () => {
    let calls = 0;
    await expect(
      generatePetFramePack({
        ...options,
        isCancelled: () => ++calls > 2
      })
    ).rejects.toBeInstanceOf(GenerationCancelled);
  });

  it("honors cancellation during saving and reuses the saved pack on resume", async () => {
    const checkpoint = createGenerationCheckpoint();
    const original = invokeMock.getMockImplementation()!;
    let cancelled = false;
    invokeMock.mockImplementation(async (command, args, opts) => {
      const value = await original(command, args, opts);
      if (command === "save_manual_frame_pack") cancelled = true;
      return value;
    });
    await expect(generatePetFramePack({ ...options, checkpoint, isCancelled: () => cancelled })).rejects.toBeInstanceOf(GenerationCancelled);
    expect(checkpoint.frameRoot).toBe("/tmp/pet-pack");
    const calls = invokeMock.mock.calls.length;
    const resumed = await generatePetFramePack({ ...options, checkpoint });
    expect(resumed.frameRoot).toBe("/tmp/pet-pack");
    expect(invokeMock.mock.calls).toHaveLength(calls);
  });

  it("continues from the failed frame without regenerating completed requests", async () => {
    const checkpoint = createGenerationCheckpoint();
    const original = invokeMock.getMockImplementation()!;
    let generated = 0;
    invokeMock.mockImplementation(async (command, args, opts) => {
      if (command === "generate_minimax_image" && ++generated === 8) throw new Error("temporary network failure");
      return original(command, args, opts);
    });
    await expect(generatePetFramePack({ ...options, checkpoint })).rejects.toThrow("temporary network");
    expect(checkpoint.actions.idle).toHaveLength(5);
    expect(checkpoint.cleanedFrames.sit).toHaveLength(1);
    await generatePetFramePack({ ...options, checkpoint });
    expect(generated).toBe(32); // 31 successful requests + the single failed request.
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "upload_reference_image")).toHaveLength(2);
    expect(JSON.stringify(checkpoint)).not.toContain(options.apiKey);
  });

  it("keeps a paid response received after cancellation for the next attempt", async () => {
    const checkpoint = createGenerationCheckpoint();
    const original = invokeMock.getMockImplementation()!;
    let cancelled = false;
    invokeMock.mockImplementation(async (command, args, opts) => {
      const result = await original(command, args, opts);
      if (command === "generate_minimax_image") cancelled = true;
      return result;
    });
    await expect(generatePetFramePack({ ...options, checkpoint, isCancelled: () => cancelled })).rejects.toBeInstanceOf(GenerationCancelled);
    expect(checkpoint.characterRaw).toBeTruthy();
    await generatePetFramePack({ ...options, checkpoint });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "generate_minimax_image")).toHaveLength(31);
  });

  it("surfaces background removal failures and retries cleanup without requesting a new image", async () => {
    const checkpoint = createGenerationCheckpoint();
    vi.mocked(removeBackgroundFromDataUrl).mockRejectedValueOnce(new Error("canvas failed"));
    await expect(generatePetFramePack({ ...options, removeBackground: true, checkpoint })).rejects.toThrow("canvas failed");
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "save_manual_frame_pack")).toBe(false);
    await generatePetFramePack({ ...options, removeBackground: true, checkpoint });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "generate_minimax_image")).toHaveLength(31);
  });

  it("regenerates a rejected action while preserving completed actions", async () => {
    const checkpoint = createGenerationCheckpoint();
    vi.mocked(normalizeActionFrames).mockImplementationOnce(async f => f).mockImplementationOnce(async f => f)
      .mockRejectedValueOnce(new FrameQualityError("clipped subject"));
    await expect(generatePetFramePack({ ...options, checkpoint })).rejects.toThrow("clipped subject");
    expect(checkpoint.actions.idle).toHaveLength(5);
    expect(checkpoint.actions.sit).toHaveLength(0);
    await generatePetFramePack({ ...options, checkpoint });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "generate_minimax_image")).toHaveLength(36);
  });

  it("does not invalidate cached images for a display-name change", async () => {
    const checkpoint = createGenerationCheckpoint();
    await generatePetFramePack({ ...options, checkpoint });
    await generatePetFramePack({ ...options, checkpoint, petName: "另一只" });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "generate_minimax_image")).toHaveLength(31);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "save_manual_frame_pack")).toHaveLength(1);
  });

  it("invalidates cached images when the appearance inputs change", async () => {
    const checkpoint = createGenerationCheckpoint();
    await generatePetFramePack({ ...options, checkpoint });
    await generatePetFramePack({ ...options, checkpoint, appearanceNotes: "戴红围巾" });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "generate_minimax_image")).toHaveLength(62);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "save_manual_frame_pack")).toHaveLength(2);
  });
});
