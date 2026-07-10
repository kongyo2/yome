import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
