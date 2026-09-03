import {
  Command,
  InvalidArgumentError,
  Option as CommanderOption,
} from "commander";
import pc from "picocolors";
import {
  exists as backupExists,
  load as backupLoad,
  remove as backupRemove,
} from "../backup/index.js";
import { logger, setup as setupLogfile } from "../logfile/index.js";
import { DefaultGroup, resolveGroupName } from "../server/group.js";
import { Version, Revision, Name } from "../version.js";
import { isStdinRedirected, readStdin } from "./stdin.js";
import { resolveArgs, resolveUnwatchArgs } from "./args.js";
import {
  buildDeeplink,
  deeplinkDisplayNames,
  displayNames,
  serverUrl,
  writeJson,
  type DeeplinkEntry,
} from "./display.js";
import { readRestoreFile, writeRestoreFile } from "../common/restore.js";
import type { RestoreData, UploadedFileData } from "../common/restore.js";
import type { ProbeStatus } from "./probe.js";
import type { PostBatch } from "./client.js";

// Modules that pull expensive-to-compile node builtins (node:http,
// node:child_process, node:net, node:readline) or the server subtree are
// loaded on demand. Node compiles builtin modules lazily, and keeping them
// out of the static import graph cuts tens of milliseconds from every CLI
// invocation that does not need them.
let probeModP: Promise<typeof import("./probe.js")> | null = null;
const probeMod = () => (probeModP ??= import("./probe.js"));
let clientModP: Promise<typeof import("./client.js")> | null = null;
const clientMod = () => (clientModP ??= import("./client.js"));
let helpersModP: Promise<typeof import("./helpers.js")> | null = null;
const helpersMod = () => (helpersModP ??= import("./helpers.js"));
let backgroundModP: Promise<typeof import("./background.js")> | null = null;
const backgroundMod = () => (backgroundModP ??= import("./background.js"));
let serverRunnerModP: Promise<typeof import("./server-runner.js")> | null =
  null;
const serverRunnerMod = () =>
  (serverRunnerModP ??= import("./server-runner.js"));

const DEFAULT_PORT = 6275;
// How long a CLI invocation waits for the server it spawned to answer.
const READY_TIMEOUT_MS = 10_000;

interface Flags {
  target: string;
  port: number;
  portExplicit: boolean;
  bind: string;
  open: boolean;
  noOpen: boolean;
  shutdown: boolean;
  restart: boolean;
  restore: string;
  restoreSession: boolean;
  foreground: boolean;
  status: boolean;
  watch: boolean;
  unwatch: boolean;
  recursive: boolean;
  close: boolean;
  clear: boolean;
  json: boolean;
  yes: boolean;
  dangerouslyAllowRemoteAccess: boolean;
}

// A Session is everything a server should be serving. The same shape is
// seeded into an in-process server, written to a restore file for a
// background one, or posted to a server that is already running.
type Session = PostBatch;

function sessionFor(
  group: string,
  files: string[],
  patterns: string[],
  uploadedFiles: UploadedFileData[],
): Session {
  return {
    filesByGroup: new Map([[group, files]]),
    patternsByGroup: new Map(patterns.length > 0 ? [[group, patterns]] : []),
    uploadedFiles,
  };
}

function logFileHint(port: number): string {
  return `see yome-${port}.log under the state dir`;
}

// requireTarget validates the --target flag, returning its normalized form.
function requireTarget(target: string): string {
  const { name, error } = resolveGroupName(target);
  if (error) {
    throw new Error(`invalid target group name "${target}": ${error.message}`);
  }
  return name;
}

async function promptYesNo(
  message: string,
  emptyAsYes = false,
): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  process.stderr.write(message);
  return await new Promise<boolean>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let answered = false;
    rl.question("", (ans) => {
      answered = true;
      rl.close();
      const v = ans.trim().toLowerCase();
      if (v === "") {
        resolve(emptyAsYes);
        return;
      }
      resolve(v === "y" || v === "yes");
    });
    // stdin EOF (e.g. `yome --clear < /dev/null`) closes the interface
    // without ever invoking the question callback; without this the promise
    // never settles and the process exits 0 mid-command.
    rl.on("close", () => {
      if (!answered) resolve(false);
    });
  });
}

function emitServeOutput(
  addr: string,
  deeplinks: DeeplinkEntry[],
  printURL: boolean,
  jsonMode: boolean,
): void {
  if (jsonMode) {
    const names = deeplinks.length > 0 ? deeplinkDisplayNames(deeplinks) : [];
    const files = deeplinks.map((e, i) => ({
      url: e.url,
      name: names[i] ?? "",
      path: e.path,
    }));
    writeJson({
      url: `http://${addr}`,
      files,
    });
    return;
  }
  if (printURL) {
    process.stdout.write(`http://${addr}\n`);
  }
  if (deeplinks.length === 0) return;
  const names = deeplinkDisplayNames(deeplinks);
  for (let i = 0; i < deeplinks.length; i++) {
    process.stdout.write(`  ${deeplinks[i]?.url ?? ""}  ${names[i] ?? ""}\n`);
  }
}

function deeplinksFromStatus(
  addr: string,
  status: ProbeStatus,
): DeeplinkEntry[] {
  const deeplinks: DeeplinkEntry[] = [];
  for (const g of status.groups ?? []) {
    for (const f of g.files) {
      deeplinks.push({
        url: buildDeeplink(addr, g.name, f.id, DefaultGroup),
        path: f.path,
        name: f.name,
      });
    }
  }
  return deeplinks;
}

async function removeFileQuietly(path: string): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(path, { force: true });
  } catch {
    // best-effort
  }
}

async function runMain(args: string[], flags: Flags): Promise<number> {
  // Runs that will host the server in-process are known up front; warm the
  // server chunk in parallel with the argument/probe work below.
  if (flags.foreground || flags.restore !== "") void serverRunnerMod();

  // Set up the log file unless this is a foreground run without --restore
  // (interactive; stderr is the better place). Detached children always log
  // to the file: their stdio is discarded.
  if (!flags.foreground || flags.restore !== "") {
    try {
      setupLogfile(flags.port);
    } catch (err) {
      logger.warn("failed to setup log file, using stderr", {
        error: String(err),
      });
    }
  }

  const bind = flags.bind.replace(/^\[/, "").replace(/\]$/, "");
  // Use bracketed form for IPv6 in URLs (e.g. [::1]:6275).
  const addr = bind.includes(":")
    ? `[${bind}]:${flags.port}`
    : `${bind}:${flags.port}`;

  if (flags.clear) return await runClear(flags, addr, bind);
  if (flags.status) {
    const { doStatus } = await clientMod();
    return await doStatus(flags.json);
  }
  if (flags.shutdown) return await runControl("shutdown", flags, addr);
  if (flags.restart) return await runControl("restart", flags, addr);
  if (flags.unwatch) return await runUnwatch(args, flags, addr);
  if (flags.close) return await runClose(args, flags, addr);
  if (flags.restore !== "") return await runRestore(flags, addr, bind);
  return await runServe(args, flags, addr, bind);
}

// --clear: forget the saved session for the port. A running server is shut
// down first and respawned empty, so the clear cannot be undone by its
// final backup flush.
async function runClear(
  flags: Flags,
  addr: string,
  bind: string,
): Promise<number> {
  const {
    probeServer,
    waitForReady,
    waitForServerDown,
    ServerConflictError,
    PROBE_TIMEOUT_FAST,
  } = await probeMod();
  let wasServerRunning = false;
  try {
    await probeServer(addr, PROBE_TIMEOUT_FAST);
    wasServerRunning = true;
  } catch {
    // not running
  }
  const hasBackup = backupExists(flags.port);
  if (!wasServerRunning && !hasBackup) {
    process.stderr.write(`yome: no saved session for port ${flags.port}\n`);
    return 0;
  }
  if (!flags.yes) {
    const ok = await promptYesNo(
      `yome: clear saved session for port ${flags.port}? [Y/n] `,
      true,
    );
    if (!ok) {
      process.stderr.write("yome: canceled\n");
      return 0;
    }
  }
  if (wasServerRunning) {
    const { doShutdown } = await clientMod();
    await doShutdown(addr);
    await waitForServerDown(addr);
  }
  // Remove unconditionally: the dying server's final backup flush may have
  // just created a backup that did not exist when hasBackup was sampled
  // (e.g. the session changed within the 1s debounce window).
  await backupRemove(flags.port);
  if (!wasServerRunning) {
    process.stderr.write(
      `yome: cleared saved session for port ${flags.port}\n`,
    );
    return 0;
  }

  const { spawnDetached } = await backgroundMod();
  const proc = spawnDetached({
    bind,
    host: bind,
    port: flags.port,
    dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
    // The detached child cannot answer the non-loopback bind prompt
    // (its stdin is ignored); the user already confirmed this bind for
    // the server we just shut down.
    yes: true,
  });
  try {
    await waitForReady(addr, READY_TIMEOUT_MS, {
      childPid: proc.pid,
      childExited: proc.exited,
    });
  } catch (err) {
    if (err instanceof ServerConflictError) {
      // Someone else grabbed the port between shutdown and respawn. The
      // session is cleared and a server is serving, which is what --clear
      // promises; just say who ended up owning it.
      process.stderr.write(
        `yome: cleared saved session for port ${flags.port}; another yome server (pid ${err.status.pid}) now serves it\n`,
      );
      return 0;
    }
    throw new Error(
      `${(err as Error).message} (spawned pid ${proc.pid}; ${logFileHint(flags.port)})`,
      { cause: err },
    );
  }
  process.stderr.write(
    `yome: cleared session and restarted server on port ${flags.port}\n`,
  );
  return 0;
}

// --shutdown / --restart: act on the given port, or on every discovered
// instance when --port was not given explicitly.
async function runControl(
  action: "shutdown" | "restart",
  flags: Flags,
  addr: string,
): Promise<number> {
  const { doShutdown, doRestart, shutdownOrRestartAll } = await clientMod();
  if (!flags.portExplicit) return await shutdownOrRestartAll(action);
  if (action === "shutdown") await doShutdown(addr);
  else await doRestart(addr);
  return 0;
}

async function runUnwatch(
  args: string[],
  flags: Flags,
  addr: string,
): Promise<number> {
  if (flags.watch) throw new Error("cannot use --unwatch with --watch");
  if (args.length === 0) {
    throw new Error("--unwatch requires a glob pattern or directory argument");
  }
  const target = requireTarget(flags.target);
  const { doUnwatch, fetchRegisteredPatterns } = await clientMod();
  const patterns = await resolveUnwatchArgs(args, flags.recursive, () =>
    fetchRegisteredPatterns(addr, target),
  );
  await doUnwatch(addr, patterns, target);
  return 0;
}

async function runClose(
  args: string[],
  flags: Flags,
  addr: string,
): Promise<number> {
  if (flags.watch) throw new Error("cannot use --close with --watch");
  if (args.length === 0) {
    throw new Error("--close requires at least one file argument");
  }
  const target = requireTarget(flags.target);
  const { doClose } = await clientMod();
  const { closed, errors } = await doClose(addr, args, target);
  if (closed.length > 0) {
    for (const n of displayNames(closed)) process.stdout.write(`  ${n}\n`);
    process.stderr.write(
      `yome: closed ${closed.length} file(s) from http://${addr}\n`,
    );
  }
  for (const e of errors) process.stderr.write(`yome: ${e.message}\n`);
  return errors.length > 0 ? 1 : 0;
}

// --restore (internal): a detached child started by startBackground or a
// restart picks its session up from the file the parent wrote.
async function runRestore(
  flags: Flags,
  addr: string,
  bind: string,
): Promise<number> {
  const rd = await readRestoreFile(flags.restore);
  const { mapFromRecord } = await helpersMod();
  return await runStartServer(flags, addr, bind, {
    filesByGroup: mapFromRecord(rd.groups ?? {}),
    patternsByGroup: mapFromRecord(rd.patterns ?? {}),
    uploadedFiles: rd.uploadedFiles ?? [],
  });
}

// The default command: open the given files, patterns, or piped content —
// in the server already running on the port when there is one, otherwise
// in a fresh server (restoring the saved session for the port).
async function runServe(
  args: string[],
  flags: Flags,
  addr: string,
  bind: string,
): Promise<number> {
  flags.target = requireTarget(flags.target);

  if (flags.recursive && args.length === 0) {
    throw new Error("--recursive (-R) requires a directory argument");
  }

  const { files, patterns } = await resolveArgs(
    args,
    flags.watch,
    flags.recursive,
  );

  if (flags.watch && patterns.length === 0) {
    if (files.length > 0) {
      throw new Error(
        "--watch (-w) requires a glob pattern or directory argument\n(hint: the shell may have expanded the glob pattern; quote it, e.g. -w '**/*.md')",
      );
    }
    throw new Error(
      "--watch (-w) requires a glob pattern or directory argument",
    );
  }

  let stdinData: UploadedFileData | null = null;
  if (isStdinRedirected()) {
    if (args.length > 0)
      throw new Error("cannot use redirected stdin with positional arguments");
    if (flags.watch)
      throw new Error("cannot use --watch (-w) with redirected stdin");
    const { name, content } = await readStdin(process.stdin);
    stdinData = { name, content, group: flags.target };
  }

  const { probeServer, PROBE_TIMEOUT_DEFAULT, PROBE_TIMEOUT_FAST } =
    await probeMod();
  if (files.length === 0 && patterns.length === 0 && !stdinData) {
    // Nothing to add: with a server running, just open the browser.
    try {
      await probeServer(addr, PROBE_TIMEOUT_DEFAULT);
      await openBrowser(addr, flags);
      return 0;
    } catch {
      // continue to start a new server
    }
  } else {
    // Try adding to an existing server first. Only fall through to startup
    // when the probe itself fails (no server running): errors from the
    // subsequent API calls must surface so users actually see "binary file
    // rejected" type problems instead of silently spawning a fresh server.
    let probed: ProbeStatus | null = null;
    try {
      probed = (await probeServer(addr, PROBE_TIMEOUT_FAST)).status;
    } catch {
      probed = null;
    }
    if (probed) {
      return await addToExistingServer(
        addr,
        probed,
        flags,
        files,
        patterns,
        stdinData,
      );
    }
  }

  const requested = sessionFor(flags.target, files, patterns, []);
  const session = await restoreSession(flags, requested);
  if (stdinData) session.uploadedFiles.push(stdinData);

  if (!(await confirmNonLoopbackBind(flags, bind, stdinData != null))) {
    return 0;
  }

  if (flags.foreground) {
    return await runStartServer(flags, addr, bind, session);
  }
  return await startBackground(flags, addr, bind, session);
}

async function addToExistingServer(
  addr: string,
  status: ProbeStatus,
  flags: Flags,
  files: string[],
  patterns: string[],
  stdinData: UploadedFileData | null,
): Promise<number> {
  const isNewGroup = !status.groups.some((g) => g.name === flags.target);
  const { postBatch } = await clientMod();
  const result = await postBatch(
    addr,
    sessionFor(flags.target, files, patterns, stdinData ? [stdinData] : []),
  );

  // Piped content was the only item: its failure is the command's failure.
  if (
    stdinData &&
    files.length === 0 &&
    patterns.length === 0 &&
    result.errors.length > 0
  ) {
    throw new Error(result.errors[0]!.message);
  }

  logger.info("added to existing server", {
    files: files.length,
    patterns: patterns.length,
    stdin: stdinData != null,
    added: result.added,
    addr,
  });
  emitServeOutput(addr, result.entries, false, flags.json);
  process.stderr.write(
    `yome: added ${result.added} item(s) to http://${addr}\n`,
  );
  // Surface real per-item failures.
  for (const e of result.errors) process.stderr.write(`yome: ${e.message}\n`);

  if (isNewGroup || flags.open) await openBrowser(addr, flags);
  return result.errors.length > 0 ? 1 : 0;
}

// restoreSession merges the saved session for the port (restored entries
// first, requested ones appended, duplicates skipped) unless the user opted
// out with --no-restore-session.
async function restoreSession(
  flags: Flags,
  requested: Session,
): Promise<Session> {
  if (!flags.restoreSession) {
    logger.info("starting ephemeral session (--no-restore-session)", {
      port: flags.port,
    });
    return requested;
  }
  const { filterValidRestoreData, mergeGroups } = await helpersMod();
  try {
    const filtered = filterValidRestoreData(await backupLoad(flags.port));
    if (
      filtered.files.size > 0 ||
      filtered.patterns.size > 0 ||
      filtered.uploadedFiles.length > 0
    ) {
      logger.info("restoring session from backup", { port: flags.port });
      process.stderr.write(
        `yome: restoring previous session for port ${flags.port}\n`,
      );
      return {
        filesByGroup: mergeGroups(filtered.files, requested.filesByGroup),
        patternsByGroup: mergeGroups(
          filtered.patterns,
          requested.patternsByGroup,
        ),
        uploadedFiles: [...filtered.uploadedFiles, ...requested.uploadedFiles],
      };
    }
  } catch (err) {
    logger.warn("failed to load backup", { error: String(err) });
  }
  return requested;
}

// confirmNonLoopbackBind warns (and prompts, unless --yes or
// --dangerously-allow-remote-access) before exposing the server beyond the
// local machine. Returns false when the user declined.
async function confirmNonLoopbackBind(
  flags: Flags,
  bind: string,
  hasStdin: boolean,
): Promise<boolean> {
  const { isLoopbackBind } = await helpersMod();
  if (isLoopbackBind(bind)) return true;
  logger.warn("binding to non-loopback address", {
    bind,
    dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
  });
  if (flags.dangerouslyAllowRemoteAccess) return true;
  if (hasStdin) {
    throw new Error(
      "cannot use redirected stdin with non-loopback bind without --dangerously-allow-remote-access",
    );
  }
  const warn = (line: string) => process.stderr.write(pc.yellow(line) + "\n");
  process.stderr.write(
    pc.bold(pc.yellow("SECURITY WARNING: ")) +
      pc.yellow(
        `Binding to ${bind} instead of localhost. yome has no authentication -- remote clients can:`,
      ) +
      "\n",
  );
  warn("  - Read any file accessible by this user");
  warn("  - Browse the filesystem via glob patterns");
  warn("  - Shut down or restart the server");
  if (flags.yes) return true;
  const ok = await promptYesNo("Continue? [y/N] ");
  if (!ok) {
    process.stderr.write("yome: canceled\n");
    return false;
  }
  return true;
}

async function openBrowser(addr: string, flags: Flags): Promise<void> {
  if (flags.noOpen) return;
  const url = serverUrl(addr, flags.target, DefaultGroup);
  try {
    // `open` is loaded lazily: it (and its platform helpers) are only needed
    // when a browser is actually opened, and keeping it out of the static
    // import graph shaves measurable time off every CLI invocation.
    const { default: open } = await import("open");
    await open(url);
  } catch (err) {
    logger.warn("could not open browser", { error: String(err) });
  }
}

async function runStartServer(
  flags: Flags,
  addr: string,
  bind: string,
  session: Session,
): Promise<number> {
  // The in-process server (and its chokidar/http dependency subtree) is only
  // required for --foreground / --restore runs; client invocations that talk
  // to an already-running server never pay for loading it.
  const { startServer } = await serverRunnerMod();
  const result = await startServer({
    addr,
    host: bind,
    port: flags.port,
    ...session,
    noOpen: flags.noOpen,
    target: flags.target,
    disableBackup: !flags.restoreSession,
    onReady: (deeplinks) => {
      emitServeOutput(addr, deeplinks, true, flags.json);
    },
  });
  if (result.restartRequested) {
    const { spawnDetached } = await backgroundMod();
    spawnDetached({
      bind,
      host: bind,
      port: flags.port,
      restoreFile: result.restartRequested,
      dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
      noRestoreSession: !flags.restoreSession,
    });
  }
  return result.exitCode;
}

async function startBackground(
  flags: Flags,
  addr: string,
  bind: string,
  session: Session,
): Promise<number> {
  const restoreData: RestoreData = {
    groups: Object.fromEntries(session.filesByGroup),
    patterns:
      session.patternsByGroup.size > 0
        ? Object.fromEntries(session.patternsByGroup)
        : {},
    uploadedFiles: session.uploadedFiles,
  };
  const restoreFile = await writeRestoreFile(restoreData);
  const [{ spawnDetached }, { waitForReady, ServerConflictError }] =
    await Promise.all([backgroundMod(), probeMod()]);
  let proc;
  try {
    proc = spawnDetached({
      bind,
      host: bind,
      port: flags.port,
      restoreFile,
      dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
      noRestoreSession: !flags.restoreSession,
    });
  } catch (err) {
    await removeFileQuietly(restoreFile);
    throw err;
  }

  let status: ProbeStatus;
  try {
    status = await waitForReady(addr, READY_TIMEOUT_MS, {
      childPid: proc.pid,
      childExited: proc.exited,
    });
  } catch (err) {
    // Remove the restore file only once the child is confirmed dead: a
    // slow-but-alive child may not have consumed it yet, and an alive child
    // removes it itself after loading.
    if (proc.exited()) await removeFileQuietly(restoreFile);
    if (err instanceof ServerConflictError) {
      // Lost a concurrent startup race: another yome server owns the port.
      // Add our files to the winner instead of reporting a false success.
      return await addToRunningServer(addr, err.status, flags, session);
    }
    throw new Error(
      `${(err as Error).message} (spawned pid ${proc.pid}; ${logFileHint(flags.port)})`,
      { cause: err },
    );
  }

  emitServeOutput(addr, deeplinksFromStatus(addr, status), true, flags.json);
  process.stderr.write(`yome: serving at http://${addr} (pid ${proc.pid})\n`);
  await openBrowser(addr, flags);
  return 0;
}

// addToRunningServer hands the whole session to a yome server that turned
// out to own the port while we were starting ours.
async function addToRunningServer(
  addr: string,
  status: ProbeStatus,
  flags: Flags,
  session: Session,
): Promise<number> {
  logger.info("port already served by another yome instance; adding to it", {
    addr,
    pid: status.pid,
  });
  const { postBatch } = await clientMod();
  const result = await postBatch(addr, session);
  if (result.attempted > 0 && result.added === 0) {
    const first = result.errors[0]?.message ?? "no item was accepted";
    throw new Error(
      `failed to add any items to the yome server at http://${addr}: ${first}`,
    );
  }
  emitServeOutput(addr, result.entries, true, flags.json);
  process.stderr.write(
    `yome: another yome server is already running at http://${addr} (pid ${status.pid}); added ${result.added} item(s) to it\n`,
  );
  for (const e of result.errors) process.stderr.write(`yome: ${e.message}\n`);

  const isNewGroup = !status.groups.some((g) => g.name === flags.target);
  if (isNewGroup || flags.open) await openBrowser(addr, flags);
  return result.errors.length > 0 ? 1 : 0;
}

const LONG_DESC = `yome is a Markdown viewer that opens .md files in a browser with live-reload.

It runs in the background, serving Markdown files using a built-in React SPA,
and automatically refreshes the browser when files are saved.

Examples:
  yome README.md                          Open a single file
  yome README.md CHANGELOG.md docs/*.md   Open multiple files
  yome spec.md --target design            Open in a named group
  yome draft.md --port 6276               Use a different port
  cat notes.md | yome                     Read Markdown from stdin
  cmd | yome --target output              Pipe command output into a group

Single Server, Multiple Files:
  By default, yome runs a single server on port 6275.
  If a yome server is already running on the same port, subsequent yome
  invocations add files to the existing session instead of starting a new one.

Groups:
  Files can be organized into named groups using the --target (-t) flag.
  Each group gets its own URL path (e.g., http://localhost:6275/design)
  and its own sidebar in the browser.

Starting and Stopping:
  yome runs in the background by default. Use --status to inspect, --shutdown
  to stop, and --restart to restart while preserving session state. Without
  an explicit --port, --shutdown and --restart act on every running instance
  discovered on this machine. Use --foreground to keep the server attached
  to the terminal.

Session Restore:
  yome automatically saves session state. When starting a new server, the
  previous session is restored and merged with any specified files.
  Use --clear to remove a saved session, or pass --no-restore-session to
  start an ephemeral one-off server that neither restores nor overwrites
  the saved backup. --shutdown leaves the saved session intact (for the
  next start); use --clear to truly forget a port. Pair --clear with
  --yes (-y) in scripts to skip the confirmation prompt.

Live-Reload:
  yome watches all opened files for changes via fs events. When a file is
  saved, the browser automatically re-renders the content.

Watch mode and glob patterns:
  --watch (-w) turns on watch mode. Directory and glob positional arguments
  are then registered as watch patterns; matching files are opened and new
  files are picked up automatically. Combine with --recursive (-R) to
  descend into subdirectories.

WARNING: --bind with a non-loopback address exposes yome to the network
without any authentication. A confirmation prompt is shown before starting.`;

export async function runCli(): Promise<number> {
  const program = new Command();
  program
    .name(Name)
    .description("yome is a Markdown viewer that opens .md files in a browser.")
    .addHelpText("after", "\n" + LONG_DESC)
    .version(`${Version} ${Revision}`)
    .argument("[files...]", "Files, directories, or glob patterns")
    .option("-t, --target <name>", "Tab group name", DefaultGroup)
    .option(
      "-p, --port <number>",
      "Server port",
      (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new InvalidArgumentError(
            "port must be an integer between 1 and 65535",
          );
        }
        return n;
      },
      DEFAULT_PORT,
    )
    .option(
      "-b, --bind <addr>",
      "Bind address (e.g. localhost, 0.0.0.0)",
      "localhost",
    )
    .option(
      "--open",
      "Always open browser (even when adding to existing group)",
    )
    .option("--no-open", "Do not open browser automatically")
    .option(
      "--shutdown",
      "Shut down running yome server(s) (all instances when --port is omitted)",
    )
    .option(
      "--restart",
      "Restart running yome server(s) (all instances when --port is omitted)",
    )
    .addOption(
      new CommanderOption(
        "--restore <file>",
        "Restore state from file (internal use)",
      ).hideHelp(),
    )
    .option(
      "--no-restore-session",
      "Skip restoring (and saving) the per-port session backup; useful for ad-hoc, ephemeral previews",
    )
    .option("--foreground", "Run yome server in foreground (do not background)")
    .option("--status", "Show status of all running yome servers")
    .option(
      "-w, --watch",
      "Treat directory and glob arguments as watch patterns",
    )
    .option(
      "--unwatch",
      "Remove watched patterns for the given directory or glob arguments",
    )
    .option(
      "-R, --recursive",
      "Recurse into subdirectories when a directory is given",
    )
    .option("--close", "Close files instead of opening them")
    .option("--clear", "Clear saved session for the specified port")
    .option("--json", "Output structured data as JSON to stdout")
    .option(
      "-y, --yes",
      "Assume yes for all confirmation prompts (e.g. --clear, non-loopback bind warning); useful in scripts and CI",
    )
    .option(
      "--dangerously-allow-remote-access",
      "Allow remote access without authentication. Recommended only for trusted networks.",
    );

  program.exitOverride();
  // The mutual-exclusion check must not look past a `--` terminator, where
  // "--open" would be a positional filename, not a flag.
  const ddIndex = process.argv.indexOf("--");
  const flagArgv =
    ddIndex === -1 ? process.argv : process.argv.slice(0, ddIndex);
  if (flagArgv.includes("--open") && flagArgv.includes("--no-open")) {
    process.stderr.write("yome: --open and --no-open are mutually exclusive\n");
    return 1;
  }

  let parsed;
  try {
    parsed = program.parse(process.argv);
  } catch (err) {
    const e = err as Error & { exitCode?: number };
    return e.exitCode ?? 1;
  }
  const opts = parsed.opts<Record<string, unknown>>();
  // Ask commander whether --port came from the command line. This handles
  // every valid short-form syntax (-p N, -pN, --port=N, clustered -Rp7000,
  // even malformed values like -pfoo) without re-implementing the parser.
  const portExplicit = program.getOptionValueSource("port") === "cli";
  // Same for --open/--no-open: they share the "open" key, so the source
  // plus the folded value distinguishes them. Unlike a raw argv scan this
  // respects `--` and option-value consumption (e.g. `--target --open`).
  const openSource = program.getOptionValueSource("open");
  const openExplicit = openSource === "cli" && opts["open"] === true;
  const noOpenExplicit = openSource === "cli" && opts["open"] === false;

  const flags: Flags = {
    target: String(opts["target"] ?? DefaultGroup),
    port: Number(opts["port"] ?? DEFAULT_PORT),
    portExplicit,
    bind: String(opts["bind"] ?? "localhost"),
    open: openExplicit,
    noOpen: noOpenExplicit,
    shutdown: opts["shutdown"] === true,
    restart: opts["restart"] === true,
    restore: typeof opts["restore"] === "string" ? opts["restore"] : "",
    // commander gives us `restoreSession: false` when the user passes
    // --no-restore-session, otherwise leaves it `undefined` (treat as enabled).
    restoreSession: opts["restoreSession"] !== false,
    foreground: opts["foreground"] === true,
    status: opts["status"] === true,
    watch: opts["watch"] === true,
    unwatch: opts["unwatch"] === true,
    recursive: opts["recursive"] === true,
    close: opts["close"] === true,
    clear: opts["clear"] === true,
    json: opts["json"] === true,
    yes: opts["yes"] === true,
    dangerouslyAllowRemoteAccess: opts["dangerouslyAllowRemoteAccess"] === true,
  };

  if (flags.shutdown && flags.restart) {
    process.stderr.write(
      "yome: --shutdown and --restart are mutually exclusive\n",
    );
    return 1;
  }

  const args = parsed.args.filter((a) => a != null && a !== "");

  try {
    return await runMain(args, flags);
  } catch (err) {
    // Also land the failure in the per-port log file (when one is set up):
    // detached children run with stdio ignored, so this is the only place a
    // startup crash becomes diagnosable afterwards.
    logger.error("fatal", { error: String(err) });
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}
