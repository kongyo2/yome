import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, load, remove, save } from "./index.js";

const TEST_PORT_BASE = 39000;

describe("backup", () => {
  const prevState = process.env["XDG_STATE_HOME"];
  let tmp: string;
  let port: number;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "yome-test-"));
    process.env["XDG_STATE_HOME"] = tmp;
    port = TEST_PORT_BASE + Math.floor(Math.random() * 1000);
  });

  afterEach(async () => {
    if (prevState === undefined) {
      delete process.env["XDG_STATE_HOME"];
    } else {
      process.env["XDG_STATE_HOME"] = prevState;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("round-trips", async () => {
    expect(exists(port)).toBe(false);
    await save(port, {
      groups: { default: ["/foo/a.md"] },
      patterns: { default: ["/foo/*.md"] },
      uploadedFiles: [{ name: "stdin.md", content: "hello", group: "default" }],
    });
    expect(exists(port)).toBe(true);
    const data = await load(port);
    expect(data).toEqual({
      groups: { default: ["/foo/a.md"] },
      patterns: { default: ["/foo/*.md"] },
      uploadedFiles: [{ name: "stdin.md", content: "hello", group: "default" }],
    });
  });

  it("load returns null when missing", async () => {
    const data = await load(port + 1);
    expect(data).toBeNull();
  });

  it("remove deletes the file", async () => {
    await save(port, { groups: { default: [] } });
    expect(exists(port)).toBe(true);
    await remove(port);
    expect(exists(port)).toBe(false);
  });

  it("remove is a no-op for missing file", async () => {
    await expect(remove(port + 2)).resolves.toBeUndefined();
  });
});
