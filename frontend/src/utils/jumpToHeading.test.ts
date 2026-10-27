import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { headingIdFromHash, jumpToHeading } from "./jumpToHeading";

beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("jumpToHeading", () => {
  it("scrolls to the heading and updates the URL hash", () => {
    const heading = document.createElement("h2");
    heading.id = "getting-started";
    const scrollIntoView = vi.fn();
    heading.scrollIntoView = scrollIntoView;
    document.body.appendChild(heading);

    const result = jumpToHeading("getting-started");

    expect(result).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(window.location.hash).toBe("#getting-started");
  });

  it("does nothing and returns false when the heading is missing", () => {
    const result = jumpToHeading("missing");

    expect(result).toBe(false);
    expect(window.location.hash).toBe("");
  });
});

describe("headingIdFromHash", () => {
  it("strips the leading # and decodes the id", () => {
    expect(headingIdFromHash(`#${encodeURIComponent("使い方")}`)).toBe(
      "使い方",
    );
  });

  it("returns null for an empty hash", () => {
    expect(headingIdFromHash("")).toBeNull();
    expect(headingIdFromHash("#")).toBeNull();
  });

  it("returns the raw id when it is not valid percent-encoding", () => {
    expect(headingIdFromHash("#100%")).toBe("100%");
  });
});
