import { useCallback, useEffect, useState } from "react";

// "Copied" confirmation state for copy buttons: markCopied() flips the flag
// on, and it clears itself after resetMs.
export function useCopiedFeedback(
  resetMs = 2000,
): [copied: boolean, markCopied: () => void] {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), resetMs);
    return () => clearTimeout(timer);
  }, [copied, resetMs]);

  const markCopied = useCallback(() => setCopied(true), []);
  return [copied, markCopied];
}
