export interface FileEntry {
  name: string;
  id: string;
  // OS-native absolute path: the SPA's tooltip and copy-path value, and what
  // the CLI echoes in its --json output.
  path: string;
  // path split into its components, so the SPA's tree never has to know
  // which separator the server's OS uses. Absent for uploaded files.
  segments?: string[];
  title?: string;
  uploaded?: boolean;
  content?: string;
}

export interface Group {
  name: string;
  files: FileEntry[];
}

export interface GlobPattern {
  pattern: string;
  patternSlash: string;
  baseDir: string;
  group: string;
  recursive: boolean;
}

// Restore/backup data shapes live in common/restore.ts (shared with the CLI
// and the backup store); re-exported here for server-side convenience.
export type { RestoreData, UploadedFileData } from "../common/restore.js";

export interface FileRef {
  id: string;
  group: string;
}

export interface SseEvent {
  name: string;
  data: string;
}

export const EVENT_UPDATE = "update";
export const EVENT_FILE_CHANGED = "file-changed";
export const EVENT_STARTED = "started";

export const ERR_BINARY_FILE = "binary file is not supported";
export const ERR_FILE_NOT_FOUND = "file not found";
