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
import { sendFile } from "./static.js";
import { EVENT_STARTED, type FileEntry } from "./types.js";

const MAX_UPLOAD_BYTES = 12 << 20;
const MAX_CONTENT_BYTES = 10 << 20;

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

async function readJsonBody<T>(
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
      try {
        resolveP(JSON.parse(buf.toString("utf8")) as T);
      } catch (err) {
        rejectP(err);
      }
    });
    req.on("error", (err) => rejectP(err));
  });
}

class RequestEntityTooLargeError extends Error {}

interface AddFileReq {
  path: string;
}
interface UploadFileReq {
  name: string;
  content: string;
}
interface MoveFileReq {
  group: string;
}
interface ReorderReq {
  fileIds: string[];
}
interface PatternReq {
  pattern: string;
  group: string;
}
interface OpenFileReq {
  fileId: string;
  path: string;
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

  async function handleAddFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const { name: group, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
    let body: AddFileReq;
    try {
      body = await readJsonBody<AddFileReq>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      return textResponse(res, 400, (err as Error).message);
    }
    if (!body.path) return textResponse(res, 400, "missing path");
    const abs = isAbsolute(body.path) ? body.path : pathResolve(body.path);
    try {
      await stat(abs);
    } catch {
      return textResponse(res, 400, `file not found: ${abs}`);
    }
    try {
      const entry = state.addFile(abs, group);
      jsonResponse(res, 200, stripContent(entry));
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
    const { name: group, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
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
    if (typeof body.name !== "string" || body.name === "") {
      return textResponse(res, 400, "missing file name");
    }
    if (Buffer.byteLength(body.content) > MAX_CONTENT_BYTES) {
      return textResponse(res, 413, "file too large (max 10MB)");
    }
    const entry = state.addUploadedFile(body.name, body.content, group);
    jsonResponse(res, 200, stripContent(entry));
  }

  function handleRemoveFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const { name: group, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
    const id = params["id"] ?? "";
    if (id === "") return textResponse(res, 400, "missing file id");
    if (!state.removeFile(id, group))
      return textResponse(res, 404, "file not found");
    res.statusCode = 204;
    res.end();
  }

  async function handleMoveFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const { name: sourceGroup, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
    const id = params["id"] ?? "";
    if (id === "") return textResponse(res, 400, "missing file id");
    let body: MoveFileReq;
    try {
      body = await readJsonBody<MoveFileReq>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      return textResponse(res, 400, (err as Error).message);
    }
    const { name: targetGroup, error: terr } = resolveGroupName(body.group);
    if (terr) return textResponse(res, 400, terr.message);
    const result = state.moveFile(id, sourceGroup, targetGroup);
    if ("error" in result) {
      return textResponse(res, result.status, result.error);
    }
    res.statusCode = 204;
    res.end();
  }

  async function handleReorder(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const { name: group, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
    let body: ReorderReq;
    try {
      body = await readJsonBody<ReorderReq>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      return textResponse(res, 400, (err as Error).message);
    }
    if (!state.reorderFiles(group, body.fileIds)) {
      return textResponse(res, 400, "invalid file IDs or group not found");
    }
    res.statusCode = 204;
    res.end();
  }

  function handleGroups(_req: IncomingMessage, res: ServerResponse) {
    jsonResponse(
      res,
      200,
      state.listGroups().map((g) => ({
        name: g.name,
        files: g.files.map(stripContent),
        patterns: state.patternsForGroup(g.name),
      })),
    );
  }

  async function handleFileContent(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    const { name: group, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
    const id = params["id"] ?? "";
    if (id === "") return textResponse(res, 400, "missing file id");
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
    const { name: group, error } = resolveGroupName(
      url.searchParams.get("group"),
    );
    if (error) return textResponse(res, 400, error.message);
    let limit = 50;
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw != null) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n <= 0)
        return textResponse(res, 400, "invalid limit");
      limit = Math.min(200, Math.floor(n));
    }
    let contextLines = 2;
    const ctxRaw = url.searchParams.get("context");
    if (ctxRaw != null) {
      const n = Number(ctxRaw);
      if (!Number.isFinite(n) || n < 0)
        return textResponse(res, 400, "invalid context");
      contextLines = Math.min(5, Math.floor(n));
    }

    const target = state.snapshotGroup(group);
    if (!target) return textResponse(res, 404, "group not found");

    const needle = q.toLowerCase();
    const results: SearchResult[] = [];
    let total = 0;
    let remaining = limit;
    // Read file contents in small parallel batches (matching stays strictly
    // in group order, and no further batch is scheduled once the limit is
    // reached), instead of one await per file.
    const READ_BATCH = 8;
    for (
      let start = 0;
      start < target.files.length && remaining > 0;
      start += READ_BATCH
    ) {
      const batch = target.files.slice(start, start + READ_BATCH);
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
      for (let i = 0; i < batch.length; i++) {
        if (remaining === 0) break;
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

  async function handleFileRaw(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    const { name: group, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
    const id = params["id"] ?? "";
    if (id === "") return textResponse(res, 400, "missing file id");
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
    try {
      const st = await stat(abs);
      if (!st.isFile()) return textResponse(res, 404, "not a file");
    } catch {
      return textResponse(res, 404, "file not found");
    }
    sendFile(res, abs);
  }

  async function handleOpenFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    if (rejectCrossSite(req, res)) return;
    const { name: group, error } = resolveGroupName(params["group"]);
    if (error) return textResponse(res, 400, error.message);
    let body: OpenFileReq;
    try {
      body = await readJsonBody<OpenFileReq>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      return textResponse(res, 400, (err as Error).message);
    }
    const entry = state.findFile(body.fileId, group);
    if (!entry) return textResponse(res, 404, "source file not found in group");
    if (entry.uploaded)
      return textResponse(
        res,
        400,
        "relative links not available for uploaded files",
      );
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
      const newEntry = state.addFile(abs, group);
      jsonResponse(res, 200, stripContent(newEntry));
    } catch (err) {
      textResponse(res, 400, (err as Error).message);
    }
  }

  async function handleAddPattern(req: IncomingMessage, res: ServerResponse) {
    if (rejectCrossSite(req, res)) return;
    let body: PatternReq;
    try {
      body = await readJsonBody<PatternReq>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      return textResponse(res, 400, (err as Error).message);
    }
    const { name: group, error } = resolveGroupName(body.group);
    if (error) return textResponse(res, 400, error.message);
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
    let body: PatternReq;
    try {
      body = await readJsonBody<PatternReq>(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      return textResponse(res, 400, (err as Error).message);
    }
    const { name: group, error } = resolveGroupName(body.group);
    if (error) return textResponse(res, 400, error.message);
    if (!state.removePattern(body.pattern, group)) {
      return textResponse(res, 404, "pattern not found");
    }
    res.statusCode = 204;
    res.end();
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
    const groups = state.listGroups();
    const statusGroups = groups.map((g) => ({
      name: g.name,
      files: g.files.map(stripContent),
      patterns: state.patternsForGroup(g.name),
    }));
    jsonResponse(res, 200, {
      version: Version,
      revision: Revision,
      pid,
      groups: statusGroups,
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
    req.on("aborted", close);
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
