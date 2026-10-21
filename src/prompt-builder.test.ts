import { describe, expect, it } from "vitest";
import {
  buildActionPrompt,
  buildCharacterPrompt,
  buildSpriteSheetPrompt,
  FRAMES_PER_ACTION,
  MAX_PROMPT_LENGTH
} from "./prompt-builder";

const context = {
  species: "cat" as const,
  petName: "奶茶",
  referenceImageUrl: "https://example.com/reference.png",
  characterReferenceUrl: "https://example.com/character.png",
  appearanceNotes: "黑白短毛猫"
};

describe("prompt builder", () => {
  it("keeps all prompts under the API limit with oversized user input", () => {
    const long = "超长内容".repeat(2000);
    const input = { ...context, petName: long, appearanceNotes: long, styleNotes: long, negativePrompt: long };
    for (const prompt of [buildCharacterPrompt(input), buildSpriteSheetPrompt(input, "walk"), buildActionPrompt(input, "walk", 0)]) {
      expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH);
    }
  });
  it("builds a compact character sheet prompt", () => {
    const prompt = buildCharacterPrompt(context);
    expect(prompt).toContain("奶茶");
    expect(prompt).toContain("黑白短毛猫");
    expect(prompt).not.toContain("{{");
    expect(prompt.length).toBeLessThan(MAX_PROMPT_LENGTH);
  });

  it("describes the 3x2 sprite sheet layout", () => {
    const prompt = buildSpriteSheetPrompt(context, "walk");
    expect(prompt).toContain("3 列 × 2 行");
    expect(prompt).toContain("第 1-5 帧");
    expect(prompt).toContain("走路");
    expect(prompt.length).toBeLessThan(MAX_PROMPT_LENGTH);
  });

  it("adds a frame index to compact action prompts", () => {
    const prompt = buildActionPrompt(context, "walk", 2);
    expect(prompt).toContain("走路");
    expect(prompt).toContain("第 3 帧");
    expect(prompt).toContain(`连续 ${FRAMES_PER_ACTION} 帧`);
    expect(prompt).not.toContain("{{");
    expect(prompt.length).toBeLessThan(MAX_PROMPT_LENGTH);
  });
});
