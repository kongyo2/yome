import type { MouseEventHandler, ReactNode } from "react";

// Hover-revealed buttons floating over code blocks, diagrams, and images.
// The dark variant matches Shiki's always-dark code theme regardless of
// the app theme; the themed variant follows the app palette.
const THEMED_OVERLAY_STYLE =
  "border-gh-border hover:border-gh-text-secondary text-gh-text-secondary bg-gh-bg-secondary";
const DARK_OVERLAY_STYLE =
  "border-[#484f58] hover:border-[#8b949e] text-[#8b949e] bg-[#2d333b]";

interface OverlayButtonProps {
  title: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  // Tailwind offset classes placing the button inside its `relative` host.
  position?: string;
  dark?: boolean;
  // Keep the button visible regardless of hover (e.g. right after copying).
  visible?: boolean;
  // The hover group that reveals the button.
  groupClass?: string;
  children: ReactNode;
}

export function OverlayButton({
  title,
  onClick,
  position = "right-2 top-2",
  dark = false,
  visible = false,
  groupClass = "group-hover:opacity-100",
  children,
}: OverlayButtonProps) {
  return (
    <button
      type="button"
      className={`absolute ${position} flex items-center justify-center rounded-md p-1 cursor-pointer transition-all duration-150 border ${dark ? DARK_OVERLAY_STYLE : THEMED_OVERLAY_STYLE} ${visible ? "opacity-100" : `opacity-0 ${groupClass}`}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

export function ZoomButton({
  onClick,
  position = "right-2 top-2",
  groupClass,
}: {
  onClick: () => void;
  position?: string;
  groupClass?: string;
}) {
  return (
    <OverlayButton
      title="Zoom"
      onClick={onClick}
      position={position}
      {...(groupClass ? { groupClass } : {})}
    >
      <svg
        className="size-4"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="7" cy="7" r="4.5" />
        <line x1="10.5" y1="10.5" x2="14" y2="14" strokeLinecap="round" />
        <line x1="5" y1="7" x2="9" y2="7" strokeLinecap="round" />
        <line x1="7" y1="5" x2="7" y2="9" strokeLinecap="round" />
      </svg>
    </OverlayButton>
  );
}

export function CheckIcon() {
  return (
    <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25ZM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
      <path d="M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75ZM1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Z" />
      <path
        d="M0.5 12.75 4.5 5.5 7.5 9 9.5 6.5 15.5 12.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
