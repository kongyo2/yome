import { Command, Option as CommanderOption } from "commander";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import pc from "picocolors";
import open from "open";
import {
  exists as backupExists,
  load as backupLoad,
  remove as backupRemove,
} from "../backup/index.js";
import { logger, setup as setupLogfile, logDir } from "../logfile/index.js";
import { DefaultGroup, resolveGroupName } from "../server/group.js";
import { Version, Revision, Name } from "../version.js";
import {
  PROBE_TIMEOUT_DEFAULT,
  PROBE_TIMEOUT_FAST,
  httpGetJson,
  httpRequestJson,
  probeServer,
  waitForReady,
  waitForServerDown,
} from "./probe.js";
import { isStdinRedirected, readStdin } from "./stdin.js";
import { resolveArgs, resolveUnwatchArgs, toAbsolute } from "./args.js";
import {
  buildDeeplink,
  deeplinkDisplayNames,
  displayNames,
  type DeeplinkEntry,
} from "./display.js";
import {
  readRestoreFile,
  startServer,
  writeRestoreFile,
} from "./server-runner.js";
import { spawnDetached } from "./background.js";
import {
  filterValidRestoreData,
  isLoopbackBind,
  mapFromRecord,
  mergeGroups,
} from "./helpers.js";
import type { RestoreData } from "../backup/index.js";

const DEFAULT_PORT = 6275;

interface Flags {
  target: string;
  port: number;
  bind: string;
  open: boolean;
  noOpen: boolean;
  shutdown: boolean;
  restart: boolean;
  restore: string;
  foreground: boolean;
  status: boolean;
  watch: boolean;
  unwatch: boolean;
  recursive: boolean;
  close: boolean;
  clear: boolean;
  json: boolean;
  dangerouslyAllowRemoteAccess: boolean;
}

async function promptYesNo(
  message: string,
  emptyAsYes = false,
): Promise<boolean> {
  process.stderr.write(message);
  return await new Promise<boolean>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question("", (ans) => {
      rl.close();
      const v = ans.trim().toLowerCase();
      if (v === "") {
        resolve(emptyAsYes);
        return;
      }
      resolve(v === "y" || v === "yes");
    });
  });
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
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

async function discoverPorts(): Promise<number[]> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(logDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const ports: number[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    if (!name.startsWith("mo-") || !name.endsWith(".log")) continue;
    const raw = name.substring(3, name.length - 4);
    const p = Number(raw);
    if (!Number.isFinite(p) || !Number.isInteger(p) || String(p) !== raw)
      continue;
    ports.push(p);
  }
  ports.sort((a, b) => a - b);
  return ports;
}

interface StatusResponse {
  version: string;
  revision: string;
  pid: number;
  groups: Array<{
    name: string;
    files: Array<{ name: string; id: string; path: string }>;
    patterns?: string[];
  }>;
}

async function doStatus(jsonMode: boolean): Promise<number> {
  const ports = await discoverPorts();
  if (ports.length === 0) {
    if (jsonMode) writeJson([]);
    else process.stderr.write("mo: no mo server found\n");
    return 0;
  }
  let found = false;
  const jsonEntries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ports.length; i++) {
    const p = ports[i]!;
    const addr = `localhost:${p}`;
    let status: StatusResponse | null = null;
    try {
      status = await httpGetJson<StatusResponse>(
        `http://${addr}/_/api/status`,
        2000,
      );
    } catch {
      found = true;
      if (jsonMode) {
        jsonEntries.push({ url: `http://${addr}`, status: "stopped" });
      } else {
        process.stdout.write(`http://${addr} (stopped)\n`);
        if (i < ports.length - 1) process.stdout.write("\n");
      }
      continue;
    }
    found = true;
    if (jsonMode) {
      const groups = (status.groups ?? []).map((g) => ({
        name: g.name,
        files: g.files.length,
        patterns: g.patterns ?? [],
      }));
      const entry: Record<string, unknown> = {
        url: `http://${addr}`,
        status: "running",
        pid: status.pid,
        version: status.version,
        revision: status.revision,
        groups,
      };
      jsonEntries.push(entry);
    } else {
      let ver = status.version;
      if (status.revision !== "" && status.revision !== "HEAD")
        ver += " " + status.revision;
      process.stdout.write(`http://${addr} (pid ${status.pid}, ${ver})\n`);
      for (const g of status.groups ?? []) {
        process.stdout.write(`  ${g.name}: ${g.files.length} file(s)\n`);
        if (g.patterns && g.patterns.length > 0) {
          process.stdout.write(`    watching: ${g.patterns.join(", ")}\n`);
        }
      }
      if (i < ports.length - 1) process.stdout.write("\n");
    }
  }
  if (jsonMode) {
    writeJson(jsonEntries);
  } else if (!found) {
    process.stderr.write("mo: no mo server found\n");
  }
  return 0;
}

async function doShutdown(addr: string): Promise<void> {
  await probeServer(addr);
  const resp = await httpRequestJson(
    "POST",
    `http://${addr}/_/api/shutdown`,
    {},
    PROBE_TIMEOUT_DEFAULT,
  );
  if (resp.status !== 202) {
    throw new Error(`unexpected response from server: ${resp.status}`);
  }
  logger.info("shutdown request sent", { addr });
  process.stderr.write(`mo: shutdown request sent to http://${addr}\n`);
}

async function doRestart(addr: string): Promise<void> {
  await probeServer(addr);
  const resp = await httpRequestJson(
    "POST",
    `http://${addr}/_/api/restart`,
    {},
    PROBE_TIMEOUT_DEFAULT,
  );
  if (resp.status !== 202) {
    throw new Error(`unexpected response from server: ${resp.status}`);
  }
  logger.info("restart request sent", { addr });
  process.stderr.write(`mo: restart request sent to http://${addr}\n`);
}

async function doUnwatch(
  addr: string,
  patterns: string[],
  groupName: string,
): Promise<void> {
  await probeServer(addr);
  for (const pat of patterns) {
    const resp = await httpRequestJson(
      "DELETE",
      `http://${addr}/_/api/patterns`,
      { pattern: pat, group: groupName },
      PROBE_TIMEOUT_DEFAULT,
    );
    if (resp.status === 404) {
      throw new Error(
        `watch pattern "${pat}" not found in group "${groupName}" (use --status to see registered patterns)`,
      );
    }
    if (resp.status !== 204) {
      throw new Error(`unexpected response from server: ${resp.status}`);
    }
    logger.info("pattern removed", { pattern: pat, group: groupName });
    process.stderr.write(`mo: unwatched ${pat}\n`);
  }
}

async function fetchRegisteredPatterns(
  addr: string,
  groupName: string,
): Promise<string[]> {
  const status = await httpGetJson<StatusResponse>(
    `http://${addr}/_/api/status`,
    PROBE_TIMEOUT_DEFAULT,
  );
  for (const g of status.groups) {
    if (g.name === groupName) return g.patterns ?? [];
  }
  throw new Error(
    `group "${groupName}" not found (use --status to see registered groups)`,
  );
}

async function doClose(
  addr: string,
  paths: string[],
  groupName: string,
): Promise<{ closed: string[]; errors: Error[] }> {
  await probeServer(addr);
  const status = await httpGetJson<StatusResponse>(
    `http://${addr}/_/api/status`,
    PROBE_TIMEOUT_DEFAULT,
  );
  const pathToID = new Map<string, string>();
  for (const g of status.groups) {
    if (g.name === groupName) {
      for (const f of g.files) pathToID.set(f.path, f.id);
      break;
    }
  }
  const closed: string[] = [];
  const errors: Error[] = [];
  for (const p of paths) {
    const abs = toAbsolute(p);
    const id = pathToID.get(abs);
    if (!id) {
      errors.push(
        new Error(
          `file "${abs}" not found in group "${groupName}" (use --status to see files)`,
        ),
      );
      continue;
    }
    const resp = await httpRequestJson(
      "DELETE",
      `http://${addr}/_/api/groups/${encodeURIComponent(groupName)}/files/${id}`,
      undefined,
      PROBE_TIMEOUT_DEFAULT,
    );
    if (resp.status === 404) {
      errors.push(new Error(`file "${abs}" not found`));
      continue;
    }
    if (resp.status !== 204) {
      errors.push(
        new Error(`unexpected response for "${abs}": ${resp.status}`),
      );
      continue;
    }
    logger.info("file closed", { path: abs, id, group: groupName });
    closed.push(abs);
  }
  return { closed, errors };
}

interface PostFileError {
  target: string;
  message: string;
}

interface PostFileResult {
  entries: DeeplinkEntry[];
  errors: PostFileError[];
}

async function postFiles(
  addr: string,
  group: string,
  files: string[],
): Promise<PostFileResult> {
  const entries: DeeplinkEntry[] = [];
  const errors: PostFileError[] = [];
  for (const f of files) {
    try {
      const resp = await httpRequestJson(
        "POST",
        `http://${addr}/_/api/groups/${encodeURIComponent(group)}/files`,
        { path: f },
        PROBE_TIMEOUT_DEFAULT,
      );
      if (resp.status !== 200) {
        const detail = resp.body.trim();
        const message = detail
          ? `failed to add "${f}": ${detail}`
          : `failed to add "${f}": HTTP ${resp.status}`;
        logger.warn("failed to add file", { path: f, status: resp.status });
        errors.push({ target: f, message });
        continue;
      }
      const entry = JSON.parse(resp.body) as { id: string; path: string };
      entries.push({
        url: buildDeeplink(addr, group, entry.id, DefaultGroup),
        path: entry.path,
      });
    } catch (err) {
      const message = `failed to add "${f}": ${(err as Error).message}`;
      logger.warn("failed to post file", { path: f, error: String(err) });
      errors.push({ target: f, message });
    }
  }
  return { entries, errors };
}

async function postPatterns(
  addr: string,
  group: string,
  patterns: string[],
): Promise<PostFileResult> {
  const entries: DeeplinkEntry[] = [];
  const errors: PostFileError[] = [];
  for (const pat of patterns) {
    try {
      const resp = await httpRequestJson(
        "POST",
        `http://${addr}/_/api/patterns`,
        { pattern: pat, group },
        PROBE_TIMEOUT_DEFAULT,
      );
      if (resp.status !== 200) {
        const detail = resp.body.trim();
        const message = detail
          ? `failed to add pattern "${pat}": ${detail}`
          : `failed to add pattern "${pat}": HTTP ${resp.status}`;
        logger.warn("failed to add pattern", {
          pattern: pat,
          status: resp.status,
        });
        errors.push({ target: pat, message });
        continue;
      }
      const data = JSON.parse(resp.body) as {
        matched: number;
        files?: Array<{ id: string; path: string }>;
      };
      for (const f of data.files ?? []) {
        entries.push({
          url: buildDeeplink(addr, group, f.id, DefaultGroup),
          path: f.path,
        });
      }
    } catch (err) {
      const message = `failed to add pattern "${pat}": ${(err as Error).message}`;
      logger.warn("failed to post pattern", {
        pattern: pat,
        error: String(err),
      });
      errors.push({ target: pat, message });
    }
  }
  return { entries, errors };
}

async function postUploadedFile(
  addr: string,
  group: string,
  name: string,
  content: string,
): Promise<DeeplinkEntry> {
  const resp = await httpRequestJson(
    "POST",
    `http://${addr}/_/api/groups/${encodeURIComponent(group)}/files/upload`,
    { name, content },
    PROBE_TIMEOUT_DEFAULT,
  );
  if (resp.status !== 200) {
    throw new Error(`upload failed: ${resp.status}: ${resp.body.trim()}`);
  }
  const entry = JSON.parse(resp.body) as { id: string; name: string };
  return {
    url: buildDeeplink(addr, group, entry.id, DefaultGroup),
    path: "",
    name: entry.name,
  };
}

async function runMain(args: string[], flags: Flags): Promise<number> {
  // setup log file unless we're in foreground+restore-less mode (we still want logs for actual server runs)
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

  if (flags.clear) {
    let wasServerRunning = false;
    try {
      await probeServer(addr, PROBE_TIMEOUT_FAST);
      wasServerRunning = true;
    } catch {
      // not running
    }
    const hasBackup = backupExists(flags.port);
    if (!wasServerRunning && !hasBackup) {
      process.stderr.write(`mo: no saved session for port ${flags.port}\n`);
      return 0;
    }
    const ok = await promptYesNo(
      `mo: clear saved session for port ${flags.port}? [Y/n] `,
      true,
    );
    if (!ok) {
      process.stderr.write("mo: canceled\n");
      return 0;
    }
    if (wasServerRunning) {
      await doShutdown(addr);
      await waitForServerDown(addr);
    }
    if (hasBackup) {
      await backupRemove(flags.port);
    }
    if (wasServerRunning) {
      spawnDetached({
        bind,
        host: bind,
        port: flags.port,
        dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
      });
      process.stderr.write(
        `mo: cleared session and restarted server on port ${flags.port}\n`,
      );
    } else {
      process.stderr.write(
        `mo: cleared saved session for port ${flags.port}\n`,
      );
    }
    return 0;
  }

  if (flags.status) {
    return await doStatus(flags.json);
  }

  if (flags.shutdown) {
    await doShutdown(addr);
    return 0;
  }

  if (flags.restart) {
    await doRestart(addr);
    return 0;
  }

  if (flags.unwatch) {
    if (flags.watch) throw new Error("cannot use --unwatch with --watch");
    if (args.length === 0)
      throw new Error(
        "--unwatch requires a glob pattern or directory argument",
      );
    const { name: resolvedTarget, error } = resolveGroupName(flags.target);
    if (error)
      throw new Error(
        `invalid target group name "${flags.target}": ${error.message}`,
      );
    const patterns = await resolveUnwatchArgs(args, flags.recursive, () =>
      fetchRegisteredPatterns(addr, resolvedTarget),
    );
    await doUnwatch(addr, patterns, resolvedTarget);
    return 0;
  }

  if (flags.close) {
    if (flags.watch) throw new Error("cannot use --close with --watch");
    if (args.length === 0)
      throw new Error("--close requires at least one file argument");
    const { name: resolvedTarget, error } = resolveGroupName(flags.target);
    if (error)
      throw new Error(
        `invalid target group name "${flags.target}": ${error.message}`,
      );
    const { closed, errors } = await doClose(addr, args, resolvedTarget);
    if (closed.length > 0) {
      const names = displayNames(closed);
      for (const n of names) process.stdout.write(`  ${n}\n`);
      process.stderr.write(
        `mo: closed ${closed.length} file(s) from http://${addr}\n`,
      );
    }
    if (errors.length > 0) {
      for (const e of errors) process.stderr.write(`mo: ${e.message}\n`);
      return 1;
    }
    return 0;
  }

  if (flags.restore !== "") {
    const rd = await readRestoreFile(flags.restore);
    return await runStartServer(
      flags,
      addr,
      bind,
      mapFromRecord(rd.groups ?? {}),
      mapFromRecord(rd.patterns ?? {}),
      rd.uploadedFiles ?? [],
    );
  }

  const { name: resolved, error: terr } = resolveGroupName(flags.target);
  if (terr)
    throw new Error(
      `invalid target group name "${flags.target}": ${terr.message}`,
    );
  flags.target = resolved;

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

  let stdinData: { name: string; content: string; group: string } | null = null;
  if (isStdinRedirected()) {
    if (args.length > 0)
      throw new Error("cannot use redirected stdin with positional arguments");
    if (flags.watch)
      throw new Error("cannot use --watch (-w) with redirected stdin");
    const { name, content } = await readStdin(process.stdin);
    stdinData = { name, content, group: flags.target };
  }

  // No files / patterns / stdin: if server running, just open browser.
  if (files.length === 0 && patterns.length === 0 && !stdinData) {
    try {
      await probeServer(addr, PROBE_TIMEOUT_DEFAULT);
      await openBrowser(addr, flags);
      return 0;
    } catch {
      // continue to start new server
    }
  }

  // Try adding to existing server first. Only fall through to startup when
  // the probe itself fails (no server running). Errors from the subsequent
  // API calls must surface so users actually see "binary file rejected"
  // type problems instead of silently spawning a fresh server.
  if (stdinData || files.length > 0 || patterns.length > 0) {
    let probed: Awaited<ReturnType<typeof probeServer>> | null = null;
    try {
      probed = await probeServer(addr, PROBE_TIMEOUT_FAST);
    } catch {
      probed = null;
    }
    if (probed !== null) {
      const isNewGroup = !probed.groups.includes(flags.target);
      const deeplinks: DeeplinkEntry[] = [];

      const pf = await postFiles(addr, flags.target, files);
      deeplinks.push(...pf.entries);
      const pp = await postPatterns(addr, flags.target, patterns);
      deeplinks.push(...pp.entries);

      let stdinUploadErr: Error | null = null;
      if (stdinData) {
        try {
          const e = await postUploadedFile(
            addr,
            flags.target,
            stdinData.name,
            stdinData.content,
          );
          deeplinks.push(e);
        } catch (err) {
          stdinUploadErr = err as Error;
          logger.warn("failed to upload stdin content", { error: String(err) });
        }
      }
      if (
        stdinData &&
        files.length === 0 &&
        patterns.length === 0 &&
        stdinUploadErr
      ) {
        throw stdinUploadErr;
      }

      const succeededFiles = pf.entries.length;
      const succeededPatterns = pp.entries.length > 0 ? patterns.length : 0;
      let added = pf.entries.length + succeededPatterns;
      if (stdinData && !stdinUploadErr) added++;
      logger.info("added to existing server", {
        files: succeededFiles,
        patterns: patterns.length,
        stdin: stdinData != null,
        addr,
      });
      emitServeOutput(addr, deeplinks, false, flags.json);
      process.stderr.write(`mo: added ${added} item(s) to http://${addr}\n`);

      // Surface real per-file failures.
      for (const e of pf.errors) {
        process.stderr.write(`mo: ${e.message}\n`);
      }
      for (const e of pp.errors) {
        process.stderr.write(`mo: ${e.message}\n`);
      }

      if (isNewGroup || flags.open) await openBrowser(addr, flags);
      if (pf.errors.length > 0 || pp.errors.length > 0) return 1;
      return 0;
    }
  }

  const filesByGroup = new Map<string, string[]>();
  filesByGroup.set(flags.target, files);
  const patternsByGroup = new Map<string, string[]>();
  if (patterns.length > 0) patternsByGroup.set(flags.target, patterns);

  let mergedFiles = filesByGroup;
  let mergedPatterns = patternsByGroup;
  let uploadedFiles: Array<{ name: string; content: string; group: string }> =
    [];

  try {
    const rd = await backupLoad(flags.port);
    const filtered = filterValidRestoreData(rd);
    if (
      filtered.files.size > 0 ||
      filtered.patterns.size > 0 ||
      filtered.uploadedFiles.length > 0
    ) {
      logger.info("restoring session from backup", { port: flags.port });
      process.stderr.write(
        `mo: restoring previous session for port ${flags.port}\n`,
      );
      mergedFiles = mergeGroups(filtered.files, filesByGroup);
      mergedPatterns = mergeGroups(filtered.patterns, patternsByGroup);
      uploadedFiles = filtered.uploadedFiles;
    }
  } catch (err) {
    logger.warn("failed to load backup", { error: String(err) });
  }

  if (stdinData) uploadedFiles.push(stdinData);

  if (!isLoopbackBind(bind)) {
    logger.warn("binding to non-loopback address", {
      bind,
      dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
    });
  }
  if (!isLoopbackBind(bind) && !flags.dangerouslyAllowRemoteAccess) {
    if (stdinData) {
      throw new Error(
        "cannot use redirected stdin with non-loopback bind without --dangerously-allow-remote-access",
      );
    }
    process.stderr.write(
      pc.bold(pc.yellow("SECURITY WARNING: ")) +
        pc.yellow(
          `Binding to ${bind} instead of localhost. mo has no authentication -- remote clients can:`,
        ) +
        "\n",
    );
    process.stderr.write(
      pc.yellow("  - Read any file accessible by this user") + "\n",
    );
    process.stderr.write(
      pc.yellow("  - Browse the filesystem via glob patterns") + "\n",
    );
    process.stderr.write(
      pc.yellow("  - Shut down or restart the server") + "\n",
    );
    const ok = await promptYesNo("Continue? [y/N] ");
    if (!ok) {
      process.stderr.write("mo: canceled\n");
      return 0;
    }
  }

  if (flags.foreground) {
    return await runStartServer(
      flags,
      addr,
      bind,
      mergedFiles,
      mergedPatterns,
      uploadedFiles,
    );
  }

  return await startBackground(
    flags,
    addr,
    bind,
    mergedFiles,
    mergedPatterns,
    uploadedFiles,
  );
}

async function openBrowser(addr: string, flags: Flags): Promise<void> {
  if (flags.noOpen) return;
  const url =
    flags.target === DefaultGroup
      ? `http://${addr}`
      : `http://${addr}/${encodeURIComponent(flags.target)}`;
  try {
    await open(url);
  } catch (err) {
    logger.warn("could not open browser", { error: String(err) });
  }
}

async function runStartServer(
  flags: Flags,
  addr: string,
  bind: string,
  filesByGroup: Map<string, string[]>,
  patternsByGroup: Map<string, string[]>,
  uploadedFiles: Array<{ name: string; content: string; group: string }>,
): Promise<number> {
  const result = await startServer({
    addr,
    host: bind,
    port: flags.port,
    filesByGroup,
    patternsByGroup,
    uploadedFiles,
    noOpen: flags.noOpen,
    target: flags.target,
    onReady: (deeplinks) => {
      emitServeOutput(addr, deeplinks, true, flags.json);
    },
  });
  if (result.restartRequested) {
    spawnDetached({
      bind,
      host: bind,
      port: flags.port,
      restoreFile: result.restartRequested,
      dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
    });
  }
  return result.exitCode;
}

async function startBackground(
  flags: Flags,
  addr: string,
  bind: string,
  filesByGroup: Map<string, string[]>,
  patternsByGroup: Map<string, string[]>,
  uploadedFiles: Array<{ name: string; content: string; group: string }>,
): Promise<number> {
  const restoreData: RestoreData = {
    groups: Object.fromEntries(filesByGroup),
    patterns:
      patternsByGroup.size > 0 ? Object.fromEntries(patternsByGroup) : {},
    uploadedFiles,
  };
  const restoreFile = await writeRestoreFile(restoreData);
  try {
    const proc = spawnDetached({
      bind,
      host: bind,
      port: flags.port,
      restoreFile,
      dangerouslyAllowRemoteAccess: flags.dangerouslyAllowRemoteAccess,
    });
    const pid = proc.pid;
    const status = await waitForReady(addr, 10_000);
    const deeplinks: DeeplinkEntry[] = [];
    if (status) {
      for (const g of status.groups ?? []) {
        for (const f of g.files) {
          deeplinks.push({
            url: buildDeeplink(addr, g.name, f.id, DefaultGroup),
            path: f.path,
            name: f.name,
          });
        }
      }
    }
    emitServeOutput(addr, deeplinks, true, flags.json);
    process.stderr.write(`mo: serving at http://${addr} (pid ${pid})\n`);
    await openBrowser(addr, flags);
    return 0;
  } catch (err) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(restoreFile, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

const LONG_DESC = `mo is a Markdown viewer that opens .md files in a browser with live-reload.

It runs in the background, serving Markdown files using a built-in React SPA,
and automatically refreshes the browser when files are saved.

Examples:
  mo README.md                          Open a single file
  mo README.md CHANGELOG.md docs/*.md   Open multiple files
  mo spec.md --target design            Open in a named group
  mo draft.md --port 6276               Use a different port
  cat notes.md | mo                     Read Markdown from stdin
  cmd | mo --target output              Pipe command output into a group

Single Server, Multiple Files:
  By default, mo runs a single server on port 6275.
  If a mo server is already running on the same port, subsequent mo
  invocations add files to the existing session instead of starting a new one.

Groups:
  Files can be organized into named groups using the --target (-t) flag.
  Each group gets its own URL path (e.g., http://localhost:6275/design)
  and its own sidebar in the browser.

Starting and Stopping:
  mo runs in the background by default. Use --status to inspect, --shutdown
  to stop, and --restart to restart while preserving session state.
  Use --foreground to keep the server attached to the terminal.

Session Restore:
  mo automatically saves session state. When starting a new server, the
  previous session is restored and merged with any specified files.
  Use --clear to remove a saved session.

Live-Reload:
  mo watches all opened files for changes via fs events. When a file is
  saved, the browser automatically re-renders the content.

Watch mode and glob patterns:
  --watch (-w) turns on watch mode. Directory and glob positional arguments
  are then registered as watch patterns; matching files are opened and new
  files are picked up automatically. Combine with --recursive (-R) to
  descend into subdirectories.

WARNING: --bind with a non-loopback address exposes mo to the network
without any authentication. A confirmation prompt is shown before starting.`;

export async function runCli(): Promise<number> {
  const program = new Command();
  program
    .name(Name)
    .description("mo is a Markdown viewer that opens .md files in a browser.")
    .addHelpText("after", "\n" + LONG_DESC)
    .version(`${Version} ${Revision}`)
    .argument("[files...]", "Files, directories, or glob patterns")
    .option("-t, --target <name>", "Tab group name", DefaultGroup)
    .option(
      "-p, --port <number>",
      "Server port",
      (v) => Number(v),
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
      "Shut down the running mo server on the specified port",
    )
    .option("--restart", "Restart the running mo server on the specified port")
    .addOption(
      new CommanderOption(
        "--restore <file>",
        "Restore state from file (internal use)",
      ).hideHelp(),
    )
    .option("--foreground", "Run mo server in foreground (do not background)")
    .option("--status", "Show status of all running mo servers")
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
      "--dangerously-allow-remote-access",
      "Allow remote access without authentication. Recommended only for trusted networks.",
    );

  program.exitOverride();
  // Detect open/no-open explicitly from argv before commander folds them.
  const openExplicit = process.argv.includes("--open");
  const noOpenExplicit = process.argv.includes("--no-open");
  if (openExplicit && noOpenExplicit) {
    process.stderr.write("mo: --open and --no-open are mutually exclusive\n");
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

  const flags: Flags = {
    target: String(opts["target"] ?? DefaultGroup),
    port: Number(opts["port"] ?? DEFAULT_PORT),
    bind: String(opts["bind"] ?? "localhost"),
    open: openExplicit,
    noOpen: noOpenExplicit,
    shutdown: opts["shutdown"] === true,
    restart: opts["restart"] === true,
    restore: typeof opts["restore"] === "string" ? opts["restore"] : "",
    foreground: opts["foreground"] === true,
    status: opts["status"] === true,
    watch: opts["watch"] === true,
    unwatch: opts["unwatch"] === true,
    recursive: opts["recursive"] === true,
    close: opts["close"] === true,
    clear: opts["clear"] === true,
    json: opts["json"] === true,
    dangerouslyAllowRemoteAccess: opts["dangerouslyAllowRemoteAccess"] === true,
  };

  if (flags.shutdown && flags.restart) {
    process.stderr.write(
      "mo: --shutdown and --restart are mutually exclusive\n",
    );
    return 1;
  }

  const args = parsed.args.filter((a) => a != null && a !== "");

  try {
    return await runMain(args, flags);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}
