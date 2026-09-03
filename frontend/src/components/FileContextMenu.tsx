import { useLayoutEffect, useState, type RefObject } from "react";
import type { FileEntry, Group } from "../hooks/useApi";
import { shouldDropUp } from "../utils/menuPlacement";
import { RemoveIcon } from "./RemoveIcon";

const MENU_ITEM_CLASS =
  "w-full px-3 py-1.5 text-left text-sm bg-transparent border-none cursor-pointer text-gh-text-secondary hover:bg-gh-bg-hover hover:text-gh-text transition-colors duration-150 flex items-center gap-2";

// Everything a file row can do from its kebab menu. Bundled so the sidebar
// hands one object down instead of threading each callback through the
// flat list, the tree, and every tree node.
export interface FileMenuActions {
  onToggle: (id: string) => void;
  onOpenInNewTab: (id: string) => void;
  onCopyPath: (path: string) => void;
  onCopyLink: (id: string) => void;
  onMoveToGroup: (id: string, group: string) => void;
  onRemove: (id: string) => void;
}

export interface FileMenuState {
  // ID of the file whose menu is open, if any (at most one at a time).
  openId: string | null;
  // Groups a file can be moved to (everything but the active group).
  otherGroups: Group[];
  // Shared by every row: only the open menu renders the dropdown node, so
  // the ref always points at the visible one (used for outside-click close).
  menuRef: RefObject<HTMLDivElement | null>;
}

interface FileContextMenuProps {
  file: FileEntry;
  menu: FileMenuState;
  actions: FileMenuActions;
}

export function FileContextMenu({ file, menu, actions }: FileContextMenuProps) {
  const isOpen = menu.openId === file.id;
  const [dropUp, setDropUp] = useState(false);

  // Measured only on open, while the menu is still at its default `top-full`
  // position: re-running this after `dropUp` flips would make it oscillate.
  useLayoutEffect(() => {
    if (!isOpen) {
      setDropUp(false);
      return;
    }
    const menuEl = menu.menuRef.current;
    const anchor = menuEl?.parentElement;
    if (!menuEl || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    setDropUp(
      shouldDropUp({
        anchorTop: anchorRect.top,
        anchorBottom: anchorRect.bottom,
        menuHeight: menuEl.offsetHeight,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [isOpen, menu.menuRef]);

  return (
    <>
      <button
        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-gh-accent flex items-center justify-center bg-transparent border-none cursor-pointer text-gh-text-secondary hover:text-gh-text rounded p-0.5 transition-opacity duration-150"
        aria-label={`More actions for ${file.name}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={(e) => {
          e.stopPropagation();
          actions.onToggle(file.id);
        }}
        title="More actions"
      >
        <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
        </svg>
      </button>
      {isOpen && (
        <div
          ref={menu.menuRef}
          className={`absolute right-0 ${dropUp ? "bottom-full" : "top-full"} z-10 bg-gh-bg border border-gh-border rounded-md shadow-lg py-1 min-w-[160px]`}
        >
          <button
            className={MENU_ITEM_CLASS}
            onClick={() => actions.onOpenInNewTab(file.id)}
          >
            <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z" />
            </svg>
            Open in new tab
          </button>
          <button
            className={MENU_ITEM_CLASS}
            onClick={() => actions.onCopyLink(file.id)}
          >
            <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Z" />
              <path d="M8.225 12.725a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 1 1-2.83-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25Z" />
            </svg>
            Copy link
          </button>
          {!file.uploaded && (
            <button
              className={MENU_ITEM_CLASS}
              onClick={() => actions.onCopyPath(file.path)}
            >
              <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
              </svg>
              Copy absolute path
            </button>
          )}
          {menu.otherGroups.length > 0 && (
            <>
              <div className="border-t border-gh-border my-1" />
              <div className="px-3 py-1.5 text-sm text-gh-text-secondary flex items-center gap-2">
                <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M12.25 2a.75.75 0 0 1 0 1.5H3.75a.25.25 0 0 0-.25.25v8.5a.25.25 0 0 0 .25.25h8.5a.75.75 0 0 0 0 1.5H3.75A1.75 1.75 0 0 1 2 12.25V3.75A1.75 1.75 0 0 1 3.75 2Z" />
                  <path d="M12 5l3.5 3-3.5 3ZM8.75 7.25a.75.75 0 0 0 0 1.5H12.5V7.25H8.75Z" />
                </svg>
                Move to...
              </div>
              {menu.otherGroups.map((g) => (
                <button
                  key={g.name}
                  className={`${MENU_ITEM_CLASS} !pl-9`}
                  onClick={() => actions.onMoveToGroup(file.id, g.name)}
                >
                  <svg
                    className="size-4 shrink-0"
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
                  {g.name === "default" ? "(default)" : g.name}
                </button>
              ))}
            </>
          )}
          <div className="border-t border-gh-border my-1" />
          <button
            className={MENU_ITEM_CLASS}
            onClick={() => actions.onRemove(file.id)}
          >
            <RemoveIcon uploaded={file.uploaded} className="size-4" />
            {file.uploaded ? "Discard" : "Close"}
          </button>
        </div>
      )}
    </>
  );
}
