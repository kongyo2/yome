import { readdirSync, realpathSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, normalize, posix, sep, isAbsolute } from "node:path";
import picomatch from "picomatch";

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

export function fromSlash(p: string): string {
  if (sep === "/") return p;
  return p.split("/").join(sep);
}

// matchPattern returns true if absPath matches absPattern using doublestar semantics.
export function matchPattern(absPattern: string, absPath: string): boolean {
  const matcher = picomatch(toSlash(absPattern), { dot: false, nocase: false });
  return matcher(toSlash(absPath));
}

interface GlobOptions {
  filesOnly?: boolean;
}

// expandGlob expands a pattern relative to base and returns matching paths.
export async function expandGlob(
  base: string,
  rel: string,
  opts: GlobOptions = {},
): Promise<string[]> {
  const filesOnly = opts.filesOnly ?? true;
  if (!isAbsolute(base)) {
    throw new Error(`base must be absolute: ${base}`);
  }

  const isRecursive = rel.includes("**");
  const matcher = picomatch(rel, { dot: false, nocase: false });

  const results: string[] = [];

  async function walk(dir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      const childAbs = join(dir, e.name);
      if (e.isDirectory()) {
        if (isRecursive) {
          await walk(childAbs, childRel);
        } else {
          // Non-recursive: still descend if pattern is multi-level
          await walk(childAbs, childRel);
        }
        if (!filesOnly && matcher(childRel)) {
          results.push(childAbs);
        }
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (matcher(childRel)) {
          results.push(childAbs);
        }
      }
    }
  }

  try {
    await walk(base, "");
  } catch {
    // ignore
  }
  return results;
}

export function expandGlobSync(
  base: string,
  rel: string,
  opts: GlobOptions = {},
): string[] {
  return globSyncWalk(base, rel, opts);
}

function globSyncWalk(base: string, rel: string, opts: GlobOptions): string[] {
  const filesOnly = opts.filesOnly ?? true;
  const matcher = picomatch(rel, { dot: false, nocase: false });
  const results: string[] = [];

  function walk(dir: string, relDir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      const childAbs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(childAbs, childRel);
        if (!filesOnly && matcher(childRel)) {
          results.push(childAbs);
        }
      } else {
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            isFile = statSync(childAbs).isFile();
          } catch {
            isFile = false;
          }
        }
        if (isFile && matcher(childRel)) {
          results.push(childAbs);
        }
      }
    }
  }
  walk(base, "");
  return results;
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

export function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Naturally sort with case-insensitive locale-aware numeric compare.
const collator = new Intl.Collator(undefined, { numeric: true });
export function sortPathsNatural(paths: string[]): void {
  paths.sort((a, b) => collator.compare(a, b));
}

// Normalize a path consistently (no trailing separator unless root).
export function cleanPath(p: string): string {
  const normalized = normalize(p);
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    return normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

export function joinPosix(...parts: string[]): string {
  return posix.join(...parts);
}

// Walk a directory tree, calling fn(absPath) for each directory.
export async function walkDirs(
  baseDir: string,
  fn: (path: string) => void,
): Promise<void> {
  fn(baseDir);
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      await walkDirs(join(baseDir, e.name), fn);
    }
  }
}

export function walkDirsSync(
  baseDir: string,
  fn: (path: string) => void,
): void {
  fn(baseDir);
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      walkDirsSync(join(baseDir, e.name), fn);
    }
  }
}

// Walk all files in a directory (recursively).
export async function walkFiles(
  baseDir: string,
  fn: (path: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(baseDir, e.name);
    if (e.isDirectory()) {
      await walkFiles(abs, fn);
    } else if (e.isFile() || e.isSymbolicLink()) {
      try {
        const st = await stat(abs);
        if (st.isFile()) fn(abs);
      } catch {
        // ignore
      }
    }
  }
}
