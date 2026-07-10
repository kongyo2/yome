export interface FileEntry {
  name: string;
  id: string;
  path: string;
  title?: string;
  uploaded?: boolean;
}

export interface Group {
  name: string;
  files: FileEntry[];
  patterns?: string[];
}

export interface FileContent {
  content: string;
  baseDir: string;
}

export interface VersionInfo {
  version: string;
  revision: string;
}

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

export interface SearchResponse {
  query: string;
  group: string;
  limit: number;
  context: number;
  total: number;
  results: SearchResult[];
}

function groupPath(group: string): string {
  return `/_/api/groups/${encodeURIComponent(group)}`;
}

export async function fetchGroups(): Promise<Group[]> {
  const res = await fetch("/_/api/groups");
  if (!res.ok) throw new Error("Failed to fetch groups");
  return res.json();
}

export async function fetchFileContent(
  group: string,
  id: string,
): Promise<FileContent> {
  const res = await fetch(`${groupPath(group)}/files/${id}/content`);
  if (!res.ok) throw new Error("Failed to fetch file content");
  return res.json();
}

export async function openRelativeFile(
  group: string,
  fileId: string,
  relativePath: string,
): Promise<FileEntry> {
  const res = await fetch(`${groupPath(group)}/files/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, path: relativePath }),
  });
  if (!res.ok) throw new Error("Failed to open file");
  return res.json();
}

export async function removeFile(group: string, id: string): Promise<void> {
  const res = await fetch(`${groupPath(group)}/files/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to remove file");
}

export async function reorderFiles(
  groupName: string,
  fileIds: string[],
): Promise<void> {
  const res = await fetch(`${groupPath(groupName)}/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileIds }),
  });
  if (!res.ok) throw new Error("Failed to reorder files");
}

export async function moveFile(
  sourceGroup: string,
  id: string,
  targetGroup: string,
): Promise<void> {
  const res = await fetch(`${groupPath(sourceGroup)}/files/${id}/group`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: targetGroup }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.trim() || "Failed to move file");
  }
}

export async function uploadFile(
  name: string,
  content: string,
  group: string,
): Promise<void> {
  const res = await fetch(`${groupPath(group)}/files/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.trim() || "Failed to upload file");
  }
}

export async function restartServer(): Promise<void> {
  const res = await fetch("/_/api/restart", { method: "POST" });
  if (!res.ok) throw new Error("Failed to restart server");
}

export async function fetchVersion(): Promise<VersionInfo> {
  const res = await fetch("/_/api/version");
  if (!res.ok) throw new Error("Failed to fetch version");
  return res.json();
}

export async function fetchSearchResults(
  query: string,
  group: string,
  limit = 50,
  context = 2,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query,
    group,
    limit: String(limit),
    context: String(context),
  });
  const res = await fetch(`/_/api/search?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to search file contents");
  return res.json();
}
