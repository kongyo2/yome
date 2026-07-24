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

// The optimized single-pass scan must produce byte-identical results to the
// straightforward per-line reference scan for every input shape.
describe("findSearchMatches parity with per-line reference", () => {
  it("matches the reference on a corpus of tricky documents", async () => {
    const { FenceTracker, extractHeadingLine } = await import("./title.js");
    function referenceImpl(
      content: string,
      needle: string,
      contextLines: number,
      limit: number,
    ) {
      if (needle === "" || limit <= 0) return [];
      const lines = content.split("\n");
      const matches: Array<Record<string, unknown>> = [];
      let currentHeading = "";
      const fences = new FenceTracker();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!fences.feed(line) && !fences.inFence) {
          const h = extractHeadingLine(line);
          if (h !== "") currentHeading = h;
        }
        const idx = line.toLowerCase().indexOf(needle);
        if (idx < 0) continue;
        const m: Record<string, unknown> = {
          line: i + 1,
          column: idx + 1,
          text: line,
          anchor: { kind: "heading", value: currentHeading },
        };
        const before = lines.slice(Math.max(0, i - contextLines), i);
        if (before.length > 0) m["before"] = before;
        const after = lines.slice(
          i + 1,
          Math.min(lines.length, i + contextLines + 1),
        );
        if (after.length > 0) m["after"] = after;
        if (currentHeading !== "") m["heading"] = currentHeading;
        matches.push(m);
        if (matches.length >= limit) break;
      }
      return matches;
    }

    const docs = [
      "",
      "\n",
      "foo",
      "foo\n",
      "foo\nfoo foo\nfoo",
      "# A\nthe cat\n## B\nthe dog\n\nthe end",
      "# Real\n```\n# Fake\nthe fenced\n```\nthe after",
      "~~~md\n# Nope\n~~~\n# Yes\nthe tail",
      "line with the needle at end the",
      "the at start\nmid the mid\n",
      "İstanbul the city\nthe İ line\nthe end", // length-changing lowercase
      "ΑΣ the sigma\nΣΟΦΟΣ the word",
      "a\r\nb the\r\n```\r\nthe fence\r\n```\r\nthe done", // CRLF document
      "    # indented not heading\nthe x",
      "# H #\nthe y",
      "#### deep heading\nthe z\n\n\nthe w",
      "the\nthe\nthe\nthe\nthe\nthe",
      "big" + "x".repeat(500) + " the " + "y".repeat(500),
    ];
    const needles = ["the", "THE", "foo", "zzz", "İ", "i̇", "σ", "e c"];
    const ctxs = [0, 1, 2, 5];
    const limits = [1, 2, 100];
    for (const doc of docs) {
      for (const needle of needles) {
        for (const ctx of ctxs) {
          for (const limit of limits) {
            const want = referenceImpl(doc, needle.toLowerCase(), ctx, limit);
            const got = findSearchMatches(
              doc,
              needle.toLowerCase(),
              ctx,
              limit,
            );
            expect(
              got,
              `doc=${JSON.stringify(doc.slice(0, 40))} needle=${needle} ctx=${ctx} limit=${limit}`,
            ).toEqual(want);
          }
        }
      }
    }
  });
});
