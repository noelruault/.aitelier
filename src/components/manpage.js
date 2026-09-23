import { allOfType, findById } from "../lib/storage.js";
import { escapeHtml, badgeLabel, isMultiStep, copyText, humanizeName } from "../lib/util.js";
import { BTN } from "../lib/ui-classes.js";
import { parseSkillManpage } from "../lib/parse-manpage-skill.js";
import { parseAgentManpage } from "../lib/parse-manpage-agent.js";
import { parseHookManpage } from "../lib/parse-manpage-hook.js";
import { renderAttachments } from "./attachments.js";
import { ENTITY_SHAPES } from "../data/load-entities.js";
import { findEntityShape } from "../lib/group-entities.js";
import { renderMarkdown, inlineFmt } from "../lib/parse-markdown.js";
import { CATEGORIES } from "../data/categories.data.js";
import { RELATED } from "../data/load-entities.js";
import { navigateTo } from "../router.js";
import { copyStep, copyEntity } from "./card.js";
import { openEditModal, duplicateEntity, deleteEntity } from "./modal-edit.js";
import { openRequestModal } from "./modal-request.js";
import { eyebrowAttributionHtml, wireAttributionCopy, attributionMetaRows } from "../lib/attribution.js";
import { getCapabilitiesSync } from "../data/capabilities.js";

/* Manpage detail view. Three-column layout: cat-rail | doc | toc-rail.
 * Body rendering delegates to lib/parse-manpage-{prompt,skill,agent}.
 * Used by deep-dive view at #/{type}/{id}. */

export function renderManpageView(mountEl, state) {
  const type = state.route.route;
  const items = allOfType(type);
  if (!items.length) {
    mountEl.innerHTML = `<div class="empty py-16 px-5 text-center text-ink-mute italic font-display text-[22px]">No ${escapeHtml(type)} found.</div>`;
    return;
  }
  const currentId = state.route.id;
  const current = items.find(e => e.id === currentId) || items[0];
  state.currentId = current.id;

  // Flex row of three siblings: cat-rail | doc | toc-rail. Each rail has a
  // fixed width and `shrink-0`; the doc takes the remaining space via
  // `flex-1 min-w-0`. Responsive hides come from arbitrary-value variants
  // (max-[820px]:hidden, max-[1100px]:hidden) so the breakpoints live on
  // the element, not in a separate CSS file. When either rail is hidden,
  // flex reclaims its slot - that is why this layout is flex, not grid.
  // On viewports < md the section stacks (flex-col) and the doc renders
  // alone. The `.cat-list` and `.cat-rail` / `.toc-rail` class names are
  // kept as semantic identifiers; only `.cat-list` is read by JS.
  mountEl.innerHTML = `
    <section class="mt-9 flex flex-col gap-8 md:flex-row md:items-start md:gap-10 2xl:gap-12">
      <aside class="cat-rail w-[220px] shrink-0 sticky top-[80px] max-h-[calc(100vh-76px)] overflow-y-auto pr-2 2xl:w-[280px] max-[820px]:hidden" id="catRail"></aside>
      <article class="doc flex-1 min-w-0 max-w-[780px] mx-auto px-2 pb-24" id="docPane"></article>
      <aside class="toc-rail w-[260px] shrink-0 sticky top-[80px] max-h-[calc(100vh-76px)] overflow-y-auto pl-3 border-l border-rule max-[1100px]:hidden" id="tocRail"></aside>
    </section>
  `;
  renderCatRail(items, current, state);
  renderDocPane(current, state);
  renderTocRail(current);
}

export function renderCatRail(items, current, state) {
  const rail = document.getElementById("catRail");
  rail.innerHTML = `<div class="rail-eyebrow font-sans text-[11px] tracking-[.26em] uppercase text-ink-mute font-semibold m-0 mb-4 pb-2.5 border-b border-rule">${escapeHtml(state.route.route)}</div>`;
  // Render known categories first, then an explicit "Uncategorized" bucket
  // at the bottom for sidecar-less entries (plan §"Uncategorized rail bucket"
  // open question - Uncategorized wins for discoverability).
  const groups = CATEGORIES.map(cat => ({ cat, swatch: true, items: items.filter(e => e.category === cat) }));
  const uncategorized = items.filter(e => !e.category);
  if (uncategorized.length) groups.push({ cat: "uncategorized", swatch: false, items: uncategorized });
  groups.forEach(({ cat, swatch, items: inCat }) => {
    if (!inCat.length) return;
    const group = document.createElement("div");
    group.className = "cat-group mb-[22px]";
    const swatchHtml = swatch
      ? `<span class="cat-swatch w-[9px] h-[9px] rounded-sm" style="background:var(--cat-${cat})"></span>`
      : `<span class="cat-swatch w-[9px] h-[9px] rounded-sm border border-rule bg-paper-deep"></span>`;
    group.innerHTML = `
      <div class="cat-head flex items-center gap-2.5 mb-2.5 cursor-pointer select-none">
        ${swatchHtml}
        <span class="cat-label font-sans text-[11.5px] tracking-[.2em] uppercase text-ink-soft font-semibold">${escapeHtml(cat)}</span>
        <span class="cat-count font-mono text-[10.5px] text-ink-faint ml-auto">${inCat.length}</span>
      </div>
      <ul class="cat-list list-none m-0 pl-[18px] border-l border-rule"></ul>
    `;
    const ul = group.querySelector(".cat-list");
    inCat.forEach(e => {
      const li = document.createElement("li");
      // Active state flows from `aria-current="page"` via Tailwind variants.
      // The left-bar indicator stays as a pseudo-element in input.css
      // (utilities cannot express ::before content) - it is rekeyed to the
      // same [aria-current=page] selector so it follows the attribute, not
      // a class.
      li.className = "py-1.5 pr-2.5 pl-3 text-ink-soft font-body text-[14.5px] rounded-sm cursor-pointer transition-colors duration-100 relative hover:bg-paper-deep hover:text-ink aria-[current=page]:bg-paper-deep aria-[current=page]:text-ink aria-[current=page]:font-semibold";
      li.textContent = humanizeName(e.name);
      if (e.name === current.name) li.setAttribute("aria-current", "page");
      li.addEventListener("click", () => navigateTo(`#/${e.type}/${e.name}`));
      ul.appendChild(li);
    });
    rail.appendChild(group);
  });
}

export function renderDocPane(entity, state) {
  const pane = document.getElementById("docPane");
  pane.innerHTML = "";
  const cat = entity.category || "uncategorized";
  const catColor = `var(--cat-${cat}, var(--cat-default))`;
  const typeLabel = entity.type === "prompts" ? "prompt" : entity.type === "hooks" ? "hook" : entity.type.slice(0, -1);
  const multi = entity.type === "prompts" && isMultiStep(entity);

  const topActions = topActionsFor(entity);
  const swatchHtml = entity.category
    ? `<span class="cat-swatch w-2.5 h-2.5 rounded-sm" style="background:${catColor}"></span>`
    : "";

  const head = document.createElement("header");
  head.className = "doc-head border-t-2 border-ink pt-6 pb-7 mb-9 border-b border-rule";
  head.innerHTML = `
    <div class="doc-eyebrow font-mono text-[11px] tracking-[.22em] uppercase text-ink-faint flex gap-3 items-center flex-wrap">
      ${swatchHtml}
      <span>${escapeHtml(typeLabel)}</span>
      <span class="sep text-ink-faint opacity-60">·</span>
      <span>${escapeHtml(cat)}</span>
      <span class="sep text-ink-faint opacity-60">·</span>
      <span>${escapeHtml(entity.name)}</span>
      <span class="sep text-ink-faint opacity-60">·</span>
      <span>${badgeLabel(entity.source)}</span>
      ${multi ? `<span class="sep text-ink-faint opacity-60">·</span><span class="multi-badge font-mono text-[9.5px] bg-accent text-paper border border-accent rounded-sm px-[7px] py-0.5 tracking-[.22em] font-bold shadow-[0_1px_0_rgba(122,28,28,.25)] whitespace-nowrap shrink-0">MULTI&middot;STEP ${entity.steps.length}</span>` : ""}
      ${eyebrowAttributionHtml(entity)}
    </div>
    <h2 class="doc-title font-display italic font-normal text-[clamp(36px,4.4vw,52px)] leading-[1.05] tracking-[-0.012em] my-4">${escapeHtml(humanizeName(entity.name))}</h2>
    <p class="doc-sub md-body text-ink-soft font-body text-[16.5px] leading-[1.55] m-0 mb-[22px] max-w-[60ch]">${inlineFmt(entity.description || "")}</p>
    <div class="doc-actions flex gap-2.5 flex-wrap">${topActions}</div>
  `;
  pane.appendChild(head);
  wireAttributionCopy(head);

  const shape = findEntityShape(ENTITY_SHAPES, entity.type, entity.name);
  if (shape && shape.collision) {
    const banner = document.createElement("div");
    banner.className = "mt-6 px-4 py-3 bg-[#f3d8d8] border border-[#d8a8a8] text-accent rounded-sm font-mono text-[12px]";
    banner.innerHTML = `Slug collision: both <code>${escapeHtml(entity.type)}/${escapeHtml(entity.name)}.md</code> and <code>${escapeHtml(entity.type)}/${escapeHtml(entity.name)}/${escapeHtml(mainFileLabel(entity.type))}</code> exist. Pick one shape and remove the other.`;
    pane.appendChild(banner);
  }

  // Body section, per type
  if (entity.type === "prompts") {
    if (multi) renderPromptMultiStep(pane, entity);
    else renderPromptSingle(pane, entity);
  } else if (entity.type === "skills") {
    renderSkillBody(pane, entity);
  } else if (entity.type === "agents") {
    renderAgentBody(pane, entity);
  } else if (entity.type === "hooks") {
    renderHookBody(pane, entity);
  }
  renderAttachments(pane, entity);

  // Wire actions
  pane.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", () => handleDocAction(btn.dataset.act, btn, entity));
  });
  pane.querySelectorAll("[data-step-copy]").forEach(btn => {
    btn.addEventListener("click", () => copyStep(entity, parseInt(btn.dataset.stepCopy, 10)));
  });
}

export function mainFileLabel(type) {
  if (type === "skills") return "SKILL.md";
  if (type === "agents") return "AGENT.md";
  if (type === "hooks") return "hook.json";
  return `${type}.md`;
}

/* BTN_CLAY (accent bg/border, uppercase) is local - only used inside the
 * manpage action row. The neutral BTN comes from src/lib/ui-classes.js. */
export const BTN_CLAY = "btn btn-clay appearance-none bg-accent border border-accent text-paper px-3.5 py-1.5 rounded-sm font-sans text-[12.5px] font-semibold tracking-[.08em] uppercase transition-colors duration-150 hover:bg-accent-hi hover:border-accent-hi active:translate-y-px";

export function topActionsFor(entity) {
  let html = "";
  if (entity.type === "prompts" && isMultiStep(entity)) {
    html += entity.steps.map((s, i) =>
      `<button class="${BTN_CLAY}" data-act="copy-step" data-step="${i}">Copy step ${i + 1}</button>`
    ).join("");
  } else if (entity.type === "prompts") {
    html += `<button class="${BTN_CLAY}" data-act="copy">Copy prompt.md</button>`;
  } else if (entity.type === "skills") {
    html += `<button class="${BTN_CLAY}" data-act="copy">Copy SKILL.md</button>`;
  } else if (entity.type === "agents") {
    html += `<button class="${BTN_CLAY}" data-act="copy">Copy AGENT.md</button>`;
  } else if (entity.type === "hooks") {
    html += `<button class="${BTN_CLAY}" data-act="copy">Copy hook.json</button>`;
  }
  // Edit / Fork / Request edit / Duplicate / Delete render only when the
  // host advertises edit capability (CLAUDE.md rule #5). Pages and
  // workflow-published consumer sites have no Worker, so the ping probe
  // fails, edits stays false, and the library is visibly read-only instead
  // of offering buttons that silently drop to localStorage.
  if (getCapabilitiesSync().edits) {
    html += `<button class="${BTN}" data-act="edit">${entity.source === "builtin" ? "Fork" : "Edit"}</button>`;
    if (entity.source === "builtin" || entity.source === "edited-builtin") {
      html += `<button class="${BTN}" data-act="request">Request edit</button>`;
    }
    html += `<button class="${BTN}" data-act="duplicate">Duplicate</button>`;
    if (entity.source !== "builtin") html += `<button class="${BTN}" data-act="delete">Delete</button>`;
  }
  return html;
}

export function handleDocAction(act, btn, entity) {
  if (act === "copy") copyEntity(entity);
  else if (act === "copy-step") copyStep(entity, parseInt(btn.dataset.step, 10));
  else if (act === "copy-snippet") copyEntity(entity);     // same source as Copy snippet header button
  else if (act === "copy-install-all") {
    const pre = document.querySelector("[data-install-all]");
    if (pre) copyText(pre.textContent, `${humanizeName(entity.name)} install command`);
  }
  else if (act === "copy-raw") {
    const pre = btn.closest("section")?.querySelector("pre.prompt-raw");
    if (pre) copyText(pre.textContent, `${humanizeName(entity.name)} raw markdown`);
  }
  else if (act === "edit") {
    if (entity.source === "builtin") openEditModal({ mode: "fork", sourceId: entity.name, sourceType: entity.type });
    else openEditModal({ mode: "edit", id: entity.name, sourceType: entity.type });
  }
  else if (act === "request") openRequestModal({ entityId: entity.name, entityType: entity.type });
  else if (act === "duplicate") duplicateEntity(entity);
  else if (act === "delete") deleteEntity(entity);
}

/* ===== Prompt body rendering ===== */

export function renderPromptSingle(pane, entity) {
  if (entity.body && entity.body.trim()) {
    pane.appendChild(makeSection("Description",
      `<div class="section-body md-body font-body text-[17px] leading-[1.65] text-ink">${renderMarkdown(entity.body)}</div>`));
  }
  appendRawPre(pane, "Raw prompt", entity.body || "");
}

function firstParagraph(body) {
  const lines = String(body || "").split("\n");
  const buf = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) { if (buf.length) break; else continue; }
    if (/^(#{1,4}\s|```|---|[-*]\s|\d+\.\s)/.test(t)) break;
    buf.push(t);
  }
  return buf.join(" ");
}

export function renderPromptMultiStep(pane, entity) {
  // .doc section margin-top 44px (via mt-11)
  // .doc h3.section-h: font-sans text-[12px] tracking-[.32em] uppercase text-ink font-bold m-0 mb-3.5 relative pb-2.5 (::after underline stays in input.css)
  // .doc .section-body: font-body text-[17px] leading-[1.65] text-ink
  const SECTION_BODY = "section-body font-body text-[17px] leading-[1.65] text-ink";
  // Workflow overview
  const overview = document.createElement("section");
  overview.className = "workflow-overview mt-11 scroll-mt-6";
  overview.innerHTML = `
    <h3 class="section-h font-sans text-[12px] tracking-[.32em] uppercase text-ink font-bold m-0 mb-3.5 relative pb-2.5">Workflow</h3>
    <p class="${SECTION_BODY} mb-3.5">This prompt runs as <b>${entity.steps.length} sequential steps</b>. Copy step 1, answer the questions, review the artifact, then copy step 2 to continue.</p>
    <ol class="workflow-list list-none p-0 mt-2 m-0 flex flex-col gap-3">
      ${entity.steps.map((s, i) => `
        <li class="flex items-center gap-3.5 px-[18px] py-4 bg-paper-deep border border-rule rounded-sm flex-wrap">
          <span class="wf-num inline-flex items-center justify-center w-[30px] h-[30px] bg-accent text-paper font-mono text-[13px] font-bold rounded-sm shrink-0">${i + 1}</span>
          <div class="wf-body flex-1 min-w-0">
            <div class="wf-label font-sans text-[12.5px] font-bold tracking-[.14em] uppercase text-ink">${escapeHtml(s.label || "Step " + (i + 1))}</div>
            <div class="wf-hint font-body text-sm text-ink-soft mt-1 italic">${escapeHtml(firstParagraph(s.body) || "Step " + (i + 1))}</div>
          </div>
          <button class="${BTN_CLAY}" data-step-copy="${i}">Copy ${i + 1}</button>
        </li>
      `).join("")}
    </ol>
  `;
  pane.appendChild(overview);

  entity.steps.forEach((s, i) => {
    const block = document.createElement("section");
    block.className = "step-block mt-14 pt-7 border-t-2 border-ink scroll-mt-6";
    block.id = `step-${i}`;
    block.innerHTML = `
      <div class="step-block-head flex items-center gap-3.5 mb-[18px] flex-wrap">
        <span class="step-num inline-flex items-center justify-center w-9 h-9 bg-accent text-paper font-mono text-[15px] font-bold rounded-sm shrink-0">${i + 1}</span>
        <div class="step-block-titles flex-1">
          <div class="step-block-eyebrow font-mono text-[10.5px] tracking-[.22em] uppercase text-ink-faint">step ${i + 1} of ${entity.steps.length}</div>
          <h3 class="step-block-title font-display italic text-[28px] leading-[1.15] mt-0.5 text-ink">${escapeHtml(s.label || "Step " + (i + 1))}</h3>
        </div>
        <button class="${BTN_CLAY}" data-step-copy="${i}">Copy step ${i + 1}</button>
      </div>
    `;
    pane.appendChild(block);

    const sub = document.createElement("div");
    sub.className = "step-block-body";
    pane.appendChild(sub);
    if (s.body && s.body.trim()) {
      sub.appendChild(makeSection("Description",
        `<div class="section-body md-body font-body text-[17px] leading-[1.65] text-ink">${renderMarkdown(s.body)}</div>`));
    }

    const raw = document.createElement("section");
    raw.className = "step-block-raw mt-6 scroll-mt-6";
    raw.innerHTML = `
      <details class="raw-fold group/fold">
        <summary class="raw-head flex items-center justify-between mb-2.5 gap-3 flex-wrap cursor-pointer list-none marker:hidden [&::-webkit-details-marker]:hidden">
          <h3 class="section-h font-sans text-[12px] tracking-[.32em] uppercase text-ink font-bold m-0 mb-0 relative pb-2.5">Raw prompt, step ${i + 1}</h3>
          <span class="raw-label font-mono text-[10.5px] tracking-[.22em] uppercase text-ink-mute select-none"><span class="group-open/fold:hidden">show</span><span class="hidden group-open/fold:inline">hide</span> <span aria-hidden="true" class="inline-block transition-transform group-open/fold:rotate-90">›</span></span>
        </summary>
        <div class="flex items-center justify-end mb-2.5 gap-3 flex-wrap">
          <span class="raw-label font-mono text-[10.5px] tracking-[.22em] uppercase text-ink-mute"><button type="button" class="appearance-none bg-transparent border-0 p-0 m-0 font-mono text-[10.5px] tracking-[.22em] uppercase text-accent hover:text-accent-hi cursor-pointer transition-colors underline underline-offset-2 decoration-dotted" data-step-copy="${i}" title="Copy this step's raw markdown">copy</button> &amp; paste into your AI/LLM</span>
        </div>
        <pre class="prompt-raw m-0 px-[26px] py-6 bg-ink text-paper font-mono text-[13px] leading-[1.7] rounded-sm overflow-x-auto whitespace-pre-wrap break-words border border-ink">${escapeHtml(s.body)}</pre>
      </details>
    `;
    pane.appendChild(raw);
  });
}

/* ===== Skill body rendering ===== */

export function renderSkillBody(pane, entity) {
  const vm = parseSkillManpage(entity);
  pane.appendChild(makeSection("Metadata", metaTable(vm.meta.concat(attributionMetaRows(entity)))));
  pane.appendChild(makeSection("Invocation", `<div class="section-body font-body text-[17px] leading-[1.65] text-ink"><p><code class="invocation-chip inline-block font-mono text-sm bg-code-bg border border-code-border rounded-sm px-2.5 py-1 text-accent tracking-[.04em]">${escapeHtml(vm.invocation)}</code></p></div>`));
  pane.appendChild(makeSection("Description", `<div class="section-body md-body font-body text-[17px] leading-[1.65] text-ink">${renderMarkdown(vm.body)}</div>`));
  appendRawPre(pane, "Raw SKILL.md", vm.body);
}

/* ===== Agent body rendering ===== */

export function renderAgentBody(pane, entity) {
  const vm = parseAgentManpage(entity);
  pane.appendChild(makeSection("Metadata", metaTable(vm.meta.concat(attributionMetaRows(entity)))));
  pane.appendChild(makeSection("Description", `<div class="section-body md-body font-body text-[17px] leading-[1.65] text-ink">${renderMarkdown(vm.body)}</div>`));
  appendRawPre(pane, "Raw agent.md", vm.body);
}

/* ===== Hook body rendering ===== */

export function renderHookBody(pane, entity) {
  const vm = parseHookManpage(entity);
  pane.appendChild(makeSection("Metadata", metaTable(vm.meta.concat(attributionMetaRows(entity)))));

  // Structured view of hook.json renders above the raw JSON so the
  // user gets the semantic decomposition first.
  if (vm.structured) pane.appendChild(renderHookStructured(vm));

  if (vm.snippet) {
    const validBadge = vm.snippetValid
      ? `<span class="font-mono text-[10px] tracking-[.2em] uppercase bg-[#e3efe6] text-[#2d6a4f] border border-[#b9d4c2] rounded-sm px-2 py-0.5">JSON ok</span>`
      : `<span class="font-mono text-[10px] tracking-[.2em] uppercase bg-[#f6e6c8] text-[#8a6500] border border-[#d6c180] rounded-sm px-2 py-0.5">JSON invalid</span>`;
    const installLine = vm.installPath
      ? `<span class="font-mono text-[11px] text-ink-mute tracking-[.04em]">install into <code class="bg-code-bg border border-code-border rounded-sm px-1.5 py-px text-accent">${escapeHtml(vm.installPath)}</code></span>`
      : "";
    pane.appendChild(makeSection("settings.json snippet",
      `<div class="flex items-center gap-2 mb-3 flex-wrap">
         <button class="${BTN_CLAY}" data-act="copy-snippet">Copy snippet</button>
         ${validBadge}
         ${installLine}
       </div>
       <pre class="prompt-raw m-0 px-[26px] py-6 bg-ink text-paper font-mono text-[13px] leading-[1.7] rounded-sm overflow-x-auto whitespace-pre-wrap break-words border border-ink">${escapeHtml(vm.snippet)}</pre>`));
  }
  pane.appendChild(makeSection("Where to install", whereToInstallHtml(vm)));
  const installAll = renderInstallAllSection(entity);
  if (installAll) pane.appendChild(installAll);
  // Description section only appears when prose (README.md for folder
  // shape, or markdown body for legacy flat) exists. Shape A hooks
  // (hook.json only) skip it - plan §"Hook" table.
  if (vm.body && vm.body.trim()) {
    pane.appendChild(makeSection("Description",
      `<div class="section-body md-body font-body text-[17px] leading-[1.65] text-ink">${renderMarkdown(vm.body)}</div>`));
    appendRawPre(pane, "Raw README.md", vm.body);
  }
}

/* Decomposed hook.json: event/matcher headline (with validation badges)
 * + one panel per inner hook entry showing Type / If / Command / Args.
 * Command is rendered in a syntax-highlighted bash pre so users see the
 * shell text decoded rather than JSON-escaped. Script references inside
 * the command cross-link to attachments below the section. */
export function renderHookStructured(vm) {
  const s = vm.structured;
  const eventBadge = s.eventKnown
    ? `<span class="font-mono text-[10px] tracking-[.2em] uppercase bg-paper-deep text-ink-mute border border-rule rounded-sm px-2 py-0.5">event</span>`
    : `<span class="font-mono text-[10px] tracking-[.2em] uppercase bg-[#f6e6c8] text-[#8a6500] border border-[#d6c180] rounded-sm px-2 py-0.5" title="Unknown event name">unknown event</span>`;
  const matcherBadge = !s.matcher
    ? ""
    : s.matcherValid
      ? `<span class="font-mono text-[10px] tracking-[.2em] uppercase bg-paper-deep text-ink-mute border border-rule rounded-sm px-2 py-0.5">matcher</span>`
      : `<span class="font-mono text-[10px] tracking-[.2em] uppercase bg-[#f3d8d8] text-accent border border-[#d8a8a8] rounded-sm px-2 py-0.5" title="Matcher is not a valid regex">bad regex</span>`;
  const head = `
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4 font-mono text-[12.5px] text-ink">
      ${eventBadge}
      <code class="bg-code-bg border border-code-border rounded-sm px-2 py-0.5 text-accent">${escapeHtml(s.event || "-")}</code>
      ${s.matcher ? `${matcherBadge}<code class="bg-code-bg border border-code-border rounded-sm px-2 py-0.5 text-ink">${escapeHtml(s.matcher)}</code>` : ""}
    </div>
  `;
  const entries = s.entries.length
    ? s.entries.map((e, i) => renderHookEntry(e, i, vm.scriptRefs)).join("")
    : `<div class="font-mono text-[12px] text-ink-mute">No inner hooks entries declared.</div>`;
  return makeSection("Hook configuration", head + entries);
}

export function renderHookEntry(entry, idx, scriptRefs) {
  const argRows = (entry.args && entry.args.length)
    ? `<div class="mt-3 font-mono text-[12px] text-ink"><span class="text-ink-mute uppercase tracking-[.18em] text-[10px] mr-2">args</span>${entry.args.map(a => `<code class="bg-code-bg border border-code-border rounded-sm px-1.5 py-px mr-1.5">${escapeHtml(a)}</code>`).join("")
    }</div>`
    : "";
  const ifRow = entry.if
    ? `<div class="mt-3 font-mono text-[12px] text-ink"><span class="text-ink-mute uppercase tracking-[.18em] text-[10px] mr-2">if</span><code class="bg-code-bg border border-code-border rounded-sm px-1.5 py-px">${escapeHtml(entry.if)}</code></div>`
    : "";
  const command = entry.command
    ? `<div class="mt-3"><div class="font-mono text-[10px] tracking-[.18em] uppercase text-ink-mute mb-1.5">command</div><pre class="m-0 px-4 py-3 bg-paper-deep border border-rule rounded-sm font-mono text-[12.5px] leading-[1.6] text-ink overflow-x-auto whitespace-pre-wrap break-words"><code class="language-bash">${escapeHtml(entry.command)}</code></pre></div>`
    : "";
  const refs = (scriptRefs || []).filter(r => entry.command && entry.command.includes(r.scriptPath));
  const refsList = refs.length
    ? `<div class="mt-3 font-mono text-[11.5px] text-ink-soft"><span class="text-ink-mute uppercase tracking-[.18em] text-[10px] mr-2">scripts</span>${refs.map(r => `<a href="#section-attachments" class="underline decoration-dotted decoration-rule hover:decoration-accent text-accent">${escapeHtml(r.attachmentPath)}</a>`).join(" ")
    }</div>`
    : "";
  return `
    <div class="mb-4 p-4 bg-paper border border-rule rounded-sm">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-ink-soft">
        <span class="text-ink-mute uppercase tracking-[.18em] text-[10px]">entry ${idx + 1}</span>
        <span class="text-ink-mute uppercase tracking-[.18em] text-[10px]">type</span>
        <code class="bg-code-bg border border-code-border rounded-sm px-1.5 py-px text-accent">${escapeHtml(entry.type)}</code>
      </div>
      ${command}${argRows}${ifRow}${refsList}
    </div>
  `;
}

export function whereToInstallHtml(vm) {
  if (!vm.installPath && !vm.snippet) {
    return `<div class="section-body font-body text-[16px] leading-[1.6] text-ink-soft"><p>No install hint declared. Add a <code>install.scope</code> (or explicit <code>install.path</code>) entry to the frontmatter.</p></div>`;
  }
  const scope = vm.installPath && vm.installPath.startsWith("~")
    ? "user-wide"
    : vm.installPath
      ? "this project"
      : "(scope not declared)";
  const path = vm.installPath || "~/.claude/settings.json";
  return `<div class="section-body font-body text-[16px] leading-[1.6] text-ink"><p>Merge the snippet into <strong>${escapeHtml(scope)}</strong>: <code class="bg-code-bg border border-code-border rounded-sm px-1.5 py-px text-accent font-mono text-[12.5px]">${escapeHtml(path)}</code></p></div>`;
}

/* Folder-shaped hooks ship at least one script under scripts/. Surface a
 * curl one-liner so the user can land the scripts on disk without
 * cloning anything; the rendered host is the SPA's own origin so the
 * command works whether the deploy is Pages or Worker. */
export function renderInstallAllSection(entity) {
  const shape = findEntityShape(ENTITY_SHAPES, entity.type, entity.name);
  if (!shape || shape.kind !== "folder" || !shape.attachments.length) return null;
  const host = (typeof location !== "undefined" && location.origin) || "https://<host>";
  const targetDir = `~/.claude/hooks/${entity.name}`;
  const lines = shape.attachments.map(att => {
    const rel = att.path.slice(`${entity.type}/${entity.name}/`.length);
    const remote = `${host}/${att.path}`;
    const local = `${targetDir}/${rel}`;
    const localDir = local.replace(/\/[^/]+$/, "");
    const chmod = /\.(sh|py|js|ts)$/i.test(att.path) ? `\n  chmod +x ${local} &&` : "";
    return `  mkdir -p ${localDir} &&\n  curl -fsSL ${remote} -o ${local} &&${chmod}`;
  });
  const oneLiner = `set -euo pipefail && \\\n${lines.join(" \\\n")}\n  echo "installed ${entity.name}"`;
  const html = `
    <p class="font-body text-[16px] leading-[1.6] text-ink mb-3">Run this once to drop the supporting scripts into <code class="bg-code-bg border border-code-border rounded-sm px-1.5 py-px text-accent font-mono text-[12.5px]">${escapeHtml(targetDir)}</code>:</p>
    <div class="flex items-center gap-2 mb-2 flex-wrap">
      <button class="${BTN_CLAY}" data-act="copy-install-all">Copy install command</button>
      <span class="font-mono text-[10.5px] text-ink-mute tracking-[.08em]">${shape.attachments.length} file${shape.attachments.length === 1 ? "" : "s"}</span>
    </div>
    <pre class="prompt-raw m-0 px-[26px] py-6 bg-ink text-paper font-mono text-[13px] leading-[1.7] rounded-sm overflow-x-auto whitespace-pre-wrap break-words border border-ink" data-install-all>${escapeHtml(oneLiner)}</pre>
  `;
  return makeSection("Install all", html);
}

export function metaTable(rows) {
  return `<table class="meta-table w-full border-collapse font-body text-[15px] mt-1 [&_tr]:border-b [&_tr]:border-rule-soft [&_tr:last-child]:border-b-0 [&_th]:text-left [&_th]:font-sans [&_th]:text-[10.5px] [&_th]:tracking-[.22em] [&_th]:uppercase [&_th]:text-ink-mute [&_th]:font-semibold [&_th]:pr-4 [&_th]:py-2.5 [&_th]:w-[140px] [&_th]:align-top [&_td]:py-2.5 [&_td]:text-ink">${rows.map(([k, v]) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`
  ).join("")}</table>`;
}

export function appendRawPre(pane, label, content) {
  const raw = document.createElement("section");
  raw.id = "section-raw";
  raw.className = "mt-11 scroll-mt-6";
  raw.innerHTML = `
    <details class="raw-fold group/fold">
      <summary class="raw-head flex items-center justify-between mb-2.5 gap-3 flex-wrap cursor-pointer list-none marker:hidden [&::-webkit-details-marker]:hidden">
        <h3 class="section-h font-sans text-[12px] tracking-[.32em] uppercase text-ink font-bold m-0 relative pb-2.5">${escapeHtml(label)}</h3>
        <span class="raw-label font-mono text-[10.5px] tracking-[.22em] uppercase text-ink-mute select-none"><span class="group-open/fold:hidden">show</span><span class="hidden group-open/fold:inline">hide</span> <span aria-hidden="true" class="inline-block transition-transform group-open/fold:rotate-90">›</span></span>
      </summary>
      <div class="flex items-center justify-end mb-2.5 gap-3 flex-wrap">
        <span class="raw-label font-mono text-[10.5px] tracking-[.22em] uppercase text-ink-mute"><button type="button" class="appearance-none bg-transparent border-0 p-0 m-0 font-mono text-[10.5px] tracking-[.22em] uppercase text-accent hover:text-accent-hi cursor-pointer transition-colors underline underline-offset-2 decoration-dotted" data-act="copy-raw" title="Copy raw markdown">copy</button> &amp; paste into your AI/LLM</span>
      </div>
      <pre class="prompt-raw m-0 px-[26px] py-6 bg-ink text-paper font-mono text-[13px] leading-[1.7] rounded-sm overflow-x-auto whitespace-pre-wrap break-words border border-ink">${escapeHtml(content)}</pre>
    </details>
  `;
  pane.appendChild(raw);
}

export function makeSection(label, innerHtml) {
  const el = document.createElement("section");
  el.id = "section-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  el.className = "mt-11 scroll-mt-6";
  el.innerHTML = `<h3 class="section-h font-sans text-[12px] tracking-[.32em] uppercase text-ink font-bold m-0 mb-3.5 relative pb-2.5">${escapeHtml(label)}</h3>${innerHtml}`;
  return el;
}

export function renderTocRail(entity) {
  const rail = document.getElementById("tocRail");
  // TOC rail markup is fully inline Tailwind. The list has no active state
  // wired up today; if one ever lands, use `aria-current="location"` plus
  // an `aria-[current=location]:` variant on the li, same pattern as the
  // cat-rail above.
  rail.innerHTML = `<div class="rail-eyebrow font-sans text-[11px] tracking-[.26em] uppercase text-ink-mute font-semibold m-0 mb-3">On this page</div><ul id="tocList" class="list-none m-0 mb-7 p-0"></ul>`;
  const list = rail.querySelector("#tocList");
  document.querySelectorAll(".doc section h3.section-h, .doc .step-block-title").forEach(h => {
    const sec = h.closest("section");
    if (!sec) return;
    const li = document.createElement("li");
    li.className = "font-body text-[13.5px] py-1.5 text-ink-soft cursor-pointer transition-colors duration-100 hover:text-ink";
    li.textContent = h.textContent;
    li.addEventListener("click", () => sec.scrollIntoView({ behavior: "smooth", block: "start" }));
    list.appendChild(li);
  });

  const rels = (RELATED[entity.name] || []).map(n => findById(n)).filter(Boolean).slice(0, 4);
  if (!rels.length) return;
  const title = document.createElement("div");
  title.className = "related-title font-sans text-[11px] tracking-[.26em] uppercase text-ink-mute font-semibold mt-4 mb-2.5";
  title.textContent = "Related";
  rail.appendChild(title);
  rels.forEach(r => {
    const a = document.createElement("a");
    a.className = "related-item block py-3 border-b border-rule-soft text-ink-soft cursor-pointer no-underline transition-colors duration-100 hover:text-ink";
    a.href = `#/${r.type}/${r.name}`;
    a.innerHTML = `<div class="rel-cat font-mono text-[10px] text-ink-faint tracking-[.18em] uppercase">${escapeHtml(r.type === "prompts" ? "prompt" : r.type.slice(0, -1))} · ${escapeHtml(r.category || "uncategorized")}</div><div class="rel-title font-display italic text-[17px] leading-[1.25] mt-0.5">${escapeHtml(humanizeName(r.name))}</div>`;
    rail.appendChild(a);
  });
}
