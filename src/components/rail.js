import { escapeHtml, effectiveBody, humanizeName } from "../lib/util.js";
import { renderCard } from "./card.js";

/* Horizontal scroll-snap rail for the dashboard. One per entity type. */

export function renderRail(mountEl, opts) {
  const { type, label, items, query } = opts;
  const visible = filterEntities(items, query);
  // .rail = mt-11
  // .rail-head: flex items-baseline gap-3.5 pb-2.5 border-b border-rule flex-wrap
  // .rail-label: font-sans text-[13px] font-bold tracking-[.32em] uppercase text-ink relative pb-1
  //   ::after underline lives on .rail-label::after but here we mimic with a wrap div if needed; keep .rail-label pseudo as raw rule -- already removed; we add an inline underline.
  // .rail-count: font-mono text-[11px] font-normal text-ink-faint tracking-[.06em]
  // .rail-controls: ml-auto inline-flex items-center gap-2
  // .rail-link: font-sans text-[12.5px] font-semibold text-accent no-underline tracking-[.04em] hover:text-accent-hi
  // .rail-arrow: bg-paper border border-rule w-7 h-7 rounded-sm font-display text-lg text-ink-soft inline-flex items-center justify-center cursor-pointer hover:bg-paper-deep hover:text-ink hover:border-ink-faint
  // .rail-strip: flex gap-6 mt-5 overflow-x-auto px-1 pt-1 pb-4 scroll-snap-type-x-mandatory scrollbar-width-thin
  // .rail-strip .card: flex-[0_0_340px] scroll-snap-align-start m-0
  // mountEl is the section. Original .rail = mt-11. Avoid duplicating "rail".
  if (!mountEl.classList.contains("mt-11")) mountEl.classList.add("mt-11");
  mountEl.innerHTML = `
    <div class="rail-head flex items-baseline gap-3.5 pb-2.5 border-b border-rule flex-wrap relative">
      <h3 class="rail-label font-sans text-[13px] font-bold tracking-[.32em] uppercase text-ink m-0 relative pb-1">
        ${escapeHtml(label)}
        <span class="rail-count font-mono text-[11px] font-normal text-ink-faint tracking-[.06em] ml-1">${visible.length}</span>
        <span aria-hidden="true" class="absolute left-0 -bottom-[10px] w-8 h-0.5 bg-accent"></span>
      </h3>
      <div class="rail-controls ml-auto inline-flex items-center gap-2">
        <a class="rail-link font-sans text-[12.5px] font-semibold text-accent no-underline tracking-[.04em] hover:text-accent-hi" href="#/${type}">View all →</a>
        <button class="rail-arrow bg-paper border border-rule w-7 h-7 rounded-sm font-display text-lg text-ink-soft inline-flex items-center justify-center cursor-pointer transition-colors duration-150 hover:bg-paper-deep hover:text-ink hover:border-ink-faint" data-dir="-1" aria-label="scroll left">‹</button>
        <button class="rail-arrow bg-paper border border-rule w-7 h-7 rounded-sm font-display text-lg text-ink-soft inline-flex items-center justify-center cursor-pointer transition-colors duration-150 hover:bg-paper-deep hover:text-ink hover:border-ink-faint" data-dir="1" aria-label="scroll right">›</button>
      </div>
    </div>
    <div class="rail-strip flex gap-6 mt-5 overflow-x-auto px-1 pt-1 pb-4 [scrollbar-width:thin] [scroll-snap-type:x_mandatory]" id="railStrip-${type}"></div>
  `;
  const strip = mountEl.querySelector(`#railStrip-${type}`);
  if (visible.length === 0) {
    strip.innerHTML = `<div class="rail-empty py-6 px-3 text-ink-mute italic font-display">No ${type} match.</div>`;
  } else {
    visible.forEach((e, i) => {
      const card = renderCard(e);
      // .rail-strip .card original: flex 0 0 340px (280px on small viewports),
      // scroll-snap-align start, m-0. mb-0 already applied; add basis + snap.
      card.classList.add("basis-[280px]", "md:basis-[340px]", "shrink-0", "grow-0", "[scroll-snap-align:start]");
      card.style.animationDelay = `${Math.min(i * 30, 300)}ms`;
      strip.appendChild(card);
    });
  }
  mountEl.querySelectorAll(".rail-arrow").forEach(btn => {
    btn.addEventListener("click", () => {
      const dir = parseInt(btn.dataset.dir, 10);
      strip.scrollBy({ left: dir * (260 + 24) * 2, behavior: "smooth" });
    });
  });
}

export function filterEntities(items, q) {
  if (!q) return items;
  const t = q.trim().toLowerCase();
  if (!t) return items;
  return items.filter(e =>
    (e.name || "").toLowerCase().includes(t) ||
    humanizeName(e.name).toLowerCase().includes(t) ||
    (e.description || "").toLowerCase().includes(t) ||
    (e.category || "").toLowerCase().includes(t) ||
    (e.tags || []).some(tag => tag.toLowerCase().includes(t)) ||
    effectiveBody(e).toLowerCase().includes(t) ||
    (e.slash || "").toLowerCase().includes(t)
  );
}
