# Aitelier

[![Supply-chain Audit](https://github.com/noelruault/.aitelier/actions/workflows/audit.yml/badge.svg)](https://github.com/noelruault/.aitelier/actions/workflows/audit.yml)

A browsable library for the prompts, skills, hooks, and agents you reuse with your AI assistant. Click a card, copy the block, paste it into ChatGPT, Claude, Gemini, a local model — whatever you use. Add a new entry by dropping a markdown file in one of four folders. No build step, no framework, no JS bundle.

> See **[README.long.md](./README.long.md)** for the full reference (parser internals, External-fork transport, `_bundle.br` performance notes, benchmarks).

## Tour

![Scripted tour of Aitelier](demo/tour.webp)

## One-click deploy

Pick a hosting target. Both give you the same SPA at a public URL; the Worker adds in-browser editing and a faster fork-browsing proxy.

| GitHub Pages (free, read-only) | Cloudflare Worker (free tier, editable) |
| --- | --- |
| 1. Click **Fork** on this repo (top-right of the GitHub page). | 1. Click the button below. Cloudflare clones the repo into your account and provisions the Worker, KV cache, and R2 storage for you. |
| 2. In your fork, open **Settings → Pages**. | 2. Connect your GitHub when prompted, accept the defaults. |
| 3. Set **Source** to *GitHub Actions*. | 3. Wait a few seconds; your URL appears under *workers.dev*. |
| 4. Push any change to `main` (or hit **Run workflow** under the *Pages* tab in **Actions**). The workflow builds the site and publishes to `https://<you>.github.io/<repo>/`. | <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/noelruault/aitelier"><img alt="Deploy to Cloudflare Workers" src="https://deploy.workers.cloudflare.com/button" /></a> |

Both paths end with a live URL you can share. Pages = pure static, edits via `git push`. Worker = static + a tiny backend so the **New** / **Edit** buttons in the UI actually save.

## Additional deploy instructions

> **Keep your fork public.** The point of this project is that other people can browse your library through the **External** pill on their own AItelier. Private forks work, but they hide from the network. Your call.

<details>
<summary><strong>GitHub Pages — the slower path, in detail</strong></summary>

Pages is the simplest hosting GitHub offers: a static folder served at a URL. The fork comes with a workflow file at `.github/workflows/pages.yml` that does the right build for you. You don't have to edit it.

What happens on each push to `main`:

1. The workflow installs [Bun](https://bun.com) and runs `bun run css` (Tailwind build) and `bun run scripts/build-manifest.ts` (file index for the SPA).
2. It runs `bun test` so a broken push doesn't ship.
3. It uploads the built site as a *Pages artifact*.
4. GitHub publishes the artifact to your `https://<you>.github.io/<repo>/` URL.

Adding or editing an entry = edit the markdown file, commit, push. The workflow redeploys in ~30 s. Reload the site, the change shows up.

You will not have **New** / **Edit** buttons on this path — Pages can't write back to your repo. That is the trade for "zero backend, zero cost".

</details>

<details>
<summary><strong>Cloudflare Worker — the editable path, in detail</strong></summary>

A Worker is a tiny serverless function that runs at Cloudflare's edge. Same SPA, but with two extras the Pages build can't do:

- **Edits save to R2.** The **New** / **Edit** / **Fork** buttons in the UI write directly to your library; no `git push` round-trip.
- **External fork browsing is fast and won't rate-limit.** When you (or a visitor) types another user's slug into the *External* pill, the Worker proxies the request and caches the result in KV. Without it, the browser hits GitHub directly and burns through the 60 req/hr unauthenticated quota.

#### Option A — one-click

Click the button in the table above. Cloudflare does all of this on your behalf: create the Worker, the `FORK_CACHE` KV namespace, and the `LIBRARY` R2 bucket. You sign in to Cloudflare, give it GitHub permission, and end up with a Worker URL like `https://aitelier.<you>.workers.dev`.

#### Option B — push-triggered redeploys via GitHub Actions

If you want every push to `main` to redeploy the Worker (like Pages does for the static path), do this once per fork:

1. In your fork's **Settings → Secrets and variables → Actions**, add:
   - Secret: `CLOUDFLARE_API_TOKEN` (create at *dash.cloudflare.com → My Profile → API Tokens → Create*; use the "Edit Cloudflare Workers" template).
   - Secret: `CLOUDFLARE_ACCOUNT_ID` (find it in any Cloudflare dashboard URL, the long hex string).
   - Variable: `DEPLOY_MODE` = `worker`.
2. Push to `main`. `.github/workflows/deploy.yml` runs `wrangler deploy`.

If you forget step 1 and `DEPLOY_MODE` stays unset, the Pages workflow runs instead. Nothing breaks; you just don't get auto-redeploy of the Worker.

#### Optional — gate the site behind an email allowlist

If you want the Worker private to you (or a small team), put **Cloudflare Access** in front of it. Access is free for up to 50 users and asks visitors to authenticate via email magic-link before the SPA loads. No code change needed.

```bash
bun install
bun run setup:access     # prompts for CF token, account id, allowed email
```

To open the site back up to the public: `bun run teardown:access`.

</details>

## Conventions on the markdown

Every entry under `prompts/`, `skills/`, `agents/`, or `hooks/` is one of two shapes:

**A single `.md` file** — for simple prompts, skills, or agents:

```md
---
name: rubber-duck
description: Explain code line by line as if to a sceptical duck.
tags: [debugging, explainer]
---

You are a sceptical rubber duck. The user will paste code…
```

**A folder** — when you want to ship supporting scripts or extra files alongside the markdown:

```
skills/format-diff/
├── SKILL.md             # frontmatter + body (use AGENT.md for agents)
└── scripts/
    └── helper.sh        # surfaces in the deep-dive as Show / Copy
```

Allowed attachment file types: `.md, .sh, .py, .js, .ts, .json, .yaml, .yml, .txt, .toml`.

### Hooks are always folders

Hooks plug into AI-assistant lifecycle events (PreToolUse, PostToolUse, etc.). The shape:

```
hooks/prevent-rm-rf/
├── hook.json            # the snippet that gets pasted into settings.json
├── README.md            # why this exists, how to tune it (optional)
└── scripts/             # any executables the hook calls (optional)
    └── ...
```

`hook.json` is the canonical handler snippet, copied straight to the user's clipboard from the deep-dive's **Copy snippet** button. If you ship a `scripts/` folder, the deep-dive also renders a one-liner `curl` install command for everything inside.

### One optional sidecar per entry

If you want the entry to land in a coloured category cluster on the **Galaxy** view, drop a JSON sidecar next to the markdown:

- `prompts/rubber-duck.aitelier.json`
- `skills/format-diff/aitelier.json`
- `agents/go-performance.aitelier.json`
- `hooks/prevent-rm-rf/aitelier.json`

```json
{
  "category": "debugging",
  "tags": ["walkthrough", "assumptions"],
  "related": ["tdd-approach", "code-review-checklist"]
}
```

Category drives the swatch colour and the cluster on Galaxy. `related` builds the edges between entries.

**Why a separate file?** The frontmatter of each `.md` is the *official* shape your AI tool expects (Claude Code's `name`/`description`/`tools`/`model`, etc.). AItelier-only metadata (`category`, `tags`, `related`) lives in this sidecar so it never collides with the spec frontmatter and never breaks when the tool you're targeting tightens its schema. Delete every `.aitelier.json` in the repo and the markdown files still load cleanly into Claude, ChatGPT, etc.

That is the whole format. Copy any existing entry as a starting point.

## License

MIT.
