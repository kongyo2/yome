import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { stateHome } from "../xdg/index.js";

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

export function backupDir(): string {
  return join(stateHome(), "yome", "backup");
}

export function backupPath(port: number): string {
  return join(backupDir(), `yome-${port}.json`);
}

export async function save(port: number, data: RestoreData): Promise<void> {
  const p = backupPath(port);
  const dir = dirname(p);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const json = JSON.stringify(data);
  const tmpName = join(
    dir,
    `yome-backup-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmpName, json, { encoding: "utf8", mode: 0o600 });
    await rename(tmpName, p);
  } catch (err) {
    await rm(tmpName, { force: true });
    throw err;
  }
}

export async function load(port: number): Promise<RestoreData | null> {
  const p = backupPath(port);
  try {
    const data = await readFile(p, "utf8");
    return JSON.parse(data) as RestoreData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function exists(port: number): boolean {
  try {
    return existsSync(backupPath(port));
  } catch {
    return false;
  }
}

export async function remove(port: number): Promise<void> {
  const p = backupPath(port);
  try {
    await rm(p, { force: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export async function statBackup(port: number): Promise<{ exists: boolean }> {
  try {
    await stat(backupPath(port));
    return { exists: true };
  } catch {
    return { exists: false };
  }
}
