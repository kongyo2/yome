import { describe, it, expect } from "vitest";
import { extractTitle, extractHeadingLine, leadingColumns } from "./title.js";

describe("extractTitle", () => {
  it("returns the first ATX heading", () => {
    expect(extractTitle("# Hello\n## World")).toBe("Hello");
  });
  it("returns empty when no heading", () => {
    expect(extractTitle("just text\nnothing here")).toBe("");
  });
  it("skips headings inside fenced code blocks", () => {
    expect(extractTitle("```\n# Not a heading\n```\n# Real")).toBe("Real");
  });
  it("supports tilde fences", () => {
    expect(extractTitle("~~~\n# Not a heading\n~~~\n# Real")).toBe("Real");
  });
  it("ignores headings indented 4+ columns", () => {
    expect(extractTitle("    # Indented\n# Real")).toBe("Real");
  });
  it("requires space after #", () => {
    expect(extractTitle("#NoSpace\n# Real")).toBe("Real");
  });
  it("strips trailing # sequence", () => {
    expect(extractTitle("# Title ###")).toBe("Title");
  });
  it("rejects 7+ hashes", () => {
    expect(extractTitle("####### Too deep\n## Real")).toBe("Real");
  });
});

describe("extractHeadingLine", () => {
  it("extracts ATX heading", () => {
    expect(extractHeadingLine("## Section")).toBe("Section");
  });
  it("returns empty for non-heading", () => {
    expect(extractHeadingLine("regular line")).toBe("");
  });
});

describe("leadingColumns", () => {
  it("counts spaces", () => {
    expect(leadingColumns("    hello")).toBe(4);
  });
  it("expands tabs to next 4-column stop", () => {
    expect(leadingColumns("\thello")).toBe(4);
    expect(leadingColumns(" \thello")).toBe(4);
    expect(leadingColumns("\t\thello")).toBe(8);
  });
});
