import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { readStorageInt, writeStorage } from "../utils/storage";

interface ResizablePanelOptions {
  storageKey: string;
  min: number;
  max: number;
  defaultWidth: number;
  // The screen edge the panel is anchored to: a left panel is as wide as
  // the pointer's x position, a right panel as wide as its distance from
  // the right edge of the window.
  edge: "left" | "right";
}

// Drag-to-resize shared by the sidebar and the ToC panel: the width is
// clamped, persisted in localStorage, and the body cursor/selection are
// locked for the duration of the drag.
export function useResizablePanel({
  storageKey,
  min,
  max,
  defaultWidth,
  edge,
}: ResizablePanelOptions) {
  const [width, setWidth] = useState(() =>
    readStorageInt(storageKey, defaultWidth, min, max),
  );
  const dragging = useRef(false);

  const onResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const raw = edge === "left" ? e.clientX : window.innerWidth - e.clientX;
      setWidth(Math.min(max, Math.max(min, raw)));
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Unmounting mid-drag must not leave the page stuck in resize mode.
      onMouseUp();
    };
  }, [edge, min, max]);

  useEffect(() => {
    writeStorage(storageKey, String(width));
  }, [storageKey, width]);

  return { width, onResizeStart };
}
