import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);

function findEntryPoint(): { entry: string; useTsx: boolean } {
  // If we're already running from dist/, use the sibling bin.
  // Otherwise (running via tsx from src/), spawn src/bin/yome.ts with tsx.
  const dir = dirname(moduleFile);
  if (
    dir.includes(`${"/"}dist${"/"}`) ||
    dir.endsWith("/dist") ||
    dir.endsWith("/dist/cli")
  ) {
    const distBin = pathResolve(dir, "..", "bin", "yome.js");
    if (existsSync(distBin)) return { entry: distBin, useTsx: false };
  }
  const srcBin = pathResolve(dir, "..", "bin", "yome.ts");
  if (existsSync(srcBin)) return { entry: srcBin, useTsx: true };
  const distBin = pathResolve(dir, "..", "bin", "yome.js");
  return { entry: distBin, useTsx: false };
}

export interface SpawnOpts {
  host: string;
  port: number;
  restoreFile?: string;
  dangerouslyAllowRemoteAccess?: boolean;
  bind: string;
}

export function spawnDetached(opts: SpawnOpts): { pid: number } {
  const { entry, useTsx } = findEntryPoint();
  const argv: string[] = [];
  if (useTsx) {
    argv.push("--import", "tsx");
  }
  argv.push(entry);
  argv.push("--port", String(opts.port));
  argv.push("--bind", opts.bind);
  argv.push("--no-open");
  argv.push("--foreground");
  if (opts.restoreFile) {
    argv.push("--restore", opts.restoreFile);
  }
  if (opts.dangerouslyAllowRemoteAccess) {
    argv.push("--dangerously-allow-remote-access");
  }
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid ?? 0 };
}
