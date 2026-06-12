import { describe, expect, test } from "bun:test";
import { applyCategoryFilter, toggleCategory } from "../src/components/chip-filter.js";

const items = [
  { id: "a", category: "performance" },
  { id: "b", category: "performance" },
  { id: "c", category: "design" },
  { id: "d", category: "quality" },
  { id: "e", category: "design" },
];

describe("applyCategoryFilter", () => {
  test("returns all items when no category active", () => {
    expect(applyCategoryFilter(items, "")).toBe(items);
    expect(applyCategoryFilter(items, null)).toBe(items);
    expect(applyCategoryFilter(items, undefined)).toBe(items);
  });

  test("filters to a single category", () => {
    expect(applyCategoryFilter(items, "performance").map(i => i.id)).toEqual(["a", "b"]);
    expect(applyCategoryFilter(items, "design").map(i => i.id)).toEqual(["c", "e"]);
    expect(applyCategoryFilter(items, "quality").map(i => i.id)).toEqual(["d"]);
  });

  test("returns empty array when no items match", () => {
    expect(applyCategoryFilter(items, "tooling")).toEqual([]);
  });

  test("does not mutate input", () => {
    const before = items.slice();
    applyCategoryFilter(items, "performance");
    expect(items).toEqual(before);
  });

  test("ignores items with no category", () => {
    const mixed = [{ id: "x" }, { id: "y", category: "design" }, null];
    expect(applyCategoryFilter(mixed, "design").map(i => i.id)).toEqual(["y"]);
  });

  test("returns empty array for empty input", () => {
    expect(applyCategoryFilter([], "performance")).toEqual([]);
  });
});

describe("toggleCategory (radio behavior)", () => {
  test("activates a category when none is active", () => {
    expect(toggleCategory("", "performance")).toBe("performance");
  });

  test("switches to a different category", () => {
    expect(toggleCategory("performance", "design")).toBe("design");
  });

  test("clicking the active chip deselects it (back to All)", () => {
    expect(toggleCategory("design", "design")).toBe("");
  });

  test("clicking with no target returns empty (All)", () => {
    expect(toggleCategory("design", "")).toBe("");
    expect(toggleCategory("design", null)).toBe("");
  });

  test("only one category can ever be active at a time", () => {
    let active = "";
    active = toggleCategory(active, "performance");
    expect(active).toBe("performance");
    active = toggleCategory(active, "quality");
    expect(active).toBe("quality");
    active = toggleCategory(active, "design");
    expect(active).toBe("design");
    active = toggleCategory(active, "design");
    expect(active).toBe("");
  });
});

describe("integration: chip click drives filter", () => {
  test("pressing 'performance' shows only performance items", () => {
    const active = toggleCategory("", "performance");
    expect(applyCategoryFilter(items, active).map(i => i.id)).toEqual(["a", "b"]);
  });

  test("pressing the active chip restores all items", () => {
    let active = toggleCategory("", "design");
    expect(applyCategoryFilter(items, active).length).toBe(2);
    active = toggleCategory(active, "design");
    expect(applyCategoryFilter(items, active)).toBe(items);
  });

  test("switching chips replaces the filter (never accumulates)", () => {
    let active = toggleCategory("", "performance");
    active = toggleCategory(active, "quality");
    const out = applyCategoryFilter(items, active);
    expect(out.map(i => i.id)).toEqual(["d"]);
  });
});
