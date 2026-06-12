/* Host capability flags. The SPA needs a synchronous way to decide
 * whether to render edit/duplicate/delete affordances. The decision is
 * source-of-truth on the Worker (env.EDITS_ENABLED in worker/wrangler.toml,
 * exposed through GET /api/library/ping). Pages has no Worker at all, so
 * the probe just fails (or returns non-JSON) and capabilities stay false.
 *
 * The boot path (src/app.js init) awaits primeCapabilities() in parallel
 * with __dataReady so by the time any view renders, getCapabilitiesSync()
 * returns a stable answer. The result is also persisted in sessionStorage
 * so refreshes within the same tab skip the roundtrip. */

const SESSION_KEY = "aitelier-capabilities-v1";

// Static fallback. `identity.kind === "none"` means no identity provider is
// live (Pages, or a Worker with IDENTITY_PROVIDER unset). Identity-aware UI
// must gate on `identity.kind !== "none"` before reading `.user`/attribution.
// `identity` is ALWAYS present so the synchronous `.identity.kind` read never
// throws (see .plans/0008_user-management.md §7).
const NONE_IDENTITY = Object.freeze({ kind: "none" });
const FALSE = Object.freeze({ edits: false, identity: NONE_IDENTITY });
let cached = FALSE;
let primed = false;

// Normalise a ping/sessionStorage payload's identity into a frozen object that
// always has a `kind`. Old sessionStorage entries (written before identity
// existed) have shape {"edits":false} with no identity, so default it here -
// otherwise a second tab-load (cache hit) would read `.identity.kind` of
// undefined and throw, even after the first load's live probe worked.
function normalizeIdentity(src) {
  const id = src && typeof src === "object" ? src.identity : null;
  if (id && typeof id === "object" && typeof id.kind === "string") return Object.freeze({ ...id });
  return NONE_IDENTITY;
}

export async function primeCapabilities() {
  if (primed) return cached;
  primed = true;

  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        cached = Object.freeze({ edits: !!parsed.edits, identity: normalizeIdentity(parsed) });
        return cached;
      }
    }
  } catch { /* private mode or bad json: fall through to probe */ }

  try {
    const r = await fetch("/api/library/ping", { cache: "no-store" });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (r.ok && ct.includes("application/json")) {
      const j = await r.json();
      cached = Object.freeze({ edits: !!(j && j.edits), identity: normalizeIdentity(j) });
    }
  } catch { /* leave at FALSE */ }

  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(cached)); } catch { /* ignore */ }
  return cached;
}

export function getCapabilitiesSync() {
  return cached;
}
