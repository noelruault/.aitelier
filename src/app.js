import { cssEscape, escapeHtml, prettyKey } from "./lib/util.js";
import { KBD, BTN_PRIMARY } from "./lib/ui-classes.js";
import { bindBackdropClose } from "./lib/modal-helpers.js";
import { normalizeKey, dispatchKey } from "./lib/keys.js";
import { loadKeymapPref, findById, allEntities, allOfType } from "./lib/storage.js";
import { KEYMAPS, ACTION_META } from "./data/keymaps.data.js";
import { parseHashRoute, navigateTo } from "./router.js";
import { renderNavbar } from "./components/navbar.js";
import { renderLegendFooter } from "./components/legend-footer.js";
import { copyEntity } from "./components/card.js";
import { filterEntities } from "./components/rail.js";
import { applyCategoryFilter } from "./components/chip-filter.js";
import { mountDashboard, unmountDashboard } from "./views/dashboard.js";
import { mountDeepDive } from "./views/deep-dive.js";
import { primeCapabilities } from "./data/capabilities.js";

/* App entry. Owns global state. Wires router + keydown + first render. */

export const state = {
  route: { route: "dashboard", id: null },
  query: "",
  activeCategory: "",
  focusedId: null,
  currentId: null,
  keymap: "normal"
};

/* ============================================================== render */

export function rerender() {
  renderNavbar(state);
  if (state.route.route === "dashboard") mountDashboard(state);
  else mountDeepDive(state);
  renderLegendFooter(state);
}

export function onRouteChange() {
  const prev = state.route;
  state.route = parseHashRoute();
  if (prev && prev.route === "dashboard" && state.route.route !== "dashboard") unmountDashboard();
  // Reset transient state on route change
  state.query = "";
  state.activeCategory = "";
  state.focusedId = null;
  state.currentId = state.route.id || null;
  rerender();
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ============================================================== action plumbing */

export function focusSearch() {
  const el = document.getElementById("searchInput") || document.getElementById("dashSearch");
  if (el) { el.focus(); el.select(); }
}

export function focusedEntity() {
  if (state.focusedId) return findById(state.focusedId);
  if (state.currentId) return findById(state.currentId);
  // Fall back to first visible entity in current view.
  if (state.route.route === "dashboard") return allEntities()[0] || null;
  return allOfType(state.route.route)[0] || null;
}

export function moveFocus(delta) {
  const list = visibleEntities();
  if (!list.length) return;
  let idx = list.findIndex(e => e.id === state.focusedId);
  if (idx < 0) idx = 0;
  const next = Math.max(0, Math.min(list.length - 1, idx + delta));
  state.focusedId = list[next].id;
  if (state.route.id) {
    // In manpage view, focusing = navigating
    navigateTo(`#/${list[next].type}/${list[next].id}`);
  } else {
    highlightFocused();
  }
}
export function jumpFocus(pos) {
  const list = visibleEntities();
  if (!list.length) return;
  const next = pos === "first" ? list[0] : list[list.length - 1];
  state.focusedId = next.id;
  if (state.route.id) navigateTo(`#/${next.type}/${next.id}`);
  else highlightFocused();
}

export function visibleEntities() {
  if (state.route.route === "dashboard") {
    const all = allEntities();
    return filterEntities(all, state.query);
  }
  let items = allOfType(state.route.route);
  items = applyCategoryFilter(items, state.activeCategory);
  return filterEntities(items, state.query);
}

export function highlightFocused() {
  document.querySelectorAll(".card.focused").forEach(c => c.classList.remove("focused"));
  if (!state.focusedId) return;
  const card = document.querySelector(`.card[data-id="${cssEscape(state.focusedId)}"]`);
  if (card) {
    card.classList.add("focused");
    card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

export function goView(mode) {
  // From deep-dive manpage, "gallery" means strip the id; "manpage" picks the first.
  if (state.route.route === "dashboard") return;
  if (mode === "gallery") navigateTo(`#/${state.route.route}`);
  else if (mode === "manpage") {
    const first = focusedEntity() || allOfType(state.route.route)[0];
    if (first) navigateTo(`#/${state.route.route}/${first.id}`);
  }
}

export function toggleHelpOverlay() {
  const el = document.getElementById("helpOverlay");
  if (!el) return;
  el.classList.toggle("open");
  if (el.classList.contains("open")) renderHelpOverlay();
}
export function renderHelpOverlay() {
  const el = document.getElementById("helpOverlay");
  if (!el) return;
  const km = KEYMAPS[state.keymap];
  el.querySelector("#helpKeymapName").textContent = `${km.label.toLowerCase()}, ${km.description}`;
  const body = el.querySelector("#helpBody");
  body.innerHTML = "";
  const byAction = {};
  Object.entries(km.bindings).forEach(([keys, act]) => { if (!act) return; (byAction[act] ||= []).push(keys); });
  const HELP_KBD = KBD;
  Object.entries(ACTION_META).forEach(([act, meta]) => {
    const keysArr = byAction[act];
    if (!keysArr || !keysArr.length) return;
    const row = document.createElement("div");
    // .help-card .shortcut-row: flex items-center justify-between py-2 border-b border-dashed border-rule; last:border-b-0
    row.className = "shortcut-row flex items-center justify-between py-2 border-b border-dashed border-rule last:border-b-0";
    const keysHtml = keysArr.map(seq =>
      seq.split(" ").map(tok =>
        tok.split("+").map(part => `<span class="${HELP_KBD}">${escapeHtml(prettyKey(part))}</span>`).join("")
      ).join('<span style="margin: 0 2px; color: var(--ink-faint);">·</span>')
    ).join('<span style="margin: 0 6px; color: var(--ink-faint); font-style: italic;">or</span>');
    row.innerHTML = `<span class="desc text-ink-soft text-[13.5px]">${escapeHtml(meta.label)}</span><span class="keys inline-flex gap-1">${keysHtml}</span>`;
    body.appendChild(row);
  });
}

export function handleEscape() {
  const modals = ["editModalBack", "reqModalBack", "reqListBack"];
  for (const m of modals) {
    const el = document.getElementById(m);
    if (el && el.classList.contains("open")) { el.classList.remove("open"); return; }
  }
  const help = document.getElementById("helpOverlay");
  if (help && help.classList.contains("open")) { help.classList.remove("open"); return; }
  const search = document.getElementById("searchInput") || document.getElementById("dashSearch");
  if (search && document.activeElement === search) {
    search.value = ""; state.query = ""; search.blur(); rerender();
    return;
  }
  // No modal / no search focus: drop any active filters (search query +
  // category chip). Esc on a "clean" view falls through to blur.
  if (state.query || state.activeCategory) {
    state.query = "";
    state.activeCategory = "";
    rerender();
    return;
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

/* ============================================================== help overlay scaffold */

export function ensureHelpOverlay() {
  if (document.getElementById("helpOverlay")) return;
  // BTN_PRIMARY comes from src/lib/ui-classes.js.
  document.body.insertAdjacentHTML("beforeend", `
    <div class="help" id="helpOverlay" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
      <div class="help-card relative bg-paper border border-rule rounded px-6 py-6 md:px-8 md:py-7 max-w-[480px] w-full max-h-[85vh] overflow-y-auto shadow-3">
        <button class="help-x absolute top-2.5 right-2.5 w-9 h-9 inline-flex items-center justify-center bg-transparent border-0 text-ink-mute hover:text-ink text-[22px] leading-none rounded-sm cursor-pointer" id="helpX" aria-label="Close">&times;</button>
        <h4 id="helpTitle" class="font-display italic text-[26px] m-0 mb-1 pr-10">Keyboard shortcuts</h4>
        <p class="help-sub text-ink-mute text-[12.5px] m-0 mb-[18px] font-mono tracking-[.08em] uppercase">keymap: <span id="helpKeymapName">normal</span></p>
        <div id="helpBody"></div>
        <div class="help-foot mt-[18px] pt-3.5 border-t border-rule flex justify-end">
          <button class="${BTN_PRIMARY}" id="helpClose">Got it <span class="kbd hidden md:inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 font-mono text-[11.5px]" style="margin-left:6px;background:transparent;border:1px solid rgba(244,237,226,.4);border-radius:4px;color:var(--paper)">Esc</span></button>
        </div>
      </div>
    </div>
  `);
  const overlay = document.getElementById("helpOverlay");
  const close = () => overlay.classList.remove("open");
  document.getElementById("helpClose").addEventListener("click", close);
  document.getElementById("helpX").addEventListener("click", close);
  bindBackdropClose(overlay, close);
}

/* ============================================================== keydown dispatcher */

export function onKeyDown(e) {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
  const inSearch = typing && ["searchInput", "dashSearch"].includes(document.activeElement.id);
  const modalOpen = ["editModalBack", "reqModalBack", "reqListBack"].some(id => {
    const el = document.getElementById(id);
    return el && el.classList.contains("open");
  });

  if (e.key === "Escape") { handleEscape(); return; }

  if (inSearch) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); moveFocus(-1); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const ent = focusedEntity();
      if (!ent) return;
      if (e.metaKey || e.ctrlKey) { navigateTo(`#/${ent.type}/${ent.id}`); copyEntity(ent); }
      else copyEntity(ent);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const el = document.activeElement;
      el.value = ""; state.query = ""; rerender(); focusSearch();
      return;
    }
    return;
  }

  if (typing || modalOpen) return;

  const token = normalizeKey(e);
  const handled = dispatchKey(token, state.keymap);
  if (handled) {
    const blocky = ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Backspace", "Enter", "/"];
    if (blocky.includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) e.preventDefault();
  }
}

/* ============================================================== init */

export async function init() {
  state.keymap = loadKeymapPref();
  ensureHelpOverlay();
  window.addEventListener("hashchange", onRouteChange);
  document.addEventListener("keydown", onKeyDown);
  try {
    await Promise.all([window.__dataReady, primeCapabilities()]);
  } catch (err) {
    const main = document.getElementById("main");
    if (main) main.innerHTML = `<pre style="padding:24px;color:#7a1c1c;">Failed to load entities: ${escapeHtml(String(err && err.message || err))}</pre>`;
    return;
  }
  onRouteChange();
}

// Auto-boot the SPA unless a tool explicitly opted out (e.g. demo/galaxy.html
// transitively imports app.js via galaxy → router - we don't want the
// dashboard to mount over a standalone demo page).
if (typeof window !== "undefined" && !window.__atelierSkipBoot) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
