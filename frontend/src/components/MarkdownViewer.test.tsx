import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MarkdownViewer } from "./MarkdownViewer";
import { fetchFileContent, openRelativeFile } from "../hooks/useApi";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

vi.mock("../hooks/useApi", () => ({
  fetchFileContent: vi
    .fn()
    .mockResolvedValue({ content: "# Hello", baseDir: "/repo" }),
  openRelativeFile: vi.fn(),
}));

// jsdom has no layout, so stub getBoundingClientRect: the scroll container and
// the sticky bar sit at the top, and the heading goes wherever a test wants it.
let scrollContainer: HTMLElement;
let headingRect: { top: number; bottom: number };
const barRect = { top: 0, bottom: 37 };
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
  } as DOMRect;
}

function renderViewer(
  props: Partial<Parameters<typeof MarkdownViewer>[0]> = {},
) {
  return render(
    <MarkdownViewer
      fileId="aaa11111"
      fileName="README.md"
      activeGroup="default"
      revision={0}
      scrollContainer={scrollContainer}
      onFileOpened={() => {}}
      onHeadingsChange={() => {}}
      isTocOpen={false}
      onTocToggle={() => {}}
      onRemoveFile={() => {}}
      isWide={false}
      fontSize="medium"
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  scrollContainer = document.createElement("div");
  headingRect = { top: 100, bottom: 150 }; // on screen by default
  Element.prototype.getBoundingClientRect = function () {
    if (this === scrollContainer) return rect(0, 800);
    // The sticky bar is the only div carrying a title attribute.
    if (this.tagName === "DIV" && this.hasAttribute("title"))
      return rect(barRect.top, barRect.bottom);
    if (/^H[1-6]$/.test(this.tagName))
      return rect(headingRect.top, headingRect.bottom);
    return rect(0, 0);
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

describe("MarkdownViewer file label", () => {
  it("shows the file name alone while the title is on screen", async () => {
    headingRect = { top: 100, bottom: 150 };
    renderViewer({
      title: "Project Readme",
      filePath: "/home/me/code/yome/docs/README.md",
    });

    const label = await screen.findByTitle("/home/me/code/yome/docs/README.md");
    expect(label.textContent).toBe("README.md");
    // The label must not be part of the rendered markdown content.
    expect(label.closest(".markdown-body")).toBeNull();
  });

  it("folds the title in once the heading scrolls behind the bar", async () => {
    headingRect = { top: -50, bottom: -10 };
    renderViewer({
      title: "Project Readme",
      filePath: "/home/me/code/yome/docs/README.md",
    });

    const label = await screen.findByTitle("/home/me/code/yome/docs/README.md");
    // The folded text is applied by the post-render geometry effect.
    await waitFor(() =>
      expect(label.textContent).toBe("Project Readme - README.md"),
    );
  });

  it("keeps just the file name when the file has no title", async () => {
    headingRect = { top: -50, bottom: -10 };
    renderViewer({ filePath: "/home/me/code/yome/docs/README.md" });

    const label = await screen.findByTitle("/home/me/code/yome/docs/README.md");
    expect(label.textContent).toBe("README.md");
  });

  it("uses the file name as the tooltip for uploaded files", async () => {
    headingRect = { top: -50, bottom: -10 };
    renderViewer({ title: "Pasted", uploaded: true });

    const label = await screen.findByTitle("README.md");
    await waitFor(() => expect(label.textContent).toBe("Pasted - README.md"));
  });

  it("right-aligns the label text", async () => {
    renderViewer({
      title: "Project Readme",
      filePath: "/home/me/code/yome/docs/README.md",
    });

    const label = await screen.findByTitle("/home/me/code/yome/docs/README.md");
    expect(label).toHaveClass("text-right");
  });
});

describe("MarkdownViewer images", () => {
  const pngDataUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

  it("renders a data:image URI through the sanitizer unchanged", async () => {
    vi.mocked(fetchFileContent).mockResolvedValue({
      content: `![embedded](${pngDataUri})`,
      baseDir: "/repo",
    });
    renderViewer();
    const img = await screen.findByRole("img", { name: "embedded" });
    expect(img).toHaveAttribute("src", pngDataUri);
  });

  it("does not render a non-image data: URI as an image source", async () => {
    vi.mocked(fetchFileContent).mockResolvedValue({
      content: "![bad](data:text/html,<script>alert(1)</script>)",
      baseDir: "/repo",
    });
    renderViewer();
    const img = await screen.findByRole("img", { name: "bad" });
    expect(img).not.toHaveAttribute("src");
  });

  it("rewrites a relative image src to the raw API path", async () => {
    vi.mocked(fetchFileContent).mockResolvedValue({
      content: "![diagram](images/diagram.png)",
      baseDir: "/repo",
    });
    renderViewer();
    const img = await screen.findByRole("img", { name: "diagram" });
    expect(img).toHaveAttribute(
      "src",
      "/_/api/groups/default/files/aaa11111/raw/images/diagram.png",
    );
  });
});

describe("MarkdownViewer relative links", () => {
  beforeEach(() => {
    vi.mocked(fetchFileContent).mockResolvedValue({
      content: "[Next page](next.md)",
      baseDir: "/repo",
    });
    vi.mocked(openRelativeFile).mockResolvedValue({
      id: "bbb22222",
      name: "next.md",
      path: "/repo/next.md",
    });
  });

  it("points the href at a self-resolving relative-open URL", async () => {
    renderViewer();
    const link = await screen.findByRole("link", { name: "Next page" });
    expect(link).toHaveAttribute("href", "/?from=aaa11111&open=next.md");
  });

  it("opens in place on a plain click", async () => {
    const onFileOpened = vi.fn();
    renderViewer({ onFileOpened });
    const link = await screen.findByRole("link", { name: "Next page" });

    const notPrevented = fireEvent.click(link);

    expect(notPrevented).toBe(false); // preventDefault was called
    await waitFor(() =>
      expect(onFileOpened).toHaveBeenCalledWith("bbb22222", undefined),
    );
    expect(openRelativeFile).toHaveBeenCalledWith(
      "default",
      "aaa11111",
      "next.md",
    );
  });

  it("lets the browser handle a Cmd/Ctrl click natively", async () => {
    const onFileOpened = vi.fn();
    renderViewer({ onFileOpened });
    const link = await screen.findByRole("link", { name: "Next page" });

    const notPrevented = fireEvent.click(link, { metaKey: true });

    expect(notPrevented).toBe(true); // default preserved → new browser tab
    expect(openRelativeFile).not.toHaveBeenCalled();
    expect(onFileOpened).not.toHaveBeenCalled();
  });

  it("carries a fragment through the href and in-place open", async () => {
    vi.mocked(fetchFileContent).mockResolvedValue({
      content: "[Auth](api.md#auth)",
      baseDir: "/repo",
    });
    vi.mocked(openRelativeFile).mockResolvedValue({
      id: "ccc33333",
      name: "api.md",
      path: "/repo/api.md",
    });
    const onFileOpened = vi.fn();
    renderViewer({ onFileOpened });
    const link = await screen.findByRole("link", { name: "Auth" });

    // The self-resolving href keeps the section for new-tab opens.
    expect(link).toHaveAttribute("href", "/?from=aaa11111&open=api.md#auth");

    // An in-place click forwards the anchor so App can scroll to it.
    fireEvent.click(link);
    await waitFor(() =>
      expect(onFileOpened).toHaveBeenCalledWith("ccc33333", "auth"),
    );
    expect(openRelativeFile).toHaveBeenCalledWith(
      "default",
      "aaa11111",
      "api.md",
    );
  });
});

describe("MarkdownViewer anchor scrolling", () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("scrolls to the fragment target and consumes it once rendered", async () => {
    vi.mocked(fetchFileContent).mockResolvedValue({
      content: "# Hello\n\n## Auth\n\nbody",
      baseDir: "/repo",
    });
    const scrolled = vi.fn();
    renderViewer({ scrollToAnchorId: "auth", onScrolledToAnchor: scrolled });

    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    // rehype-slug gives the "## Auth" heading id="auth"; it must be the target.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const target = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(target.id).toBe("auth");
  });

  it("consumes a fragment with no matching target without scrolling", async () => {
    vi.mocked(fetchFileContent).mockResolvedValue({
      content: "# Hello",
      baseDir: "/repo",
    });
    const scrolled = vi.fn();
    renderViewer({
      scrollToAnchorId: "does-not-exist",
      onScrolledToAnchor: scrolled,
    });

    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
