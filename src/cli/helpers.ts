import { statSync } from "node:fs";
import { isIP } from "node:net";
import type { RestoreData, UploadedFileData } from "../backup/index.js";

export function isLoopbackBind(bind: string): boolean {
  if (bind === "localhost") return true;
  const v = isIP(bind);
  if (!v) return false;
  if (v === 4) return bind.startsWith("127.");
  if (v === 6) {
    // Normalize IPv6 via WHATWG URL parser so non-canonical loopback
    // spellings like "::01", "0:0:0:0:0:0:0:01", or "0::1" all
    // canonicalize to "[::1]" and pass the check.
    try {
      const normalized = new URL(`http://[${bind}]/`).hostname.toLowerCase();
      return normalized === "[::1]";
    } catch {
      const lower = bind.toLowerCase();
      return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
    }
  }
  return false;
}

export function mergeGroups(
  base: Map<string, string[]>,
  additional: Map<string, string[]>,
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const [g, items] of base) merged.set(g, [...items]);
  for (const [g, items] of additional) {
    const list = merged.get(g) ?? [];
    const seen = new Set(list);
    for (const v of items) {
      if (!seen.has(v)) {
        list.push(v);
        seen.add(v);
      }
    }
    merged.set(g, list);
  }
  return merged;
}

export interface FilteredRestore {
  files: Map<string, string[]>;
  patterns: Map<string, string[]>;
  uploadedFiles: UploadedFileData[];
}

export function filterValidRestoreData(
  rd: RestoreData | null,
): FilteredRestore {
  const files = new Map<string, string[]>();
  const patterns = new Map<string, string[]>();
  const uploaded = rd?.uploadedFiles ?? [];
  if (!rd) return { files, patterns, uploadedFiles: uploaded };
  for (const [group, paths] of Object.entries(rd.groups ?? {})) {
    const list: string[] = [];
    for (const p of paths) {
      try {
        statSync(p);
        list.push(p);
      } catch {
        // missing file
      }
    }
    if (list.length > 0) files.set(group, list);
  }
  for (const [group, pats] of Object.entries(rd.patterns ?? {})) {
    patterns.set(group, [...pats]);
  }
  return { files, patterns, uploadedFiles: uploaded };
}

export function mapFromRecord<T>(rec: Record<string, T[]>): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const k of Object.keys(rec)) {
    m.set(k, [...(rec[k] ?? [])]);
  }
  return m;
}
