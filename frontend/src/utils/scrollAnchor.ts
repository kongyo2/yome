// Only one element is held at a time, module-wide: the deep link, history
// traversal and restore paths live in different hooks, and a newer landing must
// replace an older one rather than fight it.
let releaseActive: (() => void) | null = null;

function supportsNativeAnchoring(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("overflow-anchor", "auto")
  );
}

// The landing offset scrollIntoView({ block: "start" }) would use: the
// element's scroll-margin-top, which keeps targets clear of the sticky file
// label bar (see app.css).
function scrollMarginTop(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
}

// Places `el` at `offset` from the top of `sc` (by default where
// scrollIntoView would put it). Where the browser has no scroll anchoring
// (WebKit), it also keeps the element there while content above it changes
// height (Mermaid, images, KaTeX rendering late) until the reader scrolls.
// Elsewhere the browser does that itself, and holding the element from script
// as well would fight it whenever it anchors on a different node.
export function anchorScroll(
  sc: HTMLElement,
  el: HTMLElement,
  offset = scrollMarginTop(el),
): () => void {
  releaseActive?.();

  const position = () =>
    el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  let lastWritten = sc.scrollTop;
  const apply = () => {
    const delta = position() - offset;
    if (Math.abs(delta) < 1) return;
    sc.scrollTop += delta;
    lastWritten = sc.scrollTop;
  };

  apply();
  if (supportsNativeAnchoring()) return () => {};
  // Hold where the element actually landed. Near the end of the document the
  // scroll position is clamped short of `offset`, and chasing it later would
  // move the element when only content below it grows.
  offset = position();

  const content = el.closest("article") ?? sc.firstElementChild;
  const observer =
    content && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (!el.isConnected) {
            release();
            return;
          }
          apply();
        })
      : null;

  // The scroll event is the one signal every way of scrolling produces (wheel,
  // touch, keys, scrollbar drag, find in page), so it decides when the reader
  // has taken over, rather than a list of input events.
  const onScroll = () => {
    if (!el.isConnected) {
      release();
      return;
    }
    if (sc.scrollTop === lastWritten) return;
    // The browser clamped the scroll position after content above the element
    // shrank at the end of the document, and the element stayed where it is held.
    if (Math.abs(position() - offset) < 1) {
      lastWritten = sc.scrollTop;
      return;
    }
    release();
  };

  function release() {
    observer?.disconnect();
    sc.removeEventListener("scroll", onScroll);
    if (releaseActive === release) releaseActive = null;
  }

  if (content) observer?.observe(content);
  sc.addEventListener("scroll", onScroll, { passive: true });
  releaseActive = release;
  return release;
}

function firstVisible(
  parent: Element,
  scTop: number,
  scBottom: number,
): HTMLElement | null {
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (getComputedStyle(child).position === "absolute") continue;
    const rect = child.getBoundingClientRect();
    if (rect.bottom <= scTop) continue;
    // Content comes in document order, so nothing after this is in view either.
    if (rect.top >= scBottom) return null;
    // A block that starts above the view keeps its top when something inside it
    // above the visible part grows, so the visible part is found further down.
    if (rect.top < scTop) return firstVisible(child, scTop, scBottom) ?? child;
    return child;
  }
  return null;
}

// The first element of the article in view, descending into blocks that start
// above it, which is what native scroll anchoring would hold. Absolutely
// positioned elements (the search hit overlay) do not move with the content, so
// they are skipped.
export function visibleTop(
  sc: HTMLElement,
): { el: HTMLElement; offset: number } | null {
  const article = sc.querySelector("article");
  if (!article) return null;
  const { top: scTop, bottom: scBottom } = sc.getBoundingClientRect();
  const el = firstVisible(article, scTop, scBottom);
  return el ? { el, offset: el.getBoundingClientRect().top - scTop } : null;
}
