interface MenuPlacementInput {
  // Anchor row edges in viewport coordinates, as getBoundingClientRect
  // returns them.
  anchorTop: number;
  anchorBottom: number;
  menuHeight: number;
  viewportHeight: number;
}

// Flipping up is only worth it when the menu would run past the bottom edge
// and it actually fits above. When it fits in neither direction we stay
// down: the sidebar scrolls vertically, so a menu overflowing downward is
// still reachable, while one flipped past the top edge is clipped for good.
export function shouldDropUp({
  anchorTop,
  anchorBottom,
  menuHeight,
  viewportHeight,
}: MenuPlacementInput): boolean {
  const fitsDown = anchorBottom + menuHeight <= viewportHeight;
  const fitsUp = anchorTop - menuHeight >= 0;
  return !fitsDown && fitsUp;
}
