import { escapeHtml } from "../lib/util.js";
import { allOfType, allEntities } from "../lib/storage.js";
import { CATEGORIES } from "../data/categories.data.js";
import { ENTITY_FOLDERS } from "../lib/group-entities.js";
import { toggleCategory } from "./chip-filter.js";
import { openEditModal } from "./modal-edit.js";

/* Search input + category filter chips. Mounted by views that need it
 * (deep-dive currently). Dashboard has its own search row.
 *
 * Chip model: single-select (radio). One category active at a time, or
 * "All" when no category is active. Visual baseline is identical across
 * chips; the pressed chip is the only one in the accent color. */

export function renderSearchToolbar(mountEl, state, onChange) {
  // toolbar shell utilities are applied to the mount element by deep-dive.js
  // (`class="toolbar"`). Add Tailwind utilities here so the original styling
  // moves with the markup.
  // Toolbar shell: stack on small viewports, flex row from md up. Flex
  // (rather than grid) so the three slots reclaim space cleanly if any
  // child is conditionally hidden in the future.
  if (!mountEl.classList.contains("mt-6")) {
    mountEl.classList.add(
      "mt-6", "pt-4", "pb-[18px]", "flex", "flex-col", "gap-[18px]",
      "items-stretch", "border-b", "border-dashed", "border-rule",
      "md:flex-row", "md:items-center"
    );
  }
  // "New" button always visible on entity-type routes. Pre-selects the
  // current route's type so the modal opens on the right tab. Worker
  // persistence + drag-drop folder ingest land in Phases 4/5; for now
  // entries persist to localStorage.
  const NEW_BTN = "new-btn shrink-0 self-start md:self-auto appearance-none border border-accent bg-accent text-paper px-3.5 py-1.5 rounded-sm font-sans text-[12.5px] font-semibold tracking-[.08em] uppercase inline-flex items-center gap-1.5 transition-colors duration-150 hover:bg-accent-hi hover:border-accent-hi cursor-pointer";
  const newBtnHtml = `<button id="toolbarNewBtn" type="button" class="${NEW_BTN}" title="New ${escapeHtml(state.route.route.slice(0, -1))} (n)"><span aria-hidden="true">+</span> New</button>`;

  mountEl.innerHTML = `
    <div class="search relative w-full md:max-w-[560px]">
      <span class="search-glyph absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute font-mono text-[13px]">/</span>
      <input id="searchInput" type="text" placeholder="Search ${state.route.route}..."
             autocomplete="off" spellcheck="false" value="${escapeHtml(state.query)}"
             class="appearance-none w-full bg-paper-deep border border-rule rounded-sm py-2 pl-9 pr-3.5 text-ink text-sm font-sans transition-colors duration-150 focus:outline-none focus:border-accent focus:bg-paper placeholder:text-ink-faint" />
      <kbd class="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] px-1.5 py-px border border-rule rounded text-ink-mute bg-paper">/</kbd>
    </div>
    <div class="chips flex-1 min-w-0 flex flex-wrap gap-2 items-center" id="catChips"></div>
    ${newBtnHtml}
  `;
  const input = mountEl.querySelector("#searchInput");
  input.addEventListener("input", e => { state.query = e.target.value; onChange(); });

  renderChips(mountEl.querySelector("#catChips"), state, onChange);

  const btn = mountEl.querySelector("#toolbarNewBtn");
  if (btn) btn.addEventListener("click", () => {
    const type = state.route.route;
    const sourceType = ENTITY_FOLDERS.includes(type) ? type : "prompts";
    openEditModal({ mode: "new", sourceType });
  });
}

export const CHIP_CLS = "chip group/chip appearance-none border border-rule bg-paper-deep text-ink pl-[11px] pr-3 py-1.5 rounded-sm font-sans text-[12.5px] font-semibold inline-flex items-center gap-2 tracking-[.04em] transition-colors duration-150 hover:bg-paper-edge hover:border-ink-faint aria-pressed:bg-accent aria-pressed:text-paper aria-pressed:border-accent aria-pressed:hover:bg-accent-hi aria-pressed:hover:border-accent-hi";
export const SWATCH_CLS = "swatch w-[9px] h-[9px] rounded-sm inline-block bg-[var(--ink-faint)] group-aria-pressed/chip:bg-paper";
export const COUNT_CLS = "chip-count font-mono text-[10.5px] text-ink-faint tracking-[.06em] font-normal group-aria-pressed/chip:text-paper/65";

export function renderChips(wrap, state, onChange) {
  const refresh = () => { renderChips(wrap, state, onChange); onChange(); };
  wrap.innerHTML = "";
  const items = currentTypeEntities(state);

  wrap.appendChild(buildChip({
    label: "All",
    count: items.length,
    pressed: !state.activeCategory,
    onClick: () => { state.activeCategory = ""; refresh(); }
  }));

  const counts = {};
  items.forEach(e => counts[e.category] = (counts[e.category] || 0) + 1);
  CATEGORIES.forEach(cat => {
    if (!counts[cat]) return;
    wrap.appendChild(buildChip({
      label: cat,
      count: counts[cat],
      pressed: state.activeCategory === cat,
      onClick: () => { state.activeCategory = toggleCategory(state.activeCategory, cat); refresh(); }
    }));
  });
}

export function buildChip({ label, count, pressed, onClick }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = CHIP_CLS;
  btn.setAttribute("aria-pressed", pressed ? "true" : "false");
  btn.innerHTML = `<span class="${SWATCH_CLS}"></span>${escapeHtml(label)}<span class="${COUNT_CLS}">${count}</span>`;
  btn.addEventListener("click", onClick);
  return btn;
}

export function currentTypeEntities(state) {
  const t = state.route.route;
  if (ENTITY_FOLDERS.includes(t)) return allOfType(t);
  return allEntities();
}
