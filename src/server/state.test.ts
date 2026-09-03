import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "./state.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "yome-state-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("State", () => {
  it("adds a file to the default group", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    const path = join(tmp, "a.md");
    await writeFile(path, "# Hello\n");
    const entry = state.addFile(path, "default");
    expect(entry.name).toBe("a.md");
    expect(entry.title).toBe("Hello");
    expect(entry.id).toMatch(/^[0-9a-f]{8}$/);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("dedupes by absolute path within a group", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    const path = join(tmp, "a.md");
    await writeFile(path, "# Hello\n");
    const a = state.addFile(path, "default");
    const b = state.addFile(path, "default");
    expect(a.id).toBe(b.id);
    expect(state.listGroups()[0]?.files).toHaveLength(1);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("rejects binary files", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    const path = join(tmp, "binary");
    await writeFile(path, Buffer.from([0xff, 0x00, 0x01, 0x02]));
    expect(() => state.addFile(path, "default")).toThrow(/binary/);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("removes file and group when empty", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    const path = join(tmp, "a.md");
    await writeFile(path, "# Hello\n");
    const entry = state.addFile(path, "g1");
    expect(state.listGroups()).toHaveLength(1);
    expect(state.removeFile(entry.id, "g1")).toBe(true);
    expect(state.listGroups()).toHaveLength(0);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("reorders files within a group", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    const p1 = join(tmp, "a.md");
    const p2 = join(tmp, "b.md");
    await writeFile(p1, "# A");
    await writeFile(p2, "# B");
    const e1 = state.addFile(p1, "default");
    const e2 = state.addFile(p2, "default");
    expect(state.reorderFiles("default", [e2.id, e1.id])).toBe(true);
    expect(state.listGroups()[0]?.files.map((f) => f.id)).toEqual([
      e2.id,
      e1.id,
    ]);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("moves a file between groups", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    const path = join(tmp, "a.md");
    await writeFile(path, "# A");
    const entry = state.addFile(path, "src");
    const result = state.moveFile(entry.id, "src", "dst");
    expect("ok" in result && result.ok).toBe(true);
    expect(
      state.listGroups().find((g) => g.name === "dst")?.files,
    ).toHaveLength(1);
    expect(state.listGroups().find((g) => g.name === "src")).toBeUndefined();
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("handles uploaded files", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    const e1 = state.addUploadedFile("stdin.md", "hello world", "default");
    const e2 = state.addUploadedFile("stdin.md", "hello world", "default");
    expect(e1.id).toBe(e2.id);
    expect(e1.uploaded).toBe(true);
    expect(state.listGroups()[0]?.files).toHaveLength(1);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("adds and removes a glob pattern", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    await writeFile(join(tmp, "a.md"), "# A");
    await writeFile(join(tmp, "b.md"), "# B");
    const entries = await state.addPattern(join(tmp, "*.md"), "default");
    expect(entries).toHaveLength(2);
    expect(state.patternsForGroup("default")).toEqual([join(tmp, "*.md")]);
    expect(state.removePattern(join(tmp, "*.md"), "default")).toBe(true);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("returns snapshot copies that do not alias internal entries", async () => {
    const state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
    const path = join(tmp, "a.md");
    await writeFile(path, "# Hello\n");
    const entry = state.addFile(path, "default");
    const listed = state.listGroups()[0]!.files[0]!;
    listed.title = "tampered";
    const snap = state.snapshotGroup("default")!.files[0]!;
    snap.title = "tampered too";
    expect(state.findFile(entry.id, "default")?.title).toBe("Hello");
    // The internal array is not shared either.
    state.listGroups()[0]!.files.length = 0;
    expect(state.listGroups()[0]?.files).toHaveLength(1);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("rejects binary uploaded content", async () => {
    const state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
    expect(() =>
      state.addUploadedFile("blob.md", "PNG\0\0\0", "default"),
    ).toThrow(/binary/);
    expect(state.listGroups()).toEqual([]);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("drops an empty title instead of storing an empty string on change", async () => {
    const state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
    const path = join(tmp, "t.md");
    await writeFile(path, "# Titled\n");
    const entry = state.addFile(path, "default");
    expect(entry.title).toBe("Titled");
    await writeFile(path, "no heading anymore\n");
    (
      state as unknown as { notifyFileChangedByPath: (p: string) => void }
    ).notifyFileChangedByPath(path);
    const after = state.findFile(entry.id, "default")!;
    expect("title" in after).toBe(false);
    expect(JSON.stringify(after)).not.toContain('"title"');
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("adds a newly created file to every group whose pattern matches", async () => {
    const state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
    await mkdir(join(tmp, "docs"));
    await state.addPattern(join(tmp, "docs", "*.md"), "alpha");
    await state.addPattern(join(tmp, "docs", "**", "*.md"), "beta");
    await state.addPattern(join(tmp, "docs", "*.txt"), "gamma");
    const created = join(tmp, "docs", "later.md");
    await writeFile(created, "# Later");
    // Simulate the watcher's create event for the new file.
    await (
      state as unknown as { handleCreateForGlobs: (p: string) => Promise<void> }
    ).handleCreateForGlobs(created);
    const inGroup = (name: string) =>
      state
        .listGroups()
        .find((g) => g.name === name)
        ?.files.some((f) => f.path === created) ?? false;
    // Same outcome as registration-time expansion: both matching groups
    // get the file, the non-matching one does not.
    expect(inGroup("alpha")).toBe(true);
    expect(inGroup("beta")).toBe(true);
    expect(inGroup("gamma")).toBe(false);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("keeps a directory watch while another recursive pattern still covers it", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    await mkdir(join(tmp, "docs"));
    const mdPattern = join(tmp, "docs", "**", "*.md");
    const txtPattern = join(tmp, "docs", "**", "*.txt");
    await state.addPattern(mdPattern, "default");
    await state.addPattern(txtPattern, "default");
    const priv = state as unknown as {
      watchedDirs: Map<string, number>;
      handleCreateForGlobs: (p: string) => Promise<void>;
    };
    expect(priv.watchedDirs.get(join(tmp, "docs"))).toBe(2);

    // A directory created later must be ref-counted once per covering
    // pattern, exactly like directories that existed at registration time.
    const later = join(tmp, "docs", "later");
    await mkdir(later);
    await priv.handleCreateForGlobs(later);
    expect(priv.watchedDirs.get(later)).toBe(2);

    // A directory outside every pattern's base is left alone.
    const outside = join(tmp, "docs2");
    await mkdir(outside);
    await priv.handleCreateForGlobs(outside);
    expect(priv.watchedDirs.has(outside)).toBe(false);

    state.removePattern(mdPattern, "default");
    const deadline = Date.now() + 2000;
    while (priv.watchedDirs.get(later) !== 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(priv.watchedDirs.get(later)).toBe(1);
    expect(priv.watchedDirs.get(join(tmp, "docs"))).toBe(1);
    state.closeAllSubscribers();
    await state.closeBackup();
  });

  it("re-registering a pattern is idempotent and returns current matches", async () => {
    const state = new State({ fileChangeDebounceMs: 0 });
    await writeFile(join(tmp, "a.md"), "# A");
    const first = await state.addPattern(join(tmp, "*.md"), "default");
    expect(first).toHaveLength(1);
    const again = await state.addPattern(join(tmp, "*.md"), "default");
    expect(again).toHaveLength(1);
    // Registered once, and files are not duplicated either.
    expect(state.patternsForGroup("default")).toEqual([join(tmp, "*.md")]);
    const group = state.listGroups().find((g) => g.name === "default");
    expect(group?.files).toHaveLength(1);
    state.closeAllSubscribers();
    await state.closeBackup();
  });
});
