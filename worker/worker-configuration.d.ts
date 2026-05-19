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
}
