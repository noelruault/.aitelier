/*
 * identity/provider.ts - the single trust boundary for write attribution.
 *
 * Identity is NOT hard-coded to Cloudflare. We define one interface, ship
 * adapters behind it, and let `IDENTITY_PROVIDER` pick which one is active.
 * Every write handler in worker/src/library.ts consumes the abstract
 * `IdentityProvider`, never a vendor's headers, so a future SAML / OIDC /
 * OAuth adapter is one new file plus one entry in the registry below - no
 * write-handler changes. See .plans/0008_user-management.md §1-§2.
 */

export interface Identity {
  /** Stable identifier. Email by default; opaque `sub` when no email exists. */
  id: string;
  /** Display label used by the SPA. Local-part of email by default. */
  label: string;
  /** Raw email if the provider exposes one. May equal `id`. */
  email?: string;
}

/* Env subset the adapters read. Kept narrow so adapters don't depend on the
 * whole Worker Env. Mirrors the new keys in worker-configuration.d.ts. */
export interface IdentityEnv {
  IDENTITY_PROVIDER?: string;
  AUTH_REQUIRED?: string;
  ACCESS_AUD?: string;          // CF Access application AUD (Worker secret)
  ACCESS_TEAM_DOMAIN?: string;  // "<team>.cloudflareaccess.com" (Worker secret)
  DEV_IDENTITY?: string;        // wrangler-dev-only; never set in production
}

export interface IdentityProvider {
  /** Slug surfaced by the capability probe ("cloudflare-access" | "none" | ...). */
  kind: string;
  /**
   * Resolve identity for an incoming request.
   *   - returns `null` when no credential was presented (anonymous), and
   *   - THROWS when a credential is present but invalid (forged/expired JWT,
   *     bad signature, aud mismatch, ...) so the caller can return 401.
   * The ping handler must swallow the throw (a lapsed Access session must not
   * dark the capability probe); the write handler must honour it. See §8.
   */
  resolve(request: Request, env: IdentityEnv): Promise<Identity | null>;
}

/** Local-part of an email (everything before "@", dots kept). Non-emails pass
 * through unchanged so an opaque `sub` still produces a usable label. */
export function localPart(idOrEmail: string): string {
  const at = idOrEmail.indexOf("@");
  return at > 0 ? idOrEmail.slice(0, at) : idOrEmail;
}

/** Build an `Identity` from an email string. */
export function identityFromEmail(email: string): Identity {
  return { id: email, label: localPart(email), email };
}

/*
 * Registry. Lazily instantiated so adapter module state (the cloudflare-access
 * JWKS cache) is per-isolate and shared across requests. Adding an adapter =
 * one import + one entry here + one new file. Keep this the ONLY dispatch site.
 */
import { NoneProvider } from "./none";
import { CloudflareAccessProvider } from "./cloudflare-access";

let registry: Record<string, IdentityProvider> | null = null;

function buildRegistry(): Record<string, IdentityProvider> {
  return {
    "none": new NoneProvider(),
    "cloudflare-access": new CloudflareAccessProvider(),
  };
}

/**
 * Pick the active provider.
 *   - slug ABSENT (undefined / "") -> "none" (safe degrade; a deploy that never
 *     opted in is anonymous-write, not crashed). Matches §0 opt-out default.
 *   - slug PRESENT but unrecognised -> THROW at boot. A typo on a private
 *     deploy must fail loud, never silently fall through to an open "none".
 */
export function identityProviderFor(slug: string | undefined): IdentityProvider {
  if (!registry) registry = buildRegistry();
  const key = (slug ?? "").trim() || "none";
  const provider = registry[key];
  if (!provider) {
    throw new Error(
      `Unknown IDENTITY_PROVIDER: ${JSON.stringify(slug)} (known: ${Object.keys(registry).join(", ")})`
    );
  }
  return provider;
}
