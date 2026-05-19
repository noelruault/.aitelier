/* GitHub adapter for the Worker. All upstream traffic goes through here
 * so the SSRF guard, the User-Agent, and the KV caching policy sit in
 * one place. The three operations match the routes in plan section 4.3:
 *
 *   fetchRepoMeta   <- /api/external/:owner/:repo/meta
 *   fetchTree       <- /api/external/:owner/:repo/tree/:sha/:folder
 *   fetchBlob       <- /api/external/blob/:sha?url=<download_url>
 *
 * Cache layout (KV keys, plan section 2.2):
 *   github:repo:{owner}/{repo}@{branch?}     TTL.repo
 *   github:tree:{owner}/{repo}@{sha}/{folder} TTL.tree
 *   github:file:{blobSha}                     TTL.blob
 */

import { TTL, kvGetJson, kvGetText, kvPutJson, kvPutText } from "./kv-cache";

export type RepoMeta = {
  default_branch: string;
  sha: string;
  sha_date: string | null;
};

export type TreeEntry = {
  name: string;
  path: string;
  sha: string;          // the blob sha (the value stays stable per content)
  download_url: string | null;
};

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public retryAfter: string | null = null
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const GH_API = "https://api.github.com";
const GH_RAW = "https://raw.githubusercontent.com";
const UA = "aitelier-worker (+https://github.com/noelruault/aitelier)";

async function ghJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const retryAfter =
      res.headers.get("Retry-After") ||
      res.headers.get("X-RateLimit-Reset");
    throw new HttpError(res.status, `${url} -> ${res.status}`, retryAfter);
  }
  return (await res.json()) as T;
}

export async function fetchRepoMeta(
  env: Env,
  owner: string,
  repo: string,
  branch: string | null
): Promise<RepoMeta> {
  const key = `github:repo:${owner}/${repo}${branch ? `@${branch}` : ""}`;
  const cached = await kvGetJson<RepoMeta>(env, key);
  if (cached) return cached;

  // /commits?per_page=1 without `sha` already returns commits on the
  // default branch, so we skip the separate /repos/:o/:r probe when no
  // explicit branch was requested. We still expose default_branch on the
  // returned meta - when unknown we leave it blank; callers only use it
  // for display.
  const qs = branch ? `?sha=${encodeURIComponent(branch)}&per_page=1` : `?per_page=1`;
  const commits = await ghJson<
    Array<{
      sha: string;
      commit?: { committer?: { date?: string }; author?: { date?: string } };
    }>
  >(`${GH_API}/repos/${owner}/${repo}/commits${qs}`);

  if (!commits || !commits.length) {
    throw new HttpError(404, `no commits on ${owner}/${repo}${branch ? `@${branch}` : ""}`);
  }
  const sha = commits[0].sha;
  const sha_date =
    commits[0].commit?.committer?.date ||
    commits[0].commit?.author?.date ||
    null;

  const meta: RepoMeta = { default_branch: branch || "", sha, sha_date };
  await kvPutJson(env, key, meta, TTL.repo);
  return meta;
}

type RecursiveTree = Record<string, TreeEntry[]>;

/** Single recursive fetch keyed by commit sha. The /git/trees response is
 *  immutable per sha so caching is content-addressed. Replaces N per-folder
 *  /contents API calls with one upstream hit. */
async function fetchRecursiveTree(
  env: Env,
  owner: string,
  repo: string,
  sha: string
): Promise<RecursiveTree> {
  const key = `github:tree:${owner}/${repo}@${sha}`;
  const cached = await kvGetJson<RecursiveTree>(env, key);
  if (cached) return cached;

  const url = `${GH_API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/vnd.github+json" },
  });
  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After") || res.headers.get("X-RateLimit-Reset");
    throw new HttpError(res.status, `${url} -> ${res.status}`, retryAfter);
  }
  const body = (await res.json()) as {
    truncated?: boolean;
    tree?: Array<{ type?: string; path?: string; sha?: string }>;
  };
  if (body.truncated) {
    // No realistic Aitelier fork hits this. Surfacing as 502 so the browser
    // gets a clear signal; if a real catalog ever grows this large we can
    // add per-folder fallback here.
    throw new HttpError(502, `tree truncated for ${owner}/${repo}@${sha}`);
  }
  const grouped: RecursiveTree = Object.create(null);
  for (const it of body.tree || []) {
    if (!it || it.type !== "blob" || typeof it.path !== "string" || typeof it.sha !== "string") continue;
    // Only top-level `<folder>/<slug>.md` entries become listable. Matches
    // the previous contents-API filter so folder-shaped entities served via
    // library.ts are unaffected.
    const m = /^([^/]+)\/([^/]+)\.md$/.exec(it.path);
    if (!m) continue;
    const folder = m[1];
    const name = `${m[2]}.md`;
    const download_url = `${GH_RAW}/${owner}/${repo}/${sha}/${it.path}`;
    (grouped[folder] || (grouped[folder] = [])).push({
      name,
      path: it.path,
      sha: it.sha,
      download_url,
    });
  }
  await kvPutJson(env, key, grouped, TTL.tree);
  return grouped;
}

export async function fetchTree(
  env: Env,
  owner: string,
  repo: string,
  sha: string,
  folder: string
): Promise<TreeEntry[]> {
  const grouped = await fetchRecursiveTree(env, owner, repo, sha);
  return grouped[folder] ? grouped[folder].slice() : [];
}

/** Bundle fetch: proxies `raw.githubusercontent.com/:o/:r/:sha/_bundle.br`
 *  and stores the compressed bytes in KV keyed by commit sha. The body is
 *  binary (brotli-compressed); KV stores it as an ArrayBuffer.
 *
 *  Returns null when the publisher hasn't shipped a bundle (404), so the
 *  caller can fall back to the tree path. Any other upstream error throws
 *  so the browser surfaces a real reason. */
export async function fetchBundle(
  env: Env,
  owner: string,
  repo: string,
  sha: string
): Promise<ArrayBuffer | null> {
  const key = `github:bundle:${owner}/${repo}@${sha}`;
  // KV stores binary as ArrayBuffer when we PUT a Uint8Array; reading
  // back as "arrayBuffer" gives us the same bytes for the response.
  let cached: ArrayBuffer | null = null;
  try { cached = await env.FORK_CACHE.get(key, "arrayBuffer"); } catch { cached = null; }
  if (cached) return cached;

  const url = `${GH_RAW}/${owner}/${repo}/${sha}/_bundle.br`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new HttpError(res.status, `bundle ${owner}/${repo}@${sha} -> ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  try { await env.FORK_CACHE.put(key, buf, { expirationTtl: TTL.blob }); } catch { /* best effort */ }
  return buf;
}

/** The blob route accepts the raw download_url from the tree entry as a
 *  query param. We validate it stays within raw.githubusercontent.com so
 *  the Worker can't be coerced into a generic SSRF proxy. */
export async function fetchBlob(
  env: Env,
  blobSha: string,
  downloadUrl: string | null
): Promise<string> {
  const key = `github:file:${blobSha}`;
  const cached = await kvGetText(env, key);
  if (cached !== null) return cached;

  if (!downloadUrl) {
    throw new HttpError(400, "blob fetch requires a download_url, hit the tree route first");
  }
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new HttpError(400, "invalid download_url");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "raw.githubusercontent.com") {
    throw new HttpError(400, "download_url must point at raw.githubusercontent.com");
  }

  const res = await fetch(parsed.toString(), { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new HttpError(res.status, `blob ${blobSha} -> ${res.status}`);
  }
  const text = await res.text();
  await kvPutText(env, key, text, TTL.blob);
  return text;
}
