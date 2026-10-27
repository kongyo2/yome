import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FileContextMenu,
  type FileMenuActions,
  type FileMenuState,
} from "./FileContextMenu";
import type { FileEntry } from "../hooks/useApi";

const file: FileEntry = { id: "aaa11111", name: "a.md", path: "/a.md" };

function renderMenu(isOpen: boolean) {
  const onToggle = vi.fn();
  const menu: FileMenuState = {
    openId: isOpen ? file.id : null,
    otherGroups: [],
    menuRef: createRef<HTMLDivElement>(),
  };
  const actions: FileMenuActions = {
    onToggle,
    onOpenInNewTab: () => {},
    onCopyPath: () => {},
    onCopyLink: () => {},
    onMoveToGroup: () => {},
    onRemove: () => {},
  };
  render(<FileContextMenu file={file} menu={menu} actions={actions} />);
  return onToggle;
}

describe("FileContextMenu", () => {
  it("closes on Escape and returns focus to the toggle", async () => {
    const onToggle = renderMenu(true);
    screen.getByText("Copy link").focus();

    await userEvent.keyboard("{Escape}");

    expect(onToggle).toHaveBeenCalledWith("aaa11111");
    expect(
      screen.getByRole("button", { name: "More actions for a.md" }),
    ).toHaveFocus();
  });

  it("ignores Escape while closed", async () => {
    const onToggle = renderMenu(false);

    await userEvent.keyboard("{Escape}");

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("ignores other keys while open", async () => {
    const onToggle = renderMenu(true);

    await userEvent.keyboard("{Enter}");

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("keeps the toggle visible while its menu is open", () => {
    renderMenu(true);

    const toggle = screen.getByRole("button", {
      name: "More actions for a.md",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveClass("opacity-100");
    expect(toggle).not.toHaveClass("opacity-0");
  });
});
