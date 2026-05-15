import { useEffect, useCallback, useRef, useState } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

export type ZoomContent =
  | { type: "image"; src: string; alt?: string }
  | { type: "svg"; svg: string };

interface ZoomModalProps {
  content: ZoomContent;
  onClose: () => void;
}

export function ZoomModal({ content, onClose }: ZoomModalProps) {
  const [initialScale, setInitialScale] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const zoomContentRef = useRef<HTMLDivElement>(null);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const calcScale = useCallback((w: number, h: number) => {
    if (w <= 0 || h <= 0) return 1;
    const vw = window.innerWidth * 0.85;
    const vh = window.innerHeight * 0.85;
    return Math.min(vw / w, vh / h);
  }, []);

  // Measure actual rendered content size and calculate fit scale
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) {
        setInitialScale(1);
        return;
      }
      const contentW = el.scrollWidth;
      const contentH = el.scrollHeight;
      setInitialScale(calcScale(contentW, contentH));
    });
    return () => cancelAnimationFrame(raf);
  }, [content, calcScale]);

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    const down = mouseDownPos.current;
    mouseDownPos.current = null;
    if (!down) return;

    // Ignore drag (moved more than 5px)
    const dist = Math.sqrt(
      (e.clientX - down.x) ** 2 + (e.clientY - down.y) ** 2,
    );
    if (dist > 5) return;

    // Don't close if clicking on the content or close button
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    if (zoomContentRef.current?.contains(target)) return;

    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      role="dialog"
      aria-modal="true"
      aria-label="Zoom viewer"
    >
      <button
        type="button"
        className="absolute top-4 right-4 z-10 flex items-center justify-center rounded-md p-2 cursor-pointer text-white/70 hover:text-white transition-colors duration-150"
        onClick={onClose}
        aria-label="Close"
      >
        <svg
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
      {/* Hidden content for measuring actual size */}
      {initialScale === null && (
        <div
          ref={contentRef}
          style={{
            position: "absolute",
            visibility: "hidden",
            pointerEvents: "none",
          }}
        >
          {content.type === "image" ? (
            <img
              src={content.src}
              alt={content.alt ?? ""}
              onLoad={() => {
                const el = contentRef.current;
                if (el) {
                  setInitialScale(calcScale(el.scrollWidth, el.scrollHeight));
                }
              }}
              onError={() => setInitialScale(1)}
            />
          ) : (
            <div dangerouslySetInnerHTML={{ __html: content.svg }} />
          )}
        </div>
      )}
      {initialScale !== null && (
        <TransformWrapper
          initialScale={initialScale}
          minScale={initialScale * 0.5}
          maxScale={Math.max(initialScale * 10, 10)}
          wheel={{ step: 0.1 }}
          doubleClick={{ disabled: true }}
          centerOnInit
        >
          <TransformComponent
            wrapperStyle={{ width: "100%", height: "100%" }}
            contentStyle={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div ref={zoomContentRef}>
              {content.type === "image" ? (
                <img
                  src={content.src}
                  alt={content.alt ?? ""}
                  draggable={false}
                />
              ) : (
                <div dangerouslySetInnerHTML={{ __html: content.svg }} />
              )}
            </div>
          </TransformComponent>
        </TransformWrapper>
      )}
    </div>
  );
}
