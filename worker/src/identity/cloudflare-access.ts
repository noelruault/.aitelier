/*
 * identity/cloudflare-access.ts - validate a Cloudflare Access JWT.
 *
 * Reads the `Cf-Access-Jwt-Assertion` header that Access injects at the edge,
 * verifies its RS256 signature against the team JWKS, and checks aud / exp /
 * nbf / iat / iss. Returns the email identity on success, `null` when no token
 * was presented (anonymous), and THROWS on any present-but-invalid token so
 * the caller returns 401.
 *
 * Fail-closed everywhere (.plans/0008_user-management.md §11.6):
 *   - `ACCESS_AUD` empty/unset  -> reject all tokens (no wildcard aud).
 *   - JWKS fetch needed but fails -> throw (never serve a write off stale keys).
 * Cloudflare's JWKS endpoint is on Cloudflare's own edge, so a fetch failure
 * already implies a serious Cloudflare-side outage; refusing writes is correct.
 */

import { Identity, IdentityProvider, IdentityEnv, identityFromEmail } from "./provider";

interface Jwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string; }

const JWKS_TTL_MS = 10 * 60 * 1000; // §11.6: 10 minutes
const CLOCK_SKEW_S = 60;            // tolerate 60s of clock skew on exp/nbf/iat

export class CloudflareAccessProvider implements IdentityProvider {
  kind = "cloudflare-access";

  // Per-isolate JWKS cache. `inflight` coalesces concurrent refreshes so warm
  // isolates don't thunder-herd the JWKS endpoint at the TTL boundary.
  private keys: Map<string, CryptoKey> | null = null;
  private fetchedAt = 0;
  private inflight: Promise<Map<string, CryptoKey>> | null = null;

  async resolve(request: Request, env: IdentityEnv): Promise<Identity | null> {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null; // anonymous - no credential presented

    const aud = (env.ACCESS_AUD || "").trim();
    if (!aud) throw new Error("ACCESS_AUD unset; refusing all Access JWTs (fail-closed)");
    const team = (env.ACCESS_TEAM_DOMAIN || "").trim();
    if (!team) throw new Error("ACCESS_TEAM_DOMAIN unset; cannot locate JWKS");
    const certsUrl = `https://${team}/cdn-cgi/access/certs`;

    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed JWT");
    const header = parseJson(b64urlToString(parts[0]), "JWT header");
    const payload = parseJson(b64urlToString(parts[1]), "JWT payload");
    if (header.alg !== "RS256") throw new Error(`unexpected JWT alg ${String(header.alg)}`);
    const kid = String(header.kid || "");
    if (!kid) throw new Error("JWT missing kid");

    // Resolve the signing key; on a kid miss, force one refresh (keys rotate).
    let key = (await this.getKeys(certsUrl)).get(kid);
    if (!key) key = (await this.refresh(certsUrl)).get(kid);
    if (!key) throw new Error(`no JWKS key for kid ${kid}`);

    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
    if (!ok) throw new Error("JWT signature invalid");

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && now > payload.exp + CLOCK_SKEW_S) throw new Error("JWT expired");
    if (typeof payload.nbf === "number" && now + CLOCK_SKEW_S < payload.nbf) throw new Error("JWT not yet valid (nbf)");
    if (typeof payload.iat === "number" && payload.iat > now + CLOCK_SKEW_S) throw new Error("JWT issued in the future (iat)");

    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
    if (!audOk) throw new Error("JWT aud mismatch");
    const expectedIss = `https://${team}`;
    if (payload.iss && payload.iss !== expectedIss) throw new Error("JWT iss mismatch");

    const email = String(payload.email || "").trim();
    if (email) return identityFromEmail(email);
    // No email claim: fall back to the opaque subject so the writer is still
    // stably identified (label degrades to the sub, per §1).
    const sub = String(payload.sub || "").trim();
    if (!sub) throw new Error("JWT carries neither email nor sub");
    return { id: sub, label: sub };
  }

  /** Return cached keys when fresh; otherwise refresh (coalesced). Fail-closed:
   * a needed-but-failed fetch throws rather than serving stale keys. */
  private async getKeys(url: string): Promise<Map<string, CryptoKey>> {
    if (this.keys && Date.now() - this.fetchedAt < JWKS_TTL_MS) return this.keys;
    return this.refresh(url);
  }

  private refresh(url: string): Promise<Map<string, CryptoKey>> {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchKeys(url)
      .then((m) => { this.keys = m; this.fetchedAt = Date.now(); return m; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchKeys(url: string): Promise<Map<string, CryptoKey>> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = await res.json() as { keys?: Jwk[] };
    const map = new Map<string, CryptoKey>();
    for (const jwk of body.keys || []) {
      if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      map.set(jwk.kid, key);
    }
    if (!map.size) throw new Error("JWKS contained no usable RSA keys");
    return map;
  }
}

function parseJson(s: string, what: string): any {
  try { return JSON.parse(s); } catch { throw new Error(`malformed ${what}`); }
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}
