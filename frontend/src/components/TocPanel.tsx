import { useResizablePanel } from "../hooks/useResizablePanel";
import { isPlainLeftClick } from "../utils/linkClick";

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

interface TocPanelProps {
  headings: TocHeading[];
  activeHeadingId: string | null;
  onHeadingClick: (id: string) => void;
}

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 240;
const STORAGE_KEY = "yome-toc-width";

const INDENT: Record<number, string> = {
  1: "pl-3",
  2: "pl-6",
  3: "pl-9",
  4: "pl-12",
  5: "pl-15",
  6: "pl-18",
};

export function TocPanel({
  headings,
  activeHeadingId,
  onHeadingClick,
}: TocPanelProps) {
  const { width, onResizeStart } = useResizablePanel({
    storageKey: STORAGE_KEY,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    defaultWidth: DEFAULT_WIDTH,
    edge: "right",
  });

  return (
    <aside
      className="relative shrink-0 bg-gh-bg-sidebar border-l border-gh-border flex flex-col overflow-y-auto overscroll-contain"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-gh-border active:bg-gh-border transition-colors"
        onMouseDown={onResizeStart}
      />
      <nav className="flex flex-col pb-1">
        {headings.length === 0 ? (
          <div className="px-3 py-2 text-gh-text-secondary text-sm">
            No headings
          </div>
        ) : (
          headings.map((h) => (
            <a
              key={h.id}
              href={`#${h.id}`}
              className={`flex items-center w-full ${INDENT[h.level] ?? "pl-3"} pr-3 py-1.5 border-none cursor-pointer text-left text-sm no-underline transition-colors duration-150 ${
                h.id === activeHeadingId
                  ? "bg-gh-bg-active text-gh-text font-semibold"
                  : "bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover"
              }`}
              onClick={(e) => {
                if (!isPlainLeftClick(e)) return;
                e.preventDefault();
                onHeadingClick(h.id);
              }}
              title={h.text}
              aria-current={h.id === activeHeadingId ? "location" : undefined}
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {h.text}
              </span>
            </a>
          ))
        )}
      </nav>
    </aside>
  );
}
