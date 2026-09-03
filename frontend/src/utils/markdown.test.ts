import { describe, it, expect } from "vitest";
import {
  rehypeStripClobberPrefix,
  sanitizeSchema,
  stripInlineMarkdown,
  urlTransform,
} from "./markdown";

describe("urlTransform", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("keeps data:image/ URIs on src", () => {
    expect(urlTransform(png, "src")).toBe(png);
  });

  it("drops data: URIs that are not images", () => {
    expect(
      urlTransform("data:text/html,<script>alert(1)</script>", "src"),
    ).toBe("");
  });

  it("drops data:image/ URIs on href", () => {
    expect(urlTransform(png, "href")).toBe("");
  });

  it("leaves ordinary and relative URLs alone", () => {
    expect(urlTransform("https://example.com/a.png", "src")).toBe(
      "https://example.com/a.png",
    );
    expect(urlTransform("images/a.png", "src")).toBe("images/a.png");
    expect(urlTransform("#section", "href")).toBe("#section");
    expect(urlTransform("javascript:alert(1)", "href")).toBe("");
  });
});

describe("sanitizeSchema", () => {
  it("allows the data scheme on src and style on span/div", () => {
    expect(sanitizeSchema.protocols.src).toContain("data");
    expect(sanitizeSchema.protocols.src).toContain("https");
    expect(sanitizeSchema.attributes.span).toContain("style");
    expect(sanitizeSchema.attributes.div).toContain("align");
  });
});

describe("rehypeStripClobberPrefix", () => {
  it("removes the clobber prefix from footnote ids only", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          properties: { id: "user-content-fn-1" },
          children: [
            { type: "element", properties: { id: "user-content-fnref-1" } },
            { type: "element", properties: { id: "user-content-other" } },
            { type: "text" },
          ],
        },
        { type: "element", properties: { id: "user-content-footnote-label" } },
      ],
    };
    rehypeStripClobberPrefix()(tree);
    const [first, second] = tree.children;
    expect(first.properties?.id).toBe("fn-1");
    expect(first.children?.[0]?.properties?.id).toBe("fnref-1");
    expect(first.children?.[1]?.properties?.id).toBe("user-content-other");
    expect(second.properties?.id).toBe("footnote-label");
  });
});

describe("stripInlineMarkdown", () => {
  it("strips inline markup", () => {
    expect(stripInlineMarkdown("Install `yome`")).toBe("Install yome");
    expect(stripInlineMarkdown("**Bold** and _em_ and ~~gone~~")).toBe(
      "Bold and em and gone",
    );
    expect(stripInlineMarkdown("See [docs](http://x) ![i](a.png)")).toBe(
      "See docs i",
    );
  });
});
