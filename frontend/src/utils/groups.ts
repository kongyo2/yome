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

export interface RelativeOpenRequest {
  // ID of the source file the relative link was rendered in.
  from: string;
  // Relative path to resolve against the source file, as written in the link.
  open: string;
}

// A relative Markdown link has no file ID until the server resolves it, so a new
// browser tab cannot be pointed straight at buildFileUrl. This URL carries the
// source file and the relative path instead, and the SPA resolves it on load.
export function buildRelativeOpenUrl(
  groupName: string,
  sourceFileId: string,
  relativePath: string,
): string {
  const params = new URLSearchParams({
    from: sourceFileId,
    open: relativePath,
  });
  return `${groupToPath(groupName)}?${params.toString()}`;
}

export function parseRelativeOpenFromSearch(
  search: string,
): RelativeOpenRequest | null {
  const params = new URLSearchParams(search);
  const from = params.get("from");
  const open = params.get("open");
  if (!from || !open) return null;
  return { from, open };
}
