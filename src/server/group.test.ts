import { describe, it, expect } from "vitest";
import { resolveGroupName, DefaultGroup } from "./group.js";

describe("resolveGroupName", () => {
  it("normalizes empty to default", () => {
    expect(resolveGroupName("")).toEqual({ name: DefaultGroup, error: null });
    expect(resolveGroupName(null)).toEqual({ name: DefaultGroup, error: null });
    expect(resolveGroupName(undefined)).toEqual({
      name: DefaultGroup,
      error: null,
    });
  });
  it("trims slashes", () => {
    expect(resolveGroupName("/docs/").name).toBe("docs");
    expect(resolveGroupName("///")).toEqual({
      name: DefaultGroup,
      error: null,
    });
  });
  it("rejects underscore-only", () => {
    const r = resolveGroupName("_");
    expect(r.error).not.toBeNull();
  });
  it("rejects reserved _/", () => {
    const r = resolveGroupName("_/foo");
    expect(r.error).not.toBeNull();
  });
  it("rejects forbidden chars", () => {
    expect(resolveGroupName("foo?bar").error).not.toBeNull();
    expect(resolveGroupName("foo#bar").error).not.toBeNull();
    expect(resolveGroupName("foo\\bar").error).not.toBeNull();
  });
  it("rejects double slashes", () => {
    expect(resolveGroupName("foo//bar").error).not.toBeNull();
  });
  it("rejects . and .. segments", () => {
    expect(resolveGroupName("foo/.").error).not.toBeNull();
    expect(resolveGroupName("foo/..").error).not.toBeNull();
  });
  it("accepts valid multi-segment", () => {
    expect(resolveGroupName("docs/api").error).toBeNull();
  });
});
