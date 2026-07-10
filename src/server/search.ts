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
