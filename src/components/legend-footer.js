import { KEYMAPS } from "../data/keymaps.data.js";
import { escapeHtml, prettyKey } from "../lib/util.js";

/* Sticky bottom legend bar. Renders the most-used shortcuts in the active
 * keymap, plus current view + keymap meta on the right. */

export function renderLegendFooter(state) {
  const bar = document.getElementById("legend");
  if (!bar) return;
  // .legend-bar shell utilities (gradient stays in input.css).
  bar.classList.add(
    "fixed", "left-0", "right-0", "bottom-0", "h-9", "border-t", "border-rule",
    "px-[22px]", "flex", "items-center", "gap-[18px]", "font-mono", "text-[10.5px]",
    "text-ink-mute", "z-[80]", "overflow-x-auto", "whitespace-nowrap",
    // Keyboard shortcuts are meaningless on touch devices, hide the bar there.
    "max-md:hidden"
  );
  const km = KEYMAPS[state.keymap];
  const html = [];

  const groups = [
    { label: "navigate", actions: ["focus.next", "focus.prev"], combine: true },
    { label: "copy",        actions: ["prompt.copy"] },
    { label: "copy + open", actions: ["prompt.copyOpen"] },
    { label: "edit",        actions: ["prompt.edit"] },
    { label: "req. edit",   actions: ["prompt.requestEdit"] },
    { label: "delete",      actions: ["prompt.delete"] }
  ];
  const right = [
    { label: "shortcuts", actions: ["ui.help"] },
    { label: "clear",     actions: ["ui.escape"] }
  ];

  const GROUP = "group inline-flex items-center gap-1.5 text-ink-soft";
  const KEYS_BOX = "keys inline-flex gap-[3px]";
  const LAB = "lab tracking-[.08em] lowercase";

  groups.forEach(g => {
    const ks = g.combine
      ? g.actions.map(a => firstBindingForAction(a, state.keymap)).filter(Boolean).map(keysToHtml).join("")
      : keysToHtml(firstBindingForAction(g.actions[0], state.keymap));
    html.push(`<span class="${GROUP}"><span class="${KEYS_BOX}">${ks}</span><span class="${LAB}">${escapeHtml(g.label)}</span></span>`);
  });
  html.push(`<span class="spacer flex-1"></span>`);
  right.forEach(g => {
    html.push(`<span class="${GROUP}"><span class="${KEYS_BOX}">${keysToHtml(firstBindingForAction(g.actions[0], state.keymap))}</span><span class="${LAB}">${escapeHtml(g.label)}</span></span>`);
  });
  html.push(`<span class="meta font-mono text-[10.5px] text-ink-faint tracking-[.08em] max-md:hidden">keys <b class="text-ink-soft font-semibold">${escapeHtml(km.label.toLowerCase())}</b> · view <b class="text-ink-soft font-semibold">${escapeHtml(state.route.route)}</b></span>`);
  bar.innerHTML = html.join("");
}

export function firstBindingForAction(actionId, keymapId) {
  const map = KEYMAPS[keymapId].bindings;
  for (const [keys, act] of Object.entries(map)) {
    if (act === actionId) return keys;
  }
  return null;
}
/* Legend-bar uses a smaller, flatter kbd than the help overlay. */
export const LEGEND_KBD = "kbd bg-paper border border-rule border-b-2 rounded-sm text-ink px-1.5 py-px font-mono text-[10.5px] leading-[1.4]";
export function keysToHtml(keys) {
  if (!keys) return `<span class="${LEGEND_KBD} opacity-45">·</span>`;
  return keys.split(" ").map(tok =>
    tok.split("+").map(part => `<span class="${LEGEND_KBD}">${escapeHtml(prettyKey(part))}</span>`).join("")
  ).join('<span class="mx-0.5 text-ink-faint">·</span>');
}
