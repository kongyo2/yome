import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface CompiledRoute {
  method: string;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const EMPTY_PARAMS: Record<string, string> = Object.freeze({});

export class Router {
  // method -> exact path -> handler, for parameterless routes. These can
  // never overlap with a parameterized route (every registered param route
  // has a distinct segment count/shape), so checking them first returns the
  // same handler the linear regex scan would.
  private staticRoutes = new Map<string, Map<string, RouteHandler>>();
  // method -> parameterized routes, in registration order.
  private paramRoutes = new Map<string, CompiledRoute[]>();

  add(method: string, pattern: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    let regexStr = "^";
    const parts = pattern.split("/");
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i] ?? "";
      if (i === 0 && seg === "") {
        regexStr += "";
        continue;
      }
      if (seg.startsWith("{") && seg.endsWith("...}")) {
        const name = seg.slice(1, -4);
        paramNames.push(name);
        regexStr += "/(.+)";
      } else if (seg.startsWith("{") && seg.endsWith("}")) {
        const name = seg.slice(1, -1);
        paramNames.push(name);
        regexStr += "/([^/]+)";
      } else {
        regexStr += "/" + seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    regexStr += "$";
    const compiled: CompiledRoute = {
      method: method.toUpperCase(),
      pattern,
      regex: new RegExp(regexStr),
      paramNames,
      handler,
    };
    if (paramNames.length === 0) {
      let byPath = this.staticRoutes.get(compiled.method);
      if (!byPath) {
        byPath = new Map();
        this.staticRoutes.set(compiled.method, byPath);
      }
      if (!byPath.has(pattern)) byPath.set(pattern, handler);
    } else {
      let list = this.paramRoutes.get(compiled.method);
      if (!list) {
        list = [];
        this.paramRoutes.set(compiled.method, list);
      }
      list.push(compiled);
    }
  }

  match(
    method: string,
    urlPath: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const m = method.toUpperCase();
    const exact = this.staticRoutes.get(m)?.get(urlPath);
    if (exact) return { handler: exact, params: EMPTY_PARAMS };
    const candidates = this.paramRoutes.get(m);
    if (!candidates) return null;
    for (const r of candidates) {
      const match = r.regex.exec(urlPath);
      if (!match) continue;
      const params: Record<string, string> = {};
      let decodeFailed = false;
      for (let i = 0; i < r.paramNames.length; i++) {
        const name = r.paramNames[i];
        const value = match[i + 1];
        if (name !== undefined && value !== undefined) {
          try {
            params[name] = decodeURIComponent(value);
          } catch {
            // Malformed percent-encoding: treat as a non-match so a single
            // bad request cannot crash the server.
            decodeFailed = true;
            break;
          }
        }
      }
      if (decodeFailed) continue;
      return { handler: r.handler, params };
    }
    return null;
  }
}
