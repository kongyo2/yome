import { useEffect, useState } from "react";
import { highlight, highlightCached } from "../utils/lazy-render";
import { copyText } from "../utils/clipboard";
import { useCopiedFeedback } from "../hooks/useCopiedFeedback";
import { CheckIcon, CopyIcon, OverlayButton } from "./OverlayButton";

export function CodeBlockCopyButton({
  code,
  themed = false,
}: {
  code: string;
  themed?: boolean;
}) {
  const [copied, markCopied] = useCopiedFeedback();

  const handleCopy = async () => {
    if (await copyText(code)) markCopied();
  };

  return (
    <OverlayButton
      title="Copy code"
      onClick={handleCopy}
      dark={!themed}
      visible={copied}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </OverlayButton>
  );
}

// Resolves highlighted HTML for the current code/language pair. The
// returned HTML is guaranteed to belong to the *current* inputs: a reused
// component instance whose props just changed falls back to the cache (or
// the plain fallback) instead of flashing the previous block's output for a
// frame. Cache hits paint synchronously; misses resolve via lazy shiki with
// a plaintext fallback for unsupported languages.
export function useHighlightedHtml(code: string, language: string): string {
  const [rendered, setRendered] = useState(() => ({
    code,
    language,
    html: highlightCached(code, language) ?? "",
  }));

  useEffect(() => {
    let cancelled = false;
    const cached = highlightCached(code, language);
    if (cached != null) {
      setRendered({ code, language, html: cached });
      return () => {
        cancelled = true;
      };
    }
    highlight(code, language)
      .then((result) => {
        if (!cancelled) setRendered({ code, language, html: result });
        return undefined;
      })
      .catch(() => {
        // Fallback: if language not supported, try plaintext
        if (!cancelled) {
          highlight(code, "text")
            .then((result) => {
              if (!cancelled) setRendered({ code, language, html: result });
              return undefined;
            })
            .catch(() => {});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (rendered.code === code && rendered.language === language) {
    return rendered.html;
  }
  return highlightCached(code, language) ?? "";
}

function PlainCode({ code }: { code: string }) {
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}

export function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const html = useHighlightedHtml(code, language);

  return (
    <div className="relative group">
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <PlainCode code={code} />
      )}
      <CodeBlockCopyButton code={code} />
    </div>
  );
}

// HighlightedView renders a whole document (non-Markdown files, the raw
// Markdown view) as one highlighted block.
export function HighlightedView({
  content,
  language,
}: {
  content: string;
  language: string;
}) {
  const html = useHighlightedHtml(content, language);

  if (html) {
    return (
      <div
        className="[&_pre]:!rounded-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <PlainCode code={content} />;
}

export function RawView({ content }: { content: string }) {
  return <HighlightedView content={content} language="markdown" />;
}
