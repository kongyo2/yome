import type { FileEntry } from "../hooks/useApi";
import { buildFileUrl } from "../utils/groups";
import { isPlainLeftClick } from "../utils/linkClick";
import {
  FileContextMenu,
  type FileMenuActions,
  type FileMenuState,
} from "./FileContextMenu";
import { FileIcon } from "./FileIcon";

export interface FileItemProps {
  file: FileEntry;
  activeGroup: string;
  isActive: boolean;
  showTitle: boolean;
  onFileSelect: (id: string) => void;
  menu: FileMenuState;
  actions: FileMenuActions;
  // Label override for tree rows (the path segment rather than the name).
  label?: string;
  // Nesting depth for tree rows; drives the left indent.
  depth?: number;
}

// One file row, shared by the flat list and the tree view: a real link (so
// modifier clicks open a new tab) plus the kebab context menu.
export function FileItem({
  file,
  activeGroup,
  isActive,
  showTitle,
  onFileSelect,
  menu,
  actions,
  label,
  depth,
}: FileItemProps) {
  return (
    <div className="relative group/file">
      <a
        href={buildFileUrl(activeGroup, file.id)}
        className={`flex items-center gap-2 w-full px-3 py-2 border-none cursor-pointer text-left text-sm no-underline transition-colors duration-150 ${
          isActive
            ? "bg-gh-bg-active text-gh-text font-semibold"
            : "bg-transparent text-gh-text-secondary hover:bg-gh-bg-hover"
        }`}
        style={
          depth !== undefined
            ? { paddingLeft: `${depth * 16 + 12}px` }
            : undefined
        }
        onClick={(e) => {
          if (!isPlainLeftClick(e)) return;
          e.preventDefault();
          onFileSelect(file.id);
        }}
        title={file.uploaded ? file.name : file.path}
        aria-current={isActive ? "page" : undefined}
      >
        <FileIcon uploaded={file.uploaded} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap pr-6">
          {(showTitle && file.title) || label || file.name}
        </span>
      </a>
      <FileContextMenu file={file} menu={menu} actions={actions} />
    </div>
  );
}
