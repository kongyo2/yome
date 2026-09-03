import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyText } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const originalExecCommand = document.execCommand;

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  document.execCommand = vi.fn(() => true);
});

afterEach(() => {
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    setClipboard(undefined);
  }
  document.execCommand = originalExecCommand;
});

describe("copyText", () => {
  it("uses the async Clipboard API when it works", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    expect(await copyText("hello")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    // The temporary textarea is cleaned up.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand on insecure origins without the API", async () => {
    setClipboard(undefined);
    expect(await copyText("hello")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither path works", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    expect(await copyText("hello")).toBe(false);
  });
});
