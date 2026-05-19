#!/usr/bin/env bun
/*
 * setup-access.ts - provision Cloudflare Access in front of the Aitelier Worker.
 *
 * Draft, lives under .plans/deploy-modes/ until stage 3 lands. Promote to
 * repo-root `scripts/setup-access.ts` and wire `bun run setup:access`.
 *
 * Run:   bun run .plans/deploy-modes/setup-access.ts
 * Or:    bun run .plans/deploy-modes/setup-access.ts --delete   (teardown)
 *
 * Behaviour:
 *   - Reads inputs from env vars; prompts on stdin for any missing.
 *   - Idempotent: looks up existing Access app + policy by name; updates instead
 *     of duplicating.
 *   - Pushes ACCESS_AUD + ACCESS_TEAM_DOMAIN to the Worker via `wrangler secret put`.
 *
 * Required env (or interactive):
 *   CLOUDFLARE_API_TOKEN    Token with: Account: Access: Apps and Policies: Edit
 *                                       Account: Workers Scripts: Edit
 *                                       Account: Cloudflare Tunnel: Read (Zero Trust org lookup)
 *   CLOUDFLARE_ACCOUNT_ID   The same account that owns the Worker.
 *   WORKER_HOSTNAME         e.g. aitelier.example.workers.dev
 *   ACCESS_ALLOWED_EMAILS   Comma-separated. Single email is fine.
 *   ACCESS_SESSION_DURATION Default 24h.
 *   ACCESS_IDP              Default onetimepin. Alt: github, google, azureAD (must be
 *                           pre-configured in Zero Trust dash).
 *   APP_NAME                Default "Aitelier".
 *   POLICY_NAME             Default "Owner".
 *   WRANGLER_CWD            Default "worker".
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";

const CF = "https://api.cloudflare.com/client/v4";

type Json = Record<string, unknown>;

interface Config {
  apiToken: string;
  accountId: string;
  workerHost: string;
  emails: string[];
  sessionDuration: string;
  idp: string;
  appName: string;
  policyName: string;
  wranglerCwd: string;
  deletion: boolean;
}

async function main() {
  const cfg = await loadConfig();

  if (cfg.deletion) {
    await teardown(cfg);
    return;
  }

  const org = await getOrg(cfg);
  const idpUuid = await resolveIdp(cfg, cfg.idp);
  const app = await ensureApp(cfg, idpUuid);
  await ensurePolicy(cfg, app.id, app.aud);
  await pushWorkerSecret(cfg, "ACCESS_AUD", app.aud);
  await pushWorkerSecret(cfg, "ACCESS_TEAM_DOMAIN", org.auth_domain);

  const loginUrl = `https://${org.auth_domain}/cdn-cgi/access/login/${cfg.workerHost}`;
  console.log("");
  console.log("Aitelier is now private.");
  console.log(`  Worker URL:   https://${cfg.workerHost}`);
  console.log(`  Login URL:    ${loginUrl}`);
  console.log(`  App AUD:      ${app.aud}`);
  console.log(`  Team domain:  ${org.auth_domain}`);
  console.log("");
  console.log("Re-deploy the Worker so the new ACCESS_AUD secret is bound:");
  console.log(`  (cd ${cfg.wranglerCwd} && bunx wrangler deploy)`);
  console.log("");
  console.log("Teardown: bun run .plans/deploy-modes/setup-access.ts --delete");
}

async function loadConfig(): Promise<Config> {
  const deletion = process.argv.includes("--delete");
  const rl = createInterface({ input, output });
  const ask = async (label: string, fallback?: string): Promise<string> => {
    const def = fallback ? ` [${fallback}]` : "";
    const ans = (await rl.question(`${label}${def}: `)).trim();
    return ans || fallback || "";
  };

  const apiToken = process.env.CLOUDFLARE_API_TOKEN || (await ask("Cloudflare API token"));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (await ask("Cloudflare account id"));
  const workerHost = process.env.WORKER_HOSTNAME || (await ask("Worker hostname (no https://)"));
  const emailsRaw = process.env.ACCESS_ALLOWED_EMAILS || (await ask("Allowed emails (comma-separated)"));
  const sessionDuration = process.env.ACCESS_SESSION_DURATION || (await ask("Session duration", "24h"));
  const idp = process.env.ACCESS_IDP || (await ask("Identity provider", "onetimepin"));
  const appName = process.env.APP_NAME || (await ask("Application name", "Aitelier"));
  const policyName = process.env.POLICY_NAME || (await ask("Policy name", "Owner"));
  const wranglerCwd = process.env.WRANGLER_CWD || "worker";

  rl.close();

  if (!apiToken || !accountId || !workerHost || !emailsRaw) {
    fatal("Missing required input. Set the env vars or answer the prompts.");
  }

  return {
    apiToken,
    accountId,
    workerHost,
    emails: emailsRaw.split(",").map((s) => s.trim()).filter(Boolean),
    sessionDuration,
    idp,
    appName,
    policyName,
    wranglerCwd,
    deletion,
  };
}

async function cf<T = Json>(cfg: Config, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CF}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${cfg.apiToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text); } catch { /* keep null */ }
  if (!res.ok || (parsed && parsed.success === false)) {
    const errs = parsed && (parsed.errors as unknown);
    fatal(`Cloudflare API ${method} ${path} failed (${res.status})`, errs ?? text);
  }
  return (parsed?.result ?? parsed) as T;
}

interface Org {
  auth_domain: string;        // <team>.cloudflareaccess.com
  is_ui_read_only: boolean;
}
async function getOrg(cfg: Config): Promise<Org> {
  // Zero Trust org. If 404 here, user has not enabled Zero Trust yet.
  try {
    return await cf<Org>(cfg, "GET", `/accounts/${cfg.accountId}/access/organizations`);
  } catch {
    fatal(
      "Zero Trust is not enabled on this account.",
      "Open https://one.dash.cloudflare.com/ → Zero Trust onboarding → pick a team name. " +
      "It is free up to 50 seats. Re-run this script after."
    );
  }
}

interface Idp { id: string; name: string; type: string; }
async function resolveIdp(cfg: Config, wanted: string): Promise<string> {
  const list = await cf<Idp[]>(cfg, "GET", `/accounts/${cfg.accountId}/access/identity_providers`);
  // `onetimepin` is built-in but does NOT appear in identity_providers; it's a special string.
  // For named IdPs, match by `type` (lowercase) first, then by `name`.
  const target = wanted.toLowerCase();
  if (target === "onetimepin") return "onetimepin";
  const hit = list.find((x) => x.type.toLowerCase() === target) ||
    list.find((x) => x.name.toLowerCase() === target);
  if (!hit) {
    fatal(
      `Identity provider "${wanted}" not found in this Zero Trust org.`,
      "Configure it in https://one.dash.cloudflare.com/ → Settings → Authentication, " +
      "or pass ACCESS_IDP=onetimepin to use email OTP (zero setup)."
    );
  }
  return hit.id;
}

interface App { id: string; aud: string; name: string; domain: string; }
async function ensureApp(cfg: Config, idpUuid: string): Promise<App> {
  const apps = await cf<App[]>(cfg, "GET", `/accounts/${cfg.accountId}/access/apps`);
  const existing = apps.find((a) => a.name === cfg.appName);
  const allowedIdps = idpUuid === "onetimepin" ? [] : [idpUuid];

  const body = {
    name: cfg.appName,
    domain: cfg.workerHost,
    type: "self_hosted",
    session_duration: cfg.sessionDuration,
    auto_redirect_to_identity: idpUuid !== "onetimepin" && allowedIdps.length === 1,
    allowed_idps: allowedIdps,
    app_launcher_visible: false,
  };

  if (existing) {
    return await cf<App>(cfg, "PUT", `/accounts/${cfg.accountId}/access/apps/${existing.id}`, body);
  }
  return await cf<App>(cfg, "POST", `/accounts/${cfg.accountId}/access/apps`, body);
}

interface Policy { id: string; name: string; decision: string; }
async function ensurePolicy(cfg: Config, appId: string, _aud: string): Promise<Policy> {
  const policies = await cf<Policy[]>(cfg, "GET", `/accounts/${cfg.accountId}/access/apps/${appId}/policies`);
  const existing = policies.find((p) => p.name === cfg.policyName);

  const body = {
    name: cfg.policyName,
    decision: "allow",
    include: cfg.emails.map((email) => ({ email: { email } })),
  };

  if (existing) {
    return await cf<Policy>(cfg, "PUT", `/accounts/${cfg.accountId}/access/apps/${appId}/policies/${existing.id}`, body);
  }
  return await cf<Policy>(cfg, "POST", `/accounts/${cfg.accountId}/access/apps/${appId}/policies`, body);
}

function pushWorkerSecret(cfg: Config, name: string, value: string): void {
  // `wrangler secret put` reads value from stdin when --stdin is passed.
  const proc = spawnSync("bunx", ["wrangler", "secret", "put", name], {
    cwd: cfg.wranglerCwd,
    input: value,
    encoding: "utf-8",
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, CLOUDFLARE_API_TOKEN: cfg.apiToken, CLOUDFLARE_ACCOUNT_ID: cfg.accountId },
  });
  if (proc.status !== 0) {
    fatal(`wrangler secret put ${name} failed`, `exit ${proc.status}`);
  }
}

async function teardown(cfg: Config): Promise<void> {
  const apps = await cf<App[]>(cfg, "GET", `/accounts/${cfg.accountId}/access/apps`);
  const existing = apps.find((a) => a.name === cfg.appName);
  if (existing) {
    await cf(cfg, "DELETE", `/accounts/${cfg.accountId}/access/apps/${existing.id}`);
    console.log(`Deleted Access app "${cfg.appName}".`);
  } else {
    console.log(`No Access app named "${cfg.appName}", nothing to delete.`);
  }
  // Clear Worker secrets so the Worker reverts to public mode after redeploy.
  deleteWorkerSecret(cfg, "ACCESS_AUD");
  deleteWorkerSecret(cfg, "ACCESS_TEAM_DOMAIN");
  console.log("");
  console.log("Re-deploy the Worker to drop the secrets:");
  console.log(`  (cd ${cfg.wranglerCwd} && bunx wrangler deploy)`);
}

function deleteWorkerSecret(cfg: Config, name: string): void {
  const proc = spawnSync("bunx", ["wrangler", "secret", "delete", name, "--force"], {
    cwd: cfg.wranglerCwd,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: cfg.apiToken, CLOUDFLARE_ACCOUNT_ID: cfg.accountId },
  });
  if (proc.status !== 0) {
    // Don't fatal; secret may already be gone.
    console.warn(`wrangler secret delete ${name} returned ${proc.status} (continuing).`);
  }
}

function fatal(...lines: unknown[]): never {
  for (const line of lines) {
    console.error(typeof line === "string" ? line : JSON.stringify(line, null, 2));
  }
  process.exit(1);
}

await main();
