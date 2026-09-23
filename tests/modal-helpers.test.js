import { describe, expect, test } from "bun:test";
import { shouldCloseOnBackdropClick, bindBackdropClose } from "../src/lib/modal-helpers.js";

describe("shouldCloseOnBackdropClick", () => {
  test("true when click target is the backdrop itself", () => {
    const backdrop = { id: "back" };
    expect(shouldCloseOnBackdropClick({ target: backdrop }, backdrop)).toBe(true);
  });

  test("false when click target is a child of the backdrop", () => {
    const backdrop = { id: "back" };
    const child = { id: "child" };
    expect(shouldCloseOnBackdropClick({ target: child }, backdrop)).toBe(false);
  });

  test("false on missing args", () => {
    expect(shouldCloseOnBackdropClick(null, {})).toBe(false);
    expect(shouldCloseOnBackdropClick({ target: {} }, null)).toBe(false);
    expect(shouldCloseOnBackdropClick()).toBe(false);
  });
});

describe("bindBackdropClose", () => {
  function makeEl() {
    const listeners = [];
    return {
      listeners,
      addEventListener(type, fn) { listeners.push({ type, fn }); },
      dispatch(type, event) {
        for (const l of listeners) if (l.type === type) l.fn(event);
      }
    };
  }

  test("invokes onClose only when the backdrop itself is clicked", () => {
    const el = makeEl();
    let calls = 0;
    bindBackdropClose(el, () => calls++);
    el.dispatch("click", { target: el });
    expect(calls).toBe(1);
    el.dispatch("click", { target: { id: "inner" } });
    expect(calls).toBe(1);
  });

  test("ignores invalid arguments without throwing", () => {
    expect(() => bindBackdropClose(null, () => {})).not.toThrow();
    expect(() => bindBackdropClose(makeEl(), "not a function")).not.toThrow();
  });

  test("multiple binds stack on the same backdrop", () => {
    const el = makeEl();
    let a = 0, b = 0;
    bindBackdropClose(el, () => a++);
    bindBackdropClose(el, () => b++);
    el.dispatch("click", { target: el });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
