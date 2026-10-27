import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "./state.js";

// A base directory that stats as a directory but cannot be read is hard to
// produce portably (root can read anything), so the failure is injected into
// the recursive expansion instead.
vi.mock("../common/glob-match.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../common/glob-match.js")>();
  return {
    ...mod,
    expandRecursiveGlob: vi.fn(() =>
      Promise.reject(new Error("EACCES: permission denied, scandir")),
    ),
  };
});

let tmp: string;
let state: State;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "yome-rollback-"));
  await mkdir(join(tmp, "docs"));
  state = new State({ fileChangeDebounceMs: 0 });
});

afterEach(async () => {
  state.closeAllSubscribers();
  await state.closeBackup();
  await rm(tmp, { recursive: true, force: true });
});

describe("addPattern when the initial expansion fails", () => {
  it("rolls back the pattern, its directory watches and the group it created", async () => {
    const pattern = join(tmp, "docs", "**", "*.md");

    await expect(state.addPattern(pattern, "fresh")).rejects.toThrow(
      /glob expansion failed/,
    );

    expect(state.patternsForGroup("fresh")).toEqual([]);
    expect(state.listGroups().map((g) => g.name)).toEqual([]);
    expect(state.snapshotRestoreData().patterns).toBeUndefined();
    const priv = state as unknown as { watchedDirs: Map<string, number> };
    expect([...priv.watchedDirs.keys()]).toEqual([]);
  });

  it("keeps a group that existed before the failed pattern", async () => {
    const path = join(tmp, "keep.md");
    await writeFile(path, "# Keep");
    state.addFile(path, "default");

    await expect(
      state.addPattern(join(tmp, "docs", "**", "*.md"), "default"),
    ).rejects.toThrow(/glob expansion failed/);

    expect(state.patternsForGroup("default")).toEqual([]);
    expect(state.listGroups()[0]?.files.map((f) => f.path)).toEqual([path]);
  });
});
