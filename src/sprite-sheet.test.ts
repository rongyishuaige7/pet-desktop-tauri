import { describe, expect, it } from "vitest";
import { spriteSheetCellRect, SPRITE_COLUMNS, SPRITE_ROWS } from "./sprite-sheet";

describe("sprite sheet slicing", () => {
  it("splits a 3:2 sheet into six square cells", () => {
    const first = spriteSheetCellRect(900, 600, 0);
    const fourth = spriteSheetCellRect(900, 600, 4);
    const sixth = spriteSheetCellRect(900, 600, 5);

    expect(first).toEqual({ x: 0, y: 0, width: 300, height: 300 });
    expect(fourth).toEqual({ x: 300, y: 300, width: 300, height: 300 });
    expect(sixth).toEqual({ x: 600, y: 300, width: 300, height: 300 });
    expect(SPRITE_COLUMNS * SPRITE_ROWS).toBe(6);
  });
});
