export type LinkResolution =
  | { type: "external" }
  | { type: "hash" }
  | { type: "markdown"; hrefPath: string; fragment?: string }
  | { type: "file"; rawUrl: string }
  | { type: "passthrough" };

function rawBasePath(group: string, fileId: string): string {
  return `/_/api/groups/${encodeURIComponent(group)}/files/${fileId}/raw`;
}

// Detects an absolute URI: starts with a scheme (RFC 3986) like
// `http:`, `https:`, `mailto:`, `tel:`, `ftp:`, `data:`, etc., or a
// protocol-relative `//` reference.
const ABSOLUTE_URI_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

export function resolveLink(
  href: string | undefined,
  group: string,
  fileId: string,
): LinkResolution {
  if (!href || ABSOLUTE_URI_RE.test(href)) {
    return { type: "external" };
  }
  if (href.startsWith("#")) {
    return { type: "hash" };
  }
  const [hrefPath, ...fragmentParts] = href.split("#");
  if (hrefPath.endsWith(".md") || hrefPath.endsWith(".mdx")) {
    // Keep the fragment (e.g. api.md#auth) so cross-file section links can
    // scroll to the target heading after the file opens.
    const fragment = fragmentParts.join("#");
    return fragment === ""
      ? { type: "markdown", hrefPath }
      : { type: "markdown", hrefPath, fragment };
  }
  const basename = hrefPath.split("/").pop() || "";
  if (basename.includes(".")) {
    return { type: "file", rawUrl: `${rawBasePath(group, fileId)}/${href}` };
  }
  return { type: "passthrough" };
}

export function resolveImageSrc(
  src: string | undefined,
  group: string,
  fileId: string,
): string | undefined {
  // Pass through absolute URIs (http/https/data/etc.) and protocol-relative
  // references; only rewrite genuine relative paths to the raw-asset API.
  if (src && !ABSOLUTE_URI_RE.test(src)) {
    return `${rawBasePath(group, fileId)}/${src}`;
  }
  return src;
}

export function extractLanguage(className: string | undefined): string | null {
  // Language ids can contain +, #, and - (c++, c#, objective-c).
  const match = /language-([\w+#-]+)/.exec(className || "");
  return match ? match[1] : null;
}
