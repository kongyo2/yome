import { State } from "../server/state.js";
import { createServer } from "../server/http.js";
import { save as saveBackup } from "../backup/index.js";
import { buildDeeplink, type DeeplinkEntry } from "./display.js";
import { logger } from "../logfile/index.js";
import { DefaultGroup } from "../server/group.js";

export { readRestoreFile, writeRestoreFile } from "../common/restore.js";

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
    // Return the promise so State can await the final flush during shutdown.
    state.enableBackup((data) => saveBackup(opts.port, data));
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
        // Flush the final backup before the process can exit; a lost flush
        // drops the last ~1s of session changes, and a late flush can undo
        // a concurrent `--clear`.
        await state.closeBackup();
        const closed = new Promise<void>((r) => server.close(() => r()));
        // Browsers hold idle keep-alive sockets that would otherwise delay
        // close() by up to keepAliveTimeout.
        server.closeIdleConnections();
        await closed;
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
        import("open")
          .then(({ default: open }) => open(url))
          .catch((err) =>
            logger.warn("could not open browser", { error: String(err) }),
          );
      }
    });
  });
}
