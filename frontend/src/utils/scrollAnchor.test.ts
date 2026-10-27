import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { anchorScroll, visibleTop } from "./scrollAnchor";

let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  private callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    resizeCallbacks.push(this.callback);
  }
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback);
  }
}

function resize() {
  for (const cb of resizeCallbacks) cb();
}

// A scroller whose heading sits `headingTop` pixels into the content, so its
// position in the viewport follows scrollTop the way real layout does.
function setup(initialHeadingTop: number) {
  const sc = document.createElement("div");
  const article = document.createElement("article");
  const heading = document.createElement("h2");
  article.appendChild(heading);
  sc.appendChild(article);
  document.body.appendChild(sc);
  const layout = { headingTop: initialHeadingTop };
  sc.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  heading.getBoundingClientRect = () =>
    ({ top: layout.headingTop - sc.scrollTop }) as DOMRect;
  const offset = () =>
    heading.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  // jsdom has no layout, so the end of the document is modelled as a cap.
  let maxScroll = Infinity;
  let scrollTop = 0;
  Object.defineProperty(sc, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.min(v, maxScroll);
    },
  });
  const limitScroll = (max: number) => {
    maxScroll = max;
  };
  const scrollBy = (delta: number) => {
    sc.scrollTop += delta;
    sc.dispatchEvent(new Event("scroll"));
  };
  return { sc, heading, layout, offset, scrollBy, limitScroll };
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  // WebKit, which has no scroll anchoring, unless a test says otherwise.
  vi.stubGlobal("CSS", { supports: () => false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("anchorScroll", () => {
  it("places the element at the offset", () => {
    const { sc, heading, offset } = setup(500);

    anchorScroll(sc, heading, 40);

    expect(offset()).toBe(40);
  });

  it("lands where scrollIntoView would, below the element's scroll margin", () => {
    const { sc, heading, offset } = setup(500);
    heading.style.scrollMarginTop = "48px";

    anchorScroll(sc, heading);

    expect(offset()).toBe(48);
  });

  it("keeps the element in place when content above it grows", () => {
    const { sc, heading, layout, offset } = setup(500);
    anchorScroll(sc, heading);

    layout.headingTop += 190;
    resize();

    expect(sc.scrollTop).toBe(690);
    expect(offset()).toBe(0);
  });

  it("ignores the scroll event caused by its own adjustment", () => {
    const { sc, heading, layout, offset } = setup(500);
    anchorScroll(sc, heading);

    layout.headingTop += 190;
    resize();
    sc.dispatchEvent(new Event("scroll"));
    layout.headingTop += 100;
    resize();

    expect(offset()).toBe(0);
  });

  it("lets go once the reader scrolls", () => {
    const { sc, heading, layout, offset, scrollBy } = setup(500);
    anchorScroll(sc, heading);

    scrollBy(-120);
    layout.headingTop += 190;
    resize();

    expect(offset()).toBe(310);
  });

  it("only places the element where the browser anchors scrolling itself", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const { sc, heading, layout, offset } = setup(500);

    anchorScroll(sc, heading);
    expect(offset()).toBe(0);

    layout.headingTop += 190;
    resize();

    expect(resizeCallbacks).toHaveLength(0);
    expect(offset()).toBe(190);
  });

  it("releases the previous element when a new one is anchored", () => {
    const first = setup(500);
    const second = setup(800);
    anchorScroll(first.sc, first.heading);
    anchorScroll(second.sc, second.heading);

    first.layout.headingTop += 190;
    resize();

    expect(first.offset()).toBe(190);
    expect(second.offset()).toBe(0);
  });

  it("lets go when the element leaves the document", () => {
    const { sc, heading, layout } = setup(500);
    anchorScroll(sc, heading);

    heading.remove();
    layout.headingTop += 190;
    resize();

    expect(sc.scrollTop).toBe(500);
  });

  it("holds a clamped landing where it ended up rather than chasing the offset", () => {
    const { sc, heading, offset, limitScroll } = setup(800);
    // The document end stops the scroll 300px short of the requested position.
    limitScroll(500);
    anchorScroll(sc, heading);
    expect(offset()).toBe(300);

    // Content below the heading grows, which lifts the limit without moving it.
    limitScroll(Infinity);
    resize();

    expect(offset()).toBe(300);
  });

  it("keeps holding when the browser clamps the scroll after content above shrinks", () => {
    const { sc, heading, layout, offset, limitScroll } = setup(500);
    anchorScroll(sc, heading);

    // At the end of the document, content above shrinks by 100 and the scroll
    // range with it, so the browser clamps scrollTop and the heading stays put.
    layout.headingTop -= 100;
    limitScroll(400);
    sc.scrollTop = 500;
    sc.dispatchEvent(new Event("scroll"));
    limitScroll(Infinity);
    layout.headingTop += 190;
    resize();

    expect(offset()).toBe(0);
  });

  it("stops holding when released by its caller", () => {
    const { sc, heading, layout, offset } = setup(500);
    const release = anchorScroll(sc, heading);

    release();
    layout.headingTop += 190;
    resize();

    expect(offset()).toBe(190);
  });
});

describe("visibleTop", () => {
  function block(
    article: HTMLElement,
    top: number,
    bottom: number,
    absolute = false,
  ) {
    const el = document.createElement("div");
    if (absolute) el.style.position = "absolute";
    el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
    article.appendChild(el);
    return el;
  }

  function scroller() {
    const sc = document.createElement("div");
    const article = document.createElement("article");
    sc.appendChild(article);
    document.body.appendChild(sc);
    sc.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    return { sc, article };
  }

  it("returns the first block that reaches into view with its offset", () => {
    const { sc, article } = scroller();
    block(article, -400, 40);
    const visible = block(article, 40, 300);

    expect(visibleTop(sc)).toEqual({ el: visible, offset: -60 });
  });

  it("skips absolutely positioned overlays", () => {
    const { sc, article } = scroller();
    block(article, -2000, 3000, true);
    const visible = block(article, 150, 300);

    expect(visibleTop(sc)).toEqual({ el: visible, offset: 50 });
  });

  it("descends into a block that starts above the view", () => {
    const { sc, article } = scroller();
    const list = block(article, -500, 900);
    block(list, -500, -100);
    const visible = block(list, -100, 300);

    expect(visibleTop(sc)).toEqual({ el: visible, offset: -200 });
  });

  it("keeps the visible item in place when an earlier item in the same list grows", () => {
    const sc = document.createElement("div");
    const article = document.createElement("article");
    const list = document.createElement("ul");
    const earlier = document.createElement("li");
    const visible = document.createElement("li");
    list.append(earlier, visible);
    article.appendChild(list);
    sc.appendChild(article);
    document.body.appendChild(sc);
    // Positions within the content, so their place on screen follows scrollTop.
    // The earlier item ends above the view; the visible one straddles its top.
    const layout = { split: 1200 };
    sc.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    list.getBoundingClientRect = () =>
      ({
        top: 1000 - sc.scrollTop,
        bottom: layout.split + 600 - sc.scrollTop,
      }) as DOMRect;
    earlier.getBoundingClientRect = () =>
      ({
        top: 1000 - sc.scrollTop,
        bottom: layout.split - sc.scrollTop,
      }) as DOMRect;
    visible.getBoundingClientRect = () =>
      ({
        top: layout.split - sc.scrollTop,
        bottom: layout.split + 600 - sc.scrollTop,
      }) as DOMRect;
    sc.scrollTop = 1300;

    const top = visibleTop(sc)!;
    expect(top.el).toBe(visible);
    anchorScroll(sc, top.el, top.offset);
    // An image in the earlier item finishes loading.
    layout.split += 190;
    resize();

    expect(visible.getBoundingClientRect().top).toBe(-100);
  });

  it("keeps a straddling block when nothing inside it is in view", () => {
    const { sc, article } = scroller();
    const paragraph = block(article, -200, 2000);
    // An inline link further down the same paragraph, below the view.
    block(paragraph, 900, 920);

    expect(visibleTop(sc)).toEqual({ el: paragraph, offset: -300 });
  });

  it("returns null without an article", () => {
    const sc = document.createElement("div");
    document.body.appendChild(sc);

    expect(visibleTop(sc)).toBeNull();
  });
});
