import { RemoveIcon } from "./RemoveIcon";

interface CloseFileButtonProps {
  onClose: () => void;
  uploaded?: boolean;
}

export function CloseFileButton({ onClose, uploaded }: CloseFileButtonProps) {
  return (
    <button
      className="flex items-center justify-center bg-transparent border border-gh-border rounded-md p-1.5 text-gh-text-secondary cursor-pointer transition-colors duration-150 hover:bg-gh-bg-hover"
      onClick={onClose}
      aria-label={uploaded ? "Discard" : "Close file"}
      title={uploaded ? "Discard" : "Close file"}
    >
      <RemoveIcon uploaded={uploaded} />
    </button>
  );
}
