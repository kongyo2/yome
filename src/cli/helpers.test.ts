import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterValidRestoreData,
  isLoopbackBind,
  mapFromRecord,
  mergeGroups,
} from "./helpers.js";

describe("isLoopbackBind", () => {
  it("accepts localhost", () => {
    expect(isLoopbackBind("localhost")).toBe(true);
  });
  it("accepts 127.x.x.x", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("127.1.2.3")).toBe(true);
  });
  it("accepts ::1", () => {
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("0:0:0:0:0:0:0:1")).toBe(true);
  });
  it("rejects other addresses", () => {
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("192.168.1.1")).toBe(false);
    expect(isLoopbackBind("nothostname")).toBe(false);
  });
});

describe("mergeGroups", () => {
  it("merges base and additional with base order first", () => {
    const base = new Map([["default", ["a", "b"]]]);
    const additional = new Map([["default", ["c"]]]);
    const out = mergeGroups(base, additional);
    expect(out.get("default")).toEqual(["a", "b", "c"]);
  });

  it("dedupes entries when merging", () => {
    const base = new Map([["default", ["a", "b"]]]);
    const additional = new Map([["default", ["b", "c"]]]);
    const out = mergeGroups(base, additional);
    expect(out.get("default")).toEqual(["a", "b", "c"]);
  });

  it("includes additional-only groups", () => {
    const base = new Map([["default", ["a"]]]);
    const additional = new Map([["docs", ["b"]]]);
    const out = mergeGroups(base, additional);
    expect(out.get("default")).toEqual(["a"]);
    expect(out.get("docs")).toEqual(["b"]);
  });
});

describe("filterValidRestoreData", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mo-filter-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty maps for null input", () => {
    const out = filterValidRestoreData(null);
    expect(out.files.size).toBe(0);
    expect(out.patterns.size).toBe(0);
    expect(out.uploadedFiles).toEqual([]);
  });

  it("filters missing files", () => {
    const existing = join(tmp, "a.md");
    writeFileSync(existing, "");
    const out = filterValidRestoreData({
      groups: { default: [existing, join(tmp, "missing.md")] },
    });
    expect(out.files.get("default")).toEqual([existing]);
  });

  it("preserves patterns as-is", () => {
    const out = filterValidRestoreData({
      groups: {},
      patterns: { default: ["/foo/*.md"] },
    });
    expect(out.patterns.get("default")).toEqual(["/foo/*.md"]);
  });

  it("preserves uploaded files", () => {
    const upload = { name: "x.md", content: "y", group: "default" };
    const out = filterValidRestoreData({ groups: {}, uploadedFiles: [upload] });
    expect(out.uploadedFiles).toEqual([upload]);
  });
});

describe("mapFromRecord", () => {
  it("turns a record into a map", () => {
    const m = mapFromRecord({ a: [1, 2], b: [3] });
    expect(m.get("a")).toEqual([1, 2]);
    expect(m.get("b")).toEqual([3]);
  });
  it("clones the arrays", () => {
    const src = { a: [1] };
    const m = mapFromRecord(src);
    const arr = m.get("a")!;
    arr.push(99);
    expect(src.a).toEqual([1]);
  });
});
