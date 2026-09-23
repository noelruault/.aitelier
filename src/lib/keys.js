import { KEYMAPS } from "../data/keymaps.data.js";
import { ACTIONS } from "./actions.js";

/* Keyboard dispatcher. Consumes KEYMAPS (from src/data/keymaps.data.js) and
 * ACTIONS (from src/lib/actions.js). Supports modifier prefixes and chords
 * (space-separated tokens) with a 1200ms timeout. */

export function normalizeKey(e) {
  const parts = [];
  if (e.metaKey) parts.push("mod");
  else if (e.ctrlKey) parts.push(navigator.platform.includes("Mac") ? "ctrl" : "mod");
  if (e.altKey) parts.push("alt");
  let key = e.key;
  if (key.length === 1) {
    // Single-char: keep as-is. Uppercase letters imply shift.
  } else if (e.shiftKey) {
    parts.push("shift");
  }
  parts.push(key);
  return parts.join("+");
}

export let chordBuf = [];
export let chordTimer = null;

export function clearChord() {
  chordBuf = [];
  if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; }
  const ind = document.getElementById("chordIndicator");
  if (ind) ind.classList.remove("show");
}
export function showChord() {
  let ind = document.getElementById("chordIndicator");
  if (!ind) {
    ind = document.createElement("div");
    ind.id = "chordIndicator";
    ind.className = "chord-indicator";
    document.body.appendChild(ind);
  }
  ind.textContent = chordBuf.join(" ") + " ⋯";
  ind.classList.add("show");
}

/* Run the action bound to the key (or chord) in the active keymap.
 * Returns true if handled. state.keymap holds the active keymap id. */
export function dispatchKey(token, keymapId) {
  const km = KEYMAPS[keymapId];
  if (!km) return false;
  const bindings = km.bindings;

  // Exact match with current chord buffer
  const candidates = [chordBuf.concat(token).join(" "), token];
  for (const seq of candidates) {
    if (bindings[seq] != null) {
      clearChord();
      const action = ACTIONS[bindings[seq]];
      if (action) { action(); return true; }
      return false;
    }
  }

  // Prefix?
  const seq = chordBuf.concat(token).join(" ");
  const isPrefix = Object.keys(bindings).some(k => k.startsWith(seq + " "));
  if (isPrefix) {
    chordBuf.push(token);
    if (chordTimer) clearTimeout(chordTimer);
    chordTimer = setTimeout(clearChord, 1200);
    showChord();
    return true;
  }

  // No match, no prefix. Drop chord, retry with new token alone.
  if (chordBuf.length > 0) {
    clearChord();
    return dispatchKey(token, keymapId);
  }
  return false;
}
