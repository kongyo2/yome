import { describe, it, expect } from "vitest";
import type { MouseEvent } from "react";
import { isPlainLeftClick } from "./linkClick";

function event(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as MouseEvent;
}

describe("isPlainLeftClick", () => {
  it("returns true for a left-click without modifiers", () => {
    expect(isPlainLeftClick(event())).toBe(true);
  });

  it("returns false for non-primary buttons", () => {
    expect(isPlainLeftClick(event({ button: 1 }))).toBe(false);
    expect(isPlainLeftClick(event({ button: 2 }))).toBe(false);
  });

  it.each([["metaKey"], ["ctrlKey"], ["shiftKey"], ["altKey"]] as const)(
    "returns false when %s is held",
    (key) => {
      expect(isPlainLeftClick(event({ [key]: true }))).toBe(false);
    },
  );
});
