import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const moduleFile = fileURLToPath(import.meta.url);
const moduleDir = dirname(moduleFile);

// Resolve the bundled frontend directory.
// In built form it sits at dist/frontend; in dev (src/server/static.ts) it lives at ../../frontend/dist.
function findFrontendDir(): string {
  const candidates = [
    resolve(moduleDir, "..", "frontend"),
    resolve(moduleDir, "..", "..", "frontend", "dist"),
    resolve(moduleDir, "..", "..", "..", "frontend", "dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return candidates[0]!;
}

export const FRONTEND_DIR = findFrontendDir();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeForFile(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = path.substring(dot).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function serveSpa(req: IncomingMessage, res: ServerResponse): void {
  let urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  if (urlPath === "/") urlPath = "/index.html";
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // Malformed percent-encoding — refuse instead of crashing the process.
    res.statusCode = 400;
    res.end("bad request");
    return;
  }
  if (decoded.includes("..")) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  const requested = join(FRONTEND_DIR, decoded);

  // Ensure the resolved path stays within FRONTEND_DIR using a
  // separator-aware boundary check.
  const baseAbs = resolve(FRONTEND_DIR);
  const requestedAbs = resolve(requested);
  if (requestedAbs !== baseAbs && !requestedAbs.startsWith(baseAbs + sep)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }

  try {
    const st = statSync(requested);
    if (st.isFile()) {
      sendFile(res, requested);
      return;
    }
  } catch {
    // fall through to SPA fallback
  }

  const fallback = join(FRONTEND_DIR, "index.html");
  sendFile(res, fallback);
}

export function sendFile(res: ServerResponse, path: string): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeForFile(path));
  res.setHeader("Content-Length", String(st.size));
  const stream = createReadStream(path);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    }
  });
  stream.pipe(res);
}

export function joinPosix(...p: string[]): string {
  return posix.join(...p);
}
