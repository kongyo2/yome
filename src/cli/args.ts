import { isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { statSync } from "node:fs";
import {
  expandGlob,
  hasGlobChars,
  splitPattern,
  toSlash,
  sortPathsNatural,
} from "../common/glob.js";

export const MARKDOWN_GLOB = "*.md";
export const MARKDOWN_GLOB_RECURSIVE = "**/*.md";

export function markdownGlobFor(recursive: boolean): string {
  return recursive ? MARKDOWN_GLOB_RECURSIVE : MARKDOWN_GLOB;
}

export function toAbsolute(p: string): string {
  return isAbsolute(p) ? p : pathResolve(p);
}

export async function expandGlobAbsolute(
  absPattern: string,
): Promise<string[]> {
  const { base, rel } = splitPattern(toSlash(absPattern));
  const matches = await expandGlob(base, rel, { filesOnly: true });
  sortPathsNatural(matches);
  return matches;
}

export interface ResolvedArgs {
  files: string[];
  patterns: string[];
}

export async function resolveArgs(
  args: string[],
  watchMode: boolean,
  recursive: boolean,
): Promise<ResolvedArgs> {
  const files: string[] = [];
  const patterns: string[] = [];

  for (const arg of args) {
    const abs = toAbsolute(arg);

    if (hasGlobChars(arg)) {
      if (watchMode) {
        patterns.push(abs);
        continue;
      }
      const matches = await expandGlobAbsolute(abs);
      if (matches.length === 0) {
        throw new Error(`no files matched ${arg}`);
      }
      files.push(...matches);
      continue;
    }

    let st;
    try {
      st = statSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`file not found: ${abs}`, { cause: err });
      }
      throw new Error(`cannot stat path ${abs}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (st.isDirectory()) {
      const pat = join(abs, markdownGlobFor(recursive));
      if (watchMode) {
        patterns.push(pat);
        continue;
      }
      const matches = await expandGlobAbsolute(pat);
      if (matches.length === 0) {
        throw new Error(`no .md files in ${abs}`);
      }
      files.push(...matches);
      continue;
    }
    files.push(abs);
  }
  return { files, patterns };
}

export interface ResolveUnwatchOpts {
  registered: string[]; // already-fetched patterns for the group
}

export async function resolveUnwatchArgs(
  args: string[],
  recursive: boolean,
  fetchRegistered: () => Promise<string[]>,
): Promise<string[]> {
  const patterns: string[] = [];
  let registered: string[] | null = null;

  for (const arg of args) {
    const abs = toAbsolute(arg);

    if (hasGlobChars(arg)) {
      patterns.push(abs);
      continue;
    }

    let st;
    try {
      st = statSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (!recursive)
          throw new Error(`path not found: ${abs}`, { cause: err });
      } else {
        throw new Error(`cannot stat path ${abs}: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
    if (st && !st.isDirectory()) {
      throw new Error(
        "--unwatch requires glob patterns or directories, not individual files (hint: use --close to remove individual files)",
      );
    }

    if (recursive) {
      if (registered === null) {
        registered = await fetchRegistered();
      }
      const prefix = abs + sep;
      const matched = registered.filter((p) => p.startsWith(prefix));
      if (matched.length === 0) {
        throw new Error(
          `no watched patterns found under ${abs} (use --status to see registered patterns)`,
        );
      }
      patterns.push(...matched);
    } else {
      patterns.push(join(abs, MARKDOWN_GLOB));
    }
  }
  // Dedupe preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of patterns) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }
  return unique;
}
