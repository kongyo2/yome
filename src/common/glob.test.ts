import { describe, it, expect } from "vitest";
import {
  hasGlobChars,
  isRecursivePattern,
  splitPattern,
  matchPattern,
  toSlash,
  sortPathsNatural,
} from "./glob.js";

describe("hasGlobChars", () => {
  it("detects *, ?, [", () => {
    expect(hasGlobChars("a*b")).toBe(true);
    expect(hasGlobChars("a?b")).toBe(true);
    expect(hasGlobChars("a[bc]d")).toBe(true);
  });
  it("returns false for plain paths", () => {
    expect(hasGlobChars("plain/path.md")).toBe(false);
  });
});

describe("splitPattern", () => {
  it("splits at first glob component", () => {
    expect(splitPattern("/a/b/*.md")).toEqual({ base: "/a/b", rel: "*.md" });
  });
  it("handles **", () => {
    expect(splitPattern("/a/**/c.md")).toEqual({ base: "/a", rel: "**/c.md" });
  });
  it("returns root when no base", () => {
    expect(splitPattern("/*.md")).toEqual({ base: "/", rel: "*.md" });
  });
});

describe("isRecursivePattern", () => {
  it("detects **", () => {
    expect(isRecursivePattern("a/**/b")).toBe(true);
    expect(isRecursivePattern("*.md")).toBe(false);
  });
});

describe("matchPattern", () => {
  it("matches single-level glob", () => {
    expect(matchPattern("/foo/*.md", "/foo/bar.md")).toBe(true);
    expect(matchPattern("/foo/*.md", "/foo/sub/bar.md")).toBe(false);
  });
  it("matches recursive glob", () => {
    expect(matchPattern("/foo/**/*.md", "/foo/sub/bar.md")).toBe(true);
  });
});

describe("toSlash", () => {
  it("converts path separators when on posix", () => {
    expect(toSlash("/foo/bar")).toBe("/foo/bar");
  });
});

describe("sortPathsNatural", () => {
  it("sorts numerically", () => {
    const arr = ["foo2.md", "foo10.md", "foo1.md"];
    sortPathsNatural(arr);
    expect(arr).toEqual(["foo1.md", "foo2.md", "foo10.md"]);
  });
});
