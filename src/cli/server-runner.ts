import { State } from "../server/state.js";
import { createServer } from "../server/http.js";
import { save as saveBackup } from "../backup/index.js";
import { buildDeeplink, serverUrl, type DeeplinkEntry } from "./display.js";
import { logger } from "../logfile/index.js";
import { DefaultGroup } from "../server/group.js";
import type { UploadedFileData } from "../common/restore.js";

export { readRestoreFile, writeRestoreFile } from "../common/restore.js";

export interface StartServerOpts {
  addr: string;
  host: string;
  port: number;
  filesByGroup: Map<string, string[]>;
  patternsByGroup: Map<string, string[]>;
  uploadedFiles: UploadedFileData[];
  noOpen: boolean;
  target: string;
  disableBackup?: boolean;
  onReady?: (deeplinks: DeeplinkEntry[]) => void;
}

export interface ServerRunResult {
  exitCode: number;
  restartRequested?: string;
}

// seedState loads the initial session into a fresh State and returns the
// deeplinks for everything that was accepted. Throws when every plain file
// was rejected and nothing else could stand in for it.
async function seedState(
  state: State,
  opts: StartServerOpts,
): Promise<DeeplinkEntry[]> {
  const deeplinks: DeeplinkEntry[] = [];
  const push = (group: string, id: string, path: string) =>
    deeplinks.push({
      url: buildDeeplink(opts.addr, group, id, DefaultGroup),
      path,
    });

  let totalFiles = 0;
  let skippedFiles = 0;
  for (const [group, files] of opts.filesByGroup) {
    for (const f of files) {
      totalFiles++;
      try {
        const entry = state.addFile(f, group);
        push(group, entry.id, entry.path);
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
        for (const entry of entries) push(group, entry.id, entry.path);
      } catch (err) {
        logger.warn("failed to add pattern", {
          pattern: pat,
          error: String(err),
        });
      }
    }
  }
  let uploadsAdded = 0;
  for (const uf of opts.uploadedFiles) {
    try {
      state.addUploadedFile(uf.name, uf.content, uf.group);
      uploadsAdded++;
    } catch (err) {
      // A corrupt entry in a saved session must not block the whole start.
      logger.warn("skipping uploaded file", {
        name: uf.name,
        error: String(err),
      });
    }
  }

  if (
    totalFiles > 0 &&
    skippedFiles === totalFiles &&
    patternsAdded === 0 &&
    uploadsAdded === 0
  ) {
    throw new Error(`all ${totalFiles} file(s) were skipped`);
  }
  return deeplinks;
}

export async function startServer(
  opts: StartServerOpts,
): Promise<ServerRunResult> {
  const state = new State();

  if (!opts.disableBackup) {
    // Return the promise so State can await the final flush during shutdown.
    state.enableBackup((data) => saveBackup(opts.port, data));
  }

  let deeplinks: DeeplinkEntry[];
  try {
    deeplinks = await seedState(state, opts);
  } catch (err) {
    await abandon(state);
    throw err;
  }

  const server = createServer(state);

  return await new Promise<ServerRunResult>((resolve, reject) => {
    let restartFile = "";
    let isShuttingDown = false;
    let listening = false;

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

    // Failed to bind (typically EADDRINUSE). Nothing was served, so tear
    // the state down without flushing a backup: the instance that does own
    // the port must keep its own saved session. The file watcher is closed
    // too — its handles would otherwise keep the process alive forever
    // after the error was reported.
    const failListen = async (err: Error) => {
      isShuttingDown = true;
      process.off("SIGINT", handleSig);
      process.off("SIGTERM", handleSig);
      await abandon(state);
      reject(
        new Error(`cannot listen on ${opts.addr}: ${err.message}`, {
          cause: err,
        }),
      );
    };

    server.on("error", (err) => {
      if (isShuttingDown) return;
      if (listening) reject(err);
      else void failListen(err);
    });

    server.listen(opts.port, opts.host, () => {
      listening = true;
      logger.info("serving", { url: `http://${opts.addr}` });
      if (opts.onReady) opts.onReady(deeplinks);
      if (!opts.noOpen) {
        const url = serverUrl(opts.addr, opts.target, DefaultGroup);
        import("open")
          .then(({ default: open }) => open(url))
          .catch((err) =>
            logger.warn("could not open browser", { error: String(err) }),
          );
      }
    });
  });
}

// abandon releases everything a State holds (watcher handles, timers,
// pending backup) for a server that never served a request.
async function abandon(state: State): Promise<void> {
  state.closeAllSubscribers();
  await state.discardBackup();
}
