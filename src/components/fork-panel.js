import { ForkCache } from "../data/fork-cache.js";
import { ForkStaleness } from "../data/fork-staleness.js";
import { createExternalTransport } from "../data/transport-worker.js";
import { BTN, BTN_PRIMARY } from "../lib/ui-classes.js";
import { escapeHtml } from "../lib/util.js";

/* External fork panel. Mounted by the dashboard above the inventory/galaxy
 * area when the user opens it via the External pill. Owns:
 *   - the slug input + Fetch button
 *   - the cached-forks list (each row a quick-load button)
 *   - the currently-viewing banner with Back-to-local + Refresh
 *
 * No view state of its own beyond a transient status message line. The
 * dashboard owns `dashState.panelOpen`, `dashState.source`, and
 * `dashState.externalSlug`, and passes a small handler bag down so the
 * panel doesn't need to know about persistence or rerender plumbing.
 *
 * Pure render: every state change goes through `ctx.requestRerender()`
 * so we don't accumulate stale DOM. Side effects (network, cache writes)
 * happen here, view updates happen on the parent. */

export function renderForkPanel(host, ctx) {
  if (!host) return;
  const ds = ctx.dashState;
  if (!ds.panelOpen) { host.innerHTML = ""; return; }

  const current = ds.externalSlug || null;
  const forks = ForkCache.listForks();

  // .fork-panel-mount: mb-7; :empty -> hidden (handled below by empty-innerHTML)
  if (!host.classList.contains("mb-7")) host.classList.add("mb-7");
  // BTN / BTN_PRIMARY are the shared constants from src/lib/ui-classes.js.

  host.innerHTML = `
    <section class="fork-panel bg-paper border border-rule rounded-md px-[22px] pt-[18px] pb-4 shadow-1 mt-3" role="region" aria-label="External fork loader">
      <div class="fork-panel-eyebrow font-mono text-[10.5px] tracking-[.14em] text-ink-mute mb-2.5 flex items-center gap-2 flex-wrap">
        <span class="dot w-1.5 h-1.5 bg-clay rounded-full shadow-[0_0_0_3px_rgba(196,74,42,.18)]"></span>
        Browse a public fork by slug. <code>username</code> resolves to <code>username/.aitelier</code>.
      </div>
      <div class="fork-panel-input flex gap-2 mb-2.5 flex-wrap" id="forkForm" role="group" aria-label="Fork slug">
        <input id="forkInput" type="text"
               name="aitelier-fork-slug"
               autocomplete="off"
               autocorrect="off"
               autocapitalize="off"
               spellcheck="false"
               inputmode="text"
               data-1p-ignore="true"
               data-lpignore="true"
               data-bwignore="true"
               placeholder="github handle, owner/repo, or owner/repo@branch"
               class="flex-1 min-w-[200px] appearance-none bg-paper-deep border border-rule rounded-sm px-3 py-2.5 text-ink font-mono text-[13px] tracking-[.02em] focus:outline-none focus:border-accent focus:bg-paper" />
        <button type="button" id="forkFetchBtn" class="${BTN_PRIMARY}">Fetch</button>
      </div>
      <div class="fork-panel-msg min-h-[18px] font-mono text-[11.5px] tracking-[.04em] text-ink-mute mb-1.5" id="forkMsg" data-tone="" aria-live="polite"></div>
      ${forks.length ? `
        <div class="fork-panel-list-head flex justify-between items-center mt-3.5 mb-1.5 pb-1.5 border-b border-dashed border-rule font-sans text-[11px] tracking-[.22em] uppercase text-ink-mute font-semibold">
          <span>Cached forks</span>
          <span class="fork-panel-count font-mono text-[10.5px] text-ink-faint tracking-[.08em]">${forks.length}</span>
        </div>
        <ul class="fork-panel-list list-none m-0 p-0">
          ${forks.map(f => renderForkRow(f, current)).join("")}
        </ul>` : `
        <div class="fork-panel-empty pt-3.5 pb-1 font-display italic text-[14.5px] text-ink-faint">
          No forks cached yet. Try <code>octocat</code> or <code>octocat/Hello-World</code>.
        </div>`}
      ${current ? `
        <div class="fork-panel-current flex items-center gap-2.5 mt-3.5 pt-3 border-t border-dashed border-rule flex-wrap">
          <span class="fork-current-label font-mono text-[10.5px] tracking-[.22em] uppercase text-ink-mute">Viewing</span>
          <code class="fork-current-slug font-mono text-[12.5px] bg-paper-deep border border-rule px-2 py-[3px] rounded-sm text-accent">${escapeHtml(current)}</code>
          <span class="fork-current-spacer flex-1"></span>
          <button class="${BTN}" id="forkRefreshBtn">Refresh</button>
          <button class="${BTN_PRIMARY}" id="forkBackBtn">Back to local</button>
        </div>` : ""}
    </section>
  `;

  const $input = host.querySelector("#forkInput");
  const $btn   = host.querySelector("#forkFetchBtn");
  const $msg   = host.querySelector("#forkMsg");

  // No <form> wrapper, on purpose: Safari/macOS autofill heuristics flag
  // an input + submit button in a <form> as a login pair the moment the
  // placeholder or label mentions "username". A plain button + keydown
  // handler avoids the credential overlay entirely.
  $btn.addEventListener("click", () => { void doFetch($input.value); });
  $input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); void doFetch($input.value); }
  });

  host.querySelectorAll(".fork-row").forEach(li => {
    const slug = li.dataset.slug;
    const branch = li.dataset.branch || "";
    li.addEventListener("click", e => {
      // Per-row buttons handle their own events
      if (e.target.closest("[data-act]")) return;
      void selectFromCache(slug, branch);
    });
    li.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "forget") {
          ForkCache.forgetFork(slug);
          if (ctx.dashState.externalSlug === slug) {
            ForkCache.restoreLocal();
            ctx.setSource(null);
            return;
          }
          ctx.requestRerender();
        } else if (act === "view") {
          void selectFromCache(slug, branch);
        } else if (act === "refresh") {
          void doFetch(branch ? `${slug}@${branch}` : slug);
        }
      });
    });
  });

  const $back = host.querySelector("#forkBackBtn");
  if ($back) $back.addEventListener("click", () => {
    ForkCache.restoreLocal();
    ctx.setSource(null);
  });

  const $refresh = host.querySelector("#forkRefreshBtn");
  if ($refresh && current) {
    $refresh.addEventListener("click", () => {
      const rec = ForkCache.readFork(current);
      const slugStr = rec && rec.branch ? `${current}@${rec.branch}` : current;
      void doFetch(slugStr);
    });
  }

  // Focus the input on first open if it's empty, no slug currently loaded.
  if (!current && !$input.value) $input.focus();

  // Kick off lazy upstream-staleness checks for every visible row.
  // ForkStaleness debounces with a 5-min sessionStorage TTL, so this is
  // cheap on re-renders within the same tab.
  attachStalenessBadges(host);

  /* ----- handlers ----- */

  function setMsg(text, tone) {
    $msg.textContent = text;
    $msg.dataset.tone = tone || "";
  }

  async function doFetch(raw) {
    const slug = ForkCache.resolveSlug(raw);
    if (!slug) { setMsg("Unrecognised slug. Try username, owner/repo, or owner/repo@branch.", "err"); return; }
    setMsg(`Fetching ${ForkCache.slugLabel(slug)}...`, "load");
    // Selector picks the Worker transport when /api/external/ping is
    // reachable (probe cached per-tab in sessionStorage), otherwise
    // falls back to direct GitHub from the browser.
    const transport = await createExternalTransport(slug);
    let snapshot;
    try { snapshot = await ForkCache.captureSnapshot(transport); }
    catch (e) {
      setMsg(humanizeError(slug, e), "err");
      return;
    }
    const fileCount = Object.keys(snapshot.files || {}).length;
    ForkCache.writeSnapshot(slug, snapshot);
    try { await ForkCache.applySnapshot(snapshot); }
    catch (e) {
      setMsg(`Snapshot stored, but apply failed: ${e && e.message || e}`, "err");
      return;
    }
    if (fileCount === 0) {
      setMsg(`Loaded ${ForkCache.slugLabel(slug)}, but no entities found. Expected prompts/, skills/, or agents/ at the repo root.`, "warn");
    } else {
      setMsg(`Loaded ${ForkCache.slugLabel(slug)} (${fileCount} files).`, "ok");
    }
    ctx.setSource(slug);
  }

  async function selectFromCache(slugStr, branch) {
    const rec = ForkCache.readFork(slugStr);
    if (!rec || !rec.snapshots || !rec.snapshots.length) {
      // Cache row exists with no snapshots, refetch as a fallback
      return doFetch(branch ? `${slugStr}@${branch}` : slugStr);
    }
    try { await ForkCache.applySnapshot(rec.snapshots[0]); }
    catch (e) {
      setMsg(`Apply failed: ${e && e.message || e}`, "err");
      return;
    }
    ForkCache.touchViewed({ owner: slugStr.split("/")[0], repo: slugStr.split("/")[1] });
    const [owner, repo] = slugStr.split("/");
    ctx.setSource({ owner, repo, branch: branch || rec.branch || null });
  }
}

export function renderForkRow(f, currentSlug) {
  const fetchedAt = f.fetchedAt ? new Date(f.fetchedAt) : null;
  const ago = fetchedAt ? formatAgo(fetchedAt) : "(no snapshot)";
  const sha = f.sha ? f.sha.slice(0, 7) : "-";
  const active = f.slug === currentSlug ? " is-active" : "";
  const branchAttr = f.branch ? ` data-branch="${escapeHtml(f.branch)}"` : "";
  // .icon-btn: bg-paper border border-rule text-ink-soft w-[26px] h-[26px] inline-flex items-center justify-center rounded-sm cursor-pointer font-sans text-[12px] leading-none
  // .fork-row-actions .icon-btn override: w/h 26px, font-size 12px (already applied above)
  const ICON_BTN = "icon-btn bg-paper border border-rule text-ink-soft w-[26px] h-[26px] inline-flex items-center justify-center rounded-sm cursor-pointer font-sans text-[12px] leading-none transition-colors duration-150 hover:bg-paper-deep hover:text-ink hover:border-ink-faint";
  return `
    <li class="fork-row${active} flex items-center gap-3 py-2.5 px-1 border-b border-rule-soft cursor-pointer transition-colors duration-100 hover:bg-paper-deep" data-slug="${escapeHtml(f.slug)}"${branchAttr}>
      <div class="fork-row-main flex-1 min-w-0 flex flex-col gap-0.5">
        <span class="fork-row-slug font-mono text-[13px] text-ink overflow-hidden text-ellipsis whitespace-nowrap">${escapeHtml(f.slug)}${f.branch ? `<span class="fork-row-branch text-ink-mute ml-1">@${escapeHtml(f.branch)}</span>` : ""}</span>
        <span class="fork-row-meta font-mono text-[10.5px] text-ink-faint tracking-[.04em]">${escapeHtml(ago)} · <code>${escapeHtml(sha)}</code> · ${f.snapshotCount} snap${f.snapshotCount === 1 ? "" : "s"}</span>
      </div>
      <span class="fork-badge shrink-0 inline-flex items-center justify-center min-w-[26px] h-[22px] px-2 rounded-full font-mono text-[11px] tracking-[.04em] bg-paper-deep border border-rule text-ink-mute"
            data-slug="${escapeHtml(f.slug)}"
            data-status="idle"
            data-sha="${escapeHtml(f.sha || "")}"
            data-fetched="${escapeHtml(f.fetchedAt || "")}"
            data-branch="${escapeHtml(f.branch || "")}"
            title="Checking upstream...">·</span>
      <span class="fork-row-actions shrink-0 inline-flex gap-1">
        <button class="${ICON_BTN}" data-act="refresh" title="Refresh">↻</button>
        <button class="${ICON_BTN}" data-act="forget" title="Forget">×</button>
      </span>
    </li>
  `;
}

/* Walk every idle .fork-badge in the panel and paint it based on the
 * staleness probe. Painting rules follow plan section 1:
 *
 *   - successful upstream check, sha matches cache       -> fresh (•)
 *   - successful upstream check, sha differs             -> ahead (↻ N)
 *   - upstream check failed AND fetched > 7 days ago     -> stale (⚠)
 *   - upstream check failed AND fetched <= 7 days ago    -> error (✗)
 *
 * Calls are lazy and per-row; the probe itself caches in sessionStorage
 * for 5 minutes, so re-renders don't re-hit GitHub. */
export function attachStalenessBadges(host) {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  host.querySelectorAll(".fork-badge[data-status='idle']").forEach(el => {
    const slugStr   = el.dataset.slug || "";
    const cachedSha = el.dataset.sha || null;
    const fetchedAt = el.dataset.fetched || null;
    const branch    = el.dataset.branch || null;
    const [owner, repo] = slugStr.split("/");
    if (!owner || !repo) return;

    el.dataset.status = "loading";
    el.textContent = "…";

    ForkStaleness.checkStale({ owner, repo, branch }, cachedSha).then(res => {
      const fetchedDate = fetchedAt ? new Date(fetchedAt) : null;
      const ageMs = fetchedDate ? Date.now() - fetchedDate.getTime() : Infinity;
      const ago = fetchedDate ? formatAgo(fetchedDate) : "(no snapshot)";
      const succeeded = !res.reason && res.upstreamSha;

      if (!succeeded) {
        if (ageMs > SEVEN_DAYS_MS) {
          el.dataset.status = "stale";
          el.textContent = "⚠";
          el.title = `Stale, cached ${ago}. Upstream check ${res.reason ? `failed: ${res.reason}` : "did not return a sha"}.`;
        } else {
          el.dataset.status = "error";
          el.textContent = "✗";
          el.title = `Upstream check ${res.reason ? `failed: ${res.reason}` : "returned no sha"}.`;
        }
        return;
      }
      if (res.stale) {
        el.dataset.status = "ahead";
        el.textContent = `↻ ${res.aheadBy || 1}`;
        const u = (res.upstreamSha || "").slice(0, 7);
        const c = (cachedSha || "").slice(0, 7);
        el.title = `Upstream ahead, newest sha ${u}, cached ${c}. Click Refresh to re-fetch.`;
        return;
      }
      el.dataset.status = "fresh";
      el.textContent = "•";
      el.title = `Up to date, cached ${ago}.`;
    }).catch(e => {
      el.dataset.status = "error";
      el.textContent = "✗";
      el.title = `Upstream check threw: ${e && e.message || e}`;
    });
  });
}

export function formatAgo(d) {
  const diff = Date.now() - d.getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const day = Math.floor(h / 24);
  return `${day}d ago`;
}

export function humanizeError(slug, e) {
  const status = e && e.status;
  const label = ForkCache.slugLabel(slug);
  if (status === 404 && slug.repo === ".aitelier") {
    return `No .aitelier repo found for ${slug.owner}. Try owner/repo for a custom name.`;
  }
  if (status === 404) return `Not found: ${label}.`;
  if (status === 403) return `GitHub rate-limited (60/hr/IP without a Worker). Try again later or deploy the Worker.`;
  if (status === 0)   return `Network error: ${e && e.message || "unknown"}.`;
  return `Fetch failed (${status || "error"}): ${e && e.message || e}`;
}

if (typeof window !== "undefined") window.renderForkPanel = renderForkPanel;
