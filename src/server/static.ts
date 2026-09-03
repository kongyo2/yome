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
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
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

// etagMatches implements the weak comparison of If-None-Match (RFC 9110
// §13.1.2): a list of entity tags, or "*", where W/ prefixes are ignored.
function etagMatches(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw.trim() === "*") return true;
  const strong = etag.replace(/^W\//, "");
  return raw
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === strong);
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
  if (etagMatches(req.headers["if-none-match"], asset.etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", String(asset.buf.length));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
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

// sendLocalFile streams a user file (raw assets referenced from Markdown:
// images, attachments) with validators so a browser re-render does not
// re-download unchanged images: `no-cache` forces a revalidation on every
// use, and a matching If-None-Match / If-Modified-Since answers 304.
export function sendLocalFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): void {
  let st;
  try {
    st = statSync(path, { bigint: true });
  } catch {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  if (!st.isFile()) {
    res.statusCode = 404;
    res.end("not a file");
    return;
  }
  // Validator: size, nanosecond mtime, and inode. The inode catches the
  // common "replace by rename" write (editors, generators) even when the
  // tool preserves timestamps, and nanosecond precision separates rapid
  // same-size in-place rewrites — cases a size+millisecond tag would 304.
  const etag = `W/"${st.size.toString(16)}-${st.mtimeNs.toString(16)}-${st.ino.toString(16)}"`;
  const mtimeMs = Number(st.mtimeNs / 1_000_000n);
  res.setHeader("Content-Type", mimeForFile(path));
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", new Date(mtimeMs).toUTCString());
  res.setHeader("Cache-Control", "no-cache");

  let fresh = etagMatches(req.headers["if-none-match"], etag);
  const ims = req.headers["if-modified-since"];
  if (!fresh && req.headers["if-none-match"] === undefined && ims) {
    const since = Date.parse(Array.isArray(ims) ? (ims[0] ?? "") : ims);
    // HTTP dates carry second precision; compare at that granularity.
    if (!Number.isNaN(since))
      fresh = Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  if (fresh) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Length", String(st.size));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}
