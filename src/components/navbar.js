import { KEYMAPS } from "../data/keymaps.data.js";
import { escapeHtml, toast } from "../lib/util.js";
import { BTN } from "../lib/ui-classes.js";
import { loadEditRequests, saveKeymapPref } from "../lib/storage.js";
import { clearChord } from "../lib/keys.js";
import { renderLegendFooter } from "./legend-footer.js";
import { openRequestsList } from "./modal-requests-list.js";
import { renderHelpOverlay, toggleHelpOverlay } from "../app.js";
import { getCapabilitiesSync } from "../data/capabilities.js";

/* Top navbar. Renders into #navbar. Highlights the active route.
 * Owns the keymap selector and the edit-requests counter button so the
 * markup survives route changes. */

export function renderNavbar(state) {
  const el = document.getElementById("navbar");
  if (!el) return;
  const r = state.route.route;

  const keymapOptions = Object.entries(KEYMAPS).map(([id, km]) =>
    `<option value="${id}" ${id === state.keymap ? "selected" : ""}>${escapeHtml(km.label)}</option>`
  ).join("");

  const reqCount = loadEditRequests().length;

  // navbar gradient + border-bottom stays in input.css. Add sticky+backdrop here.
  el.classList.add("sticky", "top-0", "z-50", "border-b", "border-rule", "backdrop-blur-[6px]");

  // BTN class string is the shared constant from src/lib/ui-classes.js.
  // Active route uses `aria-current="page"` so Tailwind's native
  // `aria-[current=page]:` variant carries the pressed colours; the link
  // also keeps its `hover:` chain locked to the active colours so a
  // mouseover does not visually unset the indicator.
  const NAV_LINK = "font-sans text-[12.5px] font-semibold tracking-[.04em] text-ink-soft no-underline px-2 md:px-3.5 py-[7px] rounded-sm transition-colors duration-150 whitespace-nowrap hover:bg-paper-deep hover:text-ink aria-[current=page]:bg-ink aria-[current=page]:text-paper aria-[current=page]:hover:bg-ink aria-[current=page]:hover:text-paper";
  const navCurrent = (target) => r === target ? "page" : "false";

  el.innerHTML = `
    <div class="nav-inner max-w-[1320px] mx-auto px-4 py-3.5 flex items-center gap-4 flex-wrap md:px-8 md:gap-6 md:flex-nowrap">
      <a class="nav-brand inline-flex items-center gap-2 font-display italic text-[22px] text-ink no-underline tracking-[-0.01em]" href="#/">
        <span class="brand-dot inline-block w-2 h-2 bg-clay rounded-full shadow-[0_0_0_3px_rgba(196,74,42,.18)]"></span>
        <span class="brand-name">Aitelier</span>
      </a>
      <div class="nav-links order-3 basis-full md:order-none md:basis-auto flex gap-1 ml-0 flex-wrap md:ml-3 md:flex-nowrap">
        <a class="${NAV_LINK}" href="#/"          aria-current="${navCurrent("dashboard")}">Dashboard</a>
        <a class="${NAV_LINK}" href="#/prompts"   aria-current="${navCurrent("prompts")}">Prompts</a>
        <a class="${NAV_LINK}" href="#/skills"    aria-current="${navCurrent("skills")}">Skills</a>
        <a class="${NAV_LINK}" href="#/agents"    aria-current="${navCurrent("agents")}">Agents</a>
        <a class="${NAV_LINK}" href="#/hooks"     aria-current="${navCurrent("hooks")}">Hooks</a>
      </div>
      <div class="nav-meta ml-auto flex gap-3.5 items-center font-mono text-[10.5px] tracking-[.14em] uppercase text-ink-mute flex-wrap">
        <label class="keymap-toggle hidden md:inline-flex items-center gap-2 py-0.5 pl-3 pr-1 border border-rule rounded-sm bg-paper-deep text-ink-soft font-mono text-[10.5px] tracking-[.18em] uppercase" title="Keyboard mode">
          <span class="label text-ink-mute">keys</span>
          <select id="keymapSelect" aria-label="Keyboard mode" class="appearance-none border-0 bg-paper text-ink rounded-sm py-1 pl-2.5 pr-6 font-mono text-[10.5px] tracking-[.18em] uppercase cursor-pointer focus:outline focus:outline-2 focus:outline-accent focus:outline-offset-2">${keymapOptions}</select>
        </label>
        ${getCapabilitiesSync().edits ? `<button class="${BTN} nav-req-btn" id="navRequestsBtn" title="Edit requests">
          Edit reqs
          <span class="counter-pip inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 ml-1.5 font-mono text-[10.5px] bg-clay text-paper rounded-full" id="reqCounter" style="${reqCount ? "" : "display:none;"}">${reqCount}</span>
        </button>` : ""}
        <button class="${BTN} nav-help-btn hidden md:inline-flex" id="navHelpBtn" title="Shortcuts (?)">?</button>
        <a class="nav-github-btn inline-flex items-center text-ink-soft hover:text-ink transition-colors duration-150"
           href="https://github.com/noelruault/.aitelier"
           target="_blank" rel="noopener noreferrer"
           title="View source on GitHub" aria-label="View source on GitHub">
          <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </a>
      </div>
    </div>
  `;

  document.getElementById("keymapSelect").addEventListener("change", e => {
    state.keymap = e.target.value;
    saveKeymapPref(state.keymap);
    clearChord();
    toast(`Keymap: ${KEYMAPS[state.keymap].label}`);
    renderLegendFooter(state);
    const help = document.getElementById("helpOverlay");
    if (help && help.classList.contains("open")) renderHelpOverlay();
  });
  document.getElementById("navRequestsBtn")?.addEventListener("click", openRequestsList);
  document.getElementById("navHelpBtn").addEventListener("click", toggleHelpOverlay);
}
