import { describe, expect, test } from "bun:test";
import { BTN, BTN_PRIMARY, KBD } from "../src/lib/ui-classes.js";

describe("shared button class strings", () => {
  test("BTN contains the load-bearing utilities", () => {
    // These utilities are what makes the chip look correct across all
    // four modals, the navbar, and the manpage action row. If one of
    // these drops out, regressions are easy to ship.
    for (const u of ["btn", "appearance-none", "bg-paper-deep", "border-rule", "text-ink", "rounded-sm", "active:translate-y-px"]) {
      expect(BTN).toContain(u);
    }
  });

  test("BTN_PRIMARY uses the inverted ink/paper scheme", () => {
    for (const u of ["btn-primary", "bg-ink", "border-ink", "text-paper", "hover:bg-accent", "active:translate-y-px"]) {
      expect(BTN_PRIMARY).toContain(u);
    }
  });

  test("BTN and BTN_PRIMARY are not the same string", () => {
    expect(BTN).not.toBe(BTN_PRIMARY);
  });

  test("KBD chip carries mono font + bordered shadow", () => {
    for (const u of ["kbd", "font-mono", "border-rule", "shadow-[0_1px_0_var(--color-paper-edge)]"]) {
      expect(KBD).toContain(u);
    }
  });
});
