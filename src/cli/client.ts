// Client-side commands that talk to an already-running yome server (or
// inspect on-disk state for one): --status, --shutdown, --restart, --close,
// --unwatch, and the add-file/pattern/upload calls used when a server is
// already listening on the target port.
import { readdir } from "node:fs/promises";
import { backupDir } from "../backup/index.js";
import { logger, logDir } from "../logfile/index.js";
import { DefaultGroup } from "../server/group.js";
import {
  PROBE_TIMEOUT_DEFAULT,
  httpGetJson,
  httpRequestJson,
  probeServer,
} from "./probe.js";
import { toAbsolute } from "./args.js";
import { buildDeeplink, writeJson, type DeeplinkEntry } from "./display.js";

export { writeJson };

async function listPortsFromDir(
  dir: string,
  prefix: string,
  suffix: string,
): Promise<number[]> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ports: number[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const raw = name.substring(prefix.length, name.length - suffix.length);
    const p = Number(raw);
    if (!Number.isFinite(p) || !Number.isInteger(p) || String(p) !== raw)
      continue;
    ports.push(p);
  }
  return ports;
}

interface DiscoveredPorts {
  all: number[];
  // Ports that have a backup JSON but no log file. These have no observable
  // history in `--status` otherwise — surfacing them here is what makes
  // long-lived orphan backups discoverable.
  backupOnly: Set<number>;
}

async function discoverPortsDetailed(): Promise<DiscoveredPorts> {
  const [logPorts, backupPorts] = await Promise.all([
    listPortsFromDir(logDir(), "yome-", ".log"),
    listPortsFromDir(backupDir(), "yome-", ".json"),
  ]);
  const logSet = new Set(logPorts);
  const backupOnly = new Set<number>();
  for (const p of backupPorts) {
    if (!logSet.has(p)) backupOnly.add(p);
  }
  const all = [...new Set([...logPorts, ...backupPorts])].sort((a, b) => a - b);
  return { all, backupOnly };
}

async function discoverPorts(): Promise<number[]> {
  return (await discoverPortsDetailed()).all;
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

export async function doStatus(jsonMode: boolean): Promise<number> {
  const { all: ports, backupOnly } = await discoverPortsDetailed();
  if (ports.length === 0) {
    if (jsonMode) writeJson([]);
    else process.stderr.write("yome: no yome server found\n");
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
      const orphanBackup = backupOnly.has(p);
      if (jsonMode) {
        const entry: Record<string, unknown> = {
          url: `http://${addr}`,
          status: "stopped",
        };
        if (orphanBackup) entry["orphanBackup"] = true;
        jsonEntries.push(entry);
      } else {
        const note = orphanBackup ? " (saved session backup only)" : "";
        process.stdout.write(`http://${addr} (stopped)${note}\n`);
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
    process.stderr.write("yome: no yome server found\n");
  }
  return 0;
}

export async function doShutdown(addr: string): Promise<void> {
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
  process.stderr.write(`yome: shutdown request sent to http://${addr}\n`);
}

export async function doRestart(addr: string): Promise<void> {
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
  process.stderr.write(`yome: restart request sent to http://${addr}\n`);
}

export async function shutdownOrRestartAll(
  action: "shutdown" | "restart",
): Promise<number> {
  const ports = await discoverPorts();
  if (ports.length === 0) {
    process.stderr.write("yome: no yome server found\n");
    return 0;
  }
  let actedCount = 0;
  const errors: Array<{ port: number; message: string }> = [];
  for (const port of ports) {
    const addr = `localhost:${port}`;
    try {
      // Use the full probe timeout (not the fast one) so a temporarily
      // slow-but-running yome instance is not silently skipped.
      await probeServer(addr, PROBE_TIMEOUT_DEFAULT);
    } catch {
      continue;
    }
    try {
      if (action === "shutdown") {
        await doShutdown(addr);
      } else {
        await doRestart(addr);
      }
      actedCount++;
    } catch (err) {
      errors.push({ port, message: (err as Error).message });
    }
  }
  for (const e of errors) {
    process.stderr.write(
      `yome: failed to ${action} port ${e.port}: ${e.message}\n`,
    );
  }
  if (actedCount === 0 && errors.length === 0) {
    process.stderr.write("yome: no running yome server found\n");
  }
  return errors.length > 0 ? 1 : 0;
}

export async function doUnwatch(
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
    process.stderr.write(`yome: unwatched ${pat}\n`);
  }
}

export async function fetchRegisteredPatterns(
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

export async function doClose(
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
    // Per-file try/catch keeps the "collect all, return partial success"
    // contract: a network error mid-batch must not discard prior results.
    try {
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
    } catch (err) {
      errors.push(
        new Error(`failed to close "${abs}": ${(err as Error).message}`, {
          cause: err,
        }),
      );
    }
  }
  return { closed, errors };
}

export interface PostFileError {
  target: string;
  message: string;
}

export interface PostFileResult {
  entries: DeeplinkEntry[];
  errors: PostFileError[];
  // Number of requests the server accepted. For patterns this can exceed
  // entries.length (a registered pattern may match zero files today).
  succeeded: number;
}

export async function postFiles(
  addr: string,
  group: string,
  files: string[],
): Promise<PostFileResult> {
  const entries: DeeplinkEntry[] = [];
  const errors: PostFileError[] = [];
  let succeeded = 0;
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
      succeeded++;
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
  return { entries, errors, succeeded };
}

export async function postPatterns(
  addr: string,
  group: string,
  patterns: string[],
): Promise<PostFileResult> {
  const entries: DeeplinkEntry[] = [];
  const errors: PostFileError[] = [];
  let succeeded = 0;
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
      succeeded++;
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
  return { entries, errors, succeeded };
}

export async function postUploadedFile(
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
