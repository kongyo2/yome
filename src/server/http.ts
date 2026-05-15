import http, {
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { Router } from "./router.js";
import { buildHandlers } from "./handlers.js";
import { serveSpa } from "./static.js";
import type { State } from "./state.js";

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

export function createServer(state: State): Server {
  const router = new Router();
  const h = buildHandlers(state, { pid: process.pid });

  router.add("POST", "/_/api/groups/{group}/files", (req, res, p) =>
    h.handleAddFile(req, res, p),
  );
  router.add("POST", "/_/api/groups/{group}/files/upload", (req, res, p) =>
    h.handleUploadFile(req, res, p),
  );
  router.add("DELETE", "/_/api/groups/{group}/files/{id}", (req, res, p) =>
    h.handleRemoveFile(req, res, p),
  );
  router.add("PUT", "/_/api/groups/{group}/files/{id}/group", (req, res, p) =>
    h.handleMoveFile(req, res, p),
  );
  router.add("GET", "/_/api/groups", (req, res) => h.handleGroups(req, res));
  router.add("PUT", "/_/api/groups/{group}/reorder", (req, res, p) =>
    h.handleReorder(req, res, p),
  );
  router.add("GET", "/_/api/groups/{group}/files/{id}/content", (req, res, p) =>
    h.handleFileContent(req, res, p),
  );
  router.add("GET", "/_/api/search", (req, res) => h.handleSearch(req, res));
  router.add(
    "GET",
    "/_/api/groups/{group}/files/{id}/raw/{path...}",
    (req, res, p) => h.handleFileRaw(req, res, p),
  );
  router.add("POST", "/_/api/groups/{group}/files/open", (req, res, p) =>
    h.handleOpenFile(req, res, p),
  );
  router.add("POST", "/_/api/patterns", (req, res) =>
    h.handleAddPattern(req, res),
  );
  router.add("DELETE", "/_/api/patterns", (req, res) =>
    h.handleRemovePattern(req, res),
  );
  router.add("POST", "/_/api/restart", (req, res) => h.handleRestart(req, res));
  router.add("POST", "/_/api/shutdown", (req, res) =>
    h.handleShutdown(req, res),
  );
  router.add("GET", "/_/api/status", (req, res) => h.handleStatus(req, res));
  router.add("GET", "/_/api/version", (req, res) => h.handleVersion(req, res));
  router.add("GET", "/_/events", (req, res) => h.handleSSE(req, res));

  const server = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Content-Security-Policy", CSP);

      const url = req.url ?? "/";
      const path = url.split("?")[0] ?? "/";
      const method = req.method ?? "GET";

      if (path.startsWith("/_/")) {
        const match = router.match(method, path);
        if (!match) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        try {
          const result = match.handler(req, res, match.params);
          if (result instanceof Promise) {
            result.catch((err) => {
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end(String(err));
              }
            });
          }
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(String(err));
          }
        }
        return;
      }

      // SPA fallback for everything else
      serveSpa(req, res);
    },
  );

  server.keepAliveTimeout = 10_000;
  server.headersTimeout = 12_000;
  return server;
}
