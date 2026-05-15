import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "./state.js";

let tmp: string;
let state: State;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mo-watch-"));
  state = new State({ fileChangeDebounceMs: 30 });
});

afterEach(async () => {
  state.closeAllSubscribers();
  state.closeBackup();
  await rm(tmp, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error("waitFor timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("file watcher integration", () => {
  it("emits a file-changed SSE event when a watched file is modified", async () => {
    const path = join(tmp, "live.md");
    await writeFile(path, "# Original");
    state.addFile(path, "default");
    const seen: string[] = [];
    state.subscribe((e) => {
      if (e.name === "file-changed") seen.push(e.data);
    });
    await new Promise((r) => setTimeout(r, 100));
    await writeFile(path, "# Updated");
    await waitFor(() => seen.length > 0, 3000);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("auto-adds new files matching a glob pattern", async () => {
    await state.addPattern(join(tmp, "*.md"), "default");
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(join(tmp, "new.md"), "# New");
    await waitFor(() => {
      const g = state.listGroups().find((x) => x.name === "default");
      return g != null && g.files.some((f) => f.name === "new.md");
    }, 4000);
    const g = state.listGroups().find((x) => x.name === "default");
    expect(g?.files.some((f) => f.name === "new.md")).toBe(true);
  });

  it("removes a file entry when its underlying file is unlinked", async () => {
    const path = join(tmp, "removable.md");
    await writeFile(path, "# X");
    state.addFile(path, "default");
    await new Promise((r) => setTimeout(r, 100));
    await unlink(path);
    await waitFor(() => state.listGroups().length === 0, 4000);
    expect(state.listGroups()).toEqual([]);
  });
});
