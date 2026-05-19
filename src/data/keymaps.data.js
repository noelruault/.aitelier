/* =========================================================================
 *  Keymaps (JSON-shaped, easy to extend, easy to lift out to a separate file)
 *  Each binding is "<keys>": "<actionId>".
 *  Keys:
 *    - Single key: "j", "Enter", "ArrowDown", "PageDown", "Home", "/", "?"
 *    - With modifier: "mod+k" (mod = Cmd on macOS, Ctrl elsewhere),
 *      "shift+ArrowDown", "alt+l"
 *    - Chord: space-separated, e.g. "g g", "y y", "d d", "g v"
 *    - Letter case: uppercase implies the shifted letter ("G" = shift+g)
 *  Actions are looked up in the ACTIONS registry below; null disables a key.
 * ========================================================================= */
export const KEYMAPS = {
  normal: {
    label: "Normal",
    description: "Arrow keys, Enter to copy, letter shortcuts.",
    bindings: {
      "/": "search.focus",
      "mod+k": "search.focus",
      "ArrowDown": "focus.next",
      "ArrowUp": "focus.prev",
      "PageDown": "focus.pageDown",
      "PageUp": "focus.pageUp",
      "Home": "focus.first",
      "End": "focus.last",
      "Enter": "prompt.copy",
      "mod+Enter": "prompt.copyOpen",
      "g": "view.gallery",
      "m": "view.manpage",
      "n": "prompt.new",
      "e": "prompt.edit",
      "c": "prompt.copy",
      "r": "prompt.requestEdit",
      "mod+d": "prompt.duplicate",
      "Backspace": "prompt.delete",
      "Delete": "prompt.delete",
      "?": "ui.help",
      "Escape": "ui.escape"
    }
  },
  vim: {
    label: "Vim",
    description: "j/k nav, gg/G jumps, yy/dd, gv/gm to switch views.",
    bindings: {
      "/": "search.focus",
      "mod+k": "search.focus",
      "j": "focus.next",
      "k": "focus.prev",
      "ArrowDown": "focus.next",
      "ArrowUp": "focus.prev",
      "mod+f": "focus.pageDown",
      "mod+b": "focus.pageUp",
      "g g": "focus.first",
      "G": "focus.last",
      "Enter": "prompt.copy",
      "mod+Enter": "prompt.copyOpen",
      "y y": "prompt.copy",
      "p": "prompt.duplicate",
      "i": "prompt.edit",
      "o": "prompt.new",
      "r": "prompt.requestEdit",
      "g v": "view.gallery",
      "g m": "view.manpage",
      "d d": "prompt.delete",
      "x": "prompt.delete",
      "?": "ui.help",
      "Escape": "ui.escape"
    }
  },
  jetbrains: {
    label: "JetBrains",
    description: "⌘-heavy + F-keys (IntelliJ / GoLand / WebStorm muscle memory).",
    bindings: {
      "mod+shift+a": "search.focus",     // Find Action
      "mod+shift+f": "search.focus",     // Find in Path
      "/": "search.focus",
      "ArrowDown": "focus.next",
      "ArrowUp": "focus.prev",
      "alt+ArrowDown": "focus.pageDown",
      "alt+ArrowUp": "focus.pageUp",
      "mod+Home": "focus.first",
      "mod+End": "focus.last",
      "Enter": "prompt.copy",
      "mod+b": "prompt.copyOpen",  // Go to declaration → open detail
      "mod+Enter": "prompt.copyOpen",
      "mod+n": "prompt.new",       // Generate / new
      "F6": "prompt.edit",      // Move / rename
      "mod+shift+r": "prompt.requestEdit", // Refactor request mnemonic
      "mod+d": "prompt.duplicate", // Duplicate line
      "mod+Backspace": "prompt.delete",    // Delete line
      "Delete": "prompt.delete",
      "F1": "ui.help",
      "?": "ui.help",
      "Escape": "ui.escape"
    }
  }
};

/* Pretty labels for the help overlay, ordered. */
export const ACTION_META = {
  "search.focus": { label: "Focus search" },
  "focus.next": { label: "Next prompt" },
  "focus.prev": { label: "Previous prompt" },
  "focus.pageDown": { label: "Page down" },
  "focus.pageUp": { label: "Page up" },
  "focus.first": { label: "Jump to first" },
  "focus.last": { label: "Jump to last" },
  "prompt.copy": { label: "Copy focused prompt" },
  "prompt.copyOpen": { label: "Copy + open in Manpage" },
  "prompt.new": { label: "New prompt" },
  "prompt.edit": { label: "Edit (or fork built-in)" },
  "prompt.requestEdit": { label: "Request edit (for built-ins)" },
  "prompt.duplicate": { label: "Duplicate focused prompt" },
  "prompt.delete": { label: "Delete (user prompts only)" },
  "view.gallery": { label: "Switch to Gallery" },
  "view.manpage": { label: "Switch to Manpage" },
  "ui.help": { label: "Toggle this overlay" },
  "ui.escape": { label: "Clear search / close modals" }
};
