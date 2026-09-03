import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileEntry } from "../hooks/useApi";
import { buildTree, type TreeNode } from "../utils/buildTree";
import { readStorageRecord, writeJsonStorage } from "../utils/storage";
import type { FileMenuActions, FileMenuState } from "./FileContextMenu";
import { FileItem } from "./FileItem";

const COLLAPSED_STORAGE_KEY = "yome-sidebar-tree-collapsed";

function getInitialCollapsed(group: string): Set<string> {
  const stored = readStorageRecord<unknown>(COLLAPSED_STORAGE_KEY)[group];
  return new Set(
    Array.isArray(stored)
      ? stored.filter((p): p is string => typeof p === "string")
      : [],
  );
}

interface TreeViewProps {
  files: FileEntry[];
  activeGroup: string;
  activeFileId: string | null;
  showTitle: boolean;
  onFileSelect: (id: string) => void;
  menu: FileMenuState;
  actions: FileMenuActions;
}

export function TreeView({
  files,
  activeGroup,
  activeFileId,
  showTitle,
  onFileSelect,
  menu,
  actions,
}: TreeViewProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [prevGroup, setPrevGroup] = useState(activeGroup);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() =>
    getInitialCollapsed(activeGroup),
  );

  if (prevGroup !== activeGroup) {
    setPrevGroup(activeGroup);
    setCollapsedPaths(getInitialCollapsed(activeGroup));
  }

  useEffect(() => {
    const all = readStorageRecord<string[]>(COLLAPSED_STORAGE_KEY);
    all[activeGroup] = [...collapsedPaths];
    writeJsonStorage(COLLAPSED_STORAGE_KEY, all);
  }, [collapsedPaths, activeGroup]);

  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const rowProps = {
    activeGroup,
    activeFileId,
    showTitle,
    onFileSelect,
    menu,
    actions,
    collapsedPaths,
    onToggleCollapse: handleToggleCollapse,
  };

  return (
    <>
      {tree.children.map((node) => (
        <TreeNodeItem key={node.fullPath} node={node} depth={0} {...rowProps} />
      ))}
    </>
  );
}

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  activeGroup: string;
  activeFileId: string | null;
  showTitle: boolean;
  onFileSelect: (id: string) => void;
  menu: FileMenuState;
  actions: FileMenuActions;
  collapsedPaths: Set<string>;
  onToggleCollapse: (path: string) => void;
}

function TreeNodeItem({ node, depth, ...rest }: TreeNodeItemProps) {
  if (node.file != null) {
    return (
      <FileItem
        file={node.file}
        label={node.name}
        depth={depth}
        activeGroup={rest.activeGroup}
        isActive={node.file.id === rest.activeFileId}
        showTitle={rest.showTitle}
        onFileSelect={rest.onFileSelect}
        menu={rest.menu}
        actions={rest.actions}
      />
    );
  }

  const isCollapsed = rest.collapsedPaths.has(node.fullPath);

  return (
    <div>
      <button
        className="flex items-center gap-1.5 w-full px-3 py-1.5 border-none cursor-pointer text-left text-sm bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover transition-colors duration-150"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() => rest.onToggleCollapse(node.fullPath)}
        aria-expanded={!isCollapsed}
      >
        {/* Chevron */}
        <svg
          className={`size-3 shrink-0 transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6.427 4.427l3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 11.396V4.604a.25.25 0 0 1 .427-.177Z" />
        </svg>
        {/* Folder icon */}
        <svg
          className="size-4 shrink-0"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          {isCollapsed ? (
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7Z" />
          ) : (
            <path d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.2c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1h6.8A1.75 1.75 0 0 1 16 4.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237ZM1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H7.5c-.55 0-1.07-.26-1.4-.7l-.9-1.2a.25.25 0 0 0-.2-.1Z" />
          )}
        </svg>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {node.name}
        </span>
      </button>
      {!isCollapsed &&
        node.children.map((child) => (
          <TreeNodeItem
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            {...rest}
          />
        ))}
    </div>
  );
}
