import { basename, dirname } from "node:path";

export interface DeeplinkEntry {
  url: string;
  path: string;
  name?: string;
}

// Lives here (not in client.ts) so JSON-mode output does not drag the
// HTTP client — and with it node:http — into the CLI's startup path.
export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

// serverUrl is the browser entry point for a group: the bare origin for the
// default group, otherwise the group's own path.
export function serverUrl(
  addr: string,
  groupName: string,
  defaultGroup: string,
): string {
  if (groupName === defaultGroup) return `http://${addr}`;
  return `http://${addr}/${encodeURIComponent(groupName)}`;
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

// displayNames computes short display names for file paths, adding parent
// directory components as needed to distinguish files with the same base
// name.
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
        // Stop expanding once the filesystem root is reached.
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

// deeplinkDisplayNames uses the entry name as a fallback when the path is
// empty (uploaded files).
export function deeplinkDisplayNames(entries: DeeplinkEntry[]): string[] {
  const paths = entries.map((e) => (e.path !== "" ? e.path : (e.name ?? "")));
  return displayNames(paths);
}
