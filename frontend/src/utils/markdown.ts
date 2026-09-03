import { defaultUrlTransform } from "react-markdown";
import { defaultSchema } from "rehype-sanitize";

// Minimal structural view of a hast node: enough for the tree walks below
// without depending on the hast type package directly.
interface HastNode {
  type: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const FOOTNOTE_ID_PATTERN = /^user-content-(fn-|fnref-|footnote-label$)/;
const CLOBBER_PREFIX = "user-content-";

// Strip the `user-content-` prefix that remark-gfm bakes into footnote IDs,
// so rehype-sanitize can re-add it exactly once (avoiding double-prefixed
// IDs).
export function rehypeStripClobberPrefix() {
  function walk(node: HastNode) {
    const id = node.properties?.["id"];
    if (typeof id === "string" && FOOTNOTE_ID_PATTERN.test(id)) {
      node.properties!["id"] = id.slice(CLOBBER_PREFIX.length);
    }
    for (const child of node.children ?? []) {
      if (child.type === "element") walk(child);
    }
  }
  return (tree: HastNode) => {
    walk(tree);
  };
}

// Extend the default GitHub-compatible schema: style/align attributes used
// in raw HTML, and the data: scheme on src (narrowed to images by
// urlTransform below).
export const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.["span"] || []), "style"],
    div: [...(defaultSchema.attributes?.["div"] || []), "style", "align"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.["src"] || []), "data"],
  },
};

// react-markdown's defaultUrlTransform drops every data: URI, on top of
// rehype-sanitize. Restrict the exception to data:image/ on src: img is
// script-inert for data URIs, while data:text/html on href would be a
// vector.
export function urlTransform(url: string, key: string): string {
  if (key === "src" && url.startsWith("data:image/")) {
    return url;
  }
  return defaultUrlTransform(url);
}

// Best-effort removal of inline markdown markup so a raw heading string can
// be compared against rendered DOM textContent (e.g. "Install `yome`" vs
// "Install yome").
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // emphasis
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    .trim();
}
