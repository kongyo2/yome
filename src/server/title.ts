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

export function extractTitle(content: string): string {
  let fenceChar = 0;
  let fenceLen = 0;
  const lines = content.split("\n");
  for (const line of lines) {
    if (leadingColumns(line) >= 4) continue;
    const trimmed = line.trim();

    if (fenceChar !== 0) {
      if (trimmed.length > 0 && trimmed.charCodeAt(0) === fenceChar) {
        let fl = 0;
        while (fl < trimmed.length && trimmed.charCodeAt(fl) === fenceChar)
          fl++;
        const rest = trimmed.substring(fl).replace(/^[ \t]+/, "");
        if (fl >= fenceLen && rest === "") {
          fenceChar = 0;
          fenceLen = 0;
        }
      }
      continue;
    }

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const fc = trimmed.charCodeAt(0);
      let fl = 0;
      while (fl < trimmed.length && trimmed.charCodeAt(fl) === fc) fl++;
      fenceChar = fc;
      fenceLen = fl;
      continue;
    }

    if (trimmed.startsWith("#")) {
      let hashes = 0;
      while (
        hashes < trimmed.length &&
        trimmed.charCodeAt(hashes) === 35 /* # */
      )
        hashes++;
      if (hashes > 6) continue;
      const after = trimmed.substring(hashes);
      if (
        after.length === 0 ||
        (after.charCodeAt(0) !== 32 && after.charCodeAt(0) !== 9)
      )
        continue;
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
      if (title !== "") return title;
    }
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
    return { title: extractTitle(buf.slice(0, n).toString("utf8")), ok: true };
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
