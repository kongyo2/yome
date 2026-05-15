import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TocPanel } from "./TocPanel";
import type { TocHeading } from "./TocPanel";

const headings: TocHeading[] = [
  { id: "intro", text: "Introduction", level: 1 },
  { id: "setup", text: "Setup", level: 2 },
  { id: "config", text: "Configuration", level: 3 },
  { id: "usage", text: "Usage", level: 2 },
];

beforeEach(() => {
  localStorage.clear();
});

describe("TocPanel", () => {
  it("renders all headings", () => {
    render(
      <TocPanel
        headings={headings}
        activeHeadingId={null}
        onHeadingClick={() => {}}
      />,
    );
    expect(screen.getByText("Introduction")).toBeInTheDocument();
    expect(screen.getByText("Setup")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Usage")).toBeInTheDocument();
  });

  it("shows 'No headings' when list is empty", () => {
    render(
      <TocPanel
        headings={[]}
        activeHeadingId={null}
        onHeadingClick={() => {}}
      />,
    );
    expect(screen.getByText("No headings")).toBeInTheDocument();
  });

  it("highlights the active heading", () => {
    render(
      <TocPanel
        headings={headings}
        activeHeadingId="setup"
        onHeadingClick={() => {}}
      />,
    );
    const activeLink = screen.getByText("Setup").closest("a")!;
    expect(activeLink.className).toContain("bg-gh-bg-active");
    expect(activeLink.className).toContain("font-semibold");
    expect(activeLink.getAttribute("aria-current")).toBe("location");

    const inactiveLink = screen.getByText("Introduction").closest("a")!;
    expect(inactiveLink.className).toContain("bg-transparent");
    expect(inactiveLink.getAttribute("aria-current")).toBeNull();
  });

  it("calls onHeadingClick with the heading id", async () => {
    const user = userEvent.setup();
    const onHeadingClick = vi.fn();
    render(
      <TocPanel
        headings={headings}
        activeHeadingId={null}
        onHeadingClick={onHeadingClick}
      />,
    );

    await user.click(screen.getByText("Configuration"));
    expect(onHeadingClick).toHaveBeenCalledWith("config");
  });

  it("renders each heading as a link with hash href", () => {
    render(
      <TocPanel
        headings={headings}
        activeHeadingId={null}
        onHeadingClick={() => {}}
      />,
    );
    expect(
      screen.getByText("Introduction").closest("a")?.getAttribute("href"),
    ).toBe("#intro");
    expect(screen.getByText("Setup").closest("a")?.getAttribute("href")).toBe(
      "#setup",
    );
  });

  it("applies different indentation per heading level", () => {
    render(
      <TocPanel
        headings={headings}
        activeHeadingId={null}
        onHeadingClick={() => {}}
      />,
    );
    const h1Link = screen.getByText("Introduction").closest("a")!;
    const h2Link = screen.getByText("Setup").closest("a")!;
    const h3Link = screen.getByText("Configuration").closest("a")!;

    expect(h1Link.className).toContain("pl-3");
    expect(h2Link.className).toContain("pl-6");
    expect(h3Link.className).toContain("pl-9");
  });

  it("shows heading text as title attribute", () => {
    render(
      <TocPanel
        headings={headings}
        activeHeadingId={null}
        onHeadingClick={() => {}}
      />,
    );
    expect(screen.getByTitle("Introduction")).toBeInTheDocument();
    expect(screen.getByTitle("Setup")).toBeInTheDocument();
  });
});
