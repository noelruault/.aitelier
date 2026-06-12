import { loadRecently, findEntity } from "../lib/storage.js";
import { renderCard } from "./card.js";

/* Mixed-type "Recently used" row. Reads from localStorage aitelier-recently-v1. */

export function renderRecentlyUsed(mountEl) {
  // mountEl is <section class="recent-section">. Original .recent-section = mt-11.
  if (!mountEl.classList.contains("mt-11")) mountEl.classList.add("mt-11");
  const recent = loadRecently();
  const railLabel = "rail-label font-sans text-[13px] font-bold tracking-[.32em] uppercase text-ink m-0 relative pb-1";
  const railCount = "rail-count font-mono text-[11px] font-normal text-ink-faint tracking-[.06em] ml-1";
  if (!recent.length) {
    mountEl.innerHTML = `
      <h3 class="${railLabel}">Recently used <span class="${railCount}">0</span></h3>
      <div class="recent-empty mt-3 font-display italic text-base text-ink-faint">Nothing opened yet. Click any card on a rail below to start tracking.</div>
    `;
    return;
  }
  const items = recent
    .map(r => findEntity(r.type, r.id))
    .filter(Boolean)
    .slice(0, 5);
  mountEl.innerHTML = `
    <h3 class="${railLabel}">Recently used <span class="${railCount}">${items.length}</span></h3>
    <div class="recent-row flex gap-[18px] mt-4 overflow-x-auto pb-2 [scrollbar-width:thin]" id="recentRow"></div>
  `;
  const row = mountEl.querySelector("#recentRow");
  items.forEach(e => {
    const card = renderCard(e, { recent: true });
    // .recent-card: flex 0 0 240px
    card.classList.add("recent-card", "basis-[240px]", "shrink-0", "grow-0");
    row.appendChild(card);
  });
}
