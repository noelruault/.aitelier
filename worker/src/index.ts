/* Atelier Worker, entry point.
 *
 * Two responsibilities:
 *   1. Serve the static SPA from the [assets] binding (../ in wrangler.toml).
 *   2. Expose /api/external/* routes that the browser's
 *      `transport-worker.js` calls to read public GitHub forks via a
 *      KV-backed proxy.
 *
 * Unknown routes pass through to ASSETS so the same hostname serves
 * `/`, `/src/...`, `/prompts/...`, and `/api/...` from one origin. */

import { fetchBlob, fetchBundle, fetchRepoMeta, fetchTree, HttpError } from "./transport-github";
import { handleLibrary, layeredAssetFetch } from "./library";

const SEG_RE = /^[A-Za-z0-9_.-]{1,39}$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,255}$/;
const SHA_RE = /^[a-fA-F0-9]{6,64}$/;
const FOLDER_RE = /^[A-Za-z0-9_-]{1,64}$/;

const META_RE = /^\/api\/external\/([^/]+)\/([^/]+)\/meta\/?$/;
const TREE_RE = /^\/api\/external\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/([^/]+)\/?$/;
const BLOB_RE = /^\/api\/external\/blob\/([^/]+)\/?$/;
const BUNDLE_RE = /^\/api\/external\/([^/]+)\/([^/]+)\/bundle\/([^/]+)\/?$/;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname.startsWith("/api/library/")) {
      try {
        return await handleLibrary(request, env, _ctx);
      } catch (err) {
        return errorResponse(request, err);
      }
    }

    try {
      // /api/external/ping, browser uses this to detect a Worker in front.
      if (url.pathname === "/api/external/ping") {
        return jsonResponse(request, { ok: true, kvBound: !!env.FORK_CACHE, at: new Date().toISOString() });
      }

      // /api/external/:owner/:repo/meta
      const meta = url.pathname.match(META_RE);
      if (meta) {
        const [, owner, repo] = meta;
        validateSeg(owner, "owner");
        validateSeg(repo,  "repo");
        const branch = url.searchParams.get("branch");
        if (branch !== null && branch !== "" && !BRANCH_RE.test(branch)) {
          throw new HttpError(400, "invalid branch");
        }
        const body = await fetchRepoMeta(env, owner, repo, branch || null);
        return jsonResponse(request, body);
      }

      // /api/external/:owner/:repo/tree/:sha/:folder
      const tree = url.pathname.match(TREE_RE);
      if (tree) {
        const [, owner, repo, sha, folder] = tree;
        validateSeg(owner, "owner");
        validateSeg(repo,  "repo");
        if (!SHA_RE.test(sha))      throw new HttpError(400, "invalid sha");
        if (!FOLDER_RE.test(folder)) throw new HttpError(400, "invalid folder");
        const files = await fetchTree(env, owner, repo, sha, folder);
        return jsonResponse(request, { files });
      }

      // /api/external/:owner/:repo/bundle/:sha - optional fast-path artifact
      const bundle = url.pathname.match(BUNDLE_RE);
      if (bundle) {
        const [, owner, repo, sha] = bundle;
        validateSeg(owner, "owner");
        validateSeg(repo,  "repo");
        if (!SHA_RE.test(sha)) throw new HttpError(400, "invalid sha");
        const body = await fetchBundle(env, owner, repo, sha);
        if (!body) {
          return jsonResponse(request, { ok: false, error: "no bundle published" }, 404);
        }
        return new Response(body, {
          headers: {
            ...corsHeaders(request),
            "Content-Type": "application/octet-stream",
          },
        });
      }

      // /api/external/blob/:sha?url=<download_url>
      const blob = url.pathname.match(BLOB_RE);
      if (blob) {
        const [, sha] = blob;
        if (!SHA_RE.test(sha)) throw new HttpError(400, "invalid sha");
        const downloadUrl = url.searchParams.get("url");
        const body = await fetchBlob(env, sha, downloadUrl);
        return new Response(body, {
          headers: {
            ...corsHeaders(request),
            "Content-Type": "text/markdown; charset=utf-8",
          },
        });
      }

      // Reserve the prefix for the Worker even when the route isn't
      // implemented, so a probe doesn't accidentally hit ASSETS and
      // get the SPA's index.html back with a 200.
      if (url.pathname.startsWith("/api/external/")) {
        return jsonResponse(request, { ok: false, error: "unknown route" }, 404);
      }

      // Library folders go through layered R2-then-asset fetch in Path B.
      if (url.pathname.startsWith("/prompts/") ||
          url.pathname.startsWith("/skills/") ||
          url.pathname.startsWith("/agents/") ||
          url.pathname.startsWith("/hooks/")) {
        return await layeredAssetFetch(request, env, _ctx);
      }

      // Static SPA + remaining assets served from the repo root.
      return env.ASSETS.fetch(request);
    } catch (err) {
      return errorResponse(request, err);
    }
  },
};

function validateSeg(value: string, label: string): void {
  if (!SEG_RE.test(value)) throw new HttpError(400, `invalid ${label}`);
}

function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

function errorResponse(request: Request, err: unknown): Response {
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {
      ...corsHeaders(request),
      "Content-Type": "application/json",
    };
    if (err.retryAfter) headers["Retry-After"] = err.retryAfter;
    return new Response(
      JSON.stringify({ ok: false, error: err.message, status: err.statusCode }),
      { status: err.statusCode, headers }
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 500,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

/* Same-origin only by default (plan open-question 7 default). Echo the
 * request origin only when it matches the Worker's own origin. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const here   = new URL(request.url).origin;
  const h: Record<string, string> = {};
  if (origin && origin === here) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Vary"] = "Origin";
  }
  return h;
}
