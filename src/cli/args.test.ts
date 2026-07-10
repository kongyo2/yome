import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { resolveArgs, resolveUnwatchArgs } from "./args.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "yome-args-"));
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

  it("prefers an existing literal file over glob interpretation", async () => {
    // "[draft] notes.md" contains glob metacharacters; as a character class
    // it would also match "t notes.md". The literal file must win.
    const literal = join(tmp, "[draft] notes.md");
    const neighbor = join(tmp, "t notes.md");
    writeFileSync(literal, "# Draft");
    writeFileSync(neighbor, "# Neighbor");
    const { files, patterns } = await resolveArgs([literal], false, false);
    expect(files).toEqual([literal]);
    expect(patterns).toEqual([]);
  });

  it("still expands glob-looking args that do not exist literally", async () => {
    writeFileSync(join(tmp, "x1.md"), "");
    writeFileSync(join(tmp, "x2.md"), "");
    const { files } = await resolveArgs([join(tmp, "x?.md")], false, false);
    expect(files.sort()).toEqual([join(tmp, "x1.md"), join(tmp, "x2.md")]);
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
    expect(files.sort()).toEqual(
      [join(tmp, "docs", "a.md"), standalone].sort(),
    );
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

describe("port explicit-source detection (commander getOptionValueSource)", () => {
  // Locks in the assumption behind the --shutdown/--restart fan-out gate:
  // commander tags --port as `cli` for every valid short/long syntax, so the
  // gate doesn't need to re-parse argv itself.
  const makeProgram = () => {
    const p = new Command();
    p.exitOverride()
      .option("-R, --recursive", "Recursive")
      .option("-w, --watch", "Watch")
      .option("-p, --port <number>", "Port", (v) => Number(v), 6275);
    return p;
  };
  const sourceOf = (argv: string[]): string | undefined => {
    const p = makeProgram();
    p.parse(["node", "yome", ...argv]);
    return p.getOptionValueSource("port");
  };

  it("returns 'default' when --port is omitted", () => {
    expect(sourceOf([])).toBe("default");
  });
  it("treats every explicit syntax as 'cli'", () => {
    expect(sourceOf(["-p", "7000"])).toBe("cli");
    expect(sourceOf(["-p7000"])).toBe("cli");
    expect(sourceOf(["--port", "7000"])).toBe("cli");
    expect(sourceOf(["--port=7000"])).toBe("cli");
    // Clustered short flags: -R + -p7000 packed into one token.
    expect(sourceOf(["-Rp7000"])).toBe("cli");
    expect(sourceOf(["-Rwp7000"])).toBe("cli");
  });
  it("treats malformed inline values as 'cli' too", () => {
    // -pfoo is still an explicit --port attempt from the user's perspective;
    // we must not silently fall back to fan-out shutdown semantics.
    expect(sourceOf(["-pfoo"])).toBe("cli");
  });
});
