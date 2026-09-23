/* Write-attribution rendering. Shared by the manpage eyebrow, the card foot
 * pill, and the edit-requests list so the "edited by <label>" affordance is
 * built once. See .plans/0008_user-management.md §5 / §11.1 / §11.9.
 *
 * Rules:
 *   - gated on a live identity provider (getCapabilitiesSync().identity.kind
 *     !== "none"); dormant on Pages and on Workers without a provider.
 *   - inline label is the email local-part; tooltip shows the full id; click
 *     copies the full id (existing toast).
 *   - anonymous stamps (id == null) render the timestamp only, no "by" span.
 *   - timestamps are ISO/UTC on disk, formatted locally: relative for inline,
 *     absolute for the tooltip.
 *   - Tailwind-first inline (CLAUDE.md Rule 1); copy is AI/LLM-agnostic (Rule 4).
 */

import { getCapabilitiesSync } from "../data/capabilities.js";
import { escapeHtml, copyText } from "./util.js";

/* Identity provider live on this deploy? */
export function identityActive() {
  const cap = getCapabilitiesSync();
  return !!(cap && cap.identity && cap.identity.kind && cap.identity.kind !== "none");
}

/* The signed-in user advertised by the capability probe, or null. Shape:
 * { id, label, email? }. Used to stamp the author on a new edit request and to
 * show "Signed in as <label>". Null on Pages / anonymous / lapsed session. */
export function currentUser() {
  if (!identityActive()) return null;
  const u = getCapabilitiesSync().identity.user;
  return u && u.id ? u : null;
}

function localPart(idOrEmail) {
  const s = String(idOrEmail || "");
  const at = s.indexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

/* "2h ago" / "just now" from an ISO string, via Intl.RelativeTimeFormat. */
export function relativeTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = t - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units = [
    ["year", 31536e6], ["month", 2592e6], ["week", 6048e5],
    ["day", 864e5], ["hour", 36e5], ["minute", 6e4],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  }
  return "just now";
}

/* Browser-locale absolute date for the tooltip. */
export function absoluteTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(t));
  } catch {
    return new Date(t).toISOString();
  }
}

/* A copy-on-click identity badge: label visible, full id in tooltip + clipboard.
 * `cls` lets the caller theme it for eyebrow vs pill context. */
function badge(stamp, cls) {
  const id = String(stamp.id);
  const label = stamp.label || localPart(id);
  const tip = `${id} · ${absoluteTime(stamp.at)}`;
  return `<button type="button" class="${cls}" data-copy-id="${escapeHtml(id)}" title="${escapeHtml(tip)}">${escapeHtml(label)}</button>`;
}

const EYEBROW_BADGE =
  "appearance-none bg-transparent border-0 p-0 m-0 font-mono text-[11px] tracking-[.22em] uppercase text-ink-soft hover:text-accent cursor-pointer transition-colors underline underline-offset-2 decoration-dotted";

/* Manpage eyebrow fragment: ` · edited by <badge> · <relative>` from
 * last_updated_by. Returns "" when dormant or unstamped. Anonymous -> no "by".
 * The leading separator matches the surrounding eyebrow's ` · ` dividers. */
export function eyebrowAttributionHtml(entity) {
  if (!identityActive()) return "";
  const stamp = entity && entity.last_updated_by;
  if (!stamp || !stamp.at) return "";
  const sep = `<span class="sep text-ink-faint opacity-60">·</span>`;
  const when = `<span class="attrib-when text-ink-faint normal-case tracking-normal" title="${escapeHtml(absoluteTime(stamp.at))}">${escapeHtml(relativeTime(stamp.at))}</span>`;
  if (stamp.id == null) {
    // Anonymous: timestamp only, no "by" noise.
    return `${sep}<span class="attrib-edited normal-case tracking-normal text-ink-faint">edited</span>${when}`;
  }
  return `${sep}<span class="attrib-edited normal-case tracking-normal text-ink-faint">edited by</span>${badge(stamp, EYEBROW_BADGE)}${when}`;
}

const PILL_BADGE =
  "appearance-none bg-transparent border-0 p-0 m-0 font-mono text-[10.5px] tracking-[.08em] text-ink-mute hover:text-accent cursor-pointer transition-colors underline underline-offset-2 decoration-dotted";

/* Card-foot pill: "by <badge>" from last_updated_by. "" when dormant /
 * unstamped / anonymous (anonymous adds no signal on a dense card). */
export function cardAttributionHtml(entity) {
  if (!identityActive()) return "";
  const stamp = entity && entity.last_updated_by;
  if (!stamp || !stamp.at || stamp.id == null) return "";
  return `<span class="card-by font-mono text-[10.5px] text-ink-mute tracking-[.08em] lowercase">by ${badge(stamp, PILL_BADGE)}</span>`;
}

/* Metadata-table rows for write attribution (plan §11 minimal slice:
 * created_by inline + contributors rollup; last_updated_by stays in the
 * eyebrow). Plain strings: metaTable escapes values, so the interactive
 * copy-on-click badge stays eyebrow-only. Empty when no identity provider
 * is live or the sidecar is unstamped. */
export function attributionMetaRows(entity) {
  if (!identityActive() || !entity) return [];
  const who = (stamp) => stamp.id == null ? "anonymous" : (stamp.label || localPart(stamp.id));
  const rows = [];
  const created = entity.created_by;
  if (created && created.at) {
    rows.push(["Created by", `${who(created)}, ${absoluteTime(created.at)}`]);
  }
  const contribs = Array.isArray(entity.contributors) ? entity.contributors : [];
  if (contribs.length) {
    rows.push(["Contributors", contribs.map(c =>
      `${who(c)}${c.count > 1 ? ` (${c.count})` : ""}`).join(", ")]);
  }
  return rows;
}

/* Wire copy-on-click for any identity badges under `root`. Idempotent per
 * element (guards with a dataset flag). */
export function wireAttributionCopy(root) {
  if (!root) return;
  root.querySelectorAll("[data-copy-id]").forEach((el) => {
    if (el.dataset.copyWired === "1") return;
    el.dataset.copyWired = "1";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(el.dataset.copyId, "identity");
    });
  });
}
