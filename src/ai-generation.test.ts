import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { generatePetFramePack, GenerationCancelled } from "./ai-generation";
import { FRAMES_PER_ACTION } from "./prompt-builder";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
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
  removeBackground: false
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

  it("stops when cancelled", async () => {
    let calls = 0;
    await expect(
      generatePetFramePack({
        ...options,
        isCancelled: () => ++calls > 2
      })
    ).rejects.toBeInstanceOf(GenerationCancelled);
  });
});
