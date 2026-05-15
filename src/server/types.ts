export interface FileEntry {
  name: string;
  id: string;
  path: string;
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

export interface UploadedFileData {
  name: string;
  content: string;
  group: string;
}

export interface RestoreData {
  groups: Record<string, string[]>;
  patterns?: Record<string, string[]>;
  uploadedFiles?: UploadedFileData[];
}

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
