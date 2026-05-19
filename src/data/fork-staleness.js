import { ForkCache } from "./fork-cache.js";

/* Staleness probe for cached forks. Asks an upstream source for the
 * current head sha of a slug and compares it to the cached snapshot's
 * sha. Result cached in sessionStorage so we don't ping GitHub once per
 * row render.
 *
 * Two upstream paths:
 *   - Hosted mode: GET `/api/external/<owner>/<repo>/meta` on the Worker.
 *   - Direct mode: GET `https://api.github.com/repos/<owner>/<repo>/commits?per_page=1`.
 * The Worker is preferred when available because it shares the upstream
 * call across visitors. We try the Worker first; on any non-200 (or
 * network failure, which is the normal case when no Worker is in front)
 * we fall through to direct GitHub.
 *
 * `aheadBy` is best-effort: the precise count would need the Compare API
 * which costs a second call. v1 reports `1` when shas differ. */

export const STALE_KEY = "aitelier-stale-v1";
export const STALE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function readStaleMap() {
  try { return JSON.parse(sessionStorage.getItem(STALE_KEY) || "{}"); } catch { return {}; }
}
export function writeStaleMap(m) {
  try { sessionStorage.setItem(STALE_KEY, JSON.stringify(m)); } catch { /* private mode */ }
}

export async function checkStale(slug, cachedSha) {
  const k = ForkCache.slugKey(slug);
  const map = readStaleMap();
  const now = Date.now();
  const entry = map[k];
  if (entry && (now - entry.at) < STALE_TTL_MS) {
    return decide(entry, cachedSha);
  }

  let sha = null, date = null, reason = null;
  try {
    const fromWorker = await probeWorker(slug);
    if (fromWorker) { sha = fromWorker.sha; date = fromWorker.date; }
    else {
      const fromGh = await probeDirect(slug);
      if (fromGh) { sha = fromGh.sha; date = fromGh.date; }
    }
  } catch (e) {
    reason = (e && e.message) || String(e);
  }

  const next = { at: now, sha, date, reason };
  map[k] = next;
  writeStaleMap(map);
  return decide(next, cachedSha);
}

export function decide(entry, cachedSha) {
  if (entry.reason) return { stale: false, reason: entry.reason };
  if (!entry.sha) return { stale: false, reason: "unknown" };
  if (cachedSha && entry.sha === cachedSha) return { stale: false, upstreamSha: entry.sha };
  return { stale: true, aheadBy: 1, upstreamSha: entry.sha };
}

export async function probeWorker(slug) {
  // If the Worker route isn't there, we expect either a 404 from the
  // static host or the SPA's own 200 + HTML. Either way we treat it as
  // "no Worker" and fall back.
  const url = `/api/external/${slug.owner}/${slug.repo}/meta${slug.branch ? `?branch=${encodeURIComponent(slug.branch)}` : ""}`;
  let r;
  try { r = await fetch(url, { headers: { Accept: "application/json" } }); }
  catch { return null; }
  if (!r.ok) return null;
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return null;
  const j = await r.json();
  if (!j || !j.sha) return null;
  return { sha: j.sha, date: j.sha_date || null };
}

export async function probeDirect(slug) {
  const branchQ = slug.branch ? `&sha=${encodeURIComponent(slug.branch)}` : "";
  const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/commits?per_page=1${branchQ}`;
  let r;
  try { r = await fetch(url, { headers: { Accept: "application/vnd.github+json" } }); }
  catch (e) { throw new Error(`network: ${e && e.message || e}`); }
  if (!r.ok) throw new Error(`commits: ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const c = arr[0].commit || {};
  const date = (c.committer && c.committer.date) || (c.author && c.author.date) || null;
  return { sha: arr[0].sha, date };
}

export const ForkStaleness = { checkStale, STALE_TTL_MS };

if (typeof window !== "undefined") window.ForkStaleness = ForkStaleness;
