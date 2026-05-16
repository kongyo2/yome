import { readFile, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { State } from "../server/state.js";
import { createServer } from "../server/http.js";
import { save as saveBackup } from "../backup/index.js";
import type { RestoreData } from "../backup/index.js";
import { buildDeeplink, type DeeplinkEntry } from "./display.js";
import { logger } from "../logfile/index.js";
import { DefaultGroup } from "../server/group.js";
import open from "open";

export interface StartServerOpts {
  addr: string;
  host: string;
  port: number;
  filesByGroup: Map<string, string[]>;
  patternsByGroup: Map<string, string[]>;
  uploadedFiles: Array<{ name: string; content: string; group: string }>;
  noOpen: boolean;
  target: string;
  disableBackup?: boolean;
  onReady?: (deeplinks: DeeplinkEntry[]) => void;
}

export interface ServerRunResult {
  exitCode: number;
  restartRequested?: string;
}

export async function startServer(
  opts: StartServerOpts,
): Promise<ServerRunResult> {
  const state = new State();

  if (!opts.disableBackup) {
    state.enableBackup((data) => {
      void saveBackup(opts.port, data).catch((err) =>
        logger.warn("failed to save backup", { error: String(err) }),
      );
    });
  }

  const deeplinks: DeeplinkEntry[] = [];
  let totalFiles = 0;
  let skippedFiles = 0;
  for (const [group, files] of opts.filesByGroup) {
    for (const f of files) {
      totalFiles++;
      try {
        const entry = state.addFile(f, group);
        deeplinks.push({
          url: buildDeeplink(opts.addr, group, entry.id, DefaultGroup),
          path: entry.path,
        });
      } catch (err) {
        skippedFiles++;
        logger.warn("skipping file", { path: f, error: String(err) });
      }
    }
  }
  let patternsAdded = 0;
  for (const [group, pats] of opts.patternsByGroup) {
    for (const pat of pats) {
      try {
        const entries = await state.addPattern(pat, group);
        patternsAdded++;
        for (const entry of entries) {
          deeplinks.push({
            url: buildDeeplink(opts.addr, group, entry.id, DefaultGroup),
            path: entry.path,
          });
        }
      } catch (err) {
        logger.warn("failed to add pattern", {
          pattern: pat,
          error: String(err),
        });
      }
    }
  }
  for (const uf of opts.uploadedFiles) {
    state.addUploadedFile(uf.name, uf.content, uf.group);
  }

  if (
    totalFiles > 0 &&
    skippedFiles === totalFiles &&
    patternsAdded === 0 &&
    opts.uploadedFiles.length === 0
  ) {
    throw new Error(`all ${totalFiles} file(s) were skipped`);
  }

  const server = createServer(state);

  return await new Promise<ServerRunResult>((resolve, reject) => {
    let restartFile = "";
    let isShuttingDown = false;

    const shutdown = async (restoreFile: string | null) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      try {
        state.closeAllSubscribers();
        state.closeBackup();
        await new Promise<void>((r) => server.close(() => r()));
        if (restoreFile !== null) {
          resolve({ exitCode: 0, restartRequested: restoreFile });
        } else {
          resolve({ exitCode: 0 });
        }
      } catch (err) {
        reject(err);
      }
    };

    state.onRestart((file) => {
      restartFile = file;
      void shutdown(file);
    });
    state.onShutdown(() => {
      void shutdown(null);
    });

    const handleSig = () => {
      logger.info("received signal, shutting down");
      void shutdown(restartFile !== "" ? restartFile : null);
    };
    process.on("SIGINT", handleSig);
    process.on("SIGTERM", handleSig);

    server.on("error", (err) => {
      if (!isShuttingDown) reject(err);
    });

    server.listen(opts.port, opts.host, () => {
      logger.info("serving", { url: `http://${opts.addr}` });
      if (opts.onReady) opts.onReady(deeplinks);
      if (!opts.noOpen) {
        const url =
          opts.target === DefaultGroup
            ? `http://${opts.addr}`
            : `http://${opts.addr}/${encodeURIComponent(opts.target)}`;
        open(url).catch((err) =>
          logger.warn("could not open browser", { error: String(err) }),
        );
      }
    });
  });
}

export async function readRestoreFile(path: string): Promise<RestoreData> {
  const data = await readFile(path, "utf8");
  try {
    await rm(path);
  } catch {
    // ignore
  }
  return JSON.parse(data) as RestoreData;
}

export async function writeRestoreFile(data: RestoreData): Promise<string> {
  const p = join(
    tmpdir(),
    `yome-restore-${randomBytes(8).toString("hex")}.json`,
  );
  await fsWriteFile(p, JSON.stringify(data), { mode: 0o600 });
  return p;
}
