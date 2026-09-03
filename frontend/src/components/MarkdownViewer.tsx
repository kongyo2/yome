import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import { rehypeGithubAlerts } from "rehype-github-alerts";
// oxlint-disable-next-line import/no-unassigned-import
import "katex/dist/katex.min.css";
import { katexMod } from "../utils/lazy-render";
import { fetchFileContent, openRelativeFile } from "../hooks/useApi";
import { isPlainLeftClick } from "../utils/linkClick";
import { RawToggle } from "./RawToggle";
import { TocToggle } from "./TocToggle";
import { CopyButton } from "./CopyButton";
import { CloseFileButton } from "./CloseFileButton";
import { CodeBlock, HighlightedView, RawView } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { ZoomButton } from "./OverlayButton";
import {
  resolveLink,
  resolveImageSrc,
  extractLanguage,
} from "../utils/resolve";
import { buildRelativeOpenUrl } from "../utils/groups";
import { parseFrontmatter } from "../utils/frontmatter";
import {
  rehypeStripClobberPrefix,
  sanitizeSchema,
  stripInlineMarkdown,
  urlTransform,
} from "../utils/markdown";
import { stripMdxSyntax } from "../utils/mdx";
import { isMarkdownFile, detectLanguage } from "../utils/filetype";
import { formatFileLabel } from "../utils/fileLabel";
import {
  collectSearchHitMarkers,
  SEARCH_HIT_COLUMN_OFFSET,
  type SearchHitMarker,
} from "../utils/searchHitMarkers";
import type { ZoomContent } from "./ZoomModal";
import type { TocHeading } from "./TocPanel";
import type { Components } from "react-markdown";
// oxlint-disable-next-line import/no-unassigned-import
import "github-markdown-css/github-markdown.css";
import type { FontSize } from "./FontSizeToggle";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

type KatexPlugin = (typeof import("rehype-katex"))["default"];
// Shared across viewer instances: once rehype-katex has loaded, later math
// documents render synchronously on first paint just like the old static
// import did.
let katexPluginCache: KatexPlugin | null = null;

function scrollTo(target: Element): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({
    behavior: reduced ? "auto" : "smooth",
    block: "start",
  });
}

interface MarkdownViewerProps {
  fileId: string;
  fileName: string;
  title?: string;
  filePath?: string;
  scrollContainer?: HTMLElement | null;
  activeGroup: string;
  revision: number;
  onFileOpened: (fileId: string, anchorId?: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
  isTocOpen: boolean;
  onTocToggle: () => void;
  onRemoveFile: () => void;
  uploaded?: boolean;
  isWide: boolean;
  fontSize: FontSize;
  onZoom?: (content: ZoomContent) => void;
  scrollToHeading?: string | null;
  onScrolledToHeading?: () => void;
  scrollToAnchorId?: string | null;
  onScrolledToAnchor?: () => void;
  searchQuery?: string | null;
}

function FrontmatterBlock({ yaml }: { yaml: string }) {
  return (
    <details open className="mb-4">
      <summary className="cursor-pointer select-none text-gh-text-secondary text-sm font-medium py-1">
        Metadata
      </summary>
      <div className="mt-2">
        <CodeBlock language="yaml" code={yaml} />
      </div>
    </details>
  );
}

export function MarkdownViewer({
  fileId,
  fileName,
  title,
  filePath,
  scrollContainer,
  activeGroup,
  revision,
  onFileOpened,
  onHeadingsChange,
  onContentRendered,
  isTocOpen,
  onTocToggle,
  onRemoveFile,
  uploaded,
  isWide,
  fontSize,
  onZoom,
  scrollToHeading,
  onScrolledToHeading,
  scrollToAnchorId,
  onScrolledToAnchor,
  searchQuery,
}: MarkdownViewerProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [isRawView, setIsRawView] = useState(false);
  const [searchHitMarkers, setSearchHitMarkers] = useState<SearchHitMarker[]>(
    [],
  );
  // The sticky bar shows the file name only while the document's own title is on
  // screen (so it never duplicates it), then folds the title into the label once
  // that heading scrolls up behind the bar.
  const [showFullLabel, setShowFullLabel] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const stickyLabelRef = useRef<HTMLDivElement>(null);
  const [prevFetchKey, setPrevFetchKey] = useState({
    activeGroup,
    fileId,
    revision,
  });

  // Any change to the fetch inputs (group, file, revision) re-enters the
  // loading state so stale content is never shown for the new key.
  if (
    activeGroup !== prevFetchKey.activeGroup ||
    fileId !== prevFetchKey.fileId ||
    revision !== prevFetchKey.revision
  ) {
    setPrevFetchKey({ activeGroup, fileId, revision });
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    fetchFileContent(activeGroup, fileId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setLoading(false);
        }
        return undefined;
      })
      .catch(() => {
        if (!cancelled) {
          setContent("Failed to load file.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeGroup, fileId, revision]);

  const handleLinkClick = useCallback(
    async (
      e: React.MouseEvent<HTMLAnchorElement>,
      href: string,
      fragment?: string,
    ) => {
      e.preventDefault();
      try {
        const entry = await openRelativeFile(activeGroup, fileId, href);
        onFileOpened(entry.id, fragment);
      } catch {
        // fallback: do nothing
      }
    },
    [activeGroup, fileId, onFileOpened],
  );

  // react-markdown passes the hast `node` to custom renderers; it must be
  // destructured away so it is not spread onto DOM elements.
  const components: Components = useMemo(
    () => ({
      pre: ({ children }) => <>{children}</>,
      code: ({ node: _node, className, children, ...props }) => {
        const language = extractLanguage(className);
        const code = String(children).replace(/\n$/, "");
        const isBlock = String(children).endsWith("\n");
        if (language) {
          if (language === "mermaid") {
            return <MermaidBlock code={code} onZoom={onZoom} />;
          }
          return <CodeBlock language={language} code={code} />;
        }
        if (isBlock) {
          return <CodeBlock language="text" code={code} />;
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
      img: ({ node: _node, src, alt, ...props }) => {
        const resolvedSrc = resolveImageSrc(src, activeGroup, fileId);
        if (onZoom && resolvedSrc) {
          return (
            <span className="relative inline-block group/img">
              <img src={resolvedSrc} alt={alt} {...props} />
              <ZoomButton
                onClick={() =>
                  onZoom({
                    type: "image",
                    src: resolvedSrc,
                    alt: alt ?? undefined,
                  })
                }
                position="right-1 top-2"
                groupClass="group-hover/img:opacity-100"
              />
            </span>
          );
        }
        return <img src={resolvedSrc} alt={alt} {...props} />;
      },
      a: ({ node: _node, href, children, ...props }) => {
        const resolved = resolveLink(href, activeGroup, fileId);
        switch (resolved.type) {
          case "external":
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          case "hash":
            return (
              <a
                href={href}
                onClick={(e) => {
                  if (!isPlainLeftClick(e)) return;
                  const id = href?.slice(1);
                  if (!id) return;
                  const target = document.getElementById(id);
                  if (target) {
                    e.preventDefault();
                    scrollTo(target);
                    history.pushState(null, "", href);
                  }
                }}
                {...props}
              >
                {children}
              </a>
            );
          case "markdown":
            return (
              <a
                href={buildRelativeOpenUrl(
                  activeGroup,
                  fileId,
                  resolved.hrefPath,
                  resolved.fragment,
                )}
                onClick={(e) => {
                  // Modifier / middle clicks fall through so the browser opens the
                  // self-resolving href in a new tab (App resolves it on load); only a
                  // plain click navigates in place.
                  if (!isPlainLeftClick(e)) return;
                  handleLinkClick(e, resolved.hrefPath, resolved.fragment);
                }}
                {...props}
              >
                {children}
              </a>
            );
          case "file":
            return (
              <a href={resolved.rawUrl} {...props}>
                {children}
              </a>
            );
          case "passthrough":
            return (
              <a href={href} {...props}>
                {children}
              </a>
            );
        }
      },
    }),
    [activeGroup, fileId, handleLinkClick, onZoom],
  );

  // An empty fileName means the entry is not in the groups list yet (e.g. a
  // file just opened via a relative link, before the SSE refetch lands).
  // Default to markdown rendering rather than flashing raw text.
  const isMarkdown = fileName === "" || isMarkdownFile(fileName);
  const codeLanguage = isMarkdown ? null : detectLanguage(fileName);

  // rehype-katex (and the katex library under it) loads on demand.
  // remark-math only produces math nodes for `$`-delimited input, which
  // requires at least two `$` characters — documents below that threshold
  // (including a lone shell-prompt `$`) render identically with the plugin
  // omitted. Documents that may need it hold the loading state until the
  // plugin is in (no flash of raw TeX).
  const firstDollar = content.indexOf("$");
  const needsMath =
    isMarkdown &&
    !isRawView &&
    firstDollar !== -1 &&
    content.indexOf("$", firstDollar + 1) !== -1;
  const [katexPlugin, setKatexPlugin] = useState<KatexPlugin | null>(
    katexPluginCache,
  );
  const [katexFailed, setKatexFailed] = useState(false);
  useEffect(() => {
    if (!needsMath || katexPlugin) return;
    let cancelled = false;
    katexMod()
      .then((m) => {
        katexPluginCache = m.default;
        if (!cancelled) setKatexPlugin(() => m.default);
        return undefined;
      })
      .catch(() => {
        // Render without math support rather than hanging in Loading.
        if (!cancelled) setKatexFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsMath, katexPlugin]);
  const mathReady = !needsMath || katexPlugin != null || katexFailed;

  // Treat "math plugin still loading" exactly like content loading so none
  // of the render-completion side effects (scroll restore, ToC, markers)
  // fire against an intermediate render missing the plugin.
  const showLoading = loading || !mathReady;

  const parsed = useMemo(
    () => (isMarkdown && !isRawView ? parseFrontmatter(content) : null),
    [content, isRawView, isMarkdown],
  );

  const renderedContent = useMemo(() => {
    if (!isMarkdown) {
      return <HighlightedView content={content} language={codeLanguage!} />;
    }
    if (isRawView) {
      return <RawView content={content} />;
    }
    if (needsMath && !katexPlugin && !katexFailed) {
      // Math plugin still loading; showLoading covers this frame.
      return null;
    }
    const base = parsed ? parsed.content : content;
    const md = fileName.toLowerCase().endsWith(".mdx")
      ? stripMdxSyntax(base)
      : base;
    return (
      <>
        {parsed && <FrontmatterBlock yaml={parsed.yaml} />}
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[
            rehypeRaw,
            rehypeStripClobberPrefix,
            [rehypeSanitize, sanitizeSchema],
            rehypeGithubAlerts,
            rehypeSlug,
            ...(needsMath && katexPlugin ? [katexPlugin] : []),
          ]}
          components={components}
          urlTransform={urlTransform}
        >
          {md}
        </Markdown>
      </>
    );
  }, [
    content,
    isRawView,
    isMarkdown,
    codeLanguage,
    parsed,
    components,
    fileName,
    needsMath,
    katexPlugin,
    katexFailed,
  ]);

  const prevHeadingsKey = useRef("");
  useEffect(() => {
    const newHeadings: TocHeading[] = [];
    if (!isRawView && articleRef.current) {
      for (const el of articleRef.current.querySelectorAll(HEADING_SELECTOR)) {
        if (el.id) {
          newHeadings.push({
            id: el.id,
            text: el.textContent ?? "",
            level: parseInt(el.tagName.slice(1), 10),
          });
        }
      }
    }
    const key = newHeadings
      .map((h) => `${h.id}:${h.level}:${h.text}`)
      .join(",");
    if (key !== prevHeadingsKey.current) {
      prevHeadingsKey.current = key;
      onHeadingsChange(newHeadings);
    }
  }, [isRawView, renderedContent, onHeadingsChange]);

  const onContentRenderedRef = useRef(onContentRendered);
  useLayoutEffect(() => {
    onContentRenderedRef.current = onContentRendered;
  });

  useLayoutEffect(() => {
    if (!showLoading) {
      onContentRenderedRef.current?.();
    }
  }, [showLoading, renderedContent]);

  useLayoutEffect(() => {
    if (showLoading || !scrollToHeading || !articleRef.current) {
      return;
    }

    // The server sends the raw markdown heading text; the DOM contains the
    // rendered text (inline markup stripped). Normalize both for comparison.
    const wanted = stripInlineMarkdown(scrollToHeading);
    const headings = articleRef.current.querySelectorAll(HEADING_SELECTOR);
    const target = Array.from(headings).find(
      (el) => (el.textContent ?? "").trim() === wanted,
    );
    if (target) scrollTo(target);
    // Always consume the pending heading so it cannot scroll a file opened
    // later by coincidence of matching text.
    onScrolledToHeading?.();
  }, [showLoading, renderedContent, scrollToHeading, onScrolledToHeading]);

  // Cross-file links may carry a fragment (api.md#auth). Once the target file
  // has rendered, scroll to the matching element id (rehype-slug ids for
  // headings, footnote ids, etc.).
  useLayoutEffect(() => {
    if (showLoading || !scrollToAnchorId || !articleRef.current) {
      return;
    }
    let target = document.getElementById(scrollToAnchorId);
    if (!target) {
      // Authors may percent-encode non-ASCII fragments; try the decoded form.
      try {
        target = document.getElementById(decodeURIComponent(scrollToAnchorId));
      } catch {
        /* malformed encoding — give up */
      }
    }
    if (target) scrollTo(target);
    // Always consume the pending anchor so it cannot scroll a file rendered
    // later by coincidence of a matching id.
    onScrolledToAnchor?.();
  }, [showLoading, renderedContent, scrollToAnchorId, onScrolledToAnchor]);

  useLayoutEffect(() => {
    if (
      showLoading ||
      !articleRef.current ||
      !isMarkdown ||
      isRawView ||
      !searchQuery?.trim()
    ) {
      setSearchHitMarkers([]);
      return;
    }

    const updateMarkers = () => {
      if (!articleRef.current) {
        return;
      }
      setSearchHitMarkers(
        collectSearchHitMarkers(articleRef.current, searchQuery),
      );
    };

    updateMarkers();

    const resizeObserver = new ResizeObserver(() => updateMarkers());
    resizeObserver.observe(articleRef.current);
    for (const element of articleRef.current.querySelectorAll("img, svg")) {
      resizeObserver.observe(element);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [showLoading, renderedContent, isMarkdown, isRawView, searchQuery]);

  useEffect(() => {
    const article = articleRef.current;
    const label = stickyLabelRef.current;
    if (showLoading || !scrollContainer || !article || !label) {
      setShowFullLabel(false);
      return;
    }
    // The first heading is stable for this render, so query it once and reuse it
    // across scroll/resize updates instead of re-querying on every frame.
    const heading = article.querySelector(HEADING_SELECTOR);
    if (!heading) {
      // Nothing to fold in: the label is already just the file name.
      setShowFullLabel(false);
      return;
    }
    // Fold the title into the label once that heading scrolls up behind the
    // sticky bar. A direct geometry read avoids the IntersectionObserver
    // first-callback race that can latch a stale rect when content mounts.
    let frame = 0;
    const update = () => {
      frame = 0;
      setShowFullLabel(
        heading.getBoundingClientRect().bottom <=
          label.getBoundingClientRect().bottom,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    scrollContainer.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scrollContainer.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
    // isWide/fontSize/isTocOpen change the layout, so recompute on those too.
  }, [
    showLoading,
    renderedContent,
    scrollContainer,
    isWide,
    fontSize,
    isTocOpen,
  ]);

  if (showLoading) {
    return (
      <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        {/* Always-visible sticky label. The negative top cancels the scroll
            container's p-8 top padding so the bar pins flush under the global
            header instead of leaving a gap that scrolling content would show
            through. */}
        <div
          ref={stickyLabelRef}
          className={`sticky -top-8 z-20 mx-auto mb-4 border-b border-gh-border bg-gh-bg py-2 text-sm font-medium text-right text-gh-text-secondary overflow-hidden text-ellipsis whitespace-nowrap${isWide ? "" : " max-w-[980px]"}`}
          title={!uploaded && filePath ? filePath : fileName}
        >
          {showFullLabel ? formatFileLabel(fileName, title) : fileName}
        </div>
        <article
          ref={articleRef}
          className={`markdown-body relative overflow-visible${isWide ? " markdown-body--wide" : ""}${fontSize !== "medium" ? ` markdown-body--${fontSize}` : ""}`}
        >
          <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
            {searchHitMarkers.map((marker, index) => (
              <div
                key={`${marker.top}:${marker.height}:${index}`}
                className="absolute w-1 rounded-none bg-gh-text/80"
                style={{
                  left: SEARCH_HIT_COLUMN_OFFSET,
                  top: marker.top,
                  height: marker.height,
                }}
              />
            ))}
          </div>
          {renderedContent}
        </article>
      </div>
      <div className="shrink-0 flex flex-col gap-2 -mr-4 -mt-4 sticky -top-4">
        {isMarkdown && (
          <TocToggle isTocOpen={isTocOpen} onToggle={onTocToggle} />
        )}
        {isMarkdown && (
          <RawToggle
            isRaw={isRawView}
            onToggle={() => setIsRawView((v) => !v)}
          />
        )}
        <CopyButton content={content} />
        <CloseFileButton onClose={onRemoveFile} uploaded={uploaded} />
      </div>
    </div>
  );
}
