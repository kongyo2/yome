import { describe, it, expect } from "vitest";
import { findSearchMatches } from "./search.js";

describe("findSearchMatches", () => {
  it("returns empty when needle is empty", () => {
    expect(findSearchMatches("hello", "", 2, 10)).toEqual([]);
  });
  it("finds a basic match", () => {
    const matches = findSearchMatches("line one\nfoo bar\nbaz", "foo", 1, 10);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.line).toBe(2);
    expect(matches[0]?.text).toBe("foo bar");
    expect(matches[0]?.before).toEqual(["line one"]);
    expect(matches[0]?.after).toEqual(["baz"]);
  });
  it("respects the limit", () => {
    expect(findSearchMatches("a\na\na\na", "a", 0, 2)).toHaveLength(2);
  });
  it("tracks current heading", () => {
    const matches = findSearchMatches("# Top\ntext\n## Sub\nfoo", "foo", 0, 10);
    expect(matches[0]?.heading).toBe("Sub");
  });
  it("does not treat fenced code blocks as headings", () => {
    const matches = findSearchMatches(
      "# Real\n```\n# Fake\n```\nfoo",
      "foo",
      0,
      10,
    );
    expect(matches[0]?.heading).toBe("Real");
  });
});
