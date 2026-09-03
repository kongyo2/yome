import { readFile, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve as pathResolve,
} from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../logfile/index.js";
import { Name, Revision, Version } from "../version.js";
import type { State } from "./state.js";
import { writeRestoreFile } from "../common/restore.js";
import { resolveGroupName, DefaultGroup } from "./group.js";
import {
  findSearchMatches,
  readSearchableContent,
  type SearchResult,
} from "./search.js";
import { sendLocalFile } from "./static.js";
import { EVENT_STARTED, type FileEntry } from "./types.js";

// JSON request bodies (12MB leaves headroom for the JSON envelope around a
// 10MB upload) and the uploaded content itself.
const MAX_UPLOAD_BYTES = 12 << 20;
const MAX_CONTENT_BYTES = 10 << 20;

const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 200;
const SEARCH_DEFAULT_CONTEXT = 2;
const SEARCH_MAX_CONTEXT = 5;
// Files are read in small parallel batches; matching stays strictly ordered.
const SEARCH_READ_BATCH = 8;

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function textResponse(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body + "\n");
}

function noContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

// Reject browser cross-site requests on state-mutating endpoints. CLI clients
// send neither Sec-Fetch-Site nor Origin, so they pass through unchanged.
function isSameOriginRequest(req: IncomingMessage): boolean {
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string") {
    // "same-site" allows sibling subdomains under the same registrable
    // domain — too loose for shutdown/restart. Only accept truly
    // same-origin requests and "none" (direct navigation, non-browser).
    return sfs === "same-origin" || sfs === "none";
  }
  const origin = req.headers["origin"];
  if (typeof origin === "string" && origin !== "") {
    // "null" is an opaque origin (data: URLs, sandboxed iframes, some
    // redirected POSTs); treat it as cross-origin, not absent.
    if (origin === "null") return false;
    const host = req.headers["host"];
    if (typeof host !== "string" || host === "") return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return true;
}

class RequestEntityTooLargeError extends Error {}

// readJsonBody collects a JSON object body of at most maxBytes. Anything
// that is not a JSON object (arrays, primitives, null) is rejected up front
// so handlers can index fields without guarding against TypeErrors.
async function readJsonBody<T extends object>(
  req: IncomingMessage,
  maxBytes: number,
): Promise<T> {
  return new Promise<T>((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        rejectP(new RequestEntityTooLargeError("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        rejectP(new Error("empty body"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf.toString("utf8"));
      } catch (err) {
        rejectP(err);
        return;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        rejectP(new Error("invalid JSON body: expected an object"));
        return;
      }
      resolveP(parsed as T);
    });
    req.on("error", (err) => rejectP(err));
  });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

// parseBoundedInt parses a query parameter as a non-negative integer with an
// upper clamp. Returns null when the value is present but not an integer.
function parseBoundedInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) return null;
  return Math.min(max, n);
}

interface AddFileReq {
  path?: unknown;
}
interface UploadFileReq {
  name?: unknown;
  content?: unknown;
}
interface MoveFileReq {
  group?: unknown;
}
interface ReorderReq {
  fileIds?: unknown;
}
interface PatternReq {
  pattern?: unknown;
  group?: unknown;
}
interface OpenFileReq {
  fileId?: unknown;
  path?: unknown;
}

export interface BuildHandlersOpts {
  pid: number;
}

// stripContent returns a serializable view of a FileEntry without the
// in-memory `content` field. Uploaded contents can be up to 10MB and
// must never leak into list / status / add responses.
function stripContent(entry: FileEntry): Omit<FileEntry, "content"> {
  const { content: _content, ...rest } = entry;
  void _content;
  return rest;
}

export function buildHandlers(state: State, opts: BuildHandlersOpts) {
  const pid = opts.pid;

  // Guard every state-mutating endpoint against browser cross-site requests
  // (the SPA fetches same-origin; CLI clients send neither Sec-Fetch-Site
  // nor Origin and pass through). Returns true when the request was
  // rejected and the response has been written.
  function rejectCrossSite(req: IncomingMessage, res: ServerResponse): boolean {
    if (isSameOriginRequest(req)) return false;
    textResponse(res, 403, "cross-site request rejected");
    return true;
  }

  // requireGroup validates a group name (route param or body field) and
  // writes the 400 response itself; null means "already answered".
  function requireGroup(raw: unknown, res: ServerResponse): string | null {
    const { name, error } = resolveGroupName(
      typeof raw === "string" ? raw : null,
    );
    if (error) {
      textResponse(res, 400, error.message);
      return null;
    }
    return name;
  }

  function requireFileId(
    params: Record<string, string>,
    res: ServerResponse,
  ): string | null {
    const id = params["id"] ?? "";
    if (id === "") {
      textResponse(res, 400, "missing file id");
      return null;
    }
    return id;
  }

  // readBody wraps readJsonBody with the shared error mapping (413 for
  // oversized payloads, 400 otherwise); null means "already answered".
  async function readBody<T extends object>(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<T | null> {
    try {
      return await readJsonBody<T>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof RequestEntityTooLargeError) {
        textResponse(res, 413, "payload too large");
      } else {
        textResponse(res, 400, (err as Error).message);
      }
      return null;
    }
  }

  function groupsWithPatterns() {
    return state.listGroups().map((g) => ({
      name: g.name,
      files: g.files.map(stripContent),
      patterns: state.patternsForGroup(g.name),
    }));
  }

  async function handleAddFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const group = requireGroup(params["group"], res);
    if (group === null) return;
    const body = await readBody<AddFileReq>(req, res);
    if (body === null) return;
    if (!isNonEmptyString(body.path)) {
      return textResponse(res, 400, "missing path");
    }
    const abs = isAbsolute(body.path) ? body.path : pathResolve(body.path);
    try {
      await stat(abs);
    } catch {
      return textResponse(res, 400, `file not found: ${abs}`);
    }
    try {
      jsonResponse(res, 200, stripContent(state.addFile(abs, group)));
    } catch (err) {
      textResponse(res, 400, (err as Error).message);
    }
  }

  async function handleUploadFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const group = requireGroup(params["group"], res);
    if (group === null) return;
    let body: UploadFileReq;
    try {
      body = await readJsonBody<UploadFileReq>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof RequestEntityTooLargeError) {
        return textResponse(res, 413, "file too large (max 10MB)");
      }
      return textResponse(res, 400, (err as Error).message);
    }
    if (typeof body.content !== "string") {
      return textResponse(res, 400, "missing or invalid 'content' field");
    }
    if (!isNonEmptyString(body.name)) {
      return textResponse(res, 400, "missing file name");
    }
    if (Buffer.byteLength(body.content) > MAX_CONTENT_BYTES) {
      return textResponse(res, 413, "file too large (max 10MB)");
    }
    try {
      const entry = state.addUploadedFile(body.name, body.content, group);
      jsonResponse(res, 200, stripContent(entry));
    } catch (err) {
      textResponse(res, 400, (err as Error).message);
    }
  }

  function handleRemoveFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const group = requireGroup(params["group"], res);
    if (group === null) return;
    const id = requireFileId(params, res);
    if (id === null) return;
    if (!state.removeFile(id, group)) {
      return textResponse(res, 404, "file not found");
    }
    noContent(res);
  }

  async function handleMoveFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const sourceGroup = requireGroup(params["group"], res);
    if (sourceGroup === null) return;
    const id = requireFileId(params, res);
    if (id === null) return;
    const body = await readBody<MoveFileReq>(req, res);
    if (body === null) return;
    const targetGroup = requireGroup(body.group, res);
    if (targetGroup === null) return;
    const result = state.moveFile(id, sourceGroup, targetGroup);
    if ("error" in result) {
      return textResponse(res, result.status, result.error);
    }
    noContent(res);
  }

  async function handleReorder(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const group = requireGroup(params["group"], res);
    if (group === null) return;
    const body = await readBody<ReorderReq>(req, res);
    if (body === null) return;
    const ids = body.fileIds;
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === "string")) {
      return textResponse(res, 400, "missing or invalid 'fileIds' field");
    }
    if (!state.reorderFiles(group, ids as string[])) {
      return textResponse(res, 400, "invalid file IDs or group not found");
    }
    noContent(res);
  }

  function handleGroups(_req: IncomingMessage, res: ServerResponse) {
    jsonResponse(res, 200, groupsWithPatterns());
  }

  async function handleFileContent(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    const group = requireGroup(params["group"], res);
    if (group === null) return;
    const id = requireFileId(params, res);
    if (id === null) return;
    const entry = state.findFile(id, group);
    if (!entry) return textResponse(res, 404, "file not found");
    if (entry.uploaded) {
      return jsonResponse(res, 200, {
        content: entry.content ?? "",
        baseDir: "",
      });
    }
    try {
      const content = await readFile(entry.path, "utf8");
      jsonResponse(res, 200, { content, baseDir: dirname(entry.path) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File is gone from disk: drop it from state so the entry (and
        // possibly the group) disappears from the UI.
        state.removeFilesByPath(entry.path);
        return textResponse(res, 404, "file not found");
      }
      textResponse(res, 500, (err as Error).message);
    }
  }

  async function handleSearch(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost/");
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q === "") return textResponse(res, 400, "missing search query");
    const group = requireGroup(url.searchParams.get("group"), res);
    if (group === null) return;
    const limit = parseBoundedInt(
      url.searchParams.get("limit"),
      SEARCH_DEFAULT_LIMIT,
      1,
      SEARCH_MAX_LIMIT,
    );
    if (limit === null) return textResponse(res, 400, "invalid limit");
    const contextLines = parseBoundedInt(
      url.searchParams.get("context"),
      SEARCH_DEFAULT_CONTEXT,
      0,
      SEARCH_MAX_CONTEXT,
    );
    if (contextLines === null) return textResponse(res, 400, "invalid context");

    const target = state.snapshotGroup(group);
    if (!target) return textResponse(res, 404, "group not found");

    const needle = q.toLowerCase();
    const results: SearchResult[] = [];
    let total = 0;
    let remaining = limit;
    for (
      let start = 0;
      start < target.files.length && remaining > 0;
      start += SEARCH_READ_BATCH
    ) {
      const batch = target.files.slice(start, start + SEARCH_READ_BATCH);
      const contents = await Promise.all(
        batch.map(async (entry) => {
          try {
            return await readSearchableContent(entry);
          } catch (err) {
            logger.warn("failed to read file for search", {
              id: entry.id,
              path: entry.path,
              error: String(err),
            });
            return null;
          }
        }),
      );
      for (let i = 0; i < batch.length && remaining > 0; i++) {
        const entry = batch[i];
        const content = contents[i];
        if (!entry || content == null) continue;
        const matches = findSearchMatches(
          content,
          needle,
          contextLines,
          remaining,
        );
        if (matches.length === 0) continue;
        const r: SearchResult = {
          fileId: entry.id,
          fileName: entry.name,
          path: entry.path,
          uploaded: entry.uploaded === true,
          matches,
        };
        if (entry.title) r.title = entry.title;
        results.push(r);
        total += matches.length;
        remaining -= matches.length;
      }
    }
    jsonResponse(res, 200, {
      query: q,
      group,
      limit,
      context: contextLines,
      total,
      results,
    });
  }

  function handleFileRaw(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    const group = requireGroup(params["group"], res);
    if (group === null) return;
    const id = requireFileId(params, res);
    if (id === null) return;
    const entry = state.findFile(id, group);
    if (!entry) return textResponse(res, 404, "file not found");
    if (entry.uploaded) {
      return textResponse(
        res,
        404,
        "raw assets not available for uploaded files",
      );
    }
    const relPath = params["path"] ?? "";
    const baseDir = pathResolve(dirname(entry.path));
    const abs = pathResolve(normalize(join(baseDir, relPath)));
    // Reject sibling-directory traversal: a startsWith() check is unsafe
    // because /docs/app would accept /docs/app2/secret. Use a path-aware
    // boundary via `relative()`.
    const rel = relative(baseDir, abs);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      return textResponse(res, 403, "access denied");
    }
    sendLocalFile(req, res, abs);
  }

  async function handleOpenFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const group = requireGroup(params["group"], res);
    if (group === null) return;
    const body = await readBody<OpenFileReq>(req, res);
    if (body === null) return;
    if (!isNonEmptyString(body.fileId)) {
      return textResponse(res, 400, "missing or invalid 'fileId' field");
    }
    if (!isNonEmptyString(body.path)) {
      return textResponse(res, 400, "missing or invalid 'path' field");
    }
    const entry = state.findFile(body.fileId, group);
    if (!entry) return textResponse(res, 404, "source file not found in group");
    if (entry.uploaded) {
      return textResponse(
        res,
        400,
        "relative links not available for uploaded files",
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(body.path);
    } catch (err) {
      return textResponse(res, 400, (err as Error).message);
    }
    const abs = normalize(join(dirname(entry.path), decoded));
    try {
      await stat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return textResponse(res, 404, `file not found: ${abs}`);
      }
      return textResponse(res, 400, (err as Error).message);
    }
    try {
      jsonResponse(res, 200, stripContent(state.addFile(abs, group)));
    } catch (err) {
      textResponse(res, 400, (err as Error).message);
    }
  }

  async function handleAddPattern(req: IncomingMessage, res: ServerResponse) {
    if (rejectCrossSite(req, res)) return;
    const body = await readBody<PatternReq>(req, res);
    if (body === null) return;
    if (!isNonEmptyString(body.pattern)) {
      return textResponse(res, 400, "missing pattern");
    }
    const group = requireGroup(body.group, res);
    if (group === null) return;
    try {
      const entries = await state.addPattern(body.pattern, group);
      jsonResponse(res, 200, {
        matched: entries.length,
        files: entries.map(stripContent),
      });
    } catch (err) {
      textResponse(res, 400, (err as Error).message);
    }
  }

  async function handleRemovePattern(
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    if (rejectCrossSite(req, res)) return;
    const body = await readBody<PatternReq>(req, res);
    if (body === null) return;
    if (!isNonEmptyString(body.pattern)) {
      return textResponse(res, 400, "missing pattern");
    }
    const group = requireGroup(body.group, res);
    if (group === null) return;
    if (!state.removePattern(body.pattern, group)) {
      return textResponse(res, 404, "pattern not found");
    }
    noContent(res);
  }

  async function handleRestart(req: IncomingMessage, res: ServerResponse) {
    if (rejectCrossSite(req, res)) return;
    let restoreFile: string;
    try {
      restoreFile = await writeRestoreFile(state.snapshotRestoreData());
    } catch (err) {
      return textResponse(res, 500, (err as Error).message);
    }
    res.statusCode = 202;
    res.end();
    state.signalRestart(restoreFile);
  }

  function handleShutdown(req: IncomingMessage, res: ServerResponse) {
    if (rejectCrossSite(req, res)) return;
    res.statusCode = 202;
    res.end();
    state.signalShutdown();
  }

  function handleStatus(_req: IncomingMessage, res: ServerResponse) {
    jsonResponse(res, 200, {
      version: Version,
      revision: Revision,
      pid,
      groups: groupsWithPatterns(),
    });
  }

  function handleVersion(_req: IncomingMessage, res: ServerResponse) {
    jsonResponse(res, 200, {
      version: Version,
      revision: Revision,
      name: Name,
    });
  }

  function handleSSE(req: IncomingMessage, res: ServerResponse) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (req.method === "HEAD") {
      // Headers only; never hold a bodiless request open as a stream.
      res.end();
      return;
    }
    res.flushHeaders?.();

    res.write(`event: ${EVENT_STARTED}\ndata: ${JSON.stringify({ pid })}\n\n`);

    const unsubscribe = state.subscribe((e) => {
      if (e.name === "__close__") {
        res.end();
        return;
      }
      try {
        res.write(`event: ${e.name}\ndata: ${e.data}\n\n`);
      } catch {
        // ignore write errors
      }
    });

    const close = () => {
      unsubscribe();
      try {
        res.end();
      } catch {
        // ignore
      }
    };
    req.on("close", close);
    res.on("close", close);
  }

  return {
    handleAddFile,
    handleUploadFile,
    handleRemoveFile,
    handleMoveFile,
    handleReorder,
    handleGroups,
    handleFileContent,
    handleSearch,
    handleFileRaw,
    handleOpenFile,
    handleAddPattern,
    handleRemovePattern,
    handleRestart,
    handleShutdown,
    handleStatus,
    handleVersion,
    handleSSE,
  };
}

export { DefaultGroup };
