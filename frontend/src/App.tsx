import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Sidebar } from "./components/Sidebar";
import { MarkdownViewer } from "./components/MarkdownViewer";
import { ThemeToggle } from "./components/ThemeToggle";
import { FontSizeToggle, type FontSize } from "./components/FontSizeToggle";
import { WidthToggle } from "./components/WidthToggle";
import { GroupDropdown } from "./components/GroupDropdown";
import { ViewModeToggle, type ViewMode } from "./components/ViewModeToggle";
import { SearchToggle } from "./components/SearchToggle";
import { TitleToggle } from "./components/TitleToggle";
import { RestartButton } from "./components/RestartButton";
import { DropOverlay } from "./components/DropOverlay";
// react-zoom-pan-pinch is only needed once the user actually zooms an image
// or diagram; loading the modal lazily keeps it out of the initial bundle.
const ZoomModal = lazy(() =>
  import("./components/ZoomModal").then((m) => ({ default: m.ZoomModal })),
);
import type { ZoomContent } from "./components/ZoomModal";
import { TocPanel } from "./components/TocPanel";
import type { TocHeading } from "./components/TocPanel";
import { EmptyGroupMessage } from "./components/EmptyGroupMessage";
import { useSSE } from "./hooks/useSSE";
import { useFileDrop } from "./hooks/useFileDrop";
import { useActiveHeading } from "./hooks/useActiveHeading";
import {
  useScrollRestoration,
  SCROLL_SESSION_KEY,
} from "./hooks/useScrollRestoration";
import type { FileEntry, Group, SearchResult } from "./hooks/useApi";
import {
  fetchGroups,
  fetchSearchResults,
  openRelativeFile,
  removeFile,
  reorderFiles,
} from "./hooks/useApi";
import {
  allFileIds,
  parseGroupFromPath,
  parseFileIdFromSearch,
  parseRelativeOpenFromSearch,
  isSameOriginReferrer,
  groupToPath,
  buildFileUrl,
  sortGroupsForDisplay,
} from "./utils/groups";
import { isMarkdownFile } from "./utils/filetype";
import { formatFileLabel } from "./utils/fileLabel";
import { prefetchRenderers } from "./utils/lazy-render";

const VIEWMODE_STORAGE_KEY = "yome-sidebar-viewmode";
const WIDTH_STORAGE_KEY = "yome-layout-width";
const SHOW_TITLE_STORAGE_KEY = "yome-sidebar-show-title";
export const FONT_SIZE_STORAGE_KEY = "yome-font-size";
export const TOC_OPEN_STORAGE_KEY = "yome-toc-open";

export function getInitialFontSize(): FontSize {
  try {
    const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (
      stored === "small" ||
      stored === "medium" ||
      stored === "large" ||
      stored === "xlarge"
    ) {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return "medium";
}

export function getInitialTocOpenMap(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(TOC_OPEN_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function formatTitle(
  fileEntry: Pick<FileEntry, "name" | "title"> | undefined,
): string {
  if (fileEntry == undefined) return "yome";
  const { name, title } = fileEntry;
  return `${formatFileLabel(name, title)} | yome`;
}

export function isTocOpenForFile(
  map: Record<string, boolean>,
  fileId: string | null,
  fileName: string,
): boolean {
  if (fileId == null) return false;
  if (fileName && !isMarkdownFile(fileName)) return false;
  return map[fileId] === true;
}

export function App() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [firstContentRendered, setFirstContentRendered] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string>(
    () => parseGroupFromPath(window.location.pathname) || "default",
  );
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tocOpenMap, setTocOpenMap] =
    useState<Record<string, boolean>>(getInitialTocOpenMap);
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [contentRevision, setContentRevision] = useState(0);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [pendingSearchHeading, setPendingSearchHeading] = useState<
    string | null
  >(null);
  // Landing directly on a canonical ?file=…#heading URL (shared link, reload)
  // must scroll to the heading once the async content renders — the browser's
  // native hash jump fires before the target element exists.
  const [pendingAnchorId, setPendingAnchorId] = useState<string | null>(() => {
    if (!parseFileIdFromSearch(window.location.search)) return null;
    return window.location.hash.slice(1) || null;
  });
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>(() => {
    try {
      const stored = localStorage.getItem(VIEWMODE_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch {
      /* ignore */
    }
    return {};
  });
  const [showTitles, setShowTitles] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem(SHOW_TITLE_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch {
      /* ignore */
    }
    return {};
  });
  const [isWide, setIsWide] = useState(() => {
    try {
      return localStorage.getItem(WIDTH_STORAGE_KEY) === "wide";
    } catch {
      return false;
    }
  });
  const [fontSize, setFontSize] = useState<FontSize>(getInitialFontSize);
  const knownFileIds = useRef<Set<string>>(new Set());
  const [initialFileId, setInitialFileId] = useState<string | null>(() => {
    const fromUrl = parseFileIdFromSearch(window.location.search);
    if (fromUrl) return fromUrl;
    // Restore active file from scroll context saved before reload
    try {
      const stored = sessionStorage.getItem(SCROLL_SESSION_KEY);
      if (stored) {
        const ctx = JSON.parse(stored);
        if (ctx.url === window.location.pathname && ctx.fileId)
          return ctx.fileId;
      }
    } catch {
      /* ignore */
    }
    return null;
  });
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [zoomContent, setZoomContent] = useState<ZoomContent | null>(null);

  // Track previous values for render-time state adjustment
  const [prevGroups, setPrevGroups] = useState<Group[]>([]);
  const [prevActiveGroup, setPrevActiveGroup] = useState(activeGroup);

  // Adjust derived state during render when groups or activeGroup changes
  if (groups !== prevGroups || activeGroup !== prevActiveGroup) {
    const groupChanged = activeGroup !== prevActiveGroup;
    const isInitialLoad = prevGroups.length === 0 && groups.length > 0;
    setPrevGroups(groups);
    setPrevActiveGroup(activeGroup);

    const group = groups.find((g) => g.name === activeGroup);
    // Auto open/close the sidebar only on initial load or a group switch;
    // background refetches (SSE updates) must not override a manual toggle.
    if (groupChanged || isInitialLoad) {
      setSidebarOpen(group != null && group.files.length >= 2);
    }

    if (groups.length === 0) {
      setActiveFileId(null);
    } else if (!group) {
      setActiveGroup(sortGroupsForDisplay(groups)[0].name);
    } else if (group.files.length === 0) {
      setActiveFileId(null);
    } else if (initialFileId != null) {
      setInitialFileId(null);
      setActiveFileId(
        group.files.some((f) => f.id === initialFileId)
          ? initialFileId
          : group.files[0].id,
      );
    } else {
      setActiveFileId((prev) => {
        if (group.files.some((f) => f.id === prev)) return prev;
        return group.files[0].id;
      });
    }
  }

  // Monotonic sequence for group loads: concurrent fetches (initial load, SSE
  // resync, relative-open refetch) can resolve out of order, and applying a
  // stale response would drop just-added files and roll the selection back.
  // Only the newest call's response is applied.
  const loadSeq = useRef(0);
  const loadGroups = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const data = await fetchGroups();
      if (seq !== loadSeq.current) return;
      const newIds = allFileIds(data);
      const wasEmpty = knownFileIds.current.size === 0;
      const added: string[] = [];
      for (const id of newIds) {
        if (!knownFileIds.current.has(id)) {
          added.push(id);
        }
      }
      knownFileIds.current = newIds;

      setGroups(data);
      setGroupsLoaded(true);

      if (added.length > 0 && !wasEmpty) {
        // Only auto-select if the new file belongs to the current active group
        setActiveGroup((currentGroup) => {
          const group = data.find((g) => g.name === currentGroup);
          if (group) {
            const addedSet = new Set(added);
            const matched = group.files.filter((f) => addedSet.has(f.id));
            if (matched.length > 0) {
              setActiveFileId(matched[matched.length - 1].id);
            }
          }
          return currentGroup;
        });
      }
    } catch {
      // server may not be ready yet
    }
  }, []);

  // A relative Markdown link opened in a new tab lands here with from/open params
  // because the target file has no ID until the server resolves it. Resolve it once
  // on load, then rewrite the URL to the canonical ?file= form (carrying any
  // #fragment along so the section link still lands on its heading).
  const relativeOpen = useRef(
    parseRelativeOpenFromSearch(window.location.search),
  );
  const relativeOpenStarted = useRef(false);

  // Initial data fetch. While a relative-open resolve is pending, the resolve
  // effect below owns the first groups load: fetching here as well would just
  // race it (loadGroups sequencing would discard the stale response anyway).
  useEffect(() => {
    if (relativeOpen.current != null) return;
    loadGroups();
  }, [loadGroups]);

  // Warm the heavyweight renderers (shiki, mermaid, katex, rehype-raw) once
  // the first document has rendered (or the session has no files at all).
  // They are no longer part of the initial bundle, and prefetching must not
  // compete with the critical path — downloading/evaluating them earlier
  // measurably delays the first content paint. Note: "no file selected yet"
  // is not enough (selection lands a frame after groups do); only a truly
  // file-less session skips the render-first condition.
  const prefetchReady =
    firstContentRendered ||
    (groupsLoaded && groups.every((g) => g.files.length === 0));
  useEffect(() => {
    if (!prefetchReady) return;
    return prefetchRenderers();
  }, [prefetchReady]);

  useEffect(() => {
    if (relativeOpenStarted.current) return;
    const rel = relativeOpen.current;
    if (!rel) return;
    relativeOpenStarted.current = true;
    const group = parseGroupFromPath(window.location.pathname);
    // Resolving performs a same-origin, state-mutating POST, so only honor
    // URLs reached from this yome instance itself (modifier/middle-click).
    // A cross-site or referrer-less navigation must not mutate the session —
    // the server's Sec-Fetch-Site guard cannot see the original navigation.
    if (!isSameOriginReferrer(document.referrer, window.location.origin)) {
      relativeOpen.current = null;
      window.history.replaceState(null, "", groupToPath(group));
      loadGroups();
      return;
    }
    const fragment = window.location.hash.slice(1);
    openRelativeFile(group, rel.from, rel.open)
      .then((entry) => {
        relativeOpen.current = null;
        setInitialFileId(entry.id);
        setPendingAnchorId(fragment || null);
        window.history.replaceState(
          null,
          "",
          buildFileUrl(group, entry.id) + (fragment ? `#${fragment}` : ""),
        );
        loadGroups();
        return undefined;
      })
      .catch(() => {
        relativeOpen.current = null;
        window.history.replaceState(null, "", groupToPath(group));
        loadGroups();
      });
  }, [loadGroups]);

  // User-initiated navigation (file/group selection) calls pushState directly at
  // the call site. This effect only reconciles the URL with state for automatic
  // changes (initial mount, SSE updates, render-time fallbacks) via replaceState.
  useEffect(() => {
    // A relative-open resolve is in flight; it owns the URL until it settles.
    if (relativeOpen.current != null) return;
    // initialFileId hasn't been consumed yet — keep the URL as the user landed.
    if (initialFileId != null) return;
    const expectedUrl = activeFileId
      ? buildFileUrl(activeGroup, activeFileId)
      : groupToPath(activeGroup);
    if (window.location.pathname + window.location.search === expectedUrl)
      return;
    window.history.replaceState(null, "", expectedUrl);
  }, [activeGroup, activeFileId, initialFileId]);

  useEffect(() => {
    const handlePopState = () => {
      const fileId = parseFileIdFromSearch(window.location.search);
      setActiveGroup(parseGroupFromPath(window.location.pathname));
      setActiveFileId(fileId);
      // Re-arm the anchor scroll for history entries that carry a hash, so
      // Back/Forward lands on the linked section after the content re-renders.
      setPendingAnchorId(fileId ? window.location.hash.slice(1) || null : null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!searchQuery?.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);

    const timer = setTimeout(() => {
      fetchSearchResults(searchQuery, activeGroup)
        .then((resp) => {
          if (!cancelled) {
            setSearchResults(resp.results);
            setSearchLoading(false);
          }
          return undefined;
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults([]);
            setSearchLoading(false);
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, activeGroup]);

  const activeGroupData = useMemo(
    () => groups.find((g) => g.name === activeGroup),
    [groups, activeGroup],
  );
  const activeFile = useMemo(
    () => activeGroupData?.files.find((f) => f.id === activeFileId),
    [activeGroupData, activeFileId],
  );
  const activeFileName = activeFile?.name ?? "";
  const tocOpen = isTocOpenForFile(tocOpenMap, activeFileId, activeFileName);
  const currentShowTitle: boolean = showTitles[activeGroup] ?? false;

  const setTocOpen = useCallback(
    (open: boolean) => {
      if (activeFileId == null) return;
      setTocOpenMap((prev) => ({ ...prev, [activeFileId]: open }));
    },
    [activeFileId],
  );

  useEffect(() => {
    document.title = formatTitle(activeFile);
  }, [activeFile]);

  useSSE({
    onUpdate: () => {
      loadGroups();
    },
    onFileChanged: (fileId) => {
      setActiveFileId((current) => {
        if (current === fileId) {
          // Only re-render (and capture scroll for restoration) when the
          // change concerns the file on screen; changes to other files must
          // not arm a stale scroll restore.
          captureScrollPosition();
          setContentRevision((r) => r + 1);
        }
        return current;
      });
    },
  });

  const { isDragging } = useFileDrop(activeGroup);

  const currentViewMode: ViewMode = viewModes[activeGroup] ?? "flat";

  useEffect(() => {
    localStorage.setItem(VIEWMODE_STORAGE_KEY, JSON.stringify(viewModes));
  }, [viewModes]);

  useEffect(() => {
    localStorage.setItem(SHOW_TITLE_STORAGE_KEY, JSON.stringify(showTitles));
  }, [showTitles]);

  useEffect(() => {
    try {
      localStorage.setItem(TOC_OPEN_STORAGE_KEY, JSON.stringify(tocOpenMap));
    } catch {
      /* ignore */
    }
  }, [tocOpenMap]);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, isWide ? "wide" : "narrow");
    } catch {
      /* ignore */
    }
  }, [isWide]);

  useEffect(() => {
    try {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize);
    } catch {
      /* ignore */
    }
  }, [fontSize]);

  const handleViewModeToggle = useCallback(() => {
    setViewModes((prev) => {
      const current = prev[activeGroup] ?? "flat";
      const nextMode: ViewMode = current === "flat" ? "tree" : "flat";
      return { ...prev, [activeGroup]: nextMode };
    });
  }, [activeGroup]);

  const handleTitleToggle = useCallback(() => {
    setShowTitles((prev) => ({ ...prev, [activeGroup]: !prev[activeGroup] }));
  }, [activeGroup]);

  const handleSearchToggle = useCallback(() => {
    setSearchQuery((prev) => {
      if (prev != null) return null;
      setSidebarOpen(true);
      return "";
    });
  }, []);

  const handleGroupChange = useCallback(
    (name: string) => {
      // Re-selecting the current group must not blank the viewer or push a
      // duplicate history entry.
      if (name === activeGroup) return;
      window.history.pushState(null, "", groupToPath(name));
      setActiveGroup(name);
      setActiveFileId(null);
    },
    [activeGroup],
  );

  const handleFileSelect = useCallback(
    (fileId: string) => {
      window.history.pushState(null, "", buildFileUrl(activeGroup, fileId));
      setActiveFileId(fileId);
      setPendingSearchHeading(null);
      setPendingAnchorId(null);
    },
    [activeGroup],
  );

  const handleFileOpened = useCallback(
    (fileId: string, anchorId?: string) => {
      const hash = anchorId ? `#${anchorId}` : "";
      window.history.pushState(
        null,
        "",
        buildFileUrl(activeGroup, fileId) + hash,
      );
      setActiveFileId(fileId);
      setPendingSearchHeading(null);
      setPendingAnchorId(anchorId ?? null);
    },
    [activeGroup],
  );

  const handleSearchResultSelect = useCallback(
    (fileId: string, heading?: string) => {
      window.history.pushState(null, "", buildFileUrl(activeGroup, fileId));
      setActiveFileId(fileId);
      setPendingSearchHeading(heading || null);
      setPendingAnchorId(null);
    },
    [activeGroup],
  );

  const handleRemoveFile = useCallback(() => {
    if (activeFileId != null) {
      // On failure, refetch so the sidebar reflects the server's reality.
      removeFile(activeGroup, activeFileId).catch(() => loadGroups());
    }
  }, [activeFileId, activeGroup, loadGroups]);

  const handleFilesReorder = useCallback(
    (groupName: string, fileIds: string[]) => {
      // Optimistic update
      setGroups((prev) =>
        prev.map((g) => {
          if (g.name !== groupName) return g;
          const idToFile = new Map(g.files.map((f) => [f.id, f]));
          const reordered = fileIds
            .map((id) => idToFile.get(id))
            .filter((f): f is NonNullable<typeof f> => f != null);
          return { ...g, files: reordered };
        }),
      );
      // Roll back the optimistic order if the server rejected the reorder.
      reorderFiles(groupName, fileIds).catch(() => loadGroups());
    },
    [loadGroups],
  );

  const headingIds = useMemo(() => headings.map((h) => h.id), [headings]);

  const activeHeadingId = useActiveHeading(headingIds, scrollContainer);

  const { captureScrollPosition, onContentRendered } = useScrollRestoration(
    scrollContainer,
    activeHeadingId,
    activeFileId,
  );

  const handleViewerContentRendered = useCallback(() => {
    setFirstContentRendered(true);
    onContentRendered();
  }, [onContentRendered]);

  const handleHeadingClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  }, []);

  const handleZoom = useCallback((content: ZoomContent) => {
    setZoomContent(content);
  }, []);

  const handleZoomClose = useCallback(() => {
    setZoomContent(null);
  }, []);

  return (
    <div className="flex flex-col h-full font-sans text-gh-text bg-gh-bg">
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 bg-gh-header-bg text-gh-header-text border-b border-gh-header-border">
        <button
          type="button"
          className="flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 cursor-pointer text-gh-header-text transition-colors duration-150 hover:bg-gh-bg-hover"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Sidebar"
          aria-expanded={sidebarOpen}
          title="Toggle sidebar"
        >
          <svg
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
          >
            <rect x="2" y="3" width="20" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
            {sidebarOpen ? (
              <polyline points="6,10 4,12 6,14" />
            ) : (
              <polyline points="5,10 7,12 5,14" />
            )}
          </svg>
        </button>
        <GroupDropdown
          groups={groups}
          activeGroup={activeGroup}
          onGroupChange={handleGroupChange}
        />
        <ViewModeToggle
          viewMode={currentViewMode}
          onToggle={handleViewModeToggle}
        />
        <TitleToggle
          showTitle={currentShowTitle}
          onToggle={handleTitleToggle}
        />
        <SearchToggle
          isOpen={searchQuery != null}
          onToggle={handleSearchToggle}
        />
        <div className="ml-auto flex items-center gap-2">
          <FontSizeToggle fontSize={fontSize} onChange={setFontSize} />
          <WidthToggle isWide={isWide} onToggle={() => setIsWide((v) => !v)} />
          <ThemeToggle />
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <Sidebar
            groups={groups}
            activeGroup={activeGroup}
            activeFileId={activeFileId}
            onFileSelect={handleFileSelect}
            onFilesReorder={handleFilesReorder}
            viewMode={currentViewMode}
            showTitle={currentShowTitle}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            searchResults={searchResults}
            searchLoading={searchLoading}
            onSearchResultSelect={handleSearchResultSelect}
          />
        )}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div
            ref={setScrollContainer}
            className="flex-1 overflow-y-auto overscroll-contain p-8 bg-gh-bg"
          >
            {activeFileId != null ? (
              <MarkdownViewer
                fileId={activeFileId}
                fileName={activeFileName}
                title={activeFile?.title}
                filePath={activeFile?.path}
                scrollContainer={scrollContainer}
                activeGroup={activeGroup}
                revision={contentRevision}
                onFileOpened={handleFileOpened}
                onHeadingsChange={setHeadings}
                onContentRendered={handleViewerContentRendered}
                isTocOpen={tocOpen}
                onTocToggle={() => setTocOpen(!tocOpen)}
                onRemoveFile={handleRemoveFile}
                uploaded={activeFile?.uploaded}
                isWide={isWide}
                fontSize={fontSize}
                onZoom={handleZoom}
                scrollToHeading={pendingSearchHeading}
                onScrolledToHeading={() => setPendingSearchHeading(null)}
                scrollToAnchorId={pendingAnchorId}
                onScrolledToAnchor={() => setPendingAnchorId(null)}
                searchQuery={searchQuery}
              />
            ) : (
              <EmptyGroupMessage group={activeGroupData} />
            )}
          </div>
        </main>
        {tocOpen && (
          <TocPanel
            headings={headings}
            activeHeadingId={activeHeadingId}
            onHeadingClick={handleHeadingClick}
          />
        )}
      </div>
      <RestartButton />
      {isDragging && <DropOverlay />}
      {zoomContent && (
        <Suspense fallback={null}>
          <ZoomModal content={zoomContent} onClose={handleZoomClose} />
        </Suspense>
      )}
    </div>
  );
}
