import { basename, dirname } from "node:path";

export interface DeeplinkEntry {
  url: string;
  path: string;
  name?: string;
}

export function buildDeeplink(
  addr: string,
  groupName: string,
  fileID: string,
  defaultGroup: string,
): string {
  if (groupName === defaultGroup) return `http://${addr}/?file=${fileID}`;
  return `http://${addr}/${encodeURIComponent(groupName)}?file=${fileID}`;
}

export function displayNames(paths: string[]): string[] {
  const names = paths.map((p) => basename(p));
  const dirs = paths.map((p) => dirname(p));

  while (true) {
    const dupes = new Map<string, number[]>();
    for (let i = 0; i < names.length; i++) {
      const key = names[i] ?? "";
      const arr = dupes.get(key) ?? [];
      arr.push(i);
      dupes.set(key, arr);
    }
    let changed = false;
    for (const indices of dupes.values()) {
      if (indices.length <= 1) continue;
      for (const idx of indices) {
        const d = dirs[idx] ?? "";
        if (d === dirname(d)) continue;
        const parent = basename(d);
        names[idx] = parent + "/" + (names[idx] ?? "");
        dirs[idx] = dirname(d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return names;
}

export function deeplinkDisplayNames(entries: DeeplinkEntry[]): string[] {
  const paths = entries.map((e) => (e.path !== "" ? e.path : (e.name ?? "")));
  return displayNames(paths);
}
