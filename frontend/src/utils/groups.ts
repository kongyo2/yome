import type { Group } from "../hooks/useApi";

// Display order for groups: alphabetical with "default" last. Shared by the
// group dropdown, the sidebar "move to" menu, and the fallback-group picker.
export function compareGroupNames(a: string, b: string): number {
  if (a === "default") return 1;
  if (b === "default") return -1;
  return a.localeCompare(b);
}

export function sortGroupsForDisplay(groups: Group[]): Group[] {
  return [...groups].sort((a, b) => compareGroupNames(a.name, b.name));
}

export function allFileIds(groups: Group[]): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) {
    for (const f of g.files) {
      ids.add(f.id);
    }
  }
  return ids;
}

export function parseGroupFromPath(pathname: string): string {
  const raw = pathname.replace(/^\//, "").replace(/\/$/, "");
  if (raw === "") return "default";
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding — fall back to raw segment so the UI
    // still renders something sensible instead of crashing.
    return raw;
  }
}

export function groupToPath(groupName: string): string {
  if (groupName === "default") return "/";
  // Encode each path segment so names containing %, /, or unicode survive
  // a round trip through the browser address bar and the backend router.
  return "/" + groupName.split("/").map(encodeURIComponent).join("/");
}

export function buildFileUrl(groupName: string, fileId: string): string {
  return `${groupToPath(groupName)}?file=${fileId}`;
}

export function parseFileIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("file");
  if (raw == null || raw === "") return null;
  return raw;
}
