import { escapeRegExp } from "./regex";

export interface SearchHitMarker {
  top: number;
  height: number;
}

// Horizontal offset of the hit markers from the article's left edge (they
// sit in the gutter, just outside the text column).
export const SEARCH_HIT_COLUMN_OFFSET = -24;

// collectSearchHitMarkers finds every occurrence of `query` in the rendered
// text of `root` and returns one marker per distinct line, positioned
// relative to the article, for the gutter indicator column.
export function collectSearchHitMarkers(
  root: HTMLElement,
  query: string,
): SearchHitMarker[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const pattern = new RegExp(escapeRegExp(trimmed), "gi");
  const articleRect = root.getBoundingClientRect();
  const markers = new Map<string, SearchHitMarker>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        parent == null ||
        parent.closest("script, style, .frontmatter-block") != null ||
        node.textContent == null ||
        node.textContent.trim() === ""
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      pattern.lastIndex = 0;
      return pattern.test(node.textContent)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let current = walker.nextNode();
  while (current != null) {
    if (current instanceof Text) {
      const text = current.textContent ?? "";
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const range = document.createRange();
        range.setStart(current, start);
        range.setEnd(current, start + match[0].length);
        // A match that wraps spans one rect per visual line; mark each.
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.height <= 0 || rect.width <= 0) continue;
          const top = rect.top - articleRect.top;
          const height = rect.height;
          markers.set(`${Math.round(top)}:${Math.round(height)}`, {
            top,
            height,
          });
        }
      }
    }
    current = walker.nextNode();
  }

  return [...markers.values()].sort((a, b) => a.top - b.top);
}
