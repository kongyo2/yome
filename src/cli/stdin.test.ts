import { describe, it, expect } from "vitest";
import { stdinName } from "./stdin-name.js";

describe("stdinName", () => {
  it("returns deterministic name", () => {
    expect(stdinName("hello")).toBe(stdinName("hello"));
  });
  it("uses first 7 hex chars of sha256", () => {
    expect(stdinName("hello")).toMatch(/^stdin-[0-9a-f]{7}\.md$/);
  });
  it("differs for different content", () => {
    expect(stdinName("foo")).not.toBe(stdinName("bar"));
  });
});
