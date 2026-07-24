// Glob matching/expansion, split from glob.ts so that picomatch — which
// costs real parse time on every process start — is only loaded by code
// paths that actually match patterns (the server, and CLI invocations whose
// arguments contain globs or directories).
import { readdir, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import picomatch from "picomatch";
import { toSlash } from "./glob.js";

// Compiled matchers are cached because matchPattern runs for every watcher
// event against every registered pattern.
const matcherCache = new Map<string, (p: string) => boolean>();

// matchPattern returns true if absPath matches absPattern using doublestar semantics.
export function matchPattern(absPattern: string, absPath: string): boolean {
  const key = toSlash(absPattern);
  let matcher = matcherCache.get(key);
  if (!matcher) {
    matcher = picomatch(key, { dot: false, nocase: false });
    matcherCache.set(key, matcher);
  }
  return matcher(toSlash(absPath));
}

interface GlobOptions {
  filesOnly?: boolean;
}

// expandGlob expands a pattern relative to base and returns matching paths.
// Results preserve the order of a sequential depth-first walk (siblings in
// readdir order, subtree contents before the directory entry itself) while
// directory reads run concurrently.
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
  // For non-recursive patterns the maximum directory depth that can still
  // produce a match is (number of '/' in pattern). e.g. "*.md" → 0, so we
  // never descend; "a/*.md" → 1, so we descend exactly one level.
  const maxDirDepth = isRecursive ? Infinity : rel.split("/").length - 1;

  async function walk(
    dir: string,
    relDir: string,
    depth: number,
  ): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const parts: Array<string[] | string | undefined> = new Array(
      entries.length,
    );
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      const childRel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      const childAbs = join(dir, e.name);
      if (e.isDirectory()) {
        const includeSelf = !filesOnly && matcher(childRel);
        if (depth < maxDirDepth) {
          const slot = i;
          tasks.push(
            walk(childAbs, childRel, depth + 1).then((r) => {
              // The directory itself sorts after its own subtree, exactly
              // like the sequential walk emitted it.
              if (includeSelf) r.push(childAbs);
              parts[slot] = r;
            }),
          );
        } else if (includeSelf) {
          parts[i] = childAbs;
        }
      } else if (e.isFile()) {
        if (matcher(childRel)) parts[i] = childAbs;
      } else if (e.isSymbolicLink()) {
        // A symlink only counts as a file if its target is a regular file;
        // a symlink to a directory must not appear in file matches.
        const slot = i;
        tasks.push(
          stat(childAbs).then(
            (st) => {
              if (st.isFile() && matcher(childRel)) parts[slot] = childAbs;
            },
            () => {
              // dangling symlink — ignore
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

  try {
    return await walk(base, "", 0);
  } catch {
    return [];
  }
}
