import { readFile } from "node:fs/promises";
import { extractHeadingLine, FenceTracker } from "./title.js";
import type { FileEntry } from "./types.js";

export interface SearchAnchor {
  kind: string;
  value: string;
}

export interface SearchMatch {
  line: number;
  column?: number;
  text: string;
  before?: string[];
  after?: string[];
  heading?: string;
  anchor: SearchAnchor;
}

export interface SearchResult {
  fileId: string;
  fileName: string;
  title?: string;
  path: string;
  uploaded: boolean;
  matches: SearchMatch[];
}

export async function readSearchableContent(entry: FileEntry): Promise<string> {
  if (entry.uploaded) return entry.content ?? "";
  return await readFile(entry.path, "utf8");
}

export function findSearchMatches(
  content: string,
  needle: string,
  contextLines: number,
  limit: number,
): SearchMatch[] {
  if (needle === "" || limit <= 0) return [];
  // A needle containing a newline can never match a single line; the
  // per-line scan this function replaces returned no results for it.
  if (needle.includes("\n")) return [];

  // Lowercase the whole document once and jump between hits with indexOf
  // instead of lowercasing and scanning every line individually. Documents
  // without a hit exit after a single linear scan; documents with hits only
  // slice out the lines actually visited (everything after the final hit is
  // never touched).
  const lower = content.toLowerCase();
  if (lower.length !== content.length) {
    // Rare special-casing expansions (e.g. İ → i̇) shift offsets between
    // `lower` and `content`; fall back to the reference per-line scan for
    // exact parity.
    return findSearchMatchesPerLine(content, needle, contextLines, limit);
  }
  let pos = lower.indexOf(needle);
  if (pos < 0) return [];

  const len = content.length;
  const matches: SearchMatch[] = [];
  let currentHeading = "";
  const fences = new FenceTracker();
  const feed = (l: string): void => {
    if (!fences.feed(l) && !fences.inFence) {
      const h = extractHeadingLine(l);
      if (h !== "") currentHeading = h;
    }
  };
  const lineEndAt = (start: number): number => {
    const nl = content.indexOf("\n", start);
    return nl === -1 ? len : nl;
  };

  let lineIdx = 0;
  let lineStart = 0;
  let lineEnd = lineEndAt(0);
  // Ring of the last `contextLines` line texts before the current line.
  const beforeRing: string[] = [];
  const pushBefore = (l: string): void => {
    if (contextLines <= 0) return;
    beforeRing.push(l);
    if (beforeRing.length > contextLines) beforeRing.shift();
  };

  while (pos >= 0 && matches.length < limit) {
    // Advance lines until pos falls inside the current one, feeding each
    // passed line into fence/heading state (identical to the per-line scan).
    while (pos > lineEnd) {
      const l = content.slice(lineStart, lineEnd);
      feed(l);
      pushBefore(l);
      lineIdx++;
      lineStart = lineEnd + 1;
      lineEnd = lineEndAt(lineStart);
    }

    const line = content.slice(lineStart, lineEnd);
    feed(line);

    const m: SearchMatch = {
      line: lineIdx + 1,
      column: pos - lineStart + 1,
      text: line,
      anchor: { kind: "heading", value: currentHeading },
    };
    if (beforeRing.length > 0) m.before = [...beforeRing];
    if (contextLines > 0 && lineEnd < len) {
      const after: string[] = [];
      let aStart = lineEnd + 1;
      for (let k = 0; k < contextLines; k++) {
        const aEnd = lineEndAt(aStart);
        after.push(content.slice(aStart, aEnd));
        if (aEnd >= len) break;
        aStart = aEnd + 1;
      }
      if (after.length > 0) m.after = after;
    }
    if (currentHeading !== "") m.heading = currentHeading;
    matches.push(m);

    // One match per line: resume the scan at the start of the next line.
    pushBefore(line);
    lineIdx++;
    lineStart = lineEnd + 1;
    lineEnd = lineEndAt(lineStart);
    if (lineStart > len) break;
    pos = lower.indexOf(needle, lineStart);
  }
  return matches;
}

// Reference implementation: lowercases and scans line by line. Only used
// when case mapping changes the document length (so fast-path offsets would
// not line up); kept verbatim for exact behavioral parity.
function findSearchMatchesPerLine(
  content: string,
  needle: string,
  contextLines: number,
  limit: number,
): SearchMatch[] {
  const lines = content.split("\n");
  const matches: SearchMatch[] = [];
  let currentHeading = "";
  const fences = new FenceTracker();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (!fences.feed(line) && !fences.inFence) {
      const h = extractHeadingLine(line);
      if (h !== "") currentHeading = h;
    }

    const idx = line.toLowerCase().indexOf(needle);
    if (idx < 0) continue;

    const beforeStart = Math.max(0, i - contextLines);
    const afterEnd = Math.min(lines.length, i + contextLines + 1);

    const m: SearchMatch = {
      line: i + 1,
      column: idx + 1,
      text: line,
      anchor: { kind: "heading", value: currentHeading },
    };
    const before = lines.slice(beforeStart, i);
    if (before.length > 0) m.before = before;
    const after = lines.slice(i + 1, afterEnd);
    if (after.length > 0) m.after = after;
    if (currentHeading !== "") m.heading = currentHeading;
    matches.push(m);
    if (matches.length >= limit) break;
  }
  return matches;
}
