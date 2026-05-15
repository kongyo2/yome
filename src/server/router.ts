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

export class Router {
  private routes: CompiledRoute[] = [];

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
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      regex: new RegExp(regexStr),
      paramNames,
      handler,
    });
  }

  match(
    method: string,
    urlPath: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const m = method.toUpperCase();
    for (const r of this.routes) {
      if (r.method !== m) continue;
      const match = r.regex.exec(urlPath);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < r.paramNames.length; i++) {
        const name = r.paramNames[i];
        const value = match[i + 1];
        if (name !== undefined && value !== undefined) {
          params[name] = decodeURIComponent(value);
        }
      }
      return { handler: r.handler, params };
    }
    return null;
  }
}
