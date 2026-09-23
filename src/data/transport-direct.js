/* Direct GitHub transport. Used by the External source when no Worker
 * is in front of the static site. Talks to api.github.com and
 * raw.githubusercontent.com from the browser, subject to GitHub's
 * unauthenticated 60/hr/IP rate limit. The fork-cache and (later) KV
 * layers exist to keep this number sane.
 *
 * Factory rather than singleton, each external fork the user fetches
 * gets its own transport pinned to that slug. Implements the same
 * EntityTransport shape consumed by `loadEntities()` so the orchestrator
 * needs no per-source branching.
 *
 *   createTransportDirect({ owner, repo, branch })
 *     .list(folder)      -> Promise<string[] ids>
 *     .fetch(folder, id) -> Promise<string raw markdown>
 *     .head()            -> Promise<{ sha, date }>
 *
 * Errors carry a `status` field (`GitHubError`) so callers can show a
 * meaningful badge (404 not-found vs 403 rate-limited vs other).
 */

import { decodeBundle } from "../lib/bundle.js";

export function ghError(status, message) {
  const e = new Error(message);
  e.name = "GitHubError";
  e.status = status;
  return e;
}

export async function ghJson(url) {
  let res;
  try { res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } }); }
  catch (e) { throw ghError(0, `network: ${e && e.message || e}`); }
  if (!res.ok) throw ghError(res.status, `GET ${url}: ${res.status}`);
  return await res.json();
}

export function createTransportDirect(slug) {
  const { owner, repo } = slug;
  // `branch` is the requested ref, possibly null. `resolvedRef` is what we
  // actually use for API calls, populated lazily by ensureHead() to either
  // the explicit branch's tip sha or the default branch's tip sha.
  let resolvedSha = null;
  let resolvedDate = null;
  let resolvedBranch = slug.branch || null;
  // Catalog cache. The catalog comes from one of two paths and downstream
  // callers don't need to know which:
  //   - "bundle" - fork publishes `_bundle.br` at repo root. Single raw
  //     fetch + brotli decompress gives a Map<path, body>; list() filters
  //     by folder, fetch() serves bodies directly. No more network hits.
  //   - "tree"   - fork has no bundle. We fall back to the recursive
  //     /git/trees endpoint for slugs, then per-file raw blob fetches in
  //     fetch(). One transport instance picks one mode and sticks with it.
  let catalogP = null;

  async function ensureHead() {
    if (resolvedSha) return { sha: resolvedSha, date: resolvedDate };
    // /commits?per_page=1 without `sha` returns commits on the repo's
    // default branch directly, saving the /repos/:o/:r probe just to
    // learn what the default branch is named.
    const qs = resolvedBranch ? `?per_page=1&sha=${encodeURIComponent(resolvedBranch)}` : `?per_page=1`;
    const commits = await ghJson(`https://api.github.com/repos/${owner}/${repo}/commits${qs}`);
    if (!Array.isArray(commits) || !commits.length) throw ghError(404, "no commits");
    resolvedSha = commits[0].sha;
    const c = commits[0].commit || {};
    resolvedDate = (c.committer && c.committer.date) || (c.author && c.author.date) || null;
    return { sha: resolvedSha, date: resolvedDate };
  }

  async function tryBundle() {
    await ensureHead();
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${resolvedSha}/_bundle.br`;
    let res;
    try { res = await fetch(url); }
    catch (e) { throw ghError(0, `network: ${e && e.message || e}`); }
    if (res.status === 404) return null; // no bundle published, caller falls back
    if (!res.ok) throw ghError(res.status, `bundle: ${res.status}`);
    return await decodeBundle(res.body);
  }

  async function fetchTree() {
    await ensureHead();
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${resolvedSha}?recursive=1`;
    let res;
    try { res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } }); }
    catch (e) { throw ghError(0, `network: ${e && e.message || e}`); }
    if (!res.ok) throw ghError(res.status, `tree ${resolvedSha}: ${res.status}`);
    const body = await res.json();
    // GitHub returns truncated:true when a tree exceeds 100k entries or 7MB.
    // Catalogs are tiny in practice; surface the truncated case so we don't
    // silently serve an incomplete listing.
    if (body && body.truncated) throw ghError(0, "tree truncated, fork too large for fast-path");
    const grouped = Object.create(null);
    for (const it of (body && body.tree) || []) {
      if (!it || it.type !== "blob" || typeof it.path !== "string") continue;
      // Only top-level `<folder>/<slug>.md` entries become listable slugs.
      // Folder-shaped entities (skills/<slug>/SKILL.md, hooks/<slug>/...)
      // are out of scope for the direct transport - the worker handles
      // those server-side via library.ts.
      const m = /^([^/]+)\/([^/]+)\.md$/.exec(it.path);
      if (!m) continue;
      (grouped[m[1]] || (grouped[m[1]] = [])).push(m[2]);
    }
    return grouped;
  }

  async function ensureCatalog() {
    if (catalogP) return catalogP;
    catalogP = (async () => {
      // Bundle first; one raw fetch + decompress vs N tree+blob calls.
      // Decode failure (truncated brotli, malformed frames) is treated as
      // "no bundle" so the fork still loads via the tree fallback.
      let files = null;
      try { files = await tryBundle(); }
      catch (e) {
        // Genuine network/permission failures bubble up; treat decode
        // errors and explicit non-404 bundle failures as "fall through".
        if (e && e.status >= 400 && e.status !== 404 && e.status !== 200) {
          // Non-404 HTTP error from the raw host - surface so caller sees
          // the real problem (rate limit, repo private, etc.) instead of
          // a misleading tree fallback.
          throw e;
        }
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
      const grouped = await fetchTree();
      return { mode: "tree", files: null, grouped };
    })();
    catalogP.catch(() => { catalogP = null; });
    return catalogP;
  }

  async function list(folder) {
    const cat = await ensureCatalog();
    return cat.grouped[folder] ? cat.grouped[folder].slice() : [];
  }

  async function fetchMd(folder, id) {
    const cat = await ensureCatalog();
    if (cat.mode === "bundle") {
      const body = cat.files.get(`${folder}/${id}.md`);
      if (body === undefined) throw ghError(404, `bundle missing ${folder}/${id}.md`);
      return body;
    }
    // Tree-mode fallback: raw.githubusercontent.com avoids the contents-API
    // per-file body, which base64-encodes payloads and counts toward the
    // rate limit. The raw host serves the file directly.
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${resolvedSha}/${encodeURIComponent(folder)}/${encodeURIComponent(id)}.md`;
    let res;
    try { res = await fetch(url); }
    catch (e) { throw ghError(0, `network: ${e && e.message || e}`); }
    if (!res.ok) throw ghError(res.status, `raw ${folder}/${id}.md: ${res.status}`);
    return await res.text();
  }

  return {
    list,
    fetch: fetchMd,
    head: ensureHead,
    get sha() { return resolvedSha; },
    get branch() { return resolvedBranch; }
  };
}

if (typeof window !== "undefined") {
  window.createTransportDirect = createTransportDirect;
  window.__ghError = ghError;
}
