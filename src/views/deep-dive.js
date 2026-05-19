import { allOfType } from "../lib/storage.js";
import { escapeHtml } from "../lib/util.js";
import { renderSearchToolbar } from "../components/search-toolbar.js";
import { renderManpageView } from "../components/manpage.js";
import { renderCard } from "../components/card.js";
import { applyCategoryFilter } from "../components/chip-filter.js";
import { filterEntities } from "../components/rail.js";

/* Deep-dive view. Renders gallery (no id in route) or manpage (id in route)
 * for a single entity type. */

export function mountDeepDive(state) {
  const main = document.getElementById("main");
  const type = state.route.route;
  if (!main.classList.contains("max-w-[1320px]")) {
    main.classList.add("max-w-[1320px]", "mx-auto", "px-8", "pb-24");
  }
  if (state.route.id) {
    main.innerHTML = `<div class="deep-dive deep-dive-manpage" id="deepDive"></div>`;
    renderManpageView(document.getElementById("deepDive"), state);
    return;
  }

  // Gallery mode
  main.innerHTML = `
    <header class="masthead pt-10 pb-6 border-b border-rule flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
      <div class="brand flex-1 min-w-0 flex flex-col gap-1.5">
        <div class="brand-eyebrow font-mono text-[11px] tracking-[.22em] uppercase text-ink-mute">
          <span class="dot inline-block w-1.5 h-1.5 bg-clay rounded-full mr-2 align-[1px] shadow-[0_0_0_3px_rgba(196,74,42,.18)]"></span>${escapeHtml(type)} library
        </div>
        <h1 class="brand-title font-display font-normal italic text-[clamp(36px,5.4vw,60px)] leading-[.95] tracking-[-0.015em] mt-1 mb-0">${escapeHtml(type[0].toUpperCase() + type.slice(1))}</h1>
        <p class="brand-lede mt-3 max-w-[64ch] text-ink-soft font-body text-[15.5px] leading-[1.55]">All ${escapeHtml(type)} in one place. Click any card to open the full manpage view.</p>
      </div>
      <div class="masthead-meta shrink-0 flex gap-4 items-end text-left font-mono text-[11px] tracking-[.14em] uppercase text-ink-mute leading-[1.4] flex-wrap md:text-right [&>div]:font-mono [&>div]:text-[11px] [&>div]:tracking-[.14em] [&>div]:uppercase [&>div]:text-ink-mute [&>div]:leading-[1.4]">
        <div>${escapeHtml(type)}<span class="num text-ink text-[22px] font-display italic tracking-normal normal-case block mt-0.5">${allOfType(type).length}</span></div>
        <div>local<span class="num text-ink text-[22px] font-display italic tracking-normal normal-case block mt-0.5">${allOfType(type).filter(e => e.source !== "builtin").length}</span></div>
      </div>
    </header>

    <div class="toolbar" id="toolbar"></div>

    <section class="gallery-region mt-9">
      <div class="gallery grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-6 md:gap-8 items-start mt-6 md:mt-9" id="galleryGrid"></div>
      <div class="empty py-16 px-5 text-center text-ink-mute italic font-display text-[22px]" id="galleryEmpty" style="display:none;">No ${escapeHtml(type)} match.</div>
    </section>
  `;
  renderSearchToolbar(document.getElementById("toolbar"), state, () => renderGallery(state));
  renderGallery(state);
}

export function renderGallery(state) {
  const grid = document.getElementById("galleryGrid");
  const empty = document.getElementById("galleryEmpty");
  if (!grid) return;
  const type = state.route.route;
  let items = allOfType(type);
  items = applyCategoryFilter(items, state.activeCategory);
  items = filterEntities(items, state.query);
  grid.innerHTML = "";
  if (!items.length) { empty.style.display = ""; return; }
  empty.style.display = "none";
  items.forEach((e, i) => {
    const card = renderCard(e);
    card.style.animationDelay = `${Math.min(i * 30, 400)}ms`;
    grid.appendChild(card);
  });
}
