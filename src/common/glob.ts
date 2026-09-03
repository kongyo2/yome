import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";

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

export function resolvePathAlias(orig: string): string {
  try {
    const canonical = realpathSync(orig);
    if (canonical === orig) return "";
    return canonical;
  } catch {
    return "";
  }
}

// Naturally sort with case-insensitive locale-aware numeric compare.
const collator = new Intl.Collator(undefined, { numeric: true });
export function sortPathsNatural(paths: string[]): void {
  paths.sort((a, b) => collator.compare(a, b));
}

// The walkers below preserve the exact visit order of a sequential
// depth-first traversal (siblings in readdir order, a directory's subtree
// before the next sibling) while running the underlying directory reads
// concurrently: each entry gets an ordered slot, subtree reads run in
// parallel, and results are stitched together in slot order. Only symlinks
// need a stat() call — dirent type info covers regular files/directories —
// which alone removes one syscall per file compared to the previous
// sequential implementation.

async function collectDirs(dir: string): Promise<string[]> {
  const out: string[] = [dir];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const parts: Array<string[] | undefined> = new Array(entries.length);
  const tasks: Array<Promise<void>> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || !e.isDirectory()) continue;
    const slot = i;
    tasks.push(
      collectDirs(join(dir, e.name)).then((r) => {
        parts[slot] = r;
        return undefined;
      }),
    );
  }
  if (tasks.length > 0) await Promise.all(tasks);
  for (const p of parts) {
    if (p !== undefined) out.push(...p);
  }
  return out;
}

// Walk a directory tree, calling fn(absPath) for each directory.
export async function walkDirs(
  baseDir: string,
  fn: (path: string) => void,
): Promise<void> {
  const dirs = await collectDirs(baseDir);
  for (const d of dirs) fn(d);
}

async function collectFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const parts: Array<string[] | string | undefined> = new Array(entries.length);
  const tasks: Array<Promise<void>> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      const slot = i;
      tasks.push(
        collectFiles(abs).then((r) => {
          parts[slot] = r;
          return undefined;
        }),
      );
    } else if (e.isFile()) {
      parts[i] = abs;
    } else if (e.isSymbolicLink()) {
      // A symlink only counts as a file if its target is a regular file;
      // a symlink to a directory must not be descended into or reported.
      const slot = i;
      tasks.push(
        stat(abs).then(
          (st) => {
            if (st.isFile()) parts[slot] = abs;
            return undefined;
          },
          () => {
            // dangling symlink — ignore
            return undefined;
          },
        ),
      );
    }
  }
  if (tasks.length > 0) await Promise.all(tasks);
  const out: string[] = [];
  for (const p of parts) {
    if (p === undefined) continue;
    if (typeof p === "string") out.push(p);
    else out.push(...p);
  }
  return out;
}

// Walk all files in a directory (recursively).
export async function walkFiles(
  baseDir: string,
  fn: (path: string) => void,
): Promise<void> {
  const files = await collectFiles(baseDir);
  for (const f of files) fn(f);
}
