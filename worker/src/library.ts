/*
 * worker-library.ts - R2-backed library routes for Path B (Worker mode).
 *
 * Draft, lives under .plans/0006_deploy-modes/ until Path B base lands. Promote
 * to worker/src/library.ts and wire from worker/src/index.ts.
 *
 * Contract (see .plans/0006_deploy-modes/plan.md §3.3 - §3.5):
 *
 *   GET    /api/library/ping
 *   GET    /api/library/list                              -> R2 listing
 *   GET    /api/library/file/:folder/:name                -> R2 markdown body
 *   PUT    /api/library/file/:folder/:name (text/markdown)-> R2 upsert
 *   DELETE /api/library/file/:folder/:name                -> R2 delete
 *
 * Direct SPA reads also go through this module:
 *
 *   GET /prompts/*.md  /  /skills/*.md  /  /agents/*.md   -> R2.get
 *
 * Write attribution / identity (.plans/0008_user-management.md): Cloudflare Access
 * at the edge gates *reachability*; this module additionally *identifies the
 * writer* (via the pluggable IdentityProvider) to stamp the sidecar, and may
 * 401 as defense-in-depth when AUTH_REQUIRED is set. Identifying the writer
 * and gating the write are distinct jobs - Access does the gate, this code
 * does the identity stamp. The Worker is the SOLE writer of the `*.aitelier.json`
 * sidecar (and the future `*.history.jsonl` log): client PUT/DELETE to those
 * paths is refused (403) so authorship cannot be forged by a crafted request.
 *
 * Lazy one-time seed (plan §3.4):
 *   Sentinel KV key `library:seed-state`:
 *     - missing       -> seed needed, run blocking.
 *     - "seeding-<t>" -> another isolate seeding, treat as "in-progress".
 *     - "seeded-vN"   -> done. If N < CURRENT_BUNDLE_VERSION, gap-fill seed.
 *   Seed reads `_manifest.json` from env.ASSETS, copies missing keys into R2.
 *   Never overwrites existing R2 keys. User edits stay sacred.
 */

import { HttpError } from "./transport-github";
import { Identity, IdentityProvider, identityProviderFor } from "./identity/provider";

// Keep in sync with ENTITY_FOLDERS in src/lib/group-entities.js. The
// Worker runs under its own tsconfig (worker/tsconfig.json) and can't
// import the SPA module without widening the include set, so this is a
// deliberate two-place edit when a fifth entity type is added.
const LIBRARY_FOLDERS = new Set(["prompts", "skills", "agents", "hooks"]);
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PATH = 512;
const MAX_DEPTH_AFTER_FOLDER = 5; // e.g. skills/foo/scripts/helpers/lib.ts
const ALLOWED_EXT = new Set([
  ".md", ".sh", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".toml"
]);
const MAX_BODY = 1 << 20; // 1 MiB

const SEED_SENTINEL_KEY = "library:seed-state";
const SEED_IN_PROGRESS_TTL = 60; // seconds

interface LibEnv {
  LIBRARY: R2Bucket;
  ASSETS: Fetcher;
  FORK_CACHE: KVNamespace;     // reuse the existing KV namespace for the sentinel
  EDITS_ENABLED?: string;      // "true" to expose edit/duplicate/delete UI on this deployment
  // Identity / write-attribution config (.plans/0008_user-management.md §8). The
  // last five fields make LibEnv assignable to IdentityProvider.resolve's env.
  IDENTITY_PROVIDER?: string;  // "cloudflare-access" | "none" (absent -> "none")
  AUTH_REQUIRED?: string;      // "true" -> write returns 401 when unauthenticated
  ACCESS_AUD?: string;         // CF Access AUD (secret)
  ACCESS_TEAM_DOMAIN?: string; // "<team>.cloudflareaccess.com" (secret)
  DEV_IDENTITY?: string;       // wrangler-dev only; never set in production
}

interface LibraryEntry {
  path: string;
  size: number;
  mtime?: string;
  sha256?: string;
}

interface Manifest {
  version: string;
  files: string[];
}

let manifestCache: Manifest | null = null;
let seedPromise: Promise<void> | null = null;

// Per-isolate identity provider. Built once from IDENTITY_PROVIDER; an
// unrecognised slug throws here (fail loud per §8). The adapter holds its own
// state (cloudflare-access JWKS cache), so reuse the same instance.
let providerMemo: IdentityProvider | null = null;
function getProvider(env: LibEnv): IdentityProvider {
  if (!providerMemo) providerMemo = identityProviderFor(env.IDENTITY_PROVIDER);
  return providerMemo;
}

// Max anonymous contributor rows kept on a sidecar (FIFO of anonymous only;
// authenticated rows never evicted). Bounds growth on busy public Workers.
const MAX_ANON_CONTRIBUTORS = 50;
// Sidecar CAS retry budget on a concurrent-write miss (§11.8).
const SIDECAR_CAS_RETRIES = 3;

interface Stamp { id: string | null; label: string | null; at: string; provider: string; }
interface Contributor { id: string | null; label: string | null; first_at: string; last_at: string; count: number; provider: string; }

export async function handleLibrary(request: Request, env: LibEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Ping never seeds; cheap probe for transport detection and capability
  // advertisement. Constructing the provider throws on an unrecognised
  // IDENTITY_PROVIDER slug (fail loud on a misconfigured deploy). resolve()'s
  // throw, by contrast, is SWALLOWED here: a lapsed/forged Access session must
  // not dark the capability probe (which would silently strip the edit UI).
  // The 401-on-invalid-credential lives on the write path, never here.
  if (path === "/api/library/ping") {
    const provider = getProvider(env);
    let user: { id: string; label: string; email?: string } | undefined;
    try {
      const id = await provider.resolve(request, env);
      if (id) user = { id: id.id, label: id.label, email: id.email };
    } catch { user = undefined; }
    return json({ ok: true, edits: env.EDITS_ENABLED === "true", identity: { kind: provider.kind, user } });
  }

  await ensureSeed(env, ctx);

  if (path === "/api/library/list" && request.method === "GET") {
    const flat = url.searchParams.get("flat") === "1";
    return flat ? await listLibraryFlat(env) : await listLibraryGrouped(env);
  }

  const filePrefix = "/api/library/file/";
  if (path.startsWith(filePrefix)) {
    const rel = path.slice(filePrefix.length).replace(/\/+$/, "");
    validateLibraryPath(rel);
    if (request.method === "GET") return await readFile(env, rel);
    if (request.method === "PUT" || request.method === "DELETE") {
      // Server-derived files (sidecar, history log) are written only by this
      // module's stamping code. A client PUT/DELETE to them would forge
      // authorship, so refuse before touching R2.
      if (isServerDerivedPath(rel)) throw new HttpError(403, "server-managed file");
      const provider = getProvider(env);
      const who = await resolveOr401(provider, request, env);
      if (request.method === "PUT") return await writeFile(env, rel, request, who, provider.kind);
      return await deleteFile(env, rel);
    }
    throw new HttpError(405, "method not allowed");
  }

  throw new HttpError(404, "unknown library route");
}

/*
 * Direct read for /prompts/..., /skills/..., /agents/..., /hooks/... Called
 * from worker/src/index.ts when the path falls under a library folder.
 * Folder-shaped entities like /skills/foo/scripts/run.py go through here too.
 */
export async function layeredAssetFetch(request: Request, env: LibEnv, ctx: ExecutionContext): Promise<Response> {
  await ensureSeed(env, ctx);
  const url = new URL(request.url);
  const key = url.pathname.replace(/^\//, "");
  if (!isLibraryPath(key)) return env.ASSETS.fetch(request);

  const obj = await env.LIBRARY.get(key);
  if (obj) {
    return new Response(obj.body, {
      headers: {
        "Content-Type": contentTypeFor(key),
        "ETag": obj.etag,
        "Last-Modified": obj.uploaded.toUTCString(),
      },
    });
  }
  return new Response("not found", { status: 404 });
}

async function listLibraryFlat(env: LibEnv): Promise<Response> {
  const objs = await listAll(env.LIBRARY);
  const files: LibraryEntry[] = objs
    .filter((o) => isLibraryPath(o.key))
    .map((o) => ({
      path: o.key,
      size: o.size,
      mtime: o.uploaded.toISOString(),
      sha256: o.checksums?.sha256 ? hex(o.checksums.sha256) : undefined,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return json({ files });
}

/*
 * Grouped tree consumed by the SPA. One key per LIBRARY_FOLDERS, each an
 * array of entity descriptors:
 *   { slug, kind: "file"|"folder", main, attachments: [{ path, size }, ...] }
 *
 * Detection rule mirrors plan §2: <folder>/<slug>.md is a file entity,
 * <folder>/<slug>/<MAIN>.md is a folder entity (MAIN derived from the
 * folder name, e.g. skills -> SKILL.md). Slug collisions (same slug
 * appearing as both shapes) round-trip to the SPA marked `collision:true`
 * so the view can surface the error card from plan §2 instead of silently
 * shadowing.
 */
async function listLibraryGrouped(env: LibEnv): Promise<Response> {
  const objs = await listAll(env.LIBRARY);
  const grouped = groupEntities(objs);
  return json(grouped);
}

interface GroupedAttachment {
  path: string;
  size: number;
}

interface GroupedEntity {
  slug: string;
  kind: "file" | "folder";
  main: string;
  attachments: GroupedAttachment[];
  collision?: boolean;
}

export function mainFileFor(folder: string): string {
  // prompts intentionally stays single-file; the parser ignores folder shape.
  // Phase 2: hooks are folder-shaped, with hook.json carrying the verbatim
  // settings.json snippet. Keep in sync with src/lib/group-entities.js.
  switch (folder) {
    case "skills": return "SKILL.md";
    case "agents": return "AGENT.md";
    case "hooks":  return "hook.json";
    default:       return "";
  }
}

interface BucketObjMeta { key: string; size: number; }

function groupEntities(objs: R2Object[]): Record<string, GroupedEntity[]> {
  const out: Record<string, GroupedEntity[]> = {};
  for (const folder of LIBRARY_FOLDERS) out[folder] = [];

  // Bucket every valid path by its top-level folder.
  const byFolder = new Map<string, BucketObjMeta[]>();
  for (const o of objs) {
    if (!isLibraryPath(o.key)) continue;
    const folder = o.key.split("/", 1)[0];
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push({ key: o.key, size: o.size });
  }

  for (const [folder, entries] of byFolder) {
    const main = mainFileFor(folder);
    const files = new Map<string, GroupedEntity>();             // file-shape entities, slug -> entity
    const folders = new Map<string, GroupedEntity>();           // folder-shape entities, slug -> entity
    const orphans: BucketObjMeta[] = [];                        // files under a folder slug without a main file

    for (const e of entries) {
      const tail = e.key.slice(folder.length + 1);              // "<slug>.md" or "<slug>/<...>"
      const slash = tail.indexOf("/");
      if (slash < 0) {
        // Flat shape: only treat .md files as entities; ignore stray
        // attachments at the folder root (defensive - validator rejects
        // them today, but a future relaxation should not promote them).
        if (!tail.endsWith(".md")) continue;
        const slug = tail.slice(0, -3);
        if (!slug) continue;
        files.set(slug, { slug, kind: "file", main: e.key, attachments: [] });
        continue;
      }
      // Folder shape.
      if (folder === "prompts") continue;                       // plan §2: prompts ignores folder shape.
      const slug = tail.slice(0, slash);
      if (!slug) continue;
      const rest = tail.slice(slash + 1);
      const mainKey = `${folder}/${slug}/${main}`;
      if (rest === main) {
        const ent = folders.get(slug) || { slug, kind: "folder" as const, main: mainKey, attachments: [] };
        ent.main = mainKey;
        folders.set(slug, ent);
      } else {
        const ent = folders.get(slug) || { slug, kind: "folder" as const, main: mainKey, attachments: [] };
        ent.attachments.push({ path: e.key, size: e.size });
        folders.set(slug, ent);
      }
    }

    // Drop folder-shape entries that never produced a main file. They are
    // ignored per plan §2; rather than render an empty card, treat them as
    // attachments that should be cleaned up by the author.
    for (const [slug, ent] of folders) {
      const sawMain = entries.some(e => e.key === `${folder}/${slug}/${main}`);
      if (!sawMain) folders.delete(slug);
    }

    const merged: GroupedEntity[] = [];
    const seen = new Set<string>();
    for (const [slug, ent] of files) {
      if (folders.has(slug)) {
        // Slug collision. Plan §2 says reject; surface so the SPA can render
        // an error card instead of silently picking one shape.
        merged.push({ ...ent, collision: true });
      } else {
        merged.push(ent);
      }
      seen.add(slug);
    }
    for (const [slug, ent] of folders) {
      if (seen.has(slug)) {
        merged.push({ ...ent, collision: true });
      } else {
        // Stable attachment order.
        ent.attachments.sort((a, b) => a.path.localeCompare(b.path));
        merged.push(ent);
      }
    }
    merged.sort((a, b) => a.slug.localeCompare(b.slug));
    out[folder] = merged;
    void orphans; // currently unused; reserved for a future "stray files" badge.
  }

  return out;
}

async function readFile(env: LibEnv, key: string): Promise<Response> {
  const obj = await env.LIBRARY.get(key);
  if (!obj) throw new HttpError(404, "not found");
  return new Response(obj.body, {
    headers: { "Content-Type": contentTypeFor(key) },
  });
}

async function writeFile(env: LibEnv, key: string, request: Request, who: Identity | null, providerKind: string): Promise<Response> {
  const body = await request.text();
  if (body.length > MAX_BODY) throw new HttpError(413, "body too large");
  const sha = await sha256Hex(body);
  // Content first, then the sidecar (§11.8 atomicity): if the sidecar write is
  // lost, attribution lags one edit and the next write heals it; the reverse
  // could record an author for content that never committed.
  await env.LIBRARY.put(key, body, {
    httpMetadata: { contentType: contentTypeFor(key) },
    customMetadata: { sha256: sha },
  });
  // Stamp attribution only when writing the entity's main/content file.
  // Attachment writes (skills/foo/scripts/run.py) don't touch the sidecar, so
  // content_sha256 stays the main body's sha, never an attachment's.
  if (isMainContentFile(key)) await stampSidecar(env, key, sha, who, providerKind);
  return json({ ok: true, sha256: sha });
}

async function deleteFile(env: LibEnv, key: string): Promise<Response> {
  await env.LIBRARY.delete(key);
  return json({ ok: true });
}

/* ------------------------------ seed ------------------------------ */

async function ensureSeed(env: LibEnv, _ctx: ExecutionContext): Promise<void> {
  if (seedPromise) return seedPromise;          // already running in this isolate
  const state = await env.FORK_CACHE.get(SEED_SENTINEL_KEY);
  const manifest = await loadManifest(env);
  if (!manifest) return;                         // no manifest, nothing to seed
  if (state === `seeded-v${manifest.version}`) return;

  seedPromise = (async () => {
    await env.FORK_CACHE.put(SEED_SENTINEL_KEY, `seeding-${Date.now()}`, { expirationTtl: SEED_IN_PROGRESS_TTL });
    for (const path of manifest.files) {
      if (!isLibraryPath(path)) continue;
      const exists = await env.LIBRARY.head(path);
      if (exists) continue;                       // gap-fill, never overwrite
      const res = await env.ASSETS.fetch(new Request(`https://internal/${path}`));
      if (!res.ok) continue;
      const body = await res.arrayBuffer();
      await env.LIBRARY.put(path, body, {
        httpMetadata: { contentType: contentTypeFor(path) },
      });
    }
    await env.FORK_CACHE.put(SEED_SENTINEL_KEY, `seeded-v${manifest.version}`);
  })().finally(() => { seedPromise = null; });

  // Block this request until seed finishes. The seed touches ~50 small files
  // for a typical fork, well under the 30s Worker request budget.
  await seedPromise;
}

async function loadManifest(env: LibEnv): Promise<Manifest | null> {
  if (manifestCache) return manifestCache;
  try {
    const res = await env.ASSETS.fetch(new Request("https://internal/_manifest.json"));
    if (!res.ok) return null;
    const m = await res.json() as Manifest;
    manifestCache = m;
    return m;
  } catch {
    return null;
  }
}

/* ----------------------------- helpers ----------------------------- */

async function listAll(bucket: R2Bucket): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000, include: ["customMetadata", "httpMetadata"] });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

function isLibraryPath(key: string): boolean {
  if (key.length === 0 || key.length > MAX_PATH) return false;
  if (key.includes("..") || key.includes("//")) return false;
  const parts = key.split("/");
  if (parts.length < 2) return false;
  if (!LIBRARY_FOLDERS.has(parts[0])) return false;
  // 1..MAX_DEPTH_AFTER_FOLDER segments after the folder.
  const tail = parts.slice(1);
  if (tail.length < 1 || tail.length > MAX_DEPTH_AFTER_FOLDER) return false;
  for (const seg of tail) {
    if (!SEGMENT_RE.test(seg)) return false;
  }
  const last = tail[tail.length - 1];
  return ALLOWED_EXT.has(extOf(last));
}

function validateLibraryPath(key: string): void {
  if (!key || key.length > MAX_PATH) throw new HttpError(400, "invalid path");
  if (key.includes("..") || key.includes("//")) throw new HttpError(400, "traversal");
  const parts = key.split("/");
  if (parts.length < 2) throw new HttpError(400, "invalid path");
  if (!LIBRARY_FOLDERS.has(parts[0])) throw new HttpError(400, "invalid folder");
  const tail = parts.slice(1);
  if (tail.length < 1 || tail.length > MAX_DEPTH_AFTER_FOLDER) throw new HttpError(400, "depth");
  for (const seg of tail) {
    if (!SEGMENT_RE.test(seg)) throw new HttpError(400, "bad segment");
  }
  const last = tail[tail.length - 1];
  if (!ALLOWED_EXT.has(extOf(last))) throw new HttpError(400, "extension not allowed");
}

/* --------------------- identity / attribution -------------------- */

/* Resolve identity for a write, mapping the IdentityProvider contract onto
 * HTTP: a present-but-invalid credential (resolve throws) -> 401; an absent
 * credential (null) -> 401 only when AUTH_REQUIRED is on, else allowed
 * (anonymous write). */
async function resolveOr401(provider: IdentityProvider, request: Request, env: LibEnv): Promise<Identity | null> {
  let who: Identity | null;
  try {
    who = await provider.resolve(request, env);
  } catch {
    throw new HttpError(401, "authentication failed");
  }
  if (who == null && env.AUTH_REQUIRED === "true") throw new HttpError(401, "authentication required");
  return who;
}

/* Server-derived files the client may never write directly (§8). Covers the
 * flat `<slug>.aitelier.json` and folder `aitelier.json` sidecar shapes, plus
 * the deferred `*.history.jsonl` event log (flat + folder). Exported for tests. */
export function isServerDerivedPath(key: string): boolean {
  const base = key.split("/").pop() || "";
  return key.endsWith(".aitelier.json") || base === "aitelier.json" ||
         key.endsWith(".history.jsonl") || base === "history.jsonl";
}

/* True when `key` is an entity's main/content file (flat `<folder>/<slug>.md`,
 * or grouped `<folder>/<slug>/<MAIN>`). Attachments return false. Exported for
 * tests. */
export function isMainContentFile(key: string): boolean {
  const parts = key.split("/");
  const folder = parts[0];
  const tail = parts.slice(1);
  if (tail.length === 1) return tail[0].endsWith(".md");
  if (tail.length === 2) return tail[1] === mainFileFor(folder);
  return false;
}

/* Sidecar key for an entity content path. Flat -> `<folder>/<slug>.aitelier.json`;
 * grouped -> `<folder>/<slug>/aitelier.json`. Mirrors transport-local.js
 * sidecarPath. Exported for tests. */
export function sidecarKeyFor(key: string): string | null {
  const parts = key.split("/");
  const folder = parts[0];
  const tail = parts.slice(1);
  if (tail.length === 1) {
    const slug = tail[0].replace(/\.[^.]+$/, "");
    return slug ? `${folder}/${slug}.aitelier.json` : null;
  }
  const slug = tail[0];
  return slug ? `${folder}/${slug}/aitelier.json` : null;
}

/* Pure merge: fold a new write's stamp into an existing sidecar doc. Exported
 * for tests. `existed` distinguishes a brand-new sidecar (set created_by) from
 * a pre-v1 one lacking created_by (leave it missing - never fabricate a
 * creator, §9/§11.10). */
export function mergeSidecar(
  doc: Record<string, any>,
  opts: { folder: string; slug: string; contentSha: string; stamp: Stamp; existed: boolean },
): Record<string, any> {
  const { folder, slug, contentSha, stamp, existed } = opts;
  const authed = stamp.id != null;

  let contributors: Contributor[] = Array.isArray(doc.contributors) ? doc.contributors.slice() : [];
  if (authed) {
    const i = contributors.findIndex(c => c.id === stamp.id);
    if (i >= 0) {
      contributors[i] = { ...contributors[i], label: stamp.label, last_at: stamp.at, count: (contributors[i].count || 0) + 1, provider: stamp.provider };
    } else {
      contributors.unshift({ id: stamp.id, label: stamp.label, first_at: stamp.at, last_at: stamp.at, count: 1, provider: stamp.provider });
    }
  } else {
    // Anonymous writes never dedupe - two anonymous edits aren't necessarily
    // the same person. New row each time; capped below.
    contributors.unshift({ id: null, label: null, first_at: stamp.at, last_at: stamp.at, count: 1, provider: stamp.provider });
  }
  contributors.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
  contributors = capAnonymous(contributors, MAX_ANON_CONTRIBUTORS);

  const merged: Record<string, any> = {
    ...doc,
    id: doc.id || slug,
    type: doc.type || folder,
    content_sha256: contentSha,
    last_updated_by: stamp,
    contributors,
  };
  // created_by is set only when minting a brand-new sidecar. An existing
  // sidecar that lacks it (pre-v1) keeps it absent: the git history is the
  // audit trail, auto-stamping the current writer would be a lie.
  if (!existed) merged.created_by = stamp;
  return merged;
}

/* Keep all authenticated contributor rows; among anonymous rows (id == null),
 * keep only the newest `max` (FIFO). Assumes input sorted by last_at desc.
 * Exported for tests. */
export function capAnonymous(list: Contributor[], max: number): Contributor[] {
  let anon = 0;
  return list.filter(c => {
    if (c.id != null) return true;
    anon += 1;
    return anon <= max;
  });
}

/* Read-modify-write the sidecar under an R2 conditional PUT. The Workers R2
 * binding signals a precondition miss by RETURNING null (not a 412 / not a
 * throw), so the retry loop keys off `put === null`. Create case uses
 * etagDoesNotMatch:"*" (if-none-match), update case etagMatches on the read
 * etag. On exhaustion -> 409 (SPA prompts "changed under you, reload"). */
async function stampSidecar(env: LibEnv, contentKey: string, contentSha: string, who: Identity | null, providerKind: string): Promise<void> {
  const sideKey = sidecarKeyFor(contentKey);
  if (!sideKey) return;
  const parts = contentKey.split("/");
  const folder = parts[0];
  const slug = parts.length - 1 === 1 ? parts[1].replace(/\.[^.]+$/, "") : parts[1];
  const at = new Date().toISOString();
  const stamp: Stamp = who
    ? { id: who.id, label: who.label, at, provider: providerKind }
    : { id: null, label: null, at, provider: providerKind };

  for (let attempt = 0; attempt < SIDECAR_CAS_RETRIES; attempt++) {
    const existing = await env.LIBRARY.get(sideKey);
    let doc: Record<string, any> = {};
    let onlyIf: R2Conditional | Headers;
    if (existing) {
      try { doc = JSON.parse(await existing.text()); } catch { doc = {}; }
      onlyIf = { etagMatches: existing.etag };
    } else {
      // Create only if still absent. The documented binding form for
      // create-if-not-exists is a Headers `If-None-Match: *`.
      onlyIf = new Headers({ "If-None-Match": "*" });
    }
    const merged = mergeSidecar(doc, { folder, slug, contentSha, stamp, existed: !!existing });
    const put = await env.LIBRARY.put(sideKey, JSON.stringify(merged, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      onlyIf,
    });
    if (put !== null) return; // stored
    await sleep(casBackoffMs(attempt)); // CAS miss: another writer raced us
  }
  throw new HttpError(409, "sidecar changed under a concurrent write; reload and retry");
}

/* Randomised backoff so a team hammering one entity doesn't livelock. */
function casBackoffMs(attempt: number): number {
  return 25 * (attempt + 1) + Math.floor(Math.random() * 40);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function contentTypeFor(key: string): string {
  const e = extOf(key);
  switch (e) {
    case ".md":   return "text/markdown; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".yaml":
    case ".yml":  return "application/yaml; charset=utf-8";
    case ".sh":
    case ".py":
    case ".js":
    case ".ts":
    case ".toml":
    case ".txt":  return "text/plain; charset=utf-8";
    default:      return "application/octet-stream";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(buf);
}

function hex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/*
 * Wire-up sketch for worker/src/index.ts:
 *
 *   import { handleLibrary, layeredAssetFetch } from "./library";
 *
 *   export default {
 *     async fetch(request, env, ctx) {
 *       const url = new URL(request.url);
 *
 *       if (url.pathname.startsWith("/api/library/")) {
 *         return await handleLibrary(request, env, ctx);
 *       }
 *       if (url.pathname.startsWith("/api/external/")) {
 *         return await handleExternal(request, env);
 *       }
 *       // Library folders go through layered fetch (R2-only).
 *       if (isLibraryFolderRequest(url.pathname)) {
 *         return await layeredAssetFetch(request, env, ctx);
 *       }
 *       return env.ASSETS.fetch(request);
 *     },
 *   };
 *
 * worker-configuration.d.ts:
 *
 *   interface Env {
 *     FORK_CACHE: KVNamespace;
 *     LIBRARY: R2Bucket;
 *     ASSETS: Fetcher;
 *   }
 *
 * wrangler.toml additions:
 *
 *   [[r2_buckets]]
 *   binding = "LIBRARY"
 *   bucket_name = "aitelier-library"
 *   preview_bucket_name = "aitelier-library-preview"
 *
 *   [build]
 *   command = "bun run scripts/build-manifest.ts"
 */
