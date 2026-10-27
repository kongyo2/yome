import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { State } from "./state.js";

let tmp: string;
let state: State;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "yome-watch-"));
  state = new State({ fileChangeDebounceMs: 30 });
});

afterEach(async () => {
  state.closeAllSubscribers();
  await state.closeBackup();
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

  it("keeps the entry and reports a change on an atomic save (write temp + rename)", async () => {
    const path = join(tmp, "atomic.md");
    await writeFile(path, "# Before");
    state.addFile(path, "default");
    const seen: string[] = [];
    state.subscribe((e) => {
      if (e.name === "file-changed") seen.push(e.data);
    });
    await new Promise((r) => setTimeout(r, 100));
    // Editors like vim/VS Code replace the inode instead of writing in place.
    const tmpPath = join(tmp, ".atomic.md.tmp");
    await writeFile(tmpPath, "# After");
    await rename(tmpPath, path);
    await waitFor(() => seen.length > 0, 3000);
    // Give a wrongly-detected deletion time to surface, then verify.
    await new Promise((r) => setTimeout(r, 300));
    const g = state.listGroups().find((x) => x.name === "default");
    expect(g?.files.some((f) => f.path === path)).toBe(true);
    expect(g?.files.find((f) => f.path === path)?.title).toBe("After");

    // The file must still be watched after the inode swap.
    seen.length = 0;
    await writeFile(path, "# Again");
    await waitFor(() => seen.length > 0, 3000);
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
  it("picks up a symlinked directory created under a recursive pattern", async () => {
    const target = join(tmp, "outbound", "task");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "existing.md"), "# Existing");
    await state.addPattern(join(tmp, "**", "*.md"), "default");
    await new Promise((r) => setTimeout(r, 150));
    await mkdir(join(tmp, "pending"));
    const link = join(tmp, "pending", "task");
    try {
      await symlink(target, link);
    } catch {
      // Symlinks unavailable (e.g. Windows without privileges).
      return;
    }
    const hasPath = (path: string) =>
      state
        .listGroups()
        .find((g) => g.name === "default")
        ?.files.some((f) => f.path === path) ?? false;
    await waitFor(() => hasPath(join(link, "existing.md")), 4000);
    // A file created later in the target shows up under the link as well.
    await writeFile(join(target, "created.md"), "# Created");
    await waitFor(() => hasPath(join(link, "created.md")), 4000);
    expect(hasPath(join(target, "created.md"))).toBe(true);
  });
  it("does not report a file once per lap of a symlink loop", async () => {
    const tree = join(tmp, "tree");
    await mkdir(join(tree, "real"), { recursive: true });
    await writeFile(join(tree, "real", "a.md"), "# A");
    try {
      // tree/real/loop -> tree: following it never ends.
      await symlink(tree, join(tree, "real", "loop"));
    } catch {
      // Symlinks unavailable (e.g. Windows without privileges).
      return;
    }
    await state.addPattern(join(tree, "**", "*.md"), "default");
    await new Promise((r) => setTimeout(r, 150));
    const paths = () =>
      state
        .listGroups()
        .find((g) => g.name === "default")
        ?.files.map((f) => f.path) ?? [];
    const created = join(tree, "real", "later.md");
    await writeFile(created, "# Later");
    await waitFor(() => paths().includes(created), 4000);
    // Give events for alias paths through the loop time to surface.
    await new Promise((r) => setTimeout(r, 400));
    expect(paths().filter((p) => p.endsWith("later.md"))).toEqual([created]);
    expect(paths().some((p) => p.includes(`${sep}loop${sep}`))).toBe(false);
  });
});
