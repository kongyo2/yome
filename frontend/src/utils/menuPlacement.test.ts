import { describe, it, expect } from "vitest";
import { shouldDropUp } from "./menuPlacement";

describe("shouldDropUp", () => {
  it("keeps the menu below when it fits", () => {
    expect(
      shouldDropUp({
        anchorTop: 100,
        anchorBottom: 130,
        menuHeight: 200,
        viewportHeight: 800,
      }),
    ).toBe(false);
  });

  it("flips up when the menu would run past the bottom edge", () => {
    expect(
      shouldDropUp({
        anchorTop: 700,
        anchorBottom: 730,
        menuHeight: 200,
        viewportHeight: 800,
      }),
    ).toBe(true);
  });

  it("stays below when the menu fits in neither direction", () => {
    expect(
      shouldDropUp({
        anchorTop: 300,
        anchorBottom: 330,
        menuHeight: 500,
        viewportHeight: 800,
      }),
    ).toBe(false);
  });

  it("keeps the menu below when it ends exactly at the bottom edge", () => {
    expect(
      shouldDropUp({
        anchorTop: 570,
        anchorBottom: 600,
        menuHeight: 200,
        viewportHeight: 800,
      }),
    ).toBe(false);
  });
});
