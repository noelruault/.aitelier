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

const FALSE = Object.freeze({ edits: false });
let cached = FALSE;
let primed = false;

export async function primeCapabilities() {
  if (primed) return cached;
  primed = true;

  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        cached = Object.freeze({ edits: !!parsed.edits });
        return cached;
      }
    }
  } catch { /* private mode or bad json: fall through to probe */ }

  try {
    const r = await fetch("/api/library/ping", { cache: "no-store" });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (r.ok && ct.includes("application/json")) {
      const j = await r.json();
      cached = Object.freeze({ edits: !!(j && j.edits) });
    }
  } catch { /* leave at FALSE */ }

  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(cached)); } catch { /* ignore */ }
  return cached;
}

export function getCapabilitiesSync() {
  return cached;
}
