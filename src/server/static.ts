import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
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

// The SPA's files are immutable for the lifetime of a server process (dist
// is replaced only by reinstalling/rebuilding, which comes with a restart),
// so each one is read once and then served straight from memory: no stat,
// no open, no stream per request. Vite emits content-hashed filenames under
// /assets/, which additionally makes them safe to cache in the browser
// forever; everything else (index.html, favicon) revalidates via ETag.
interface CachedAsset {
  buf: Buffer;
  mime: string;
  etag: string;
  immutable: boolean;
}

const ASSET_CACHE_MAX_FILE = 8 * 1024 * 1024;
const ASSET_CACHE_MAX_TOTAL = 64 * 1024 * 1024;
const assetCache = new Map<string, CachedAsset>();
let assetCacheBytes = 0;

function loadAsset(absPath: string): CachedAsset | null {
  const cached = assetCache.get(absPath);
  if (cached) return cached;
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return null;
  }
  const asset: CachedAsset = {
    buf,
    mime: mimeForFile(absPath),
    etag: `"${createHash("sha1").update(buf).digest("base64url")}"`,
    immutable: absPath.startsWith(join(FRONTEND_DIR, "assets") + sep),
  };
  if (
    buf.length <= ASSET_CACHE_MAX_FILE &&
    assetCacheBytes + buf.length <= ASSET_CACHE_MAX_TOTAL
  ) {
    assetCache.set(absPath, asset);
    assetCacheBytes += buf.length;
  }
  return asset;
}

function sendAsset(
  req: IncomingMessage,
  res: ServerResponse,
  asset: CachedAsset,
): void {
  res.setHeader("Content-Type", asset.mime);
  res.setHeader("ETag", asset.etag);
  res.setHeader(
    "Cache-Control",
    asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
  if (req.headers["if-none-match"] === asset.etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", String(asset.buf.length));
  res.end(asset.buf);
}

export function serveSpa(req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? "/";
  const qIdx = rawUrl.indexOf("?");
  let urlPath = qIdx === -1 ? rawUrl : rawUrl.substring(0, qIdx);
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
  const requested = join(FRONTEND_DIR, decoded);

  // Boundary check via path resolution; this safely catches any
  // `..` based traversal without false-rejecting legitimate names that
  // happen to contain `..` mid-segment (e.g. `release..notes`).
  const baseAbs = resolve(FRONTEND_DIR);
  const requestedAbs = resolve(requested);
  if (requestedAbs !== baseAbs && !requestedAbs.startsWith(baseAbs + sep)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }

  const asset = loadAsset(requested);
  if (asset) {
    sendAsset(req, res, asset);
    return;
  }

  const fallback = loadAsset(join(FRONTEND_DIR, "index.html"));
  if (fallback) {
    sendAsset(req, res, fallback);
    return;
  }
  res.statusCode = 404;
  res.end("not found");
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
