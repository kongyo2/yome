import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDir, setup, logger } from "./index.js";

const TEST_PORT = 19999;

const prev = process.env["XDG_STATE_HOME"];
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mo-log-"));
  process.env["XDG_STATE_HOME"] = tmp;
});

afterEach(() => {
  if (prev === undefined) {
    delete process.env["XDG_STATE_HOME"];
  } else {
    process.env["XDG_STATE_HOME"] = prev;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("logfile setup", () => {
  it("creates the log directory and file", () => {
    const cleanup = setup(TEST_PORT);
    const file = join(tmp, "mo", "log", `mo-${TEST_PORT}.log`);
    expect(existsSync(file)).toBe(true);
    cleanup();
  });

  it("writes JSON records to the log file", () => {
    const cleanup = setup(TEST_PORT);
    logger.info("hi", { foo: "bar" });
    cleanup();
    const file = join(tmp, "mo", "log", `mo-${TEST_PORT}.log`);
    const content = readFileSync(file, "utf8");
    expect(content).toMatch(/"msg":"hi"/);
    expect(content).toMatch(/"foo":"bar"/);
    expect(content).toMatch(/"level":"INFO"/);
  });

  it("appends across multiple setup calls (rotation preserves)", () => {
    const c1 = setup(TEST_PORT);
    logger.info("first");
    c1();
    const c2 = setup(TEST_PORT);
    logger.info("second");
    c2();
    const file = join(tmp, "mo", "log", `mo-${TEST_PORT}.log`);
    const content = readFileSync(file, "utf8");
    expect(content).toMatch(/"msg":"first"/);
    expect(content).toMatch(/"msg":"second"/);
  });

  it("removes log files older than 7 days on setup", () => {
    const dir = join(tmp, "mo", "log");
    setup(TEST_PORT)(); // creates the dir
    const oldFile = join(dir, "mo-1234.log");
    writeFileSync(oldFile, "old", "utf8");
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, old, old);

    const recent = join(dir, "mo-5678.log");
    writeFileSync(recent, "recent", "utf8");

    setup(TEST_PORT)();
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("logDir respects XDG_STATE_HOME", () => {
    expect(logDir()).toBe(join(tmp, "mo", "log"));
  });
});
