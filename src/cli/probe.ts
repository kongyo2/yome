import { createRequire } from "node:module";
import type { IncomingMessage } from "node:http";

// Load node:http through require() instead of an ESM import: building the
// builtin's ESM module facade force-evaluates its lazy fetch/WebSocket
// getters, which drags undici in and costs ~60ms of extra startup on every
// CLI invocation that talks to a server. require() keeps those getters
// lazy. On top of that, the require itself is deferred until a request is
// actually made — commands that end up making no HTTP call (e.g. --status
// with no servers) never compile the builtin at all.
const requireBuiltin = createRequire(import.meta.url);
let httpMod: typeof import("node:http") | null = null;
function getHttp(): typeof import("node:http") {
  return (httpMod ??= requireBuiltin("node:http"));
}

export interface ProbeStatus {
  version: string;
  revision: string;
  pid: number;
  groups: Array<{
    name: string;
    files: Array<{ name: string; id: string; path: string }>;
    patterns?: string[];
  }>;
}

export interface ProbeResult {
  status: ProbeStatus;
  groups: string[];
}

// PROBE_TIMEOUT_FAST is used when a missing server is the normal case (e.g.
// first launch); PROBE_TIMEOUT_DEFAULT when the server is expected to be up.
export const PROBE_TIMEOUT_FAST = 500;
export const PROBE_TIMEOUT_DEFAULT = 2000;
// How long waitForReady keeps polling after the spawned child died, giving
// a race-winning server a chance to respond before the failure is reported.
export const DEAD_CHILD_GRACE_MS = 1000;

// ServerConflictError is thrown by waitForReady when a yome server other
// than the spawned child owns the port (it lost a concurrent startup race).
export class ServerConflictError extends Error {
  constructor(readonly status: ProbeStatus) {
    super(`another yome server is already running (pid ${status.pid})`);
    this.name = "ServerConflictError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function statusUrl(addr: string): string {
  return `http://${addr}/_/api/status`;
}

export async function probeServer(
  addr: string,
  timeoutMs = PROBE_TIMEOUT_DEFAULT,
): Promise<ProbeResult> {
  const status = await httpGetJson<ProbeStatus>(statusUrl(addr), timeoutMs);
  if (!status || !status.version) {
    throw new Error(`server on ${addr} is not a yome instance`);
  }
  return {
    status,
    groups: (status.groups ?? []).map((g) => g.name),
  };
}

export function httpGetJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = getHttp().get(
      url,
      // agent:false → one fresh connection per request (Connection: close).
      // Node ≥19 pools keep-alive sockets by default, and a pooled socket
      // keeps being served by a half-closed server — which made
      // waitForServerDown blind to an actual shutdown.
      { timeout: timeoutMs, agent: false },
      (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout connecting to ${url}`));
    });
    req.on("error", reject);
  });
}

export interface HttpResponse {
  status: number;
  body: string;
}

export function httpRequestJson(
  method: string,
  url: string,
  body: unknown,
  timeoutMs = PROBE_TIMEOUT_DEFAULT,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const data =
      body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const parsed = new URL(url);
    // Node's http.request expects an unbracketed host for IPv6 literals,
    // but URL#hostname returns "[::1]". Strip the brackets so requests to
    // http://[::1]:.../ work without ENOTFOUND.
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    const req = getHttp().request(
      {
        hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        timeout: timeoutMs,
        // See httpGetJson: never reuse pooled sockets against a server that
        // may be shutting down.
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(data.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout: ${url}`)));
    req.on("error", reject);
    if (data.length > 0) req.write(data);
    req.end();
  });
}

export async function waitForServerDown(
  addr: string,
  totalTimeoutMs = 5000,
): Promise<void> {
  const interval = 50;
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await probeServer(addr, 500);
    } catch {
      return;
    }
    await sleep(interval);
  }
  throw new Error(
    `server on ${addr} did not shut down within ${totalTimeoutMs}ms`,
  );
}

export interface WaitForReadyOptions {
  // PID of the server process this call spawned. When a yome server answers
  // with a different PID, the child lost a concurrent startup race and a
  // ServerConflictError (carrying the winner's status) is thrown.
  childPid?: number;
  // Reports whether the spawned child has exited. Polling continues for
  // DEAD_CHILD_GRACE_MS after that (the race winner may not be serving yet)
  // and then fails fast instead of waiting out the full timeout.
  childExited?: () => boolean;
}

// waitForReady polls addr until a yome server responds as ready, the spawned
// child dies, or the timeout elapses.
export async function waitForReady(
  addr: string,
  totalTimeoutMs = 10_000,
  opts: WaitForReadyOptions = {},
): Promise<ProbeStatus> {
  const deadline = Date.now() + totalTimeoutMs;
  let lastErr: Error | null = null;
  let childDeadSince: number | null = null;
  while (Date.now() < deadline) {
    try {
      const status = await httpGetJson<ProbeStatus>(statusUrl(addr), 500);
      if (status && status.version) {
        if (opts.childPid && status.pid !== opts.childPid) {
          throw new ServerConflictError(status);
        }
        return status;
      }
    } catch (err) {
      if (err instanceof ServerConflictError) throw err;
      lastErr = err as Error;
    }
    if (opts.childExited && childDeadSince === null && opts.childExited()) {
      childDeadSince = Date.now();
    }
    if (
      childDeadSince !== null &&
      Date.now() - childDeadSince >= DEAD_CHILD_GRACE_MS
    ) {
      throw new Error(
        "server process exited unexpectedly; the port may be in use by another server",
      );
    }
    // Startup readiness is on the interactive path (`yome file.md` blocks on
    // it when spawning the server); a tight poll shaves real latency.
    await sleep(15);
  }
  const detail = lastErr ? `: ${lastErr.message}` : "";
  throw new Error(
    `server did not become ready within ${totalTimeoutMs}ms; the port may be in use by another (non-yome) server${detail}`,
  );
}
