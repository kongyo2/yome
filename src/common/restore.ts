import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

// writeRestoreFile persists a state snapshot to a private temp file used to
// hand session state to a freshly spawned server process (restart flow).
export async function writeRestoreFile(data: RestoreData): Promise<string> {
  const p = join(
    tmpdir(),
    `yome-restore-${randomBytes(8).toString("hex")}.json`,
  );
  await writeFile(p, JSON.stringify(data), { mode: 0o600 });
  return p;
}

// readRestoreFile consumes (reads and deletes) a restore file.
export async function readRestoreFile(path: string): Promise<RestoreData> {
  const data = await readFile(path, "utf8");
  try {
    await rm(path);
  } catch {
    // ignore
  }
  return JSON.parse(data) as RestoreData;
}
