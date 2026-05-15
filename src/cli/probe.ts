import http, { type IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";

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

export const PROBE_TIMEOUT_FAST = 500;
export const PROBE_TIMEOUT_DEFAULT = 2000;

export async function probeServer(
  addr: string,
  timeoutMs = PROBE_TIMEOUT_DEFAULT,
): Promise<ProbeResult> {
  const status = await httpGetJson<ProbeStatus>(
    `http://${addr}/_/api/status`,
    timeoutMs,
  );
  if (!status || !status.version) {
    throw new Error(`server on ${addr} is not a mo instance`);
  }
  return {
    status,
    groups: (status.groups ?? []).map((g) => g.name),
  };
}

export function httpGetJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = http.get(
      url,
      { timeout: timeoutMs },
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
    const req = httpRequest(
      {
        hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        timeout: timeoutMs,
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
  const interval = 100;
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await probeServer(addr, 500);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `server on ${addr} did not shut down within ${totalTimeoutMs}ms`,
  );
}

export async function waitForReady(
  addr: string,
  totalTimeoutMs = 10_000,
): Promise<ProbeStatus | null> {
  const deadline = Date.now() + totalTimeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const status = await httpGetJson<ProbeStatus>(
        `http://${addr}/_/api/status`,
        500,
      );
      if (status) return status;
    } catch (err) {
      lastErr = err as Error;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (lastErr)
    throw new Error(
      `server did not become ready within ${totalTimeoutMs}ms: ${lastErr.message}`,
    );
  throw new Error(`server did not become ready within ${totalTimeoutMs}ms`);
}
