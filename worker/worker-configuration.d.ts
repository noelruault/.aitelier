// Generated shape, kept in source for now. Run `wrangler types` after
// adding bindings to regenerate.

// eslint-disable-next-line @typescript-eslint/no-empty-interface,@typescript-eslint/no-empty-object-type
interface Env {
  // Static-assets binding pointing at the repo root (configured in
  // wrangler.toml). Any route that doesn't match /api/* falls through
  // to env.ASSETS.fetch(request) so the same Worker URL serves both
  // the SPA and the API.
  ASSETS: Fetcher;

  // Shared cache for GitHub responses. Three key namespaces: repo meta,
  // sha-pinned tree listings, and content-addressed blobs.
  FORK_CACHE: KVNamespace;

  // R2 bucket that holds the user's library (prompts/skills/agents) in
  // Path B (Worker mode). Seeded lazily on first request from the bundled
  // _manifest.json; thereafter R2 is the canonical source of truth.
  LIBRARY: R2Bucket;

  // Capability flag surfaced to the SPA via /api/library/ping. "true" exposes
  // edit/duplicate/delete UI on this deployment. Default "false".
  EDITS_ENABLED?: string;

  // Identity / write-attribution config (.plans/0008_user-management.md §8).
  // [vars] - non-secret:
  IDENTITY_PROVIDER?: string;   // "cloudflare-access" | "none" (absent -> "none")
  AUTH_REQUIRED?: string;       // "true" -> write returns 401 when unauthenticated
  // secrets (wrangler secret put), provisioned by scripts/setup-access.ts:
  ACCESS_AUD?: string;          // CF Access application AUD
  ACCESS_TEAM_DOMAIN?: string;  // "<team>.cloudflareaccess.com"
  // wrangler-dev only (worker/.dev.vars), never set in production:
  DEV_IDENTITY?: string;        // email the `none` adapter synthesises locally
}
