import { loadStr, saveStr, allOfType, allEntities } from "../lib/storage.js";
import { escapeHtml } from "../lib/util.js";
import { ForkCache } from "../data/fork-cache.js";
import { renderForkPanel } from "../components/fork-panel.js";
import { renderRail, filterEntities } from "../components/rail.js";
import { renderRecentlyUsed } from "../components/recently-used.js";
import { renderGalaxy } from "../components/galaxy.js";
import { rerender } from "../app.js";

/* Dashboard view. Two orthogonal axes drive what renders:
 *   source: "local" | "external"          where the entities come from
 *   view:   "inventory" | "galaxy"        how those entities are drawn
 *
 * Three pills sit at the top of the dashboard:
 *   - Inventory + Galaxy: pick the view, mutually exclusive
 *   - External:           toggles the fork panel; aria-pressed reflects
 *                         source === "external" (the "active source" tint)
 *
 * Source state changes via the fork-panel (Fetch a slug, click a cached
 * row, Back to local). Source is sticky: switching views while source is
 * external keeps showing the fork's entities.
 *
 * Persisted in localStorage["aitelier-dash-mode-v1"]. The schema is v2
 * (JSON), the old v1 stored the bare string `"inventory"` or `"galaxy"`,
 * loadDashState() migrates that shape gracefully. */

export const DASH_MODE_KEY = "aitelier-dash-mode-v1";

export function defaultDashState() {
  return { v: 2, source: "local", view: "inventory", externalSlug: null, panelOpen: false };
}

export function loadDashState() {
  const raw = loadStr(DASH_MODE_KEY, "");
  if (!raw) return defaultDashState();
  if (raw === "inventory" || raw === "galaxy") {
    return { v: 2, source: "local", view: raw, externalSlug: null, panelOpen: false };
  }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      return {
        v: 2,
        source: j.source === "external" ? "external" : "local",
        view: j.view === "galaxy" ? "galaxy" : "inventory",
        externalSlug: (typeof j.externalSlug === "string" && j.externalSlug) ? j.externalSlug : null,
        panelOpen: !!j.panelOpen
      };
    }
  } catch { /* fall through */ }
  return defaultDashState();
}

export function saveDashState(ds) {
  saveStr(DASH_MODE_KEY, JSON.stringify({
    v: 2,
    source: ds.source,
    view: ds.view,
    externalSlug: ds.externalSlug,
    panelOpen: !!ds.panelOpen
  }));
}

/* Set the source and reload the entity arrays accordingly. Called from
 * the fork-panel: pass a slug object to switch to external, null to
 * restore local. Persists, then rerenders. */
export function setDashSource(slug) {
  const ds = loadDashState();
  if (slug) {
    ds.source = "external";
    ds.externalSlug = ForkCache.slugKey(slug);
    ds.panelOpen = true;
    window.__externalApplied = true;
  } else {
    ds.source = "local";
    ds.externalSlug = null;
    // Panel stays in whatever toggled state it was, default false on
    // explicit "Back to local" so the user returns to a clean dashboard.
    ds.panelOpen = false;
    window.__externalApplied = false;
  }
  saveDashState(ds);
  if (typeof rerender === "function") rerender();
}

export function mountDashboard(state) {
  const ds = loadDashState();

  // If the persisted external slug has no cache (cleared by user, version
  // mismatch, fresh browser), reset to local rather than render an empty
  // dashboard.
  if (ds.source === "external" && ds.externalSlug) {
    const rec = ForkCache.readFork(ds.externalSlug);
    if (!rec || !rec.snapshots || !rec.snapshots.length) {
      ds.source = "local";
      ds.externalSlug = null;
      saveDashState(ds);
    }
  }

  // First mount under an external source replays the newest snapshot into
  // the global arrays. We show a loading shell, kick off the apply, then
  // re-mount when it resolves. `__externalApplied` guards against re-runs
  // on every render.
  if (ds.source === "external" && ds.externalSlug && !window.__externalApplied) {
    const rec = ForkCache.readFork(ds.externalSlug);
    renderDashShell(state, ds, /* loading: */ true);
    ForkCache.applySnapshot(rec.snapshots[0]).then(() => {
      window.__externalApplied = true;
      mountDashboard(state);
    }).catch(err => {
      console.warn("applySnapshot failed:", err);
      window.__externalApplied = true;
      ds.source = "local";
      ds.externalSlug = null;
      saveDashState(ds);
      ForkCache.restoreLocal();
      mountDashboard(state);
    });
    return;
  }

  renderDashShell(state, ds, false);
}

export function renderDashShell(state, ds, loading) {
  const main = document.getElementById("main");
  // Three tabs, mutually exclusive at the UI layer. External wins when its
  // panel is open; otherwise the persisted `view` decides between Inventory
  // and Galaxy. `externalSourceActive` is the orthogonal "data source is a
  // fork" tint - kept so the dot/accent still reads when the user has
  // closed the panel but is browsing an external slug's entities.
  const activeTab = ds.panelOpen ? "external" : ds.view;
  const inventoryVisible = activeTab === "inventory";
  const galaxyVisible = activeTab === "galaxy";
  const externalTabActive = activeTab === "external";
  const externalSourceActive = ds.source === "external" && !!ds.externalSlug;

  // Wrap = max-w-[1320px] mx-auto px-8 pb-24 (was .wrap in input.css).
  if (!main.classList.contains("max-w-[1320px]")) {
    main.classList.add("max-w-[1320px]", "mx-auto", "px-8", "pb-24");
  }
  // Mode-pill-btn shared utilities. The `mode-pill-btn` class stays as a
  // JS selector hook (querySelectorAll) and so the external variant's
  // pseudo dot rule in input.css can still target the button. Active
  // colour + shadow ride on native `aria-pressed:` variants; the external
  // variant carries its own accent override so it does not collide with
  // the neutral ink colour of Inventory/Galaxy when pressed.
  const MODE_BTN_BASE = "mode-pill-btn appearance-none bg-transparent border-0 font-sans text-[11px] md:text-[12.5px] tracking-[.14em] md:tracking-[.18em] uppercase text-ink-mute px-3 md:px-[22px] py-1.5 md:py-2 rounded-full cursor-pointer transition-[color,background] duration-150 hover:text-ink";
  const MODE_BTN = MODE_BTN_BASE + " aria-pressed:bg-ink aria-pressed:text-paper aria-pressed:hover:bg-ink aria-pressed:hover:text-paper aria-pressed:shadow-[0_2px_4px_rgba(29,26,23,.18),inset_0_1px_0_rgba(255,255,255,.05)]";
  // The external pill needs left padding for the pseudo dot and an accent
  // (oxblood) pressed fill instead of ink.
  const MODE_BTN_EXT = MODE_BTN_BASE + " relative ml-1 md:ml-1.5 !pl-[20px] md:!pl-[26px] aria-pressed:bg-accent aria-pressed:text-paper aria-pressed:hover:bg-accent aria-pressed:hover:text-paper aria-pressed:shadow-[0_2px_4px_rgba(122,28,28,.22),inset_0_1px_0_rgba(255,255,255,.04)]";

  main.innerHTML = `
    ${externalSourceActive ? `
      <div class="fork-source-band flex items-center gap-3 mb-2 px-3.5 py-2 rounded-sm bg-clay-soft border border-[#e6b9a8] border-l-[3px] border-l-clay font-mono text-[11px] tracking-[.12em] text-accent flex-wrap" role="status">
        <span class="fork-source-eyebrow uppercase tracking-[.22em] text-accent">External source</span>
        <code class="fork-source-slug font-mono text-[12.5px] tracking-normal bg-paper border border-[#e6b9a8] px-2 py-0.5 rounded-sm text-ink">${escapeHtml(ds.externalSlug)}</code>
        <button class="fork-source-back ml-auto appearance-none bg-transparent border border-accent text-accent px-2.5 py-1 rounded-sm font-sans text-[11.5px] tracking-[.08em] uppercase cursor-pointer transition-colors duration-150 hover:bg-accent hover:text-paper" id="forkSourceBack" type="button">Back to local</button>
      </div>` : ""}

    <header class="masthead pt-10 pb-6 border-b border-rule flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
      <div class="brand flex-1 min-w-0 flex flex-col gap-1.5">
        <div class="brand-eyebrow font-mono text-[11px] tracking-[.22em] uppercase text-ink-mute">
          <span class="dot inline-block w-1.5 h-1.5 bg-clay rounded-full mr-2 align-[1px] shadow-[0_0_0_3px_rgba(196,74,42,.18)]"></span>self-eliciting toolkit, all in one place
        </div>
        <h1 class="brand-title font-display font-normal italic text-[clamp(36px,5.4vw,60px)] leading-[.95] tracking-[-0.015em] mt-1 mb-0">Aitelier</h1>
        <p class="brand-lede mt-3 max-w-[64ch] text-ink-soft font-body text-[15.5px] leading-[1.55]">Browsable library of prompts, skills, hooks, and agents. Click a tile to dive in. Copy any block to paste into your AI/LLM.</p>
      </div>
      <div class="masthead-meta shrink-0 flex gap-4 items-end text-left font-mono text-[11px] tracking-[.14em] uppercase text-ink-mute leading-[1.4] flex-wrap md:text-right [&>div]:font-mono [&>div]:text-[11px] [&>div]:tracking-[.14em] [&>div]:uppercase [&>div]:text-ink-mute [&>div]:leading-[1.4]">
        <div>prompts<span class="num text-ink text-[22px] font-display italic tracking-normal normal-case block mt-0.5">${allOfType("prompts").length}</span></div>
        <div>skills<span class="num text-ink text-[22px] font-display italic tracking-normal normal-case block mt-0.5">${allOfType("skills").length}</span></div>
        <div>agents<span class="num text-ink text-[22px] font-display italic tracking-normal normal-case block mt-0.5">${allOfType("agents").length}</span></div>
        <div>hooks<span class="num text-ink text-[22px] font-display italic tracking-normal normal-case block mt-0.5">${allOfType("hooks").length}</span></div>
      </div>
    </header>

    <div class="mode-pill-wrap flex justify-center py-[18px] pb-1.5 border-b border-rule-soft my-[18px] mb-6" role="tablist" aria-label="View mode + source">
      <div class="mode-pill inline-flex border border-rule rounded-full p-[3px] bg-paper-deep shadow-[inset_0_1px_0_rgba(255,255,255,.5),0_1px_2px_rgba(29,26,23,.06)]">
        <button class="${MODE_BTN}" data-pill="inventory" role="tab"
                aria-pressed="${inventoryVisible}">Inventory</button>
        <button class="${MODE_BTN}" data-pill="galaxy" role="tab"
                aria-pressed="${galaxyVisible}">Galaxy</button>
        <button class="${MODE_BTN_EXT} mode-pill-btn--external ${externalSourceActive ? "is-source-active" : ""}"
                data-pill="external"
                role="tab"
                aria-pressed="${externalTabActive}"
                aria-expanded="${ds.panelOpen ? "true" : "false"}">External</button>
      </div>
    </div>

    <div id="forkPanelMount" class="fork-panel-mount [&:empty]:hidden"></div>

    ${loading ? `<div class="empty py-16 px-5 text-center text-ink-mute italic font-display text-[22px]">Loading <code>${escapeHtml(ds.externalSlug || "")}</code>...</div>` : `
      <div class="dash-search relative mt-6 max-w-[720px]" data-mode-show="inventory" ${inventoryVisible ? "" : "hidden"}>
        <span class="search-glyph absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-mute font-mono text-sm">/</span>
        <input id="dashSearch" type="text" placeholder="Search prompts, skills, agents..." autocomplete="off" spellcheck="false" value="${escapeHtml(state.query)}"
               class="appearance-none w-full bg-paper-deep border border-rule rounded-sm py-3 pl-10 pr-3.5 text-ink text-[15px] font-sans transition-colors duration-150 focus:outline-none focus:border-accent focus:bg-paper" />
        <kbd class="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] px-1.5 py-px border border-rule rounded-sm text-ink-mute bg-paper">/</kbd>
        <span class="match-chip absolute right-14 top-1/2 -translate-y-1/2 font-mono text-[10.5px] text-ink-mute tracking-[.08em]" id="dashMatchChip"></span>
      </div>

      <div class="dash-inventory block" data-mode-show="inventory" ${inventoryVisible ? "" : "hidden"}>
        <section class="recent-section" id="recentSection"></section>
        <section id="railPrompts"></section>
        <section id="railSkills"></section>
        <section id="railAgents"></section>
        <section id="railHooks"></section>
      </div>

      <div class="dash-galaxy mt-2" id="galaxyMount" data-mode-show="galaxy" ${galaxyVisible ? "" : "hidden"}></div>
    `}
  `;

  // Pill handlers. Tabs are mutually exclusive: clicking Inventory/Galaxy
  // closes the External panel so only one tab reads as active. Clicking
  // External toggles `panelOpen` while preserving `view`, so closing it
  // returns to the previously selected Inventory or Galaxy.
  main.querySelectorAll(".mode-pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const pill = btn.dataset.pill;
      const cur = loadDashState();
      if (pill === "inventory" || pill === "galaxy") {
        if (cur.view === pill && !cur.panelOpen) return;
        cur.view = pill;
        cur.panelOpen = false;
      } else if (pill === "external") {
        cur.panelOpen = !cur.panelOpen;
      }
      saveDashState(cur);
      mountDashboard(state);
    });
  });

  // Top-of-page Back-to-local shortcut.
  const backBtn = document.getElementById("forkSourceBack");
  if (backBtn) backBtn.addEventListener("click", () => {
    ForkCache.restoreLocal();
    setDashSource(null);
  });

  // Mount the fork panel underneath the pill row.
  renderForkPanel(document.getElementById("forkPanelMount"), {
    state,
    dashState: ds,
    setSource: setDashSource,
    requestRerender: () => mountDashboard(state)
  });

  if (loading) return;
  // Skip view renders entirely when External is the active tab - both
  // mount points are hidden in that case, so painting them is wasted work.
  if (externalTabActive) return;
  if (inventoryVisible) renderInventory(state);
  else renderGalaxy(document.getElementById("galaxyMount"));
}

export function renderInventory(state) {
  renderRecentlyUsed(document.getElementById("recentSection"));
  renderRail(document.getElementById("railPrompts"), { type: "prompts", label: "Prompts", items: allOfType("prompts"), query: state.query });
  renderRail(document.getElementById("railSkills"), { type: "skills", label: "Skills", items: allOfType("skills"), query: state.query });
  renderRail(document.getElementById("railAgents"), { type: "agents", label: "Agents", items: allOfType("agents"), query: state.query });
  renderRail(document.getElementById("railHooks"), { type: "hooks", label: "Hooks", items: allOfType("hooks"), query: state.query });
  updateMatchChip(state);

  document.getElementById("dashSearch").addEventListener("input", e => {
    state.query = e.target.value;
    renderRail(document.getElementById("railPrompts"), { type: "prompts", label: "Prompts", items: allOfType("prompts"), query: state.query });
    renderRail(document.getElementById("railSkills"), { type: "skills", label: "Skills", items: allOfType("skills"), query: state.query });
    renderRail(document.getElementById("railAgents"), { type: "agents", label: "Agents", items: allOfType("agents"), query: state.query });
    renderRail(document.getElementById("railHooks"), { type: "hooks", label: "Hooks", items: allOfType("hooks"), query: state.query });
    updateMatchChip(state);
  });
}

export function updateMatchChip(state) {
  const chip = document.getElementById("dashMatchChip");
  if (!chip) return;
  if (!state.query.trim()) { chip.textContent = ""; chip.style.display = "none"; return; }
  const total = allEntities().length;
  const matched = filterEntities(allEntities(), state.query).length;
  chip.textContent = `${matched} / ${total}`;
  chip.style.display = "";
}

export function unmountDashboard() {
}
