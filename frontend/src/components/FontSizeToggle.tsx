export type FontSize = "small" | "medium" | "large" | "xlarge";

interface FontSizeToggleProps {
  fontSize: FontSize;
  onChange: (fontSize: FontSize) => void;
}

const LABELS: Record<FontSize, string> = {
  small: "Small text",
  medium: "Medium text",
  large: "Large text",
  xlarge: "Extra large text",
};

const NEXT_SIZE: Record<FontSize, FontSize> = {
  small: "medium",
  medium: "large",
  large: "xlarge",
  xlarge: "small",
};

export function FontSizeToggle({ fontSize, onChange }: FontSizeToggleProps) {
  const nextSize = NEXT_SIZE[fontSize];

  return (
    <button
      type="button"
      className="flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 text-gh-header-text cursor-pointer transition-colors duration-150 hover:bg-gh-bg-hover"
      onClick={() => onChange(nextSize)}
      aria-label="Text size"
      title={`Text size: ${LABELS[fontSize]}`}
    >
      <span
        className={`inline-flex w-5 h-5 items-center justify-center ${
          fontSize === "small"
            ? "text-sm"
            : fontSize === "large"
              ? "text-lg"
              : fontSize === "xlarge"
                ? "text-xl"
                : ""
        }`}
      >
        A
      </span>
    </button>
  );
}
