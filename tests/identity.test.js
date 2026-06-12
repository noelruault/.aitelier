import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { CloudflareAccessProvider } from "../worker/src/identity/cloudflare-access.ts";
import { NoneProvider } from "../worker/src/identity/none.ts";
import { identityProviderFor, localPart, identityFromEmail } from "../worker/src/identity/provider.ts";

/* Identity adapters. The cloudflare-access tests mint real RS256 JWTs with an
 * in-test keypair and serve a stub JWKS by monkeypatching global fetch, so the
 * full verify path (signature + aud/exp/nbf/iat/iss) runs without a network.
 * Mirrors .plans/user-management.md §13.2 test list:
 *   valid token, missing header, empty-aud reject, aud mismatch, expired,
 *   bad signature, forced JWKS-fetch failure -> throw (caller 401). */

const TEAM = "team.cloudflareaccess.com";
const AUD = "test-aud";
const KID = "test-kid";
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;

let privateKey;          // signs valid tokens (matches the JWKS)
let wrongPrivateKey;     // signs forged tokens (NOT in the JWKS)
let JWKS;

function b64url(input) {
  let bin;
  if (typeof input === "string") bin = input;
  else { bin = ""; for (const b of new Uint8Array(input)) bin += String.fromCharCode(b); }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function genKeypair() {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
}

async function makeJwt(payload, key = privateKey, kid = KID) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

function goodPayload(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { aud: AUD, email: "alice.smith@example.com", iss: `https://${TEAM}`, iat: now - 30, nbf: now - 30, exp: now + 3600, sub: "abc123", ...over };
}

function reqWith(token) {
  const h = new Headers();
  if (token) h.set("Cf-Access-Jwt-Assertion", token);
  return new Request("https://worker/api/library/file/prompts/x.md", { method: "PUT", headers: h });
}

function stubJwks(impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = orig; };
}

const env = { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM };

beforeAll(async () => {
  const a = await genKeypair();
  const b = await genKeypair();
  privateKey = a.privateKey;
  wrongPrivateKey = b.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", a.publicKey);
  JWKS = { keys: [{ kty: "RSA", n: jwk.n, e: jwk.e, kid: KID, alg: "RS256" }] };
});

let restore = null;
afterEach(() => { if (restore) { restore(); restore = null; } });

function serveJwks() {
  restore = stubJwks(async (url) => {
    if (String(url).includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify(JWKS), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("localPart / identityFromEmail", () => {
  test("local-part keeps dots, drops domain", () => {
    expect(localPart("alice.smith@bigcorp.example.com")).toBe("alice.smith");
    expect(localPart("opaque-sub-no-at")).toBe("opaque-sub-no-at");
  });
  test("identityFromEmail shape", () => {
    expect(identityFromEmail("bob@x.com")).toEqual({ id: "bob@x.com", label: "bob", email: "bob@x.com" });
  });
});

describe("identityProviderFor dispatch", () => {
  test("known slugs resolve to instances", () => {
    expect(identityProviderFor("none").kind).toBe("none");
    expect(identityProviderFor("cloudflare-access").kind).toBe("cloudflare-access");
  });
  test("absent slug defaults to none (safe degrade)", () => {
    expect(identityProviderFor(undefined).kind).toBe("none");
    expect(identityProviderFor("").kind).toBe("none");
    expect(identityProviderFor("   ").kind).toBe("none");
  });
  test("unrecognised slug throws (fail loud, never silent-open)", () => {
    expect(() => identityProviderFor("saml-header")).toThrow(/Unknown IDENTITY_PROVIDER/);
  });
});

describe("NoneProvider", () => {
  test("returns null without DEV_IDENTITY (anonymous)", async () => {
    expect(await new NoneProvider().resolve(reqWith(null), {})).toBeNull();
  });
  test("synthesises identity from DEV_IDENTITY (wrangler dev)", async () => {
    const id = await new NoneProvider().resolve(reqWith(null), { DEV_IDENTITY: "dev@local" });
    expect(id).toEqual({ id: "dev@local", label: "dev", email: "dev@local" });
  });
});

describe("CloudflareAccessProvider", () => {
  test("valid token -> identity", async () => {
    serveJwks();
    const p = new CloudflareAccessProvider();
    const id = await p.resolve(reqWith(await makeJwt(goodPayload())), env);
    expect(id).toEqual({ id: "alice.smith@example.com", label: "alice.smith", email: "alice.smith@example.com" });
  });

  test("missing header -> null (anonymous, no throw)", async () => {
    serveJwks();
    expect(await new CloudflareAccessProvider().resolve(reqWith(null), env)).toBeNull();
  });

  test("empty ACCESS_AUD -> throws (fail-closed, no wildcard)", async () => {
    serveJwks();
    const p = new CloudflareAccessProvider();
    await expect(p.resolve(reqWith(await makeJwt(goodPayload())), { ...env, ACCESS_AUD: "" })).rejects.toThrow(/ACCESS_AUD/);
  });

  test("aud mismatch -> throws", async () => {
    serveJwks();
    const p = new CloudflareAccessProvider();
    await expect(p.resolve(reqWith(await makeJwt(goodPayload({ aud: "other-aud" }))), env)).rejects.toThrow(/aud/);
  });

  test("expired token -> throws", async () => {
    serveJwks();
    const p = new CloudflareAccessProvider();
    const now = Math.floor(Date.now() / 1000);
    await expect(p.resolve(reqWith(await makeJwt(goodPayload({ exp: now - 1000 }))), env)).rejects.toThrow(/expired/);
  });

  test("future iat -> throws", async () => {
    serveJwks();
    const p = new CloudflareAccessProvider();
    const now = Math.floor(Date.now() / 1000);
    await expect(p.resolve(reqWith(await makeJwt(goodPayload({ iat: now + 9999 }))), env)).rejects.toThrow(/future/);
  });

  test("forged signature (kid in JWKS, wrong key) -> throws", async () => {
    serveJwks();
    const p = new CloudflareAccessProvider();
    const forged = await makeJwt(goodPayload(), wrongPrivateKey, KID);
    await expect(p.resolve(reqWith(forged), env)).rejects.toThrow(/signature/);
  });

  test("JWKS fetch failure -> throws (caller returns 401, never serves write)", async () => {
    restore = stubJwks(async () => new Response("nope", { status: 500 }));
    const p = new CloudflareAccessProvider();
    await expect(p.resolve(reqWith(await makeJwt(goodPayload())), env)).rejects.toThrow(/JWKS fetch failed/);
  });

  test("email-less token falls back to sub as id+label", async () => {
    serveJwks();
    const p = new CloudflareAccessProvider();
    const id = await p.resolve(reqWith(await makeJwt(goodPayload({ email: "" }))), env);
    expect(id).toEqual({ id: "abc123", label: "abc123" });
  });
});
