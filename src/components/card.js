import { escapeHtml, badgeClass, badgeLabel, isMultiStep, stepBody, copyText, humanizeName } from "../lib/util.js";
import { pushRecently } from "../lib/storage.js";
import { parseHookManpage } from "../lib/parse-manpage-hook.js";
import { navigateTo } from "../router.js";
import { cardAttributionHtml, wireAttributionCopy } from "../lib/attribution.js";

/* Card component. Renders a single entity tile, type-aware. Used by:
 *   - dashboard rails
 *   - dashboard recently-used row
 *   - deep-dive gallery view
 *
 * Click anywhere on the card -> opens deep-dive route #/{type}/{id}.
 * Click the Copy button -> copies the raw canonical file content
 * (prompts/*.md body, skills/SKILL.md body, agents/*.md body, hooks/hook.json). */

// Eyebrow glyph per entity type. Default ◇ preserves the original ternary.
const TYPE_GLYPHS = { prompts: "▢", skills: "◆", agents: "●", hooks: "◇" };

/* Description cap for the Recently-used row. Long entries (compression-engineer
 * et al.) blow out card height otherwise. Tuned to ~5 lines at the narrow
 * 240px basis width. */
const RECENT_DESC_MAX = 140;

export function truncate(str, max) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "").trimEnd() + "…";
}

export function renderCard(entity, opts = {}) {
  const { focused = false, compact = false, recent = false } = opts;
  const t = entity.type;
  const cat = entity.category || "uncategorized";
  const catVar = `var(--cat-${cat}, var(--cat-default))`;
  const card = document.createElement("article");
  // Original .card rule: break-inside avoid, mb-8, bg-paper, border, rounded-sm,
  // shadow-1, overflow-hidden, flex flex-col, cursor pointer. Animation lives
  // in the input.css component layer because keyframes can't be inlined.
  const compactCls = compact
    ? " p-0"
    : "";
  card.className =
    "card group/card relative flex flex-col cursor-pointer bg-paper border border-rule rounded-sm shadow-1 overflow-hidden " +
    "transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:shadow-2 hover:border-ink-faint mb-0 break-inside-avoid" +
    (compact ? " card-compact" : "") + (focused ? " focused" : "");
  card.dataset.id = entity.id;
  card.dataset.type = t;
  card.style.setProperty("--cat-color", catVar);

  const eyebrowExtras = [];
  eyebrowExtras.push(`<span class="core-badge ml-auto ${badgeClass(entity.source)} font-mono text-[9.5px] tracking-[.18em] border border-rule rounded-sm px-1.5 py-0.5 text-ink-mute bg-paper-deep whitespace-nowrap shrink-0 ${badgeColorCls(entity.source)}">${badgeLabel(entity.source)}</span>`);

  const typeGlyph = TYPE_GLYPHS[t] || "◇";

  // Recently-used row skips midSection (tags/ledger/slash) and truncates
  // description - the row is meant for a quick visual reach, not full
  // metadata.
  const midBlock = recent ? "" : midSectionForType(entity);
  const description = recent
    ? truncate(entity.description, RECENT_DESC_MAX)
    : (entity.description || "");
  const footAction = footButtonForType(entity);

  const bodyPad = compact ? "px-5 pt-[18px] pb-[14px]" : "px-7 pt-7 pb-[22px]";
  const titleSize = compact ? "text-lg my-2" : "text-[26px] mt-3.5 mb-2.5";
  const summarySize = compact ? "text-[13.5px]" : "text-[15.5px]";
  const footPad = compact ? "mt-3 pt-2.5" : "mt-5 pt-4";

  card.innerHTML = `
    <div class="card-band h-[3px]" style="background:${catVar}"></div>
    <div class="card-body relative ${bodyPad}" style="--cat-color:${catVar}">
      <div class="card-eyebrow @container/eyebrow flex flex-wrap items-center gap-x-3 gap-y-1.5 font-sans text-[11px] tracking-[.22em] uppercase text-ink-mute font-semibold">
        <span class="type-glyph font-mono text-[13px] mr-0.5" style="color:${catVar}">${typeGlyph}</span>
        <span class="type-label font-mono text-[9.5px] tracking-[.22em] uppercase text-ink-mute bg-paper-deep border border-rule rounded-sm px-1.5 py-0.5">${typeLabel(t)}</span>
        <span class="cat-name basis-full min-w-0 text-ink-soft break-words whitespace-normal order-last @[12rem]/eyebrow:basis-auto @[12rem]/eyebrow:flex-1 @[12rem]/eyebrow:order-none @[12rem]/eyebrow:truncate @[12rem]/eyebrow:whitespace-nowrap @[12rem]/eyebrow:break-normal">${escapeHtml(cat)}</span>
        ${eyebrowExtras.join("")}
      </div>
      <h3 class="card-title font-display italic ${titleSize} leading-[1.18] tracking-[-0.005em] text-ink">${escapeHtml(humanizeName(entity.name))}</h3>
      <p class="card-summary text-ink-soft font-body ${summarySize} leading-[1.55]">${escapeHtml(description)}</p>
      ${midBlock}
      <div class="card-foot ${footPad} border-t border-rule-soft flex justify-between items-center gap-2">
        <span class="meta font-mono text-[10.5px] text-ink-mute tracking-[.08em] uppercase inline-flex items-center gap-2 min-w-0">${cardMeta(entity)}${cardAttributionHtml(entity)}</span>
        <span class="copy-group inline-flex gap-1.5 shrink-0">${footAction}</span>
      </div>
    </div>
  `;
  attachCardHandlers(card, entity);
  wireAttributionCopy(card);
  return card;
}

/* Optional override for core-badge color variants (fork/local). */
export function badgeColorCls(source) {
  if (source === "user-fork" || source === "edited-builtin") return "!text-accent";
  if (source === "user-new" || source === "local") return "!text-ink !border-ink-faint";
  return "";
}

export function typeLabel(t) {
  if (t === "prompts") return "prompt";
  if (t === "hooks") return "hook";
  return t.slice(0, -1);
}

export function midSectionForType(entity) {
  if (entity.type === "skills" && entity.slash) {
    return `<div class="card-mid mt-3"><code class="mid-slash inline-block font-mono text-[11px] bg-code-bg border border-code-border rounded-sm px-2 py-[3px] text-accent tracking-[.04em]">${escapeHtml(entity.slash)}</code></div>`;
  }
  if (entity.type === "agents") {
    return `<div class="card-mid card-mid-ledger mt-3 flex flex-wrap gap-x-4 gap-y-2.5 font-mono text-[11px] text-ink-soft tracking-[.04em]">
      <span><span class="ledger-key text-ink-faint uppercase tracking-[.14em] text-[10px]">model</span> <span class="ledger-val text-ink">${escapeHtml(entity.model || "inherit")}</span></span>
      <span><span class="ledger-key text-ink-faint uppercase tracking-[.14em] text-[10px]">tools</span> <span class="ledger-val text-ink">${escapeHtml(entity.tools || "*")}</span></span>
    </div>`;
  }
  if (entity.type === "hooks" && (entity.event || entity.matcher)) {
    const parts = [];
    if (entity.event) parts.push(`<span><span class="ledger-key text-ink-faint uppercase tracking-[.14em] text-[10px]">event</span> <span class="ledger-val text-ink">${escapeHtml(entity.event)}</span></span>`);
    if (entity.matcher) parts.push(`<span><span class="ledger-key text-ink-faint uppercase tracking-[.14em] text-[10px]">matcher</span> <span class="ledger-val text-ink">${escapeHtml(entity.matcher)}</span></span>`);
    return `<div class="card-mid card-mid-ledger mt-3 flex flex-wrap gap-x-4 gap-y-2.5 font-mono text-[11px] text-ink-soft tracking-[.04em]">${parts.join("")}</div>`;
  }
  const baseTags = (entity.tags || []).slice();
  const isMulti = entity.type === "prompts" && isMultiStep(entity);
  if (isMulti && !baseTags.includes("multi-step")) baseTags.unshift("multi-step");
  if (baseTags.length) {
    return `<div class="card-tags flex flex-wrap gap-x-2 gap-y-1.5 mt-[18px]">${baseTags.map(t => {
      const baseCls = "font-mono text-[10.5px] text-ink-soft bg-code-bg border border-code-border rounded-sm px-[7px] py-0.5 tracking-[.06em]";
      const cls = t === "multi-step" ? `tag tag-multi ${baseCls}` : `tag ${baseCls}`;
      const label = t === "multi-step" && isMulti
        ? `multi-step · ${entity.steps.length}`
        : t;
      return `<span class="${cls}">${escapeHtml(label)}</span>`;
    }).join("")}</div>`;
  }
  return "";
}

export function cardMeta(entity) {
  if (entity.type === "prompts") {
    if (isMultiStep(entity)) {
      const lines = entity.steps.reduce((n, s) => n + (s.body || "").split("\n").length, 0);
      return `${entity.steps.length} steps · ${lines} lines`;
    }
    return `${(entity.body || "").split("\n").length} lines`;
  }
  if (entity.type === "skills") return `skill`;
  if (entity.type === "agents") return `agent`;
  if (entity.type === "hooks") return `hook`;
  return "";
}

export function footButtonForType(entity) {
  // Original .card-foot .copy rule: appearance none, accent border+bg, paper
  // text, px-3.5 py-1.5, rounded-sm, font-sans 12px 600, tracking-wider uppercase,
  // inline-flex gap-1.5; hover: accent-hi.
  const COPY = "copy appearance-none border border-accent bg-accent text-paper px-3.5 py-1.5 rounded-sm font-sans text-[12px] font-semibold tracking-[.08em] uppercase inline-flex items-center gap-1.5 transition-colors duration-150 hover:bg-accent-hi hover:border-accent-hi";
  if (entity.type === "prompts" && isMultiStep(entity)) {
    return entity.steps.map((s, i) =>
      `<button class="${COPY}" data-act="copy-step" data-step="${i}" title="${escapeHtml(s.label || "Step " + (i+1))}">Copy ${i + 1}</button>`
    ).join("");
  }
  if (entity.type === "skills") {
    return `<button class="${COPY}" data-act="copy">Copy SKILL.md</button>`;
  }
  if (entity.type === "agents") {
    return `<button class="${COPY}" data-act="copy">Copy AGENT.md</button>`;
  }
  if (entity.type === "hooks") {
    return `<button class="${COPY}" data-act="copy">Copy hook.json</button>`;
  }
  return `<button class="${COPY}" data-act="copy">Copy</button>`;
}

export function attachCardHandlers(card, entity) {
  card.addEventListener("click", (e) => {
    const stepBtn = e.target.closest('[data-act="copy-step"]');
    if (stepBtn) { e.stopPropagation(); copyStep(entity, parseInt(stepBtn.dataset.step, 10)); return; }
    if (e.target.closest('[data-act="copy"]')) { e.stopPropagation(); copyEntity(entity); return; }
    // Plain click → navigate to deep-dive
    pushRecently(entity.type, entity.id);
    navigateTo(`#/${entity.type}/${entity.id}`);
  });
}

/* Copy a step body (multi-step prompts). */
export function copyStep(p, idx) {
  const text = stepBody(p, idx);
  const label = humanizeName(p.name);
  copyText(text, `${label}, step ${idx + 1}`);
}

/* Copy the raw canonical file content per type. */
export function copyEntity(entity) {
  const label = humanizeName(entity.name);
  if (entity.type === "prompts") {
    if (isMultiStep(entity)) return copyStep(entity, 0);
    return copyText(entity.body || "", `${label} prompt.md`);
  }
  if (entity.type === "skills") return copyText(entity.body || "", `${label} SKILL.md`);
  if (entity.type === "agents") return copyText(entity.body || "", `${label} AGENT.md`);
  if (entity.type === "hooks") {
    const { snippet } = parseHookManpage(entity);
    return copyText(snippet || entity.body || "", `${label} hook.json`);
  }
}
