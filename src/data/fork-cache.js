import { RELATED, BUILTINS, loadEntities } from "./load-entities.js";
import { ENTITY_FOLDERS } from "../lib/group-entities.js";

/* Browser-side fork cache. Single localStorage key, JSON value, capped at
 * SNAPSHOT_LIMIT snapshots per fork. Raw markdown text is stored, not
 * parsed entities, so the parser can evolve without re-fetching.
 *
 * Shape (see plan section 2.1):
 *   { forks: { "owner/repo": ForkRecord }, meta: { cacheVersion: 1 } }
 *   ForkRecord = { branch, lastViewedAt, snapshots: Snapshot[] }
 *   Snapshot   = { fetchedAt, sha, files: { "prompts/foo.md": "raw text" } }
 *
 * Eviction: on QuotaExceededError, drop the oldest snapshot from the fork
 * with the oldest `lastViewedAt`, retry up to three times.
 *
 * `resolveSlug(input)` turns user input into `{owner, repo, branch | null}`
 * per the `.aitelier` convention: bare username -> `<username>/.aitelier`,
 * `owner/repo`, `owner/repo@branch`, or a full github.com URL. */

export const FORK_CACHE_KEY = "aitelier-fork-cache-v1";
export const SNAPSHOT_LIMIT = 5;
export const SEG_RE = /^[A-Za-z0-9_.-]{1,39}$/;
export const BRANCH_RE = /^[A-Za-z0-9_./-]{1,255}$/;

/* The local entities loaded at boot. Captured the first time we apply an
 * external snapshot so a "Back to local" can restore them without
 * re-fetching from the dev server. */
export let __localBaseline = null;

export function resolveSlug(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL form. Only github.com is accepted, anything else is a paste
  // mistake and we'd rather refuse than guess.
  if (/^https?:\/\//i.test(trimmed)) {
    let u;
    try { u = new URL(trimmed); } catch { return null; }
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo  = parts[1].replace(/\.git$/i, "");
    let branch = null;
    if (parts[2] === "tree" && parts.length >= 4) branch = parts.slice(3).join("/");
    return validateSlug(owner, repo, branch);
  }

  // Strip optional @branch suffix.
  let body = trimmed;
  let branch = null;
  const atIdx = body.indexOf("@");
  if (atIdx >= 0) {
    branch = body.slice(atIdx + 1);
    body = body.slice(0, atIdx);
  }
  if (!body) return null;

  // Disallow whitespace inside, leading/trailing slash, or double slash.
  if (/\s/.test(body) || body.startsWith("/") || body.endsWith("/") || body.includes("//")) return null;

  let owner, repo;
  if (body.includes("/")) {
    const parts = body.split("/");
    if (parts.length !== 2) return null;
    owner = parts[0];
    repo  = parts[1];
  } else {
    // The `.aitelier` convention. No slash means "the user's published
    // aitelier repo" (typically `~/.claude/` pushed to GitHub as `.aitelier`).
    owner = body;
    repo  = ".aitelier";
  }
  return validateSlug(owner, repo, branch);
}

export function validateSlug(owner, repo, branch) {
  if (!SEG_RE.test(owner) || !SEG_RE.test(repo)) return null;
  if (branch !== null && branch !== undefined) {
    if (!branch || !BRANCH_RE.test(branch)) return null;
  }
  return { owner, repo, branch: branch || null };
}

export function slugKey(slug) {
  return `${slug.owner}/${slug.repo}`;
}

export function slugLabel(slug) {
  return slug.branch ? `${slug.owner}/${slug.repo}@${slug.branch}` : `${slug.owner}/${slug.repo}`;
}

/* ============================================================== persistence */

export function readAll() {
  let raw;
  try { raw = localStorage.getItem(FORK_CACHE_KEY); } catch { return emptyCache(); }
  if (!raw) return emptyCache();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return emptyCache(); }
  if (!parsed || typeof parsed !== "object") return emptyCache();
  if (!parsed.forks || typeof parsed.forks !== "object") parsed.forks = {};
  if (!parsed.meta) parsed.meta = { cacheVersion: 1 };
  return parsed;
}

export function emptyCache() { return { forks: {}, meta: { cacheVersion: 1 } }; }

export function writeAll(cache) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { localStorage.setItem(FORK_CACHE_KEY, JSON.stringify(cache)); return true; }
    catch (e) {
      if (e && e.name === "QuotaExceededError") {
        if (!evictOldest(cache)) return false;
        continue;
      }
      return false;
    }
  }
  return false;
}

export function readFork(slug) {
  const k = (typeof slug === "string") ? slug : slugKey(slug);
  return readAll().forks[k] || null;
}

export function writeSnapshot(slug, snapshot) {
  const cache = readAll();
  const k = slugKey(slug);
  let rec = cache.forks[k];
  if (!rec) rec = { branch: slug.branch || "", lastViewedAt: "", snapshots: [] };
  if (slug.branch) rec.branch = slug.branch;
  rec.snapshots = [snapshot].concat(rec.snapshots || []).slice(0, SNAPSHOT_LIMIT);
  rec.lastViewedAt = new Date().toISOString();
  cache.forks[k] = rec;
  return writeAll(cache);
}

export function touchViewed(slug) {
  const cache = readAll();
  const k = slugKey(slug);
  const rec = cache.forks[k];
  if (!rec) return;
  rec.lastViewedAt = new Date().toISOString();
  writeAll(cache);
}

export function listForks() {
  const cache = readAll();
  return Object.entries(cache.forks).map(([k, rec]) => {
    const newest = rec.snapshots && rec.snapshots[0];
    return {
      slug: k,
      branch: rec.branch || "",
      lastViewedAt: rec.lastViewedAt || null,
      fetchedAt: newest ? newest.fetchedAt : null,
      sha: newest ? newest.sha : null,
      snapshotCount: (rec.snapshots || []).length
    };
  }).sort((a, b) => (b.lastViewedAt || "").localeCompare(a.lastViewedAt || ""));
}

export function forgetFork(slug) {
  const cache = readAll();
  const k = (typeof slug === "string") ? slug : slugKey(slug);
  if (cache.forks[k]) { delete cache.forks[k]; writeAll(cache); }
}

export function evictOldest(cache) {
  // Pick the fork with the oldest lastViewedAt that still has at least one
  // snapshot, drop its oldest snapshot (or the whole record when empty).
  let oldestSlug = null;
  let oldestStamp = null;
  for (const [k, rec] of Object.entries(cache.forks)) {
    if (!rec.snapshots || !rec.snapshots.length) continue;
    const stamp = rec.lastViewedAt || "";
    if (oldestStamp === null || stamp < oldestStamp) { oldestStamp = stamp; oldestSlug = k; }
  }
  if (!oldestSlug) return false;
  const rec = cache.forks[oldestSlug];
  rec.snapshots.pop();
  if (!rec.snapshots.length) delete cache.forks[oldestSlug];
  return true;
}

/* ============================================================== snapshot capture + apply */

/* Walk every entity folder via a transport, return a snapshot object that
 * can be persisted and later replayed via applySnapshot(). The transport
 * is expected to expose `head()` so the snapshot is sha-pinned. */
export async function captureSnapshot(transport) {
  const head = transport.head ? await transport.head() : { sha: "unknown", date: null };
  const files = {};
  for (const folder of ENTITY_FOLDERS) {
    let ids = [];
    try { ids = await transport.list(folder); } catch { ids = []; }
    const raws = await Promise.all(ids.map(id => transport.fetch(folder, id)));
    raws.forEach((raw, i) => { files[`${folder}/${ids[i]}.md`] = raw; });
  }
  return { fetchedAt: new Date().toISOString(), sha: head && head.sha || "unknown", files };
}

/* Drain the built-in entity arrays + RELATED and refill from a snapshot.
 * Uses the same orchestrator + parser as the local source so the entity
 * shapes match exactly. Captures the local baseline on first call so
 * restoreLocal() can put things back. */
export async function applySnapshot(snapshot) {
  if (!__localBaseline) {
    const baseline = { related: Object.assign({}, RELATED) };
    for (const folder of ENTITY_FOLDERS) baseline[folder] = BUILTINS[folder].slice();
    __localBaseline = baseline;
  }
  drainGlobals();
  const transport = transportFromFiles(snapshot.files || {});
  await window.loadEntities(transport, { ...BUILTINS, related: RELATED });
}

export function restoreLocal() {
  if (!__localBaseline) return;
  drainGlobals();
  for (const folder of ENTITY_FOLDERS) {
    for (const e of __localBaseline[folder]) BUILTINS[folder].push(e);
  }
  Object.assign(RELATED, __localBaseline.related);
}

export function drainGlobals() {
  for (const folder of ENTITY_FOLDERS) BUILTINS[folder].length = 0;
  for (const k of Object.keys(RELATED)) delete RELATED[k];
}

/* Tiny in-memory transport that serves a previously-captured snapshot.
 * Used by applySnapshot, identical interface to TransportLocal and
 * TransportDirect so it goes through the same orchestrator. */
export function transportFromFiles(files) {
  return {
    async list(folder) {
      const prefix = folder + "/";
      const ids = [];
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix) && path.endsWith(".md")) {
          ids.push(path.slice(prefix.length, -3));
        }
      }
      return ids;
    },
    async fetch(folder, id) {
      const path = `${folder}/${id}.md`;
      if (!(path in files)) throw new Error(`missing ${path}`);
      return files[path];
    }
  };
}

export const ForkCache = {
  KEY: FORK_CACHE_KEY,
  SNAPSHOT_LIMIT,
  resolveSlug,
  slugKey,
  slugLabel,
  readAll,
  readFork,
  writeSnapshot,
  touchViewed,
  listForks,
  forgetFork,
  captureSnapshot,
  applySnapshot,
  restoreLocal,
  transportFromFiles
};

if (typeof window !== "undefined") window.ForkCache = ForkCache;
