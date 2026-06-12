/* Tiny KV facade. Centralises TTL constants and swallows transient KV
 * errors so a cache miss never fails the request: the upstream call
 * still runs, the response still returns, only the next call won't be
 * served from cache. */

export const TTL = {
  /** Repo meta (default_branch + tip sha + sha_date). */
  repo: 86400,        // 24h
  /** Directory listing pinned to a commit sha; immutable so a long TTL is safe. */
  tree: 7 * 86400,    // 7d
  /** Blob content keyed by blob sha; content-addressed so very long TTL is safe. */
  blob: 30 * 86400,   // 30d
} as const;

export async function kvGetJson<T>(env: Env, key: string): Promise<T | null> {
  try {
    return await env.FORK_CACHE.get<T>(key, "json");
  } catch {
    return null;
  }
}

export async function kvPutJson(env: Env, key: string, value: unknown, expirationTtl: number): Promise<void> {
  try {
    await env.FORK_CACHE.put(key, JSON.stringify(value), { expirationTtl });
  } catch {
    /* swallow: cache writes are best-effort */
  }
}

export async function kvGetText(env: Env, key: string): Promise<string | null> {
  try {
    return await env.FORK_CACHE.get(key, "text");
  } catch {
    return null;
  }
}

export async function kvPutText(env: Env, key: string, value: string, expirationTtl: number): Promise<void> {
  try {
    await env.FORK_CACHE.put(key, value, { expirationTtl });
  } catch {
    /* swallow */
  }
}
