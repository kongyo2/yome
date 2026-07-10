import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EmptyGroupMessage } from "./EmptyGroupMessage";
import type { Group } from "../hooks/useApi";

const writeText = vi.fn();

// Capture the real `window.location` descriptor once so each test can
// override only the port and the original Location object is restored
// after the test runs (preventing leakage into other test files).
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });

  // Pretend the SPA is served on the default yome port unless a test overrides it.
  setLocationPort("6275");
});

afterEach(() => {
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
});

function setLocationPort(port: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, port },
    writable: true,
    configurable: true,
  });
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return { name: "default", files: [], ...overrides };
}

// Find the rendered command for a pattern by locating the <code> whose text
// contains the given substring (a unique fragment of the pattern that
// survives shell-quoting). Returns the command without the leading "$ ".
function commandFor(uniqueSubstring: string): string {
  const codes = Array.from(document.querySelectorAll("code"));
  const target = codes.find((c) => c.textContent?.includes(uniqueSubstring));
  if (!target) {
    const rendered = codes.map((c) => c.textContent).join("\n");
    throw new Error(
      `<code> containing "${uniqueSubstring}" not found. Rendered:\n${rendered}`,
    );
  }
  return target.textContent!.replace(/^\s*\$\s+/, "").trim();
}

describe("EmptyGroupMessage", () => {
  it('falls back to "No file selected" when the group has no patterns', () => {
    render(<EmptyGroupMessage group={makeGroup()} />);
    expect(screen.getByText("No file selected")).toBeInTheDocument();
  });

  it('falls back to "No file selected" when the group is undefined', () => {
    render(<EmptyGroupMessage group={undefined} />);
    expect(screen.getByText("No file selected")).toBeInTheDocument();
  });

  it('falls back to "No file selected" when the group still has files', () => {
    const group = makeGroup({
      patterns: ["/abs/foo/*.md"],
      files: [{ name: "a.md", id: "abc12345", path: "/abs/foo/a.md" }],
    });
    render(<EmptyGroupMessage group={group} />);
    expect(screen.getByText("No file selected")).toBeInTheDocument();
    expect(screen.queryByText(/No file in this group/)).not.toBeInTheDocument();
  });

  it("renders an unwatch command per pattern in the default group on the default port", () => {
    const group = makeGroup({
      patterns: ["/abs/foo/*.md", "/abs/bar/**/*.md"],
    });
    render(<EmptyGroupMessage group={group} />);

    expect(screen.getByText("No file in this group.")).toBeInTheDocument();
    expect(commandFor("/abs/foo/")).toBe("yome --unwatch '/abs/foo/*.md'");
    expect(commandFor("/abs/bar/")).toBe("yome --unwatch '/abs/bar/**/*.md'");
  });

  it("appends -t <group> for a non-default group name", () => {
    const group = makeGroup({ name: "design", patterns: ["/abs/d/*.md"] });
    render(<EmptyGroupMessage group={group} />);
    expect(commandFor("/abs/d/")).toBe(
      "yome --unwatch '/abs/d/*.md' -t design",
    );
  });

  it("appends -p <port> when the server is on a non-default port", () => {
    setLocationPort("16275");
    const group = makeGroup({ patterns: ["/abs/foo/*.md"] });
    render(<EmptyGroupMessage group={group} />);
    expect(commandFor("/abs/foo/")).toBe(
      "yome --unwatch '/abs/foo/*.md' -p 16275",
    );
  });

  it("combines -t and -p when both apply", () => {
    setLocationPort("16275");
    const group = makeGroup({ name: "design", patterns: ["/abs/d/*.md"] });
    render(<EmptyGroupMessage group={group} />);
    expect(commandFor("/abs/d/")).toBe(
      "yome --unwatch '/abs/d/*.md' -t design -p 16275",
    );
  });

  it("omits both flags for the default group on the default port", () => {
    const group = makeGroup({ patterns: ["/abs/foo/*.md"] });
    render(<EmptyGroupMessage group={group} />);
    expect(commandFor("/abs/foo/")).toBe("yome --unwatch '/abs/foo/*.md'");
  });

  it("leaves a plain pattern unquoted when no shell metacharacters are present", () => {
    const group = makeGroup({ patterns: ["/abs/foo.md"] });
    render(<EmptyGroupMessage group={group} />);
    expect(commandFor("/abs/foo.md")).toBe("yome --unwatch /abs/foo.md");
  });

  it("quotes patterns containing spaces", () => {
    const pattern = "/abs/dir with space/*.md";
    const group = makeGroup({ patterns: [pattern] });
    render(<EmptyGroupMessage group={group} />);
    expect(commandFor("dir with space")).toBe(`yome --unwatch '${pattern}'`);
  });

  it("escapes embedded single quotes using the POSIX '\\'' pattern", () => {
    const pattern = "/abs/with'quote/*.md";
    const group = makeGroup({ patterns: [pattern] });
    render(<EmptyGroupMessage group={group} />);
    expect(commandFor("with")).toBe(
      "yome --unwatch '/abs/with'\\''quote/*.md'",
    );
  });

  it("copies the rendered command to the clipboard when the copy button is clicked", async () => {
    const group = makeGroup({ patterns: ["/abs/foo/*.md"] });
    render(<EmptyGroupMessage group={group} />);

    fireEvent.click(screen.getByTitle("Copy command"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith("yome --unwatch '/abs/foo/*.md'");
    expect(
      await screen.findByRole("button", { name: "Command copied" }),
    ).toBeInTheDocument();
  });
});
