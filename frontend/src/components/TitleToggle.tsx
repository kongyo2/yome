interface TitleToggleProps {
  showTitle: boolean;
  onToggle: () => void;
}

export function TitleToggle({ showTitle, onToggle }: TitleToggleProps) {
  return (
    <button
      type="button"
      className={`flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 cursor-pointer transition-colors duration-150 hover:bg-gh-bg-hover ${
        showTitle ? "text-gh-header-text bg-gh-bg-hover" : "text-gh-header-text"
      }`}
      onClick={onToggle}
      aria-pressed={showTitle}
      aria-label="Title display"
      title={showTitle ? "Show file names" : "Show heading titles"}
    >
      <svg
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        viewBox="0 0 24 24"
      >
        {showTitle ? (
          <path
            d="M7 18L14 6M15 18h5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M6 5h12M12 5v14"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  );
}
