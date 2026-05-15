import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveArgs, resolveUnwatchArgs } from "./args.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mo-args-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveArgs", () => {
  it("treats plain files as files", async () => {
    const f = join(tmp, "a.md");
    writeFileSync(f, "# A");
    const { files, patterns } = await resolveArgs([f], false, false);
    expect(files).toEqual([f]);
    expect(patterns).toEqual([]);
  });

  it("expands a glob pattern when not in watch mode", async () => {
    writeFileSync(join(tmp, "a.md"), "");
    writeFileSync(join(tmp, "b.md"), "");
    const { files, patterns } = await resolveArgs(
      [join(tmp, "*.md")],
      false,
      false,
    );
    expect(files.sort()).toEqual([join(tmp, "a.md"), join(tmp, "b.md")]);
    expect(patterns).toEqual([]);
  });

  it("registers a glob pattern in watch mode", async () => {
    const pat = join(tmp, "*.md");
    const { files, patterns } = await resolveArgs([pat], true, false);
    expect(files).toEqual([]);
    expect(patterns).toEqual([pat]);
  });

  it("expands a directory to *.md", async () => {
    writeFileSync(join(tmp, "a.md"), "");
    writeFileSync(join(tmp, "b.md"), "");
    const { files } = await resolveArgs([tmp], false, false);
    expect(files.sort()).toEqual([join(tmp, "a.md"), join(tmp, "b.md")]);
  });

  it("expands a directory recursively with -R", async () => {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(join(tmp, "a.md"), "");
    writeFileSync(join(tmp, "sub", "b.md"), "");
    const { files } = await resolveArgs([tmp], false, true);
    expect(files.sort()).toEqual([join(tmp, "a.md"), join(tmp, "sub", "b.md")]);
  });

  it("registers directory as pattern in watch mode", async () => {
    const { patterns } = await resolveArgs([tmp], true, false);
    expect(patterns).toEqual([join(tmp, "*.md")]);
  });

  it("registers directory recursively in watch mode", async () => {
    const { patterns } = await resolveArgs([tmp], true, true);
    expect(patterns).toEqual([join(tmp, "**", "*.md")]);
  });

  it("throws for non-existent files", async () => {
    await expect(
      resolveArgs([join(tmp, "missing.md")], false, false),
    ).rejects.toThrow(/file not found/);
  });

  it("throws when an empty directory in non-watch mode has no .md", async () => {
    await expect(resolveArgs([tmp], false, false)).rejects.toThrow(
      /no \.md files/,
    );
  });

  it("sorts files naturally (numeric)", async () => {
    writeFileSync(join(tmp, "1.md"), "");
    writeFileSync(join(tmp, "2.md"), "");
    writeFileSync(join(tmp, "10.md"), "");
    const { files } = await resolveArgs([join(tmp, "*.md")], false, false);
    expect(files).toEqual([
      join(tmp, "1.md"),
      join(tmp, "2.md"),
      join(tmp, "10.md"),
    ]);
  });

  it("mixes directories and individual files in one call", async () => {
    mkdirSync(join(tmp, "docs"), { recursive: true });
    writeFileSync(join(tmp, "docs", "a.md"), "");
    const standalone = join(tmp, "standalone.md");
    writeFileSync(standalone, "");
    const { files, patterns } = await resolveArgs(
      [join(tmp, "docs"), standalone],
      false,
      false,
    );
    expect(patterns).toEqual([]);
    expect(files.sort()).toEqual([join(tmp, "docs", "a.md"), standalone].sort());
  });
});

describe("resolveUnwatchArgs", () => {
  it("accepts a glob pattern", async () => {
    const pat = join(tmp, "*.md");
    const out = await resolveUnwatchArgs([pat], false, async () => []);
    expect(out).toEqual([pat]);
  });

  it("expands a directory to *.md when not recursive", async () => {
    const out = await resolveUnwatchArgs([tmp], false, async () => []);
    expect(out).toEqual([join(tmp, "*.md")]);
  });

  it("collects registered patterns under a directory when recursive", async () => {
    const registered = [
      join(tmp, "*.md"),
      join(tmp, "sub", "*.md"),
      join(tmp, "**", "*.md"),
      "/other/place/*.md",
    ];
    const out = await resolveUnwatchArgs([tmp], true, async () => registered);
    expect(out.sort()).toEqual(
      [
        join(tmp, "*.md"),
        join(tmp, "sub", "*.md"),
        join(tmp, "**", "*.md"),
      ].sort(),
    );
  });

  it("rejects file arguments", async () => {
    const f = join(tmp, "a.md");
    writeFileSync(f, "");
    await expect(
      resolveUnwatchArgs([f], false, async () => []),
    ).rejects.toThrow(/requires glob patterns or directories/);
  });

  it("rejects unknown paths in non-recursive mode", async () => {
    await expect(
      resolveUnwatchArgs([join(tmp, "missing")], false, async () => []),
    ).rejects.toThrow(/path not found/);
  });

  it("dedupes patterns", async () => {
    const pat = join(tmp, "*.md");
    const out = await resolveUnwatchArgs([pat, pat], false, async () => []);
    expect(out).toEqual([pat]);
  });
});
