import { realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const GLOB_CHARS = /[*?[\]]/;
export function hasGlobChars(s: string): boolean {
  return GLOB_CHARS.test(s);
}

// splitPattern returns [base, rel] like Go's doublestar.SplitPattern.
// The base is the longest path prefix without any glob metacharacters.
export function splitPattern(pat: string): { base: string; rel: string } {
  const slash = pat.replace(/\\/g, "/");
  const parts = slash.split("/");
  const baseParts: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (p.includes("*") || p.includes("?") || p.includes("[")) {
      break;
    }
    baseParts.push(p);
  }
  // If pattern is absolute (starts with /), preserve leading slash.
  let base = baseParts.join("/");
  if (base === "" && slash.startsWith("/")) base = "/";
  const rel = parts.slice(i).join("/");
  return { base, rel };
}

export function isRecursivePattern(pat: string): boolean {
  return pat.includes("**");
}

export function toSlash(p: string): string {
  return p.split(sep).join("/");
}

// pathSegments splits an OS-native path into its components for the SPA's
// file tree. Only the host's own separator splits it (via toSlash), so a
// backslash inside a POSIX file name stays part of the name; empty components
// are dropped so a rooted POSIX path, a drive letter and a UNC share all line
// up positionally for the tree's common-prefix comparison.
export function pathSegments(absPath: string): string[] {
  return toSlash(absPath)
    .split("/")
    .filter((s) => s !== "");
}

// Naturally sort with case-insensitive locale-aware numeric compare.
const collator = new Intl.Collator(undefined, { numeric: true });
export function sortPathsNatural(paths: string[]): void {
  paths.sort((a, b) => collator.compare(a, b));
}

// walkSymlinkTree preserves the exact visit order of a sequential
// depth-first traversal (siblings in readdir order, a directory's subtree
// before the next sibling) while running the underlying directory reads
// concurrently: each entry gets an ordered slot, subtree reads run in
// parallel, and results are stitched together in slot order. Only symlinks
// need stat()/realpath() calls — dirent type info covers regular
// files/directories — so following symlinks costs nothing for trees that
// have none.

// One visited entry, in visit order. "unresolved" is an entry that could not
// be classified: a dangling symlink, or one removed mid-walk.
interface TreeItem {
  kind: "dir" | "file" | "unresolved";
  path: string;
}

// The canonical (symlink-resolved) paths of the directories above an entry,
// innermost first, up to the filesystem root. Only a symlink can lead back to
// one of them, so only symlinks are checked against it.
interface Ancestors {
  canonical: string;
  parent: Ancestors | null;
}

function isAncestor(chain: Ancestors | null, canonical: string): boolean {
  for (let c = chain; c !== null; c = c.parent) {
    if (c.canonical === canonical) return true;
  }
  return false;
}

// The canonical paths of the directories above root, which a walk does not
// pass through but a symlink can still lead back to (`up -> ..`). Following
// such a link would re-enter the walked tree from above.
async function canonicalAncestors(root: string): Promise<Ancestors | null> {
  const dirs: string[] = [];
  for (let dir = dirname(root); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  const canonical = await Promise.all(
    dirs.map((d) => realpath(d).catch(() => null)),
  );
  let chain: Ancestors | null = null;
  for (let i = canonical.length - 1; i >= 0; i--) {
    const c = canonical[i];
    if (c != null) chain = { canonical: c, parent: chain };
  }
  return chain;
}

// isSymlinkCycle reports whether the symlink at p resolves to a directory
// above it — the rule walkSymlinkTree cuts cycles by — so the file watcher can
// skip it too instead of following the loop until the OS gives up (ELOOP).
// Synchronous because chokidar's ignore matcher is.
export function isSymlinkCycle(p: string): boolean {
  let target;
  try {
    target = realpathSync.native(p);
  } catch {
    return false;
  }
  for (let dir = dirname(p); ; dir = dirname(dir)) {
    try {
      if (realpathSync.native(dir) === target) return true;
    } catch {
      // an ancestor that does not resolve cannot be the target either
    }
    if (dirname(dir) === dir) return false;
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// collectTree lists everything below dir; a failure to read dir itself is
// left to the caller.
async function collectTree(dir: string, chain: Ancestors): Promise<TreeItem[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts: Array<TreeItem[] | TreeItem | undefined> = new Array(
    entries.length,
  );
  const tasks: Array<Promise<void>> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const abs = join(dir, e.name);
    const slot = i;
    if (e.isDirectory()) {
      // Not a symlink, so its canonical path follows from its parent's.
      const sub = { canonical: join(chain.canonical, e.name), parent: chain };
      tasks.push(
        collectSubtree(abs, sub).then((r) => {
          parts[slot] = r;
          return undefined;
        }),
      );
    } else if (e.isFile()) {
      parts[i] = { kind: "file", path: abs };
    } else if (e.isSymbolicLink()) {
      tasks.push(
        followSymlink(abs, chain).then((r) => {
          parts[slot] = r;
          return undefined;
        }),
      );
    }
  }
  if (tasks.length > 0) await Promise.all(tasks);
  const out: TreeItem[] = [];
  for (const p of parts) {
    if (p === undefined) continue;
    if (Array.isArray(p)) {
      for (const item of p) out.push(item);
    } else {
      out.push(p);
    }
  }
  return out;
}

// collectSubtree reports a directory below the root followed by its
// contents. The directory itself is already classified, so failing to read
// it only loses its subtree.
async function collectSubtree(
  dir: string,
  chain: Ancestors,
): Promise<TreeItem[]> {
  const items: TreeItem[] = [{ kind: "dir", path: dir }];
  try {
    for (const item of await collectTree(dir, chain)) items.push(item);
  } catch {
    // unreadable, or removed mid-walk
  }
  return items;
}

async function followSymlink(
  abs: string,
  chain: Ancestors,
): Promise<TreeItem[] | TreeItem | undefined> {
  let target;
  try {
    target = await stat(abs);
  } catch {
    return { kind: "unresolved", path: abs };
  }
  // A symlink only counts as a file if its target is a regular file.
  if (target.isFile()) return { kind: "file", path: abs };
  if (!target.isDirectory()) return undefined;
  let canonical;
  try {
    canonical = await realpath(abs);
  } catch {
    return { kind: "unresolved", path: abs };
  }
  // A link back to a directory above it (on the walked path or above the
  // root) would recurse forever. Any other alias of a directory is walked
  // under its own path, so every alias of a file is reported in its own
  // right.
  if (isAncestor(chain, canonical)) return undefined;
  return collectSubtree(abs, { canonical, parent: chain });
}

export interface TreeWalkResult {
  // Entries that could not be classified. They are reported rather than
  // dropped because a caller keeping per-directory state still has to reach
  // a directory that stopped resolving between watch setup and teardown.
  unresolved: string[];
  // Why root itself could not be walked; a failure below the root only cuts
  // off the affected subtree.
  error: Error | null;
}

// walkSymlinkTree walks root, descending through directory symlinks, and
// hands every directory to visitDir and every regular file (or symlink to
// one) to visitFile. Unlike readdir-based globbing, which never enters a
// symlinked directory, this reaches files whose directory is linked into
// the tree.
export async function walkSymlinkTree(
  root: string,
  visitDir: ((path: string) => void) | null,
  visitFile: ((path: string) => void) | null,
): Promise<TreeWalkResult> {
  let canonical;
  try {
    const st = await stat(root);
    if (!st.isDirectory()) {
      if (st.isFile()) visitFile?.(root);
      return { unresolved: [], error: null };
    }
    canonical = await realpath(root);
  } catch (err) {
    return { unresolved: [root], error: asError(err) };
  }
  visitDir?.(root);
  let items;
  try {
    const above = await canonicalAncestors(root);
    items = await collectTree(root, { canonical, parent: above });
  } catch (err) {
    // root already went to visitDir, so it must not also be reported as
    // unresolved: a teardown would otherwise release it twice.
    return { unresolved: [], error: asError(err) };
  }
  const unresolved: string[] = [];
  for (const item of items) {
    if (item.kind === "dir") visitDir?.(item.path);
    else if (item.kind === "file") visitFile?.(item.path);
    else unresolved.push(item.path);
  }
  return { unresolved, error: null };
}
