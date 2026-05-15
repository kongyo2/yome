import { describe, it, expect } from "vitest";
import { buildDeeplink, displayNames } from "./display.js";

describe("buildDeeplink", () => {
  it("omits path for default group", () => {
    expect(
      buildDeeplink("localhost:6275", "default", "abc12345", "default"),
    ).toBe("http://localhost:6275/?file=abc12345");
  });
  it("includes named group", () => {
    expect(buildDeeplink("localhost:6275", "docs", "abc12345", "default")).toBe(
      "http://localhost:6275/docs?file=abc12345",
    );
  });
});

describe("displayNames", () => {
  it("returns basenames when unique", () => {
    expect(displayNames(["/a/foo.md", "/b/bar.md"])).toEqual([
      "foo.md",
      "bar.md",
    ]);
  });
  it("disambiguates with parent dir when basename collides", () => {
    const out = displayNames(["/a/x/foo.md", "/a/y/foo.md"]);
    expect(out).toEqual(["x/foo.md", "y/foo.md"]);
  });
});
