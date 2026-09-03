import { useEffect, useRef, useState } from "react";
import { mermaidMod } from "../utils/lazy-render";
import { useCopiedFeedback } from "../hooks/useCopiedFeedback";
import { CodeBlockCopyButton } from "./CodeBlock";
import {
  CheckIcon,
  ImageIcon,
  OverlayButton,
  ZoomButton,
} from "./OverlayButton";
import type { ZoomContent } from "./ZoomModal";

type MermaidTheme = "dark" | "default";

function getMermaidTheme(): MermaidTheme {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "default";
}

let mermaidCounter = 0;
// Renders are serialized: mermaid.initialize() is global, so each queued
// render must run with the theme it was requested with.
let mermaidQueue: Promise<void> = Promise.resolve();

// mermaid leaves its error diagrams in the document body on parse failure.
function cleanupMermaidErrors() {
  document.querySelectorAll("[id^='dmermaid-']").forEach((el) => el.remove());
}

async function renderMermaidNow(
  code: string,
  theme: MermaidTheme,
  width?: number,
): Promise<string> {
  const id = `mermaid-${++mermaidCounter}`;
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-9999px";
  container.style.top = "-9999px";
  container.style.width = `${width && width > 0 ? width : 800}px`;
  document.body.appendChild(container);
  try {
    // mermaid is loaded on first use; initialize() runs inside the queue
    // so each queued render still sees the theme it was requested with.
    const mermaid = (await mermaidMod()).default;
    mermaid.initialize({ startOnLoad: false, theme });
    const { svg } = await mermaid.render(id, code, container);
    return svg;
  } finally {
    container.remove();
    cleanupMermaidErrors();
  }
}

function renderMermaid(
  code: string,
  theme: MermaidTheme,
  width?: number,
): Promise<string> {
  // Chain onto the queue regardless of how the previous render ended; the
  // queue itself never rejects.
  const previous = mermaidQueue;
  const result = (async () => {
    await previous;
    return renderMermaidNow(code, theme, width);
  })();
  mermaidQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function MermaidBlock({
  code,
  onZoom,
}: {
  code: string;
  onZoom?: (content: ZoomContent) => void;
}) {
  const [svg, setSvg] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const doRender = () => {
      const width = containerRef.current?.offsetWidth;
      renderMermaid(code, getMermaidTheme(), width)
        .then((renderedSvg) => {
          if (!cancelled) setSvg(renderedSvg);
          return undefined;
        })
        .catch(() => {
          if (!cancelled) setSvg("");
        });
    };

    doRender();

    // Re-render on theme change
    const observer = new MutationObserver(() => doRender());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [code]);

  if (svg) {
    return (
      <div ref={containerRef} className="relative group">
        <div
          className="overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {onZoom && (
          <ZoomButton
            onClick={() => onZoom({ type: "svg", svg })}
            position="right-18 top-2"
          />
        )}
        <MermaidImageCopyButton svg={svg} />
        <CodeBlockCopyButton code={code} themed />
      </div>
    );
  }
  return (
    <div ref={containerRef} className="relative group">
      <pre>
        <code>{code}</code>
      </pre>
      <CodeBlockCopyButton code={code} />
    </div>
  );
}

function MermaidImageCopyButton({ svg }: { svg: string }) {
  const [copied, markCopied] = useCopiedFeedback();

  const handleCopy = async () => {
    try {
      // Pass the Blob promise directly to ClipboardItem so clipboard.write() is
      // invoked synchronously inside the user gesture. Awaiting the blob first
      // lets the transient user activation expire on Chrome and breaks the
      // user-gesture requirement on Safari/WebKit, both surfacing as a silent
      // no-op click.
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": svgToPngBlob(svg) }),
      ]);
      markCopied();
    } catch (err) {
      // oxlint-disable-next-line no-console
      console.error("mermaid copy image failed", err);
    }
  };

  return (
    <OverlayButton
      title="Copy image"
      onClick={handleCopy}
      position="right-10 top-2"
      visible={copied}
    >
      {copied ? <CheckIcon /> : <ImageIcon />}
    </OverlayButton>
  );
}

export function svgToPngBlob(svgString: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // Mermaid flowchart/stateDiagram labels embed HTML void elements such as
    // <br> inside <foreignObject>, which the strict "image/svg+xml" parser
    // rejects silently (documentElement becomes <html> and the width, height,
    // and viewBox lookups all return null). Parsing as "text/html" is lenient
    // and still preserves the case of SVG attributes (viewBox,
    // preserveAspectRatio, etc.). XMLSerializer then normalizes <br> to <br/>
    // so the resulting data URL loads cleanly as an SVG image.
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "text/html");
    const svgEl = doc.querySelector("svg");
    if (!svgEl) {
      reject(new Error("No SVG element found"));
      return;
    }

    // Ensure xmlns is present for standalone SVG rendering
    if (!svgEl.getAttribute("xmlns")) {
      svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }

    // Extract dimensions from the SVG element
    const widthAttr = svgEl.getAttribute("width");
    const heightAttr = svgEl.getAttribute("height");
    const viewBox = svgEl.getAttribute("viewBox");

    let width = 0;
    let height = 0;

    if (widthAttr && heightAttr) {
      width = parseFloat(widthAttr);
      height = parseFloat(heightAttr);
    } else if (viewBox) {
      const parts = viewBox.split(/[\s,]+/);
      width = parseFloat(parts[2]);
      height = parseFloat(parts[3]);
    }

    if (!width || !height) {
      reject(new Error("Cannot determine SVG dimensions"));
      return;
    }

    // Scale up for high-DPI displays
    const scale = 4;
    const serializer = new XMLSerializer();
    const svgData = serializer.serializeToString(svgEl);
    const dataUrl =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgData);

    const img = new Image();
    img.onload = () => {
      // Drawing or exporting can throw (e.g. a SecurityError from a canvas
      // that is not origin-clean); the promise must settle either way.
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to get canvas context"));
          return;
        }
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Failed to create PNG blob"));
          }
        }, "image/png");
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      reject(new Error("Failed to load SVG image"));
    };
    img.src = dataUrl;
  });
}
