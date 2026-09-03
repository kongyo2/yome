import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { Version } from "../version.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const distBin = pathResolve(moduleDir, "..", "..", "dist", "bin", "yome.js");
const srcBin = pathResolve(moduleDir, "..", "bin", "yome.ts");
const haveDist = existsSync(distBin);
const launchArgs = haveDist
  ? [distBin]
  : ["--no-warnings", "--experimental-strip-types", "--import", "tsx", srcBin];

function runYome(
  args: string[],
  opts: { input?: string; cwd?: string; env?: Record<string, string> } = {},
) {
  const env: Record<string, string> = { ...process.env, ...opts.env } as Record<
    string,
    string
  >;
  // When no input is provided we ignore stdin so it appears as a character
  // device (/dev/null) — otherwise spawnSync hands the child an empty pipe,
  // which yome interprets as redirected stdin and rejects when positional
  // file arguments are also given.
  const stdio: "pipe" | ["ignore", "pipe", "pipe"] =
    opts.input === undefined ? ["ignore", "pipe", "pipe"] : "pipe";
  return spawnSync(process.execPath, [...launchArgs, ...args], {
    input: opts.input,
    encoding: "utf8",
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdio,
    timeout: 15_000,
  });
}

let stateDir: string;
let port: number;

beforeAll(() => {
  if (!haveDist && !existsSync(srcBin)) {
    throw new Error(
      "Neither dist/bin/yome.js nor src/bin/yome.ts exists; build first.",
    );
  }
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "yome-e2e-"));
  // Pick a high port that we expect to be free in the test container.
  port = 30000 + Math.floor(Math.random() * 20_000);
});

afterEach(async () => {
  // Best-effort shutdown if a server is still up.
  runYome(["--port", String(port), "--shutdown"], {
    env: { XDG_STATE_HOME: stateDir },
  });
  await wait(200);
  rmSync(stateDir, { recursive: true, force: true });
});

afterAll(async () => {
  // Nothing global to clean up; per-test afterEach handles it.
});

describe("yome CLI", () => {
  it("--version prints the version", () => {
    const r = runYome(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(Version);
  });

  it("--help prints usage", () => {
    const r = runYome(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: yome/);
    expect(r.stdout).toMatch(/--target/);
  });

  it("--status reports the default port as stopped after log file is created", () => {
    const r = runYome(["--status"], { env: { XDG_STATE_HOME: stateDir } });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/stopped|no yome server found/);
  });

  it("--status --json emits an array of entries", () => {
    const r = runYome(["--status", "--json"], {
      env: { XDG_STATE_HOME: stateDir },
    });
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout) as Array<{ status?: string }>;
    expect(Array.isArray(data)).toBe(true);
    for (const entry of data) {
      expect(["running", "stopped"]).toContain(entry.status);
    }
  });

  it(
    "starts a foreground server and serves the SPA + API",
    { timeout: 30_000 },
    async () => {
      const tmpFile = join(stateDir, "smoke.md");
      writeFileSync(tmpFile, "# Smoke\n");

      const child = spawn(
        process.execPath,
        [
          ...launchArgs,
          "--foreground",
          "--port",
          String(port),
          "--bind",
          "127.0.0.1",
          "--no-open",
          tmpFile,
        ],
        {
          env: { ...process.env, XDG_STATE_HOME: stateDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
      const exited = { value: false };
      child.on("exit", () => {
        exited.value = true;
      });

      // Wait for readiness; longer than the default since CI can be slow.
      let ready = false;
      for (let i = 0; i < 100 && !ready && !exited.value; i++) {
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
        expect(
          ready,
          `server did not become ready; child stderr:\n${stderrBuf}`,
        ).toBe(true);
        const status = (await fetch(
          `http://127.0.0.1:${port}/_/api/status`,
        ).then((r) => r.json())) as {
          version: string;
          groups: Array<{ name: string; files: Array<{ name: string }> }>;
        };
        expect(status.version).toBe(Version);
        const names = status.groups.flatMap((g) => g.files.map((f) => f.name));
        expect(names).toContain("smoke.md");

        const spa = await fetch(`http://127.0.0.1:${port}/`);
        // SPA might be served or fall back to 404 if dist isn't built; we built earlier, so 200.
        expect([200, 404]).toContain(spa.status);
      } finally {
        child.kill("SIGINT");
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      }
    },
  );

  it(
    "exits promptly with an error when the port is already taken",
    { timeout: 30_000 },
    async () => {
      const tmpFile = join(stateDir, "busy.md");
      writeFileSync(tmpFile, "# Busy\n");
      // A saved session for the port must survive the failed starts
      // untouched: only the instance that owns the port may write it.
      const backupDir = join(stateDir, "yome", "backup");
      mkdirSync(backupDir, { recursive: true });
      const backupFile = join(backupDir, `yome-${port}.json`);
      const savedSession = JSON.stringify({
        groups: { default: [join(stateDir, "someone-elses.md")] },
      });
      writeFileSync(backupFile, savedSession);
      // Occupy the port with a plain (non-yome) TCP server that never
      // answers. Its accepted sockets are tracked so they can be torn down
      // explicitly: yome's probes time out and go away, but a socket whose
      // request bytes are never read stays open on this side and would
      // keep blocker.close() from ever completing.
      const blocker = createNetServer();
      const blockerSockets = new Set<import("node:net").Socket>();
      blocker.on("connection", (s) => {
        blockerSockets.add(s);
        s.on("close", () => blockerSockets.delete(s));
      });
      await new Promise<void>((resolve) =>
        blocker.listen(port, "127.0.0.1", () => resolve()),
      );
      try {
        // Foreground: the failure must be reported and the process must
        // exit instead of idling on its file watcher.
        const start = Date.now();
        const fg = runYome(
          [
            "--foreground",
            "--port",
            String(port),
            "--bind",
            "127.0.0.1",
            "--no-open",
            tmpFile,
          ],
          { env: { XDG_STATE_HOME: stateDir } },
        );
        expect(fg.status).toBe(1);
        expect(fg.stderr).toMatch(/cannot listen on 127\.0\.0\.1:\d+/);
        expect(Date.now() - start).toBeLessThan(8000);

        // Background: the parent must not report success either, and must
        // give up well before the 10s readiness timeout once its child dies.
        const bgStart = Date.now();
        const bg = runYome(
          ["--port", String(port), "--bind", "127.0.0.1", "--no-open", tmpFile],
          { env: { XDG_STATE_HOME: stateDir } },
        );
        expect(bg.status).toBe(1);
        expect(bg.stderr).toMatch(/exited unexpectedly|did not become ready/);
        expect(bg.stderr).not.toMatch(/serving at/);
        expect(Date.now() - bgStart).toBeLessThan(8000);
        // The restore file handed to the dead child is cleaned up.
        const leftovers = readdirSync(tmpdir()).filter((n) =>
          n.startsWith("yome-restore-"),
        );
        expect(leftovers).toEqual([]);
        await wait(1500);
        expect(readFileSync(backupFile, "utf8")).toBe(savedSession);
      } finally {
        for (const s of blockerSockets) s.destroy();
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    },
  );

  it(
    "two concurrent starts on an empty port end up with one server holding both files",
    { timeout: 30_000 },
    async () => {
      const fileA = join(stateDir, "race-a.md");
      const fileB = join(stateDir, "race-b.md");
      writeFileSync(fileA, "# A\n");
      writeFileSync(fileB, "# B\n");
      const launch = (file: string) =>
        new Promise<{ status: number | null; stderr: string }>((resolve) => {
          const child = spawn(
            process.execPath,
            [
              ...launchArgs,
              "--port",
              String(port),
              "--bind",
              "127.0.0.1",
              "--no-open",
              file,
            ],
            {
              env: { ...process.env, XDG_STATE_HOME: stateDir },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stderr = "";
          child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
          child.stdout?.resume();
          child.on("exit", (status) => resolve({ status, stderr }));
        });
      // Both probes see an empty port, both spawn a server; exactly one can
      // bind. The loser must add its file to the winner rather than report
      // a false success with a dead child behind it.
      const [a, b] = await Promise.all([launch(fileA), launch(fileB)]);
      expect(a.status, a.stderr).toBe(0);
      expect(b.status, b.stderr).toBe(0);

      const status = (await fetch(`http://127.0.0.1:${port}/_/api/status`).then(
        (r) => r.json(),
      )) as {
        pid: number;
        groups: Array<{ files: Array<{ path: string }> }>;
      };
      const paths = status.groups.flatMap((g) => g.files.map((f) => f.path));
      expect(paths).toContain(fileA);
      expect(paths).toContain(fileB);
      // Every "serving at (pid N)" line must name the process that actually
      // owns the port; a loser reports the takeover instead.
      for (const out of [a.stderr, b.stderr]) {
        const served = /serving at http:\/\/[^ ]+ \(pid (\d+)\)/.exec(out);
        if (served) expect(Number(served[1])).toBe(status.pid);
        else expect(out).toMatch(/added \d+ item\(s\)/);
      }
    },
  );

  it("rejects binary content on stdin before contacting any server", () => {
    const r = runYome(["--port", String(port), "--no-open"], {
      env: { XDG_STATE_HOME: stateDir },
      input: "PNG  binary",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/binary/);
  });

  it("rejects an invalid group name", () => {
    const tmpFile = join(stateDir, "a.md");
    writeFileSync(tmpFile, "# A");
    const r = runYome(
      [
        "--target",
        "_/internal",
        "--foreground",
        "--no-open",
        "--port",
        String(port),
        tmpFile,
      ],
      {
        env: { XDG_STATE_HOME: stateDir },
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/invalid target group name/);
  });

  it("--recursive without args errors out", () => {
    const r = runYome(["-R"], { env: { XDG_STATE_HOME: stateDir } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--recursive.*requires a directory/);
  });

  it(
    "--shutdown without --port stops every running instance",
    { timeout: 30_000 },
    async () => {
      const portA = port;
      const portB = port + 1;
      const tmpFile = join(stateDir, "two.md");
      writeFileSync(tmpFile, "# Two\n");

      const waitForUp = async (p: number) => {
        for (let i = 0; i < 100; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${p}/_/api/status`);
            if (res.ok) return true;
          } catch {
            // not yet
          }
          await wait(100);
        }
        return false;
      };
      const waitForDown = async (p: number) => {
        for (let i = 0; i < 50; i++) {
          try {
            await fetch(`http://127.0.0.1:${p}/_/api/status`);
          } catch {
            return true;
          }
          await wait(100);
        }
        return false;
      };

      try {
        const a = runYome(
          [
            "--port",
            String(portA),
            "--bind",
            "127.0.0.1",
            "--no-open",
            tmpFile,
          ],
          { env: { XDG_STATE_HOME: stateDir } },
        );
        expect(a.status).toBe(0);
        const b = runYome(
          [
            "--port",
            String(portB),
            "--bind",
            "127.0.0.1",
            "--no-open",
            tmpFile,
          ],
          { env: { XDG_STATE_HOME: stateDir } },
        );
        expect(b.status).toBe(0);
        expect(await waitForUp(portA)).toBe(true);
        expect(await waitForUp(portB)).toBe(true);

        const r = runYome(["--shutdown"], {
          env: { XDG_STATE_HOME: stateDir },
        });
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(new RegExp(`http://localhost:${portA}`));
        expect(r.stderr).toMatch(new RegExp(`http://localhost:${portB}`));

        expect(await waitForDown(portA)).toBe(true);
        expect(await waitForDown(portB)).toBe(true);
      } finally {
        runYome(["--port", String(portB), "--shutdown"], {
          env: { XDG_STATE_HOME: stateDir },
        });
      }
    },
  );

  it(
    "--no-restore-session does not restore prior backup and does not overwrite it",
    { timeout: 30_000 },
    async () => {
      const backupDir = join(stateDir, "yome", "backup");
      mkdirSync(backupDir, { recursive: true });
      const backupFile = join(backupDir, `yome-${port}.json`);
      const stalePath = join(stateDir, "stale.md");
      writeFileSync(stalePath, "# Stale\n");
      const originalBackup = JSON.stringify({
        groups: { default: [stalePath] },
      });
      writeFileSync(backupFile, originalBackup);

      const fresh = join(stateDir, "fresh.md");
      writeFileSync(fresh, "# Fresh\n");

      const child = spawn(
        process.execPath,
        [
          ...launchArgs,
          "--foreground",
          "--port",
          String(port),
          "--bind",
          "127.0.0.1",
          "--no-open",
          "--no-restore-session",
          fresh,
        ],
        {
          env: { ...process.env, XDG_STATE_HOME: stateDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      try {
        let ready = false;
        for (let i = 0; i < 100 && !ready; i++) {
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
        expect(
          ready,
          `server did not become ready; child stderr:\n${stderrBuf}`,
        ).toBe(true);

        const status = (await fetch(
          `http://127.0.0.1:${port}/_/api/status`,
        ).then((r) => r.json())) as {
          groups: Array<{ name: string; files: Array<{ name: string }> }>;
        };
        const names = status.groups.flatMap((g) => g.files.map((f) => f.name));
        // Only the freshly-supplied file should be present; the stale entry
        // from the pre-existing backup must NOT have been restored.
        expect(names).toContain("fresh.md");
        expect(names).not.toContain("stale.md");
        expect(stderrBuf).not.toMatch(/restoring previous session/);

        // Backup save should be disabled too — the file on disk should still
        // hold the original snapshot, not be rewritten with [fresh.md].
        // Wait past the BACKUP_DEBOUNCE_MS window (1s) just in case.
        await wait(1500);
        const after = readFileSync(backupFile, "utf8");
        expect(after).toBe(originalBackup);
      } finally {
        child.kill("SIGINT");
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      }
    },
  );

  it("--status surfaces orphan backup files (backup present, no log)", () => {
    const backupDir = join(stateDir, "yome", "backup");
    mkdirSync(backupDir, { recursive: true });
    const orphanPort = port + 100;
    const orphanFile = join(backupDir, `yome-${orphanPort}.json`);
    writeFileSync(
      orphanFile,
      JSON.stringify({ groups: { default: ["/some/path.md"] } }),
    );

    const r = runYome(["--status"], { env: { XDG_STATE_HOME: stateDir } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`http://localhost:${orphanPort}`);
    expect(r.stdout).toContain("(saved session backup only)");

    const j = runYome(["--status", "--json"], {
      env: { XDG_STATE_HOME: stateDir },
    });
    const data = JSON.parse(j.stdout) as Array<{
      url: string;
      orphanBackup?: boolean;
    }>;
    const entry = data.find((d) => d.url === `http://localhost:${orphanPort}`);
    expect(entry?.orphanBackup).toBe(true);
  });

  it("--clear --yes removes an orphan backup without prompting", () => {
    const backupDir = join(stateDir, "yome", "backup");
    mkdirSync(backupDir, { recursive: true });
    const targetPort = port + 200;
    const backupFile = join(backupDir, `yome-${targetPort}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({ groups: { default: ["/some/path.md"] } }),
    );
    expect(existsSync(backupFile)).toBe(true);

    const r = runYome(["--clear", "--yes", "--port", String(targetPort)], {
      env: { XDG_STATE_HOME: stateDir },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/cleared saved session/);
    expect(r.stderr).not.toMatch(/clear saved session.*\[Y\/n\]/);
    expect(existsSync(backupFile)).toBe(false);
  });

  it("-y short form also skips the --clear confirmation prompt", () => {
    const backupDir = join(stateDir, "yome", "backup");
    mkdirSync(backupDir, { recursive: true });
    const targetPort = port + 201;
    const backupFile = join(backupDir, `yome-${targetPort}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({ groups: { default: ["/some/path.md"] } }),
    );

    const r = runYome(["--clear", "-y", "--port", String(targetPort)], {
      env: { XDG_STATE_HOME: stateDir },
    });
    expect(r.status).toBe(0);
    expect(existsSync(backupFile)).toBe(false);
  });

  it("--clear without --yes does not consume stdin EOF and stays well-behaved", () => {
    // With nothing to clear, --clear takes the early-exit branch and never
    // reaches the prompt — exercising this guards against a regression where
    // the prompt would hang on closed stdin.
    const r = runYome(["--clear", "--port", String(port + 202)], {
      env: { XDG_STATE_HOME: stateDir },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no saved session for port/);
  });

  it("--clear prompt treats stdin EOF as a cancel instead of exiting mid-command", () => {
    const targetPort = port + 203;
    const backupDir = join(stateDir, "yome", "backup");
    mkdirSync(backupDir, { recursive: true });
    const backupFile = join(backupDir, `yome-${targetPort}.json`);
    writeFileSync(backupFile, JSON.stringify({ groups: { default: [] } }));
    // Empty piped stdin: the prompt hits EOF immediately.
    const r = runYome(["--clear", "--port", String(targetPort)], {
      env: { XDG_STATE_HOME: stateDir },
      input: "",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/canceled/);
    expect(existsSync(backupFile)).toBe(true);
  });

  it(
    "--clear --yes against a RUNNING server clears the backup and restarts it",
    { timeout: 30_000 },
    async () => {
      const tmpFile = join(stateDir, "clearme.md");
      writeFileSync(tmpFile, "# Clear Me\n");
      const backupFile = join(stateDir, "yome", "backup", `yome-${port}.json`);

      const child = spawn(
        process.execPath,
        [
          ...launchArgs,
          "--foreground",
          "--port",
          String(port),
          "--bind",
          "127.0.0.1",
          "--no-open",
          tmpFile,
        ],
        {
          env: { ...process.env, XDG_STATE_HOME: stateDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        // Wait for readiness, then for the debounced backup write.
        let ready = false;
        for (let i = 0; i < 100 && !ready; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/_/api/status`);
            if (res.ok) ready = true;
          } catch {
            // not yet
          }
          if (!ready) await wait(100);
        }
        expect(ready).toBe(true);
        let backupSeen = false;
        for (let i = 0; i < 50 && !backupSeen; i++) {
          backupSeen = existsSync(backupFile);
          if (!backupSeen) await wait(100);
        }
        expect(backupSeen).toBe(true);

        // Pass the same --bind as the original server: the respawn uses the
        // CLI's bind flag, and a bare "localhost" resolves to ::1 first on
        // some CI hosts, which would put the new server on a different
        // loopback than the 127.0.0.1 probes below.
        const r = runYome(
          ["--clear", "--yes", "--port", String(port), "--bind", "127.0.0.1"],
          {
            env: { XDG_STATE_HOME: stateDir },
          },
        );
        expect(
          r.status,
          `--clear failed; stderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
        ).toBe(0);
        expect(r.stderr).toMatch(/cleared session and restarted server/);
        // The saved session must be gone and must not resurrect.
        expect(existsSync(backupFile)).toBe(false);

        // The respawned server is up and empty. Retry: undici may first
        // burn stale pooled keep-alive sockets that belonged to the old
        // server before opening a fresh connection.
        let status: { groups: unknown[] } | null = null;
        let lastFetchErr: unknown = null;
        for (let i = 0; i < 25 && status === null; i++) {
          try {
            status = (await fetch(`http://127.0.0.1:${port}/_/api/status`).then(
              (res) => res.json(),
            )) as { groups: unknown[] };
          } catch (err) {
            lastFetchErr = err;
            await wait(200);
          }
        }
        expect(
          status?.groups,
          `respawned server unreachable; last fetch error: ${String(lastFetchErr)}`,
        ).toEqual([]);
        await wait(1500);
        expect(existsSync(backupFile)).toBe(false);
      } finally {
        child.kill("SIGINT");
        // The original server may already have exited via --clear's shutdown.
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          wait(2000),
        ]);
        // Stop the respawned detached server.
        runYome(["--port", String(port), "--shutdown"], {
          env: { XDG_STATE_HOME: stateDir },
        });
      }
    },
  );

  it(
    "--clear removes a backup created by the dying server's final flush",
    { timeout: 30_000 },
    async () => {
      // Scenario: the session changed within the 1s backup debounce, so no
      // backup exists when --clear samples the filesystem — but the awaited
      // shutdown flush writes one. --clear must still leave no backup behind.
      const tmpFile = join(stateDir, "flush.md");
      writeFileSync(tmpFile, "# Flush\n");
      const backupFile = join(stateDir, "yome", "backup", `yome-${port}.json`);

      const child = spawn(
        process.execPath,
        [
          ...launchArgs,
          "--foreground",
          "--port",
          String(port),
          "--bind",
          "127.0.0.1",
          "--no-open",
          tmpFile,
        ],
        {
          env: { ...process.env, XDG_STATE_HOME: stateDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        let ready = false;
        for (let i = 0; i < 100 && !ready; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/_/api/status`);
            if (res.ok) ready = true;
          } catch {
            // not yet
          }
          if (!ready) await wait(100);
        }
        expect(ready).toBe(true);

        // Clear right away — often before the debounced backup write fires.
        const r = runYome(
          ["--clear", "--yes", "--port", String(port), "--bind", "127.0.0.1"],
          {
            env: { XDG_STATE_HOME: stateDir },
          },
        );
        expect(
          r.status,
          `--clear failed; stderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
        ).toBe(0);
        // Regardless of which side won the debounce race, no backup may
        // survive the clear.
        expect(existsSync(backupFile)).toBe(false);
        await wait(1500);
        expect(existsSync(backupFile)).toBe(false);
      } finally {
        child.kill("SIGINT");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          wait(2000),
        ]);
        runYome(["--port", String(port), "--shutdown"], {
          env: { XDG_STATE_HOME: stateDir },
        });
      }
    },
  );
});
