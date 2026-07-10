import { useCallback, useEffect, useRef, useState } from "react";
import type { Group } from "../hooks/useApi";
import { sortGroupsForDisplay } from "../utils/groups";

interface GroupDropdownProps {
  groups: Group[];
  activeGroup: string;
  onGroupChange: (name: string) => void;
}

export function GroupDropdown({
  groups,
  activeGroup,
  onGroupChange,
}: GroupDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const listRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const updateScrollIndicators = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 0);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(updateScrollIndicators);
    }
  }, [open, updateScrollIndicators]);

  const isDefault = activeGroup === "default";
  const activeGroupExists = groups.some((g) => g.name === activeGroup);

  if (groups.length === 0) return null;

  // Single group and it's the active one: show name only (no dropdown)
  if (groups.length === 1 && activeGroupExists) {
    if (isDefault) return null;
    return (
      <span className="text-sm text-gh-header-text font-bold">
        {activeGroup}
      </span>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        className="flex items-center gap-1.5 bg-transparent border border-gh-border rounded-md p-1.5 cursor-pointer text-sm text-gh-header-text hover:bg-gh-bg-hover transition-colors duration-150"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className="size-5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
        >
          <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
        </svg>
        {!isDefault && (
          <span className="overflow-hidden text-ellipsis whitespace-nowrap max-w-32 font-bold">
            {activeGroup}
          </span>
        )}
        <svg
          className="size-3 shrink-0"
          fill="currentColor"
          viewBox="0 0 12 12"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5z" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 min-w-40 bg-gh-bg-sidebar border border-gh-border rounded-md shadow-lg z-30 flex flex-col">
          {canScrollUp && (
            <div className="flex justify-center py-0.5 text-gh-text-secondary border-b border-gh-border">
              <svg className="size-3" fill="currentColor" viewBox="0 0 12 12">
                <path d="M9.5 7.5 6 4 2.5 7.5z" />
              </svg>
            </div>
          )}
          <div
            ref={listRef}
            className="py-1 max-h-[min(24rem,calc(100vh-4rem))] overflow-y-auto"
            onScroll={updateScrollIndicators}
          >
            {sortGroupsForDisplay(groups).map((g) => (
              <button
                key={g.name}
                className={`flex items-center gap-2 w-full px-3 py-1.5 border-none cursor-pointer text-left text-xs transition-colors duration-150 ${
                  g.name === activeGroup
                    ? "bg-gh-bg-active text-gh-text font-semibold"
                    : "bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover"
                }`}
                onClick={() => {
                  onGroupChange(g.name);
                  setOpen(false);
                }}
              >
                {g.name === activeGroup ? (
                  <svg
                    className="size-3.5 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="m4.5 12.75 6 6 9-13.5"
                    />
                  </svg>
                ) : (
                  <span className="inline-block size-3.5 shrink-0" />
                )}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {g.name === "default" ? "(default)" : g.name}
                </span>
              </button>
            ))}
          </div>
          {canScrollDown && (
            <div className="flex justify-center py-0.5 text-gh-text-secondary border-t border-gh-border">
              <svg className="size-3" fill="currentColor" viewBox="0 0 12 12">
                <path d="M2.5 4.5 6 8l3.5-3.5z" />
              </svg>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
