import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  hasGlobChars,
  isRecursivePattern,
  isSymlinkCycle,
  pathSegments,
  splitPattern,
  toSlash,
  sortPathsNatural,
  walkSymlinkTree,
} from "./glob.js";
import { expandGlob, expandRecursiveGlob, matchPattern } from "./glob-match.js";

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

describe("pathSegments", () => {
  it("splits a native path and drops the empty root component", () => {
    expect(pathSegments(join(sep, "home", "me", "a.md"))).toEqual([
      "home",
      "me",
      "a.md",
    ]);
  });

  it.runIf(sep === "/")(
    "keeps a backslash inside a POSIX file name intact",
    () => {
      expect(pathSegments("/docs/foo\\bar.md")).toEqual([
        "docs",
        "foo\\bar.md",
      ]);
    },
  );
});

describe("walkSymlinkTree", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "yome-walk-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Symlinks may be unavailable (e.g. Windows without privileges); the tests
  // below have nothing to assert in that case.
  function trySymlink(target: string, path: string): boolean {
    try {
      symlinkSync(target, path);
      return true;
    } catch {
      return false;
    }
  }

  async function walk(root: string) {
    const dirs: string[] = [];
    const files: string[] = [];
    const result = await walkSymlinkTree(
      root,
      (d) => dirs.push(d),
      (f) => files.push(f),
    );
    return { dirs, files, ...result };
  }

  it("descends into symlinked directories and reports each alias path", async () => {
    mkdirSync(join(tmp, "outbound", "task"), { recursive: true });
    writeFileSync(join(tmp, "outbound", "task", "a.md"), "");
    mkdirSync(join(tmp, "pending"));
    const target = join(tmp, "outbound", "task");
    if (
      !trySymlink(target, join(tmp, "pending", "task")) ||
      !trySymlink(target, join(tmp, "pending", "copy"))
    ) {
      return;
    }

    const { dirs, files, unresolved, error } = await walk(tmp);

    expect(error).toBeNull();
    expect(unresolved).toEqual([]);
    expect(dirs).toContain(join(tmp, "pending", "task"));
    expect(dirs).toContain(join(tmp, "pending", "copy"));
    expect(files.sort()).toEqual(
      [
        join(tmp, "outbound", "task", "a.md"),
        join(tmp, "pending", "copy", "a.md"),
        join(tmp, "pending", "task", "a.md"),
      ].sort(),
    );
  });

  it("does not follow a symlink back to one of its ancestors", async () => {
    mkdirSync(join(tmp, "nested"));
    writeFileSync(join(tmp, "nested", "note.md"), "");
    if (!trySymlink(tmp, join(tmp, "nested", "back"))) return;

    const { dirs, files, error } = await walk(tmp);

    expect(error).toBeNull();
    expect(dirs).toEqual([tmp, join(tmp, "nested")]);
    expect(files).toEqual([join(tmp, "nested", "note.md")]);
  });

  it("does not follow a symlink to a directory above the walk root", async () => {
    const base = join(tmp, "base");
    mkdirSync(base);
    writeFileSync(join(base, "a.md"), "");
    mkdirSync(join(tmp, "other"));
    writeFileSync(join(tmp, "other", "o.md"), "");
    // Following `up` would walk the base's siblings and then the base again.
    if (!trySymlink(tmp, join(base, "up"))) return;

    const { dirs, files, error } = await walk(base);

    expect(error).toBeNull();
    expect(dirs).toEqual([base]);
    expect(files).toEqual([join(base, "a.md")]);
  });

  it("cuts a cycle that runs through more than one link", async () => {
    mkdirSync(join(tmp, "a"));
    mkdirSync(join(tmp, "b"));
    writeFileSync(join(tmp, "a", "fa.md"), "");
    writeFileSync(join(tmp, "b", "fb.md"), "");
    if (
      !trySymlink(join(tmp, "b"), join(tmp, "a", "x")) ||
      !trySymlink(join(tmp, "a"), join(tmp, "b", "y"))
    ) {
      return;
    }

    const { dirs, files, error } = await walk(join(tmp, "a"));

    expect(error).toBeNull();
    expect(dirs).toEqual([join(tmp, "a"), join(tmp, "a", "x")]);
    expect(files.sort()).toEqual(
      [join(tmp, "a", "fa.md"), join(tmp, "a", "x", "fb.md")].sort(),
    );
  });

  it("visits a directory before its contents, in sequential walk order", async () => {
    mkdirSync(join(tmp, "a", "b"), { recursive: true });
    writeFileSync(join(tmp, "a", "b", "c.md"), "");
    writeFileSync(join(tmp, "a", "x.md"), "");
    const order: string[] = [];
    await walkSymlinkTree(
      tmp,
      (d) => order.push(`dir:${d}`),
      (f) => order.push(`file:${f}`),
    );

    expect(order.indexOf(`dir:${tmp}`)).toBe(0);
    expect(order.indexOf(`dir:${join(tmp, "a")}`)).toBeLessThan(
      order.indexOf(`dir:${join(tmp, "a", "b")}`),
    );
    expect(order.indexOf(`dir:${join(tmp, "a", "b")}`)).toBeLessThan(
      order.indexOf(`file:${join(tmp, "a", "b", "c.md")}`),
    );
  });

  it("reports dangling symlinks as unresolved instead of visiting them", async () => {
    writeFileSync(join(tmp, "real.md"), "");
    if (!trySymlink(join(tmp, "gone"), join(tmp, "broken"))) return;

    const { dirs, files, unresolved, error } = await walk(tmp);

    expect(error).toBeNull();
    expect(dirs).toEqual([tmp]);
    expect(files).toEqual([join(tmp, "real.md")]);
    expect(unresolved).toEqual([join(tmp, "broken")]);
  });

  it("reports a missing root as unresolved together with the error", async () => {
    const missing = join(tmp, "missing");

    const { dirs, unresolved, error } = await walk(missing);

    expect(dirs).toEqual([]);
    expect(unresolved).toEqual([missing]);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("expandRecursiveGlob", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "yome-rglob-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("matches files inside symlinked directories under every alias", async () => {
    mkdirSync(join(tmp, "real"));
    writeFileSync(join(tmp, "real", "a.md"), "");
    writeFileSync(join(tmp, "real", "skip.txt"), "");
    try {
      symlinkSync(join(tmp, "real"), join(tmp, "link"));
    } catch {
      return;
    }

    const matches = await expandRecursiveGlob(tmp, "**/*.md");

    expect(matches.sort()).toEqual(
      [join(tmp, "link", "a.md"), join(tmp, "real", "a.md")].sort(),
    );
  });

  it("matches relative to the base, so the base path itself is never a pattern", async () => {
    const base = join(tmp, "my{docs}");
    mkdirSync(join(base, "sub"), { recursive: true });
    writeFileSync(join(base, "sub", "a.md"), "");

    expect(await expandRecursiveGlob(base, "**/*.md")).toEqual([
      join(base, "sub", "a.md"),
    ]);
  });

  it("throws when the base cannot be walked", async () => {
    await expect(
      expandRecursiveGlob(join(tmp, "missing"), "**/*.md"),
    ).rejects.toThrow();
  });
});

describe("isSymlinkCycle", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "yome-cycle-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function link(target: string, path: string): boolean {
    try {
      symlinkSync(target, path);
      return true;
    } catch {
      return false;
    }
  }

  it("flags a link to a directory above it", () => {
    mkdirSync(join(tmp, "nested"));
    if (!link(tmp, join(tmp, "nested", "back"))) return;
    expect(isSymlinkCycle(join(tmp, "nested", "back"))).toBe(true);
  });

  it("flags the link that closes a cycle through another link", () => {
    mkdirSync(join(tmp, "a"));
    mkdirSync(join(tmp, "b"));
    if (
      !link(join(tmp, "b"), join(tmp, "a", "x")) ||
      !link(join(tmp, "a"), join(tmp, "b", "y"))
    ) {
      return;
    }
    expect(isSymlinkCycle(join(tmp, "a", "x"))).toBe(false);
    expect(isSymlinkCycle(join(tmp, "a", "x", "y"))).toBe(true);
  });

  it("leaves links to siblings, to files and dangling links alone", () => {
    mkdirSync(join(tmp, "target"));
    writeFileSync(join(tmp, "file.md"), "");
    mkdirSync(join(tmp, "pending"));
    if (
      !link(join(tmp, "target"), join(tmp, "pending", "task")) ||
      !link(join(tmp, "file.md"), join(tmp, "pending", "file.md")) ||
      !link(join(tmp, "gone"), join(tmp, "pending", "broken"))
    ) {
      return;
    }
    expect(isSymlinkCycle(join(tmp, "pending", "task"))).toBe(false);
    expect(isSymlinkCycle(join(tmp, "pending", "file.md"))).toBe(false);
    expect(isSymlinkCycle(join(tmp, "pending", "broken"))).toBe(false);
  });
});
