/*
 * identity/none.ts - the no-auth adapter.
 *
 * Used by every deploy that hasn't opted into an identity provider: GitHub
 * Pages (no Worker reaches this anyway) and public Workers that want the
 * dashboard live without an Access gate. Writes are accepted; the sidecar
 * records `{ id: null, label: null, provider: "none" }` (handled by the
 * stamping code in library.ts when resolve() returns null).
 *
 * The ONE exception is local `wrangler dev`: when `DEV_IDENTITY` is present in
 * worker/.dev.vars, synthesise a real identity from it so the local UI renders
 * authorship while iterating. `DEV_IDENTITY` is never set in production (it
 * lives only in the git-ignored .dev.vars), so production stays anonymous.
 * See .plans/0008_user-management.md §2.1 / §11.7.
 */

import { Identity, IdentityProvider, IdentityEnv, identityFromEmail } from "./provider";

export class NoneProvider implements IdentityProvider {
  kind = "none";

  async resolve(_request: Request, env: IdentityEnv): Promise<Identity | null> {
    const dev = (env.DEV_IDENTITY || "").trim();
    if (dev) return identityFromEmail(dev);
    return null;
  }
}
