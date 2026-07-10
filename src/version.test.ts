import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Version, Name } from "./version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function pkgVersion(relPath: string): string {
  const pkg = JSON.parse(readFileSync(join(root, relPath), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

// Version is embedded in src/version.ts (shipped to clients via /_/api/version
// and --version) while npm reads package.json. The release workflow bumps all
// of them together; this test catches manual bumps that miss one.
describe("version consistency", () => {
  it("matches package.json", () => {
    expect(Version).toBe(pkgVersion("package.json"));
  });

  it("matches frontend/package.json", () => {
    expect(Version).toBe(pkgVersion(join("frontend", "package.json")));
  });

  it("has a stable binary name", () => {
    expect(Name).toBe("yome");
  });
});
