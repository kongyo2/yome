import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "./state.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "yome-backup-state-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("enableBackup", () => {
  it("invokes the save callback after state changes (debounced)", async () => {
    const state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
    const saves: Array<{ groups: Record<string, string[]> }> = [];
    state.enableBackup((data) => {
      saves.push({ groups: { ...data.groups } });
    });
    const path = join(tmp, "a.md");
    writeFileSync(path, "# A");
    state.addFile(path, "default");
    await new Promise((r) => setTimeout(r, 1200));
    expect(saves.length).toBeGreaterThanOrEqual(1);
    expect(saves.at(-1)?.groups["default"]).toEqual([path]);
    state.closeAllSubscribers();
    state.closeBackup();
  });

  it("flushes the final save when closeBackup is called", async () => {
    const state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
    const saves: Array<{ groups: Record<string, string[]> }> = [];
    state.enableBackup((data) => {
      saves.push({ groups: { ...data.groups } });
    });
    const path = join(tmp, "b.md");
    writeFileSync(path, "# B");
    state.addFile(path, "default");
    state.closeBackup();
    state.closeAllSubscribers();
    expect(saves.length).toBeGreaterThanOrEqual(1);
    expect(saves.at(-1)?.groups["default"]).toEqual([path]);
  });
});

describe("snapshotRestoreData", () => {
  it("captures groups, patterns, and uploaded files", async () => {
    const state = new State({ fileChangeDebounceMs: 0, disableWatcher: true });
    const path = join(tmp, "a.md");
    writeFileSync(path, "# A");
    state.addFile(path, "default");
    await state.addPattern(join(tmp, "*.md"), "default");
    state.addUploadedFile("stdin.md", "hello", "default");
    const snap = state.snapshotRestoreData();
    expect(snap.groups["default"]).toEqual([path]);
    expect(snap.patterns?.["default"]).toEqual([join(tmp, "*.md")]);
    expect(snap.uploadedFiles).toEqual([
      { name: "stdin.md", content: "hello", group: "default" },
    ]);
    state.closeAllSubscribers();
    state.closeBackup();
  });
});
