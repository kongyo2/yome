import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { headingIdFromHash } from "../utils/jumpToHeading";
import { anchorScroll, visibleTop } from "../utils/scrollAnchor";

export const SCROLL_SESSION_KEY = "yome-scroll-context";

interface ScrollContext {
  headingId: string | null;
  relativeOffset: number;
  rawScrollTop: number;
  fileId: string;
  url: string;
}

// A saved position in sessionStorage is not proof of a reload: beforeunload also
// saves it when the tab leaves yome for another site, and it survives until the
// tab comes back. Only a reload or a history traversal returns to the place it
// was saved from.
function isReloadOrHistoryTraversal(): boolean {
  const [nav] = performance.getEntriesByType(
    "navigation",
  ) as PerformanceNavigationTiming[];
  return nav?.type === "reload" || nav?.type === "back_forward";
}

export function useScrollRestoration(
  scrollContainer: HTMLElement | null,
  activeHeadingId: string | null,
  activeFileId: string | null,
) {
  const savedContextRef = useRef<ScrollContext | null>(null);
  const pendingRestoreRef = useRef(false);
  const sessionRestoredRef = useRef(false);
  // Captured at mount because the URL sync in App may rewrite the location (and
  // drop the hash) before the first content render.
  const [initialHash] = useState(() => headingIdFromHash(window.location.hash));

  // Single ref object for stable access in beforeunload and captureScrollPosition
  const latestRef = useRef({ scrollContainer, activeHeadingId, activeFileId });
  useLayoutEffect(() => {
    latestRef.current = { scrollContainer, activeHeadingId, activeFileId };
  });

  const captureScrollPosition = useCallback(() => {
    const {
      scrollContainer: sc,
      activeFileId: fileId,
      activeHeadingId: headingId,
    } = latestRef.current;
    if (!sc || !fileId) return;

    const rawScrollTop = sc.scrollTop;
    let relativeOffset = 0;

    if (headingId) {
      const headingEl = document.getElementById(headingId);
      if (headingEl) {
        relativeOffset =
          headingEl.getBoundingClientRect().top -
          sc.getBoundingClientRect().top;
      }
    }

    const ctx: ScrollContext = {
      headingId,
      relativeOffset,
      rawScrollTop,
      fileId,
      url: window.location.pathname,
    };

    savedContextRef.current = ctx;
    pendingRestoreRef.current = true;

    try {
      sessionStorage.setItem(SCROLL_SESSION_KEY, JSON.stringify(ctx));
    } catch {
      // sessionStorage may be unavailable
    }
  }, []);

  const restoreFromContext = useCallback((ctx: ScrollContext) => {
    const sc = latestRef.current.scrollContainer;
    if (!sc) return;

    const headingEl = ctx.headingId
      ? document.getElementById(ctx.headingId)
      : null;
    if (headingEl) {
      sc.scrollTop +=
        headingEl.getBoundingClientRect().top -
        sc.getBoundingClientRect().top -
        ctx.relativeOffset;
    } else {
      sc.scrollTop = ctx.rawScrollTop;
    }

    // The saved heading is only the one the reader was in, and it is often above
    // the viewport. Hold what is actually on screen instead.
    const top = visibleTop(sc);
    if (top) anchorScroll(sc, top.el, top.offset);
  }, []);

  const onContentRendered = useCallback(() => {
    const fileId = latestRef.current.activeFileId;

    // Path A: React re-render (ref-based)
    if (pendingRestoreRef.current && savedContextRef.current) {
      const ctx = savedContextRef.current;
      if (ctx.fileId === fileId) {
        restoreFromContext(ctx);
      }
      savedContextRef.current = null;
      pendingRestoreRef.current = false;
      try {
        sessionStorage.removeItem(SCROLL_SESSION_KEY);
      } catch {
        // ignore
      }
      return;
    }

    // Path B: Full page reload (sessionStorage-based, one-shot)
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    let restored = false;
    try {
      const stored = sessionStorage.getItem(SCROLL_SESSION_KEY);
      if (stored) {
        const ctx: ScrollContext = JSON.parse(stored);
        sessionStorage.removeItem(SCROLL_SESSION_KEY);
        if (
          ctx.fileId === fileId &&
          ctx.url === window.location.pathname &&
          (!initialHash || isReloadOrHistoryTraversal())
        ) {
          restoreFromContext(ctx);
          restored = true;
        }
      }
    } catch {
      // ignore
    }

    // On a reload the saved position wins over the URL hash. The hash stays in
    // the URL after a table-of-contents click and goes stale as the reader
    // scrolls, so preferring it would undo every reload. A fresh navigation to a
    // deep link still lands on its heading.
    if (!restored && initialHash) {
      const sc = latestRef.current.scrollContainer;
      const headingEl = document.getElementById(initialHash);
      if (sc && headingEl) {
        anchorScroll(sc, headingEl);
      }
    }
  }, [restoreFromContext, initialHash]);

  // Capture scroll position before any page unload
  useEffect(() => {
    window.addEventListener("beforeunload", captureScrollPosition);
    return () =>
      window.removeEventListener("beforeunload", captureScrollPosition);
  }, [captureScrollPosition]);

  return { captureScrollPosition, onContentRendered };
}
