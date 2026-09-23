import { createTransportDirect } from "./transport-direct.js";
import { decodeBundle } from "../lib/bundle.js";

/* Same-origin Worker transport. Used by the External source when an
 * Atelier Worker is in front of the static site (`wrangler dev`, a
 * deployed `*.workers.dev`). All upstream traffic is proxied through
 * `/api/external/...` so the audience shares one KV-backed cache.
 *
 * Implements the EntityTransport shape:
 *   list(folder)      -> Promise<string[] ids>
 *   fetch(folder, id) -> Promise<string raw markdown>
 *   head()            -> Promise<{ sha, date }>
 *
 * Internally the transport keeps a per-instance cache of meta + tree
 * entries so fetch(folder, id) can resolve to the right blob sha +
 * download_url without re-hitting the tree route.
 *
 * Routes consumed (see worker/src/index.ts):
 *   GET /api/external/:owner/:repo/meta?branch=optional
 *   GET /api/external/:owner/:repo/tree/:sha/:folder
 *   GET /api/external/blob/:sha?url=<raw.githubusercontent.com url>
 */

export const TRANSPORT_KEY = "aitelier-transport-v1";

export function workerError(status, message, retryAfter) {
  const e = new Error(message);
  e.name = "WorkerTransportError";
  e.status = status;
  e.retryAfter = retryAfter || null;
  return e;
}

export function createTransportWorker(slug, opts) {
  const { owner, repo, branch } = slug;
  const baseUrl = (opts && opts.baseUrl) || "";
  let metaP = null;
  // folder -> Map<id, { sha, download_url }>
  const treeCache = new Map();
  // Catalog cache. Same idea as the direct transport: try the bundle route
  // first, fall back to the per-folder tree route if the publisher hasn't
  // shipped a bundle. When bundle mode wins, both list() and fetch() are
  // served from the in-memory map with zero further network hits.
  let catalogP = null;

  function ensureMeta() {
    if (!metaP) {
      const url = `${baseUrl}/api/external/${owner}/${repo}/meta${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`;
      metaP = (async () => {
        let r;
        try { r = await fetch(url, { headers: { Accept: "application/json" } }); }
        catch (e) { throw workerError(0, `network: ${e && e.message || e}`); }
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw workerError(r.status, j.error || `meta: ${r.status}`, r.headers.get("Retry-After"));
        }
        return await r.json();
      })();
      // If meta fails we want the caller to be able to retry, so clear
      // the cached promise on rejection.
      metaP.catch(() => { metaP = null; });
    }
    return metaP;
  }

  async function tryBundle(sha) {
    const url = `${baseUrl}/api/external/${owner}/${repo}/bundle/${sha}`;
    let r;
    try { r = await fetch(url); }
    catch (e) { throw workerError(0, `network: ${e && e.message || e}`); }
    if (r.status === 404) return null;
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw workerError(r.status, j.error || `bundle: ${r.status}`, r.headers.get("Retry-After"));
    }
    return await decodeBundle(r.body);
  }

  async function listFromTree(folder, sha) {
    const url = `${baseUrl}/api/external/${owner}/${repo}/tree/${sha}/${encodeURIComponent(folder)}`;
    let r;
    try { r = await fetch(url, { headers: { Accept: "application/json" } }); }
    catch (e) { throw workerError(0, `network: ${e && e.message || e}`); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw workerError(r.status, j.error || `tree ${folder}: ${r.status}`, r.headers.get("Retry-After"));
    }
    const j = await r.json();
    const map = new Map();
    const ids = [];
    for (const f of (j.files || [])) {
      const name = String(f.name || "");
      const id = name.endsWith(".md") ? name.slice(0, -3) : name;
      if (!id) continue;
      map.set(id, { sha: f.sha, download_url: f.download_url || null });
      ids.push(id);
    }
    treeCache.set(folder, map);
    return ids;
  }

  async function ensureCatalog() {
    if (catalogP) return catalogP;
    catalogP = (async () => {
      const meta = await ensureMeta();
      let files = null;
      try { files = await tryBundle(meta.sha); }
      catch (e) {
        // Surface real failures (rate limit, auth) so the browser shows
        // the cause. Treat decode/parse errors as "no bundle".
        if (e && e.status >= 400 && e.status !== 404) throw e;
        files = null;
      }
      if (files) {
        const grouped = Object.create(null);
        for (const path of files.keys()) {
          const m = /^([^/]+)\/([^/]+)\.md$/.exec(path);
          if (!m) continue;
          (grouped[m[1]] || (grouped[m[1]] = [])).push(m[2]);
        }
        return { mode: "bundle", files, grouped };
      }
      return { mode: "tree", files: null, grouped: null, sha: meta.sha };
    })();
    catalogP.catch(() => { catalogP = null; });
    return catalogP;
  }

  async function list(folder) {
    const cat = await ensureCatalog();
    if (cat.mode === "bundle") {
      return cat.grouped[folder] ? cat.grouped[folder].slice() : [];
    }
    return await listFromTree(folder, cat.sha);
  }

  async function fetchMd(folder, id) {
    const cat = await ensureCatalog();
    if (cat.mode === "bundle") {
      const body = cat.files.get(`${folder}/${id}.md`);
      if (body === undefined) throw workerError(404, `bundle missing ${folder}/${id}.md`);
      return body;
    }
    let entry = treeCache.get(folder) && treeCache.get(folder).get(id);
    if (!entry) {
      // Cold path: a fetch was issued before list. Warm the tree cache.
      await listFromTree(folder, cat.sha);
      entry = treeCache.get(folder) && treeCache.get(folder).get(id);
    }
    if (!entry) throw workerError(404, `unknown id ${folder}/${id}`);
    const qs = entry.download_url ? `?url=${encodeURIComponent(entry.download_url)}` : "";
    const url = `${baseUrl}/api/external/blob/${entry.sha}${qs}`;
    let r;
    try { r = await fetch(url); }
    catch (e) { throw workerError(0, `network: ${e && e.message || e}`); }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw workerError(r.status, t || `blob ${entry.sha}: ${r.status}`, r.headers.get("Retry-After"));
    }
    return await r.text();
  }

  async function head() {
    const m = await ensureMeta();
    return { sha: m.sha, date: m.sha_date || null };
  }

  return { list, fetch: fetchMd, head };
}

/* One-shot capability probe. Cached per tab in sessionStorage so the
 * decision is made exactly once. The probe is HEAD /api/external/ping;
 * a 2xx means a Worker is in front of us, anything else (including the
 * network failing or the static host returning the SPA's index.html
 * with a 200 + text/html) selects the direct transport. */
export async function selectExternalTransport() {
  let cached = null;
  try { cached = sessionStorage.getItem(TRANSPORT_KEY); } catch { /* private mode */ }
  if (cached === "worker" || cached === "direct") return cached;

  let pick = "direct";
  try {
    const r = await fetch("/api/external/ping", {
      method: "HEAD",
      // Treat a redirect/non-2xx as "not a Worker".
      cache: "no-store"
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    // Belt + braces: only call it a Worker when the response advertises
    // JSON. A static host happily returning a 200 with text/html for an
    // unknown path would otherwise be misread as a Worker.
    if (r.ok && (ct.includes("application/json") || r.headers.get("X-Atelier-Worker"))) {
      pick = "worker";
    } else if (r.ok && ct === "") {
      // HEAD may strip the content-type on some hosts. Fall back to a
      // GET to confirm.
      try {
        const g = await fetch("/api/external/ping");
        const j = await g.json();
        if (g.ok && j && j.ok === true) pick = "worker";
      } catch { /* leave as direct */ }
    }
  } catch { /* leave as direct */ }

  try { sessionStorage.setItem(TRANSPORT_KEY, pick); } catch { /* private mode */ }
  return pick;
}

/* Factory used by the fork panel. Picks the right transport based on
 * the cached probe result. Both transports expose the same EntityTransport
 * shape, so callers don't care which one came back. */
export async function createExternalTransport(slug) {
  const which = await selectExternalTransport();
  if (which === "worker") return createTransportWorker(slug);
  return createTransportDirect(slug);
}

if (typeof window !== "undefined") {
  window.createTransportWorker = createTransportWorker;
  window.selectExternalTransport = selectExternalTransport;
  window.createExternalTransport = createExternalTransport;
  window.__TRANSPORT_KEY = TRANSPORT_KEY;
}
