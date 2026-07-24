import { describe, it, expect } from "vitest";
import {
  hasGlobChars,
  isRecursivePattern,
  splitPattern,
  toSlash,
  sortPathsNatural,
} from "./glob.js";
import { matchPattern } from "./glob-match.js";

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
    expect(matchPattern("/foo/**/*.md", "/foo/deep/nested/bar.md")).toBe(true);
  });
  it("matches recursive glob at root of base", () => {
    expect(matchPattern("/foo/**/*.md", "/foo/bar.md")).toBe(true);
  });
  it("rejects mismatched extension", () => {
    expect(matchPattern("/foo/*.md", "/foo/bar.txt")).toBe(false);
  });
  it("rejects outside base", () => {
    expect(matchPattern("/foo/*.md", "/bar/baz.md")).toBe(false);
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

describe("expandGlob depth handling", () => {
  it("does not descend into subdirectories for single-level patterns", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { expandGlob } = await import("./glob-match.js");
    const tmp = mkdtempSync(join(tmpdir(), "yome-glob-"));
    try {
      writeFileSync(join(tmp, "a.md"), "");
      writeFileSync(join(tmp, "b.md"), "");
      mkdirSync(join(tmp, "deep", "nest"), { recursive: true });
      writeFileSync(join(tmp, "deep", "c.md"), "");
      writeFileSync(join(tmp, "deep", "nest", "d.md"), "");
      const results = await expandGlob(tmp, "*.md", { filesOnly: true });
      expect(results.sort()).toEqual([join(tmp, "a.md"), join(tmp, "b.md")]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("descends only as deep as the pattern requires", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { expandGlob } = await import("./glob-match.js");
    const tmp = mkdtempSync(join(tmpdir(), "yome-glob-"));
    try {
      mkdirSync(join(tmp, "a", "nested"), { recursive: true });
      writeFileSync(join(tmp, "a", "x.md"), "");
      writeFileSync(join(tmp, "a", "nested", "y.md"), "");
      const results = await expandGlob(tmp, "a/*.md", { filesOnly: true });
      expect(results).toEqual([join(tmp, "a", "x.md")]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("recurses fully when the pattern contains **", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { expandGlob } = await import("./glob-match.js");
    const tmp = mkdtempSync(join(tmpdir(), "yome-glob-"));
    try {
      mkdirSync(join(tmp, "deep", "nest"), { recursive: true });
      writeFileSync(join(tmp, "deep", "nest", "z.md"), "");
      const results = await expandGlob(tmp, "**/*.md", { filesOnly: true });
      expect(results).toEqual([join(tmp, "deep", "nest", "z.md")]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("expandGlob symlink handling", () => {
  it("includes symlinks to files but excludes symlinks to directories", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { expandGlob } = await import("./glob-match.js");
    const tmp = mkdtempSync(join(tmpdir(), "yome-glob-"));
    try {
      writeFileSync(join(tmp, "real.md"), "");
      mkdirSync(join(tmp, "adir.md"));
      try {
        symlinkSync(join(tmp, "real.md"), join(tmp, "filelink.md"));
        symlinkSync(join(tmp, "adir.md"), join(tmp, "dirlink.md"));
        symlinkSync(join(tmp, "missing.md"), join(tmp, "broken.md"));
      } catch {
        // Symlinks may be unavailable (e.g. Windows without privileges);
        // nothing to assert in that case.
        return;
      }
      const results = await expandGlob(tmp, "*.md", { filesOnly: true });
      expect(results.sort()).toEqual([
        join(tmp, "filelink.md"),
        join(tmp, "real.md"),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
