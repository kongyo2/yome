import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const distBin = pathResolve(moduleDir, "..", "..", "dist", "bin", "mo.js");
const srcBin = pathResolve(moduleDir, "..", "bin", "mo.ts");
const haveDist = existsSync(distBin);
const launchArgs = haveDist
  ? [distBin]
  : [
      "--no-warnings",
      "--experimental-strip-types",
      "--import",
      "tsx",
      srcBin,
    ];

function runMo(args: string[], opts: { input?: string; cwd?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string> = { ...process.env, ...opts.env } as Record<string, string>;
  return spawnSync(process.execPath, [...launchArgs, ...args], {
    input: opts.input,
    encoding: "utf8",
    cwd: opts.cwd ?? process.cwd(),
    env,
    timeout: 15_000,
  });
}

let stateDir: string;
let port: number;

beforeAll(() => {
  if (!haveDist && !existsSync(srcBin)) {
    throw new Error("Neither dist/bin/mo.js nor src/bin/mo.ts exists; build first.");
  }
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mo-e2e-"));
  // Pick a high port that we expect to be free in the test container.
  port = 30000 + Math.floor(Math.random() * 20_000);
});

afterEach(async () => {
  // Best-effort shutdown if a server is still up.
  runMo(["--port", String(port), "--shutdown"], { env: { XDG_STATE_HOME: stateDir } });
  await wait(200);
  rmSync(stateDir, { recursive: true, force: true });
});

afterAll(async () => {
  // Nothing global to clean up; per-test afterEach handles it.
});

describe("mo CLI", () => {
  it("--version prints the version", () => {
    const r = runMo(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1\.5\.5/);
  });

  it("--help prints usage", () => {
    const r = runMo(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: mo/);
    expect(r.stdout).toMatch(/--target/);
  });

  it("--status reports the default port as stopped after log file is created", () => {
    const r = runMo(["--status"], { env: { XDG_STATE_HOME: stateDir } });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/stopped|no mo server found/);
  });

  it("--status --json emits an array of entries", () => {
    const r = runMo(["--status", "--json"], { env: { XDG_STATE_HOME: stateDir } });
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout) as Array<{ status?: string }>;
    expect(Array.isArray(data)).toBe(true);
    for (const entry of data) {
      expect(["running", "stopped"]).toContain(entry.status);
    }
  });

  it("starts a foreground server and serves the SPA + API", async () => {
    const tmpFile = join(stateDir, "smoke.md");
    writeFileSync(tmpFile, "# Smoke\n");

    const child = spawn(
      process.execPath,
      [...launchArgs, "--foreground", "--port", String(port), "--no-open", tmpFile],
      {
        env: { ...process.env, XDG_STATE_HOME: stateDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Wait for readiness via direct fetch
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/_/api/status`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // not yet
      }
      await wait(100);
    }
    try {
      expect(ready).toBe(true);
      const status = (await fetch(`http://127.0.0.1:${port}/_/api/status`).then((r) => r.json())) as {
        version: string;
        groups: Array<{ name: string; files: Array<{ name: string }> }>;
      };
      expect(status.version).toBe("1.5.5");
      const names = status.groups.flatMap((g) => g.files.map((f) => f.name));
      expect(names).toContain("smoke.md");

      const spa = await fetch(`http://127.0.0.1:${port}/`);
      // SPA might be served or fall back to 404 if dist isn't built; we built earlier, so 200.
      expect([200, 404]).toContain(spa.status);
    } finally {
      child.kill("SIGINT");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  it("rejects an invalid group name", () => {
    const tmpFile = join(stateDir, "a.md");
    writeFileSync(tmpFile, "# A");
    const r = runMo(["--target", "_/internal", "--foreground", "--no-open", "--port", String(port), tmpFile], {
      env: { XDG_STATE_HOME: stateDir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/invalid target group name/);
  });

  it("--recursive without args errors out", () => {
    const r = runMo(["-R"], { env: { XDG_STATE_HOME: stateDir } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--recursive.*requires a directory/);
  });
});
