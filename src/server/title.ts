import { openSync, readSync, closeSync } from "node:fs";

export const HEAD_FILE_SIZE_LIMIT = 8192;

// leadingColumns counts the indentation of a line in columns, expanding tabs to
// the next 4-column tab stop (CommonMark §2.1).
export function leadingColumns(line: string): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32 /* space */) {
      col++;
    } else if (c === 9 /* tab */) {
      col = (Math.floor(col / 4) + 1) * 4;
    } else {
      return col;
    }
  }
  return col;
}

// FenceTracker follows CommonMark code-fence state across successive lines so
// callers can skip fenced content when scanning for headings.
export class FenceTracker {
  private char = 0;
  private len = 0;

  get inFence(): boolean {
    return this.char !== 0;
  }

  // feed processes one line and returns true when the line is a fence
  // delimiter (opening or closing). Indented lines (4+ columns) never open
  // or close a fence.
  feed(line: string): boolean {
    if (leadingColumns(line) >= 4) return false;
    const trimmed = line.trim();
    if (this.char !== 0) {
      if (trimmed.length === 0 || trimmed.charCodeAt(0) !== this.char) {
        return false;
      }
      let fl = 0;
      while (fl < trimmed.length && trimmed.charCodeAt(fl) === this.char) fl++;
      const rest = trimmed.substring(fl).replace(/^[ \t]+/, "");
      if (fl >= this.len && rest === "") {
        this.char = 0;
        this.len = 0;
        return true;
      }
      return false;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const fc = trimmed.charCodeAt(0);
      let fl = 0;
      while (fl < trimmed.length && trimmed.charCodeAt(fl) === fc) fl++;
      this.char = fc;
      this.len = fl;
      return true;
    }
    return false;
  }
}

// extractTitle returns the text of the first ATX heading outside code fences.
export function extractTitle(content: string): string {
  const fences = new FenceTracker();
  for (const line of content.split("\n")) {
    if (fences.feed(line) || fences.inFence) continue;
    const title = extractHeadingLine(line);
    if (title !== "") return title;
  }
  return "";
}

export function extractHeadingLine(line: string): string {
  if (leadingColumns(line) >= 4) return "";
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) return "";
  let hashes = 0;
  while (hashes < trimmed.length && trimmed.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return "";
  const after = trimmed.substring(hashes);
  if (
    after.length === 0 ||
    (after.charCodeAt(0) !== 32 && after.charCodeAt(0) !== 9)
  )
    return "";
  let title = after.trim();
  if (title.length > 0 && title.charCodeAt(title.length - 1) === 35) {
    let i = title.length;
    while (i > 0 && title.charCodeAt(i - 1) === 35) i--;
    if (
      i === 0 ||
      title.charCodeAt(i - 1) === 32 ||
      title.charCodeAt(i - 1) === 9
    ) {
      title = i === 0 ? "" : title.substring(0, i).replace(/[ \t]+$/, "");
    }
  }
  return title;
}

export function extractTitleFromFile(path: string): {
  title: string;
  ok: boolean;
} {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { title: "", ok: false };
  }
  try {
    const buf = Buffer.alloc(HEAD_FILE_SIZE_LIMIT);
    const n = readSync(fd, buf, 0, HEAD_FILE_SIZE_LIMIT, 0);
    return {
      title: extractTitle(buf.subarray(0, n).toString("utf8")),
      ok: true,
    };
  } catch {
    return { title: "", ok: false };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}
