import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);

function findEntryPoint(): { entry: string; useTsx: boolean } {
  // If we're already running from dist/, use the sibling bin.
  // Otherwise (running via tsx from src/), spawn src/bin/yome.ts with tsx.
  const dir = dirname(moduleFile);
  const segments = dir.split(sep);
  if (segments.includes("dist")) {
    const distBin = pathResolve(dir, "..", "bin", "yome.js");
    if (existsSync(distBin)) return { entry: distBin, useTsx: false };
  }
  const srcBin = pathResolve(dir, "..", "bin", "yome.ts");
  if (existsSync(srcBin)) return { entry: srcBin, useTsx: true };
  return { entry: pathResolve(dir, "..", "bin", "yome.js"), useTsx: false };
}

export interface SpawnOpts {
  host: string;
  port: number;
  restoreFile?: string;
  dangerouslyAllowRemoteAccess?: boolean;
  bind: string;
  noRestoreSession?: boolean;
  // Forward --yes so a detached child (whose stdin is ignored) can never
  // stall or die on a confirmation prompt, e.g. the non-loopback bind
  // warning after `--clear` respawns the server.
  yes?: boolean;
}

export interface SpawnedServer {
  pid: number;
  // Resolves true once the child has exited (never rejects). Callers can
  // poll this to fail fast instead of waiting out a readiness timeout.
  exited: () => boolean;
}

export function spawnDetached(opts: SpawnOpts): SpawnedServer {
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
  if (opts.noRestoreSession) {
    argv.push("--no-restore-session");
  }
  if (opts.dangerouslyAllowRemoteAccess) {
    argv.push("--dangerously-allow-remote-access");
  }
  if (opts.yes) {
    argv.push("--yes");
  }
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let hasExited = false;
  child.once("exit", () => {
    hasExited = true;
  });
  child.unref();
  return { pid: child.pid ?? 0, exited: () => hasExited };
}
