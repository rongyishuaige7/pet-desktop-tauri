import { describe, expect, it } from "vitest";
import {
  displayRetryStillValid,
  nativeStateVersion,
  parseNativeError,
  type DisplayRetryContext
} from "./pet-activation";
import { createWebState } from "./native-pet-state";

const retry: DisplayRetryContext = {
  operationId: "op-1",
  petId: "pet-b",
  petName: "乙",
  selectionRevision: 4,
  nativeVersion: { sessionId: "s1", revision: 9 },
  code: "SETTINGS_WRITE_FAILED"
};

describe("native error parsing", () => {
  it("keeps the operation code separate from user-facing copy", () => {
    expect(parseNativeError("TARGET_CHANGED: 当前伙伴已切换")).toEqual({
      code: "TARGET_CHANGED",
      message: "当前伙伴已切换"
    });
    expect(parseNativeError(new Error("STATE_CHANGED: 状态已更新"))).toEqual({
      code: "STATE_CHANGED",
      message: "状态已更新"
    });
  });

  it("leaves ordinary messages without a code", () => {
    expect(parseNativeError("设置没有保存：磁盘已满")).toEqual({
      code: null,
      message: "设置没有保存：磁盘已满"
    });
  });
});

describe("display retry context", () => {
  it("only accepts the same pet under the same selection revision", () => {
    expect(displayRetryStillValid(retry, ["pet-a", "pet-b"], "pet-b", 4)).toBe(true);
    expect(displayRetryStillValid(retry, ["pet-a"], "pet-b", 4)).toBe(false);
    expect(displayRetryStillValid(retry, ["pet-a", "pet-b"], "pet-a", 4)).toBe(false);
    expect(displayRetryStillValid(retry, ["pet-a", "pet-b"], "pet-b", 5)).toBe(false);
  });

  it("does not record a pending placeholder session as a version", () => {
    const state = createWebState(null, false, true);
    expect(nativeStateVersion({ ...state, sessionId: "pending" })).toBeNull();
    expect(nativeStateVersion({ ...state, sessionId: "session-1", revision: 3 })).toEqual({
      sessionId: "session-1",
      revision: 3
    });
  });
});
