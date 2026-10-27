import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useScrollRestoration,
  SCROLL_SESSION_KEY,
} from "./useScrollRestoration";

function makeContainer(scrollTop = 0): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true });
  el.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON() {},
  });
  return el;
}

function mockNavigationType(type: NavigationTimingType) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { type } as PerformanceNavigationTiming,
  ]);
}

function addHeading(id: string, topOffset: number) {
  const el = document.createElement("h2");
  el.id = id;
  el.getBoundingClientRect = () => ({
    top: topOffset,
    left: 0,
    right: 800,
    bottom: topOffset + 30,
    width: 800,
    height: 30,
    x: 0,
    y: 0,
    toJSON() {},
  });
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("useScrollRestoration", () => {
  describe("Path A: heading-based restore", () => {
    it("restores scroll position using heading offset", () => {
      const container = makeContainer(400);
      const heading = addHeading("section-3", 120);

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: "section-3" as string | null,
            fileId: "abc" as string | null,
          },
        },
      );

      // Capture current position
      act(() => {
        result.current.captureScrollPosition();
      });

      // Simulate heading moved after re-render (e.g., content changed)
      heading.getBoundingClientRect = () => ({
        top: 150,
        left: 0,
        right: 800,
        bottom: 180,
        width: 800,
        height: 30,
        x: 0,
        y: 0,
        toJSON() {},
      });
      container.scrollTop = 0; // Reset as if re-rendered

      // Trigger restore
      act(() => {
        result.current.onContentRendered();
      });

      // scrollTop should be adjusted: 0 + (150 - 120) = 30
      expect(container.scrollTop).toBe(30);
    });

    it("holds the block on screen rather than the saved heading above it", () => {
      // WebKit: no native scroll anchoring, so the restore holds the position itself.
      vi.stubGlobal("CSS", { supports: () => false });
      let resize: (() => void) | null = null;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            resize = cb;
          }
          observe() {}
          disconnect() {}
        },
      );
      const sc = document.createElement("div");
      const article = document.createElement("article");
      sc.appendChild(article);
      document.body.appendChild(sc);
      sc.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
      // Positions within the content, so their place on screen follows scrollTop.
      const layout = { heading: 1000, block: 1400 };
      const heading = document.createElement("h2");
      heading.id = "section-3";
      heading.getBoundingClientRect = () =>
        ({
          top: layout.heading - sc.scrollTop,
          bottom: layout.heading + 30 - sc.scrollTop,
        }) as DOMRect;
      const block = document.createElement("p");
      block.getBoundingClientRect = () =>
        ({
          top: layout.block - sc.scrollTop,
          bottom: layout.block + 400 - sc.scrollTop,
        }) as DOMRect;
      article.append(heading, block);
      // The reader is deep in the section: its heading is 300px above the viewport.
      sc.scrollTop = 1300;

      const { result } = renderHook(() =>
        useScrollRestoration(sc, "section-3", "abc"),
      );
      act(() => {
        result.current.captureScrollPosition();
      });
      act(() => {
        result.current.onContentRendered();
      });

      // An image between the heading and the visible block finishes loading.
      layout.block += 190;
      resize!();

      expect(block.getBoundingClientRect().top).toBe(100);
    });
  });

  describe("Path A: rawScrollTop fallback", () => {
    it("falls back to rawScrollTop when heading is removed", () => {
      const container = makeContainer(500);
      const heading = addHeading("temp-heading", 200);

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: "temp-heading" as string | null,
            fileId: "abc" as string | null,
          },
        },
      );

      act(() => {
        result.current.captureScrollPosition();
      });

      // Remove the heading (simulates heading deleted from markdown)
      heading.remove();
      container.scrollTop = 0;

      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(500);
    });

    it("uses rawScrollTop when no heading was active", () => {
      const container = makeContainer(300);

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "abc" as string | null,
          },
        },
      );

      act(() => {
        result.current.captureScrollPosition();
      });
      container.scrollTop = 0;

      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(300);
    });
  });

  describe("Path B: sessionStorage restore on reload", () => {
    it("restores from sessionStorage and removes the entry", () => {
      const container = makeContainer(0);

      // Pre-populate sessionStorage as if saved before reload
      const ctx = {
        headingId: null,
        relativeOffset: 0,
        rawScrollTop: 750,
        fileId: "file1",
        url: "/",
      };
      sessionStorage.setItem(SCROLL_SESSION_KEY, JSON.stringify(ctx));

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(750);
      expect(sessionStorage.getItem(SCROLL_SESSION_KEY)).toBeNull();
    });

    it("skips restore when fileId does not match", () => {
      const container = makeContainer(0);

      sessionStorage.setItem(
        SCROLL_SESSION_KEY,
        JSON.stringify({
          headingId: null,
          relativeOffset: 0,
          rawScrollTop: 750,
          fileId: "other-file",
          url: "/",
        }),
      );

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(0);
      expect(sessionStorage.getItem(SCROLL_SESSION_KEY)).toBeNull();
    });

    it("only attempts sessionStorage restore once", () => {
      const container = makeContainer(0);

      sessionStorage.setItem(
        SCROLL_SESSION_KEY,
        JSON.stringify({
          headingId: null,
          relativeOffset: 0,
          rawScrollTop: 400,
          fileId: "file1",
          url: "/",
        }),
      );

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });
      expect(container.scrollTop).toBe(400);

      // Reset and add new sessionStorage entry
      container.scrollTop = 0;
      sessionStorage.setItem(
        SCROLL_SESSION_KEY,
        JSON.stringify({
          headingId: null,
          relativeOffset: 0,
          rawScrollTop: 999,
          fileId: "file1",
          url: "/",
        }),
      );

      // Second call should not restore (one-shot guard)
      act(() => {
        result.current.onContentRendered();
      });
      expect(container.scrollTop).toBe(0);
    });
  });

  describe("URL hash deep link", () => {
    it("scrolls to the heading named in the URL hash on first render", () => {
      window.history.replaceState(null, "", "/#section-3");
      const container = makeContainer(0);
      addHeading("section-3", 120);

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });

      // Heading sits 120px below the container top, so it lands at the top.
      expect(container.scrollTop).toBe(120);
    });

    it("yields to a saved scroll position from a reload of the same file", () => {
      window.history.replaceState(null, "", "/#section-3");
      mockNavigationType("reload");
      const container = makeContainer(0);
      addHeading("section-3", 90);

      sessionStorage.setItem(
        SCROLL_SESSION_KEY,
        JSON.stringify({
          headingId: null,
          relativeOffset: 0,
          rawScrollTop: 750,
          fileId: "file1",
          url: "/",
        }),
      );

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(750);
      expect(sessionStorage.getItem(SCROLL_SESSION_KEY)).toBeNull();
    });

    it("scrolls to the hash on a fresh navigation despite a saved position for the same file", () => {
      window.history.replaceState(null, "", "/#section-3");
      mockNavigationType("navigate");
      const container = makeContainer(0);
      addHeading("section-3", 90);

      sessionStorage.setItem(
        SCROLL_SESSION_KEY,
        JSON.stringify({
          headingId: null,
          relativeOffset: 0,
          rawScrollTop: 750,
          fileId: "file1",
          url: "/",
        }),
      );

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(90);
      expect(sessionStorage.getItem(SCROLL_SESSION_KEY)).toBeNull();
    });

    it("scrolls to the hash when the saved position belongs to another file", () => {
      window.history.replaceState(null, "", "/#section-3");
      const container = makeContainer(0);
      addHeading("section-3", 90);

      sessionStorage.setItem(
        SCROLL_SESSION_KEY,
        JSON.stringify({
          headingId: null,
          relativeOffset: 0,
          rawScrollTop: 750,
          fileId: "other-file",
          url: "/",
        }),
      );

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(90);
    });

    it("applies the hash only on the first render", () => {
      window.history.replaceState(null, "", "/#section-3");
      const container = makeContainer(0);
      addHeading("section-3", 90);

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "file1" as string | null,
          },
        },
      );

      act(() => {
        result.current.onContentRendered();
      });
      expect(container.scrollTop).toBe(90);

      container.scrollTop = 400;
      act(() => {
        result.current.onContentRendered();
      });

      expect(container.scrollTop).toBe(400);
    });
  });

  describe("captureScrollPosition", () => {
    it("writes to sessionStorage", () => {
      const container = makeContainer(250);

      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: container as HTMLElement | null,
            headingId: null as string | null,
            fileId: "abc" as string | null,
          },
        },
      );

      act(() => {
        result.current.captureScrollPosition();
      });

      const stored = sessionStorage.getItem(SCROLL_SESSION_KEY);
      expect(stored).not.toBeNull();
      const ctx = JSON.parse(stored!);
      expect(ctx.rawScrollTop).toBe(250);
      expect(ctx.fileId).toBe("abc");
    });

    it("skips capture when no scroll container", () => {
      const { result } = renderHook(
        ({ sc, headingId, fileId }) =>
          useScrollRestoration(sc, headingId, fileId),
        {
          initialProps: {
            sc: null as HTMLElement | null,
            headingId: null as string | null,
            fileId: "abc" as string | null,
          },
        },
      );

      act(() => {
        result.current.captureScrollPosition();
      });

      expect(sessionStorage.getItem(SCROLL_SESSION_KEY)).toBeNull();
    });
  });
});
