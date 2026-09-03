import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { Router } from "./router.js";
import { buildHandlers } from "./handlers.js";
import { serveSpa } from "./static.js";
import type { State } from "./state.js";

// require() rather than ESM-import node:http: materializing the builtin's
// module facade force-loads undici via its lazy fetch/WebSocket getters and
// adds ~60ms to server startup. require() leaves those getters untouched.
const requireBuiltin = createRequire(import.meta.url);
const http: typeof import("node:http") = requireBuiltin("node:http");

const CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https: data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'";

function plainError(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

export function createServer(state: State): Server {
  const router = new Router();
  const h = buildHandlers(state, { pid: process.pid });

  router.add("POST", "/_/api/groups/{group}/files", h.handleAddFile);
  router.add("POST", "/_/api/groups/{group}/files/upload", h.handleUploadFile);
  router.add("DELETE", "/_/api/groups/{group}/files/{id}", h.handleRemoveFile);
  router.add("PUT", "/_/api/groups/{group}/files/{id}/group", h.handleMoveFile);
  router.add("GET", "/_/api/groups", h.handleGroups);
  router.add("PUT", "/_/api/groups/{group}/reorder", h.handleReorder);
  router.add(
    "GET",
    "/_/api/groups/{group}/files/{id}/content",
    h.handleFileContent,
  );
  router.add("GET", "/_/api/search", h.handleSearch);
  router.add(
    "GET",
    "/_/api/groups/{group}/files/{id}/raw/{path...}",
    h.handleFileRaw,
  );
  router.add("POST", "/_/api/groups/{group}/files/open", h.handleOpenFile);
  router.add("POST", "/_/api/patterns", h.handleAddPattern);
  router.add("DELETE", "/_/api/patterns", h.handleRemovePattern);
  router.add("POST", "/_/api/restart", h.handleRestart);
  router.add("POST", "/_/api/shutdown", h.handleShutdown);
  router.add("GET", "/_/api/status", h.handleStatus);
  router.add("GET", "/_/api/version", h.handleVersion);
  router.add("GET", "/_/events", h.handleSSE);

  const server = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Content-Security-Policy", CSP);

      const url = req.url ?? "/";
      const qIdx = url.indexOf("?");
      const path = qIdx === -1 ? url : url.substring(0, qIdx);
      const method = req.method ?? "GET";

      if (!path.startsWith("/_/")) {
        // SPA fallback for everything else
        serveSpa(req, res);
        return;
      }

      // HEAD is served by the GET handler: Node drops the body for HEAD
      // responses on its own, so only the headers go out.
      const match =
        router.match(method, path) ??
        (method === "HEAD" ? router.match("GET", path) : null);
      if (!match) {
        plainError(res, 404, "not found");
        return;
      }
      try {
        const result = match.handler(req, res, match.params);
        if (result instanceof Promise) {
          result.catch((err) => plainError(res, 500, String(err)));
        }
      } catch (err) {
        plainError(res, 500, String(err));
      }
    },
  );

  server.keepAliveTimeout = 10_000;
  server.headersTimeout = 12_000;
  return server;
}
