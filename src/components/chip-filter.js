/* Pure helpers for the category filter chips. Single-select (radio) model:
 * a chip is either the active one or not. Clicking the active chip clears.
 * Kept side-effect-free so tests can exercise the logic directly. */

export function applyCategoryFilter(items, active) {
  if (!active) return items;
  return items.filter(e => e && e.category === active);
}

export function toggleCategory(current, clicked) {
  if (!clicked) return "";
  return current === clicked ? "" : clicked;
}

