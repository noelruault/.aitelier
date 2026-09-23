# Aitelier

> ⚠️ Pre-release. Force-pushes to `main` and structural changes may land without notice. Pin a commit if you fork.

Browsable library of prompts, skills, hooks, and agents. Open the site, click a card, copy any block, paste into your AI/LLM of choice. To add an entry, drop a markdown file into one of the four folders. It's a drag-and-drop project.

An **External** pill on the dashboard also lets you browse anyone else's published library on the fly, no clone or fork required. See [Notes on the External transport](#notes-on-the-external-transport) at the end for the input formats and caching behaviour.

## Tour

![Scripted tour of Aitelier](demo/tour.webp)

Regenerate with `bun run demo:tour` followed by the WebP conversion command the script prints on exit.

## Deploy

Two paths. Pick one per fork.

### GitHub Pages

Free, public, zero config.

1. Fork the repo.
2. Repo Settings → Pages → Source: GitHub Actions.
3. Push to `main`. `.github/workflows/pages.yml` builds CSS, generates `_manifest.json`, runs tests, deploys to `https://<username>.github.io/<repo>/`.

Read-only. Adding or editing entries means `git push`.

### Cloudflare Worker

Same SPA, two upgrades on top of Pages:

- **In-browser editing** backed by R2. Use the UI New/Edit buttons, no `git push` round-trip.
- **Fast browsing of other people's forks** through a KV-cached `/api/external/*` proxy. Skips GitHub's 60 req/hr/IP unauthenticated limit.

Click to fork the repo and let Cloudflare auto-provision the Worker, the KV namespace (`FORK_CACHE`), and the R2 bucket (`LIBRARY`) declared in `worker/wrangler.toml`:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/%3COWNER%3E/aitelier)

Replace `<OWNER>` in the badge URL with your GitHub username before publishing your own fork.

For push-to-main redeploys, set the repo Actions variable `DEPLOY_MODE=worker` and provide `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` as repo secrets. `.github/workflows/deploy.yml` will then run `wrangler deploy`.

Optionally gate the Worker behind an email allowlist (Cloudflare Access; no app-side auth code):

```bash
bun install
bun run setup:access     # prompts for CF token, account id, allowed email
```

Revert with `bun run teardown:access`.

---

## Conventions on the markdown

Every `.md` under `prompts/`, `skills/`, `agents/`, `hooks/` is a YAML frontmatter block followed by a plain-markdown body:

```md
---
name: rubber-duck
description: Explain code line by line as if to a sceptical duck.
tags: [debugging, explainer]
---

You are a sceptical rubber duck. The user will paste code...
```

The parser (`src/lib/parse-frontmatter.js`) handles scalars, flow lists, block lists, booleans, ints, floats. No anchors, no nested maps. Copy any existing file in the four folders for the exact shape per entity type.

Multi-step prompts split on `## Step <n>, <label>` headings and render as numbered cards in the deep-dive view.

### Folder-shaped entities

Skills, agents, and hooks can ship supporting files (setup scripts, helpers) by using a folder instead of a single `.md`:

```
skills/
├── simple-skill.md
└── folder-skill/
    ├── SKILL.md
    └── scripts/
        ├── setup.sh
        └── run.py
```

Agents use `AGENT.md`. Hooks are always folder-shaped (see below). Prompts stay single-file. Every other file inside the folder is surfaced as an attachment in the deep-dive view, with per-file Show (inline preview) and Copy buttons. Allowed attachment extensions: `.md, .sh, .py, .js, .ts, .json, .yaml, .yml, .txt, .toml`.

### Hooks

Hooks are Claude Code lifecycle handlers. Each hook is a folder under `hooks/<name>/`:

```
hooks/prevent-rm-rf/
├── hook.json        # verbatim settings.json fragment (required)
├── README.md        # prose: why + tuning (optional)
├── aitelier.json    # category/tags/install scope (optional sidecar)
└── scripts/         # supporting executables (optional)
    └── ...
```

`hook.json` is the canonical Claude-spec snippet that gets merged into the user's `settings.json`. Aitelier reads the top-level `hooks.<EventName>` key for the event, the `matcher` for the matcher pill, and decomposes each inner entry (`type` / `command` / `args` / `if`) into a structured view. The deep-dive's "Copy snippet" button copies `hook.json` straight to the clipboard.

The optional sidecar carries Aitelier-only metadata:

```json
{
  "name": "prevent-rm-rf",
  "description": "PreToolUse hook that blocks dangerous rm -rf.",
  "category": "security",
  "tags": ["pre-tool-use", "bash", "safety"],
  "install": { "scope": "user", "path": "~/.claude/settings.json" }
}
```

When `scripts/` is present, the deep-dive renders an "Install all" curl one-liner that drops every script into `~/.claude/hooks/<name>/` (user scope) or `${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>/` (project scope). Script paths referenced inside the `command` string are cross-linked to the attachment list.

---

## Development

Run locally:

```bash
make dev          # bun run css, then python3 -m http.server :8000
make open         # http://localhost:8000
make stop
```

Edit a file under `prompts/`, `skills/`, `agents/`, or `hooks/`, reload, it shows up. No manifest needed locally; the python autoindex is enough.

Run tests:

```bash
bun test
```

CI auto-deploys on push to `main`, gated by the repo Actions variable `DEPLOY_MODE`:

| `DEPLOY_MODE` | Runs on push to `main` |
|---|---|
| unset or `pages` | Pages workflow |
| `worker` | Worker workflow (`wrangler deploy`) |

---

## Notes on the External transport

The **External** pill on the dashboard browses other people's forks. It accepts:

| Input | Resolves to |
|---|---|
| `username` | `username/.aitelier` on default branch |
| `owner/repo` | `owner/repo` on default branch |
| `owner/repo@branch` | Same repo, pinned to a branch |
| `https://github.com/owner/repo[/tree/branch]` | Paste-friendly normaliser |

The transport is picked automatically at startup via `HEAD /api/external/ping`:

- **Unhosted** (Pages or any static host): browser hits GitHub directly. Subject to 60 req/hr/IP.
- **Hosted** (Worker): browser hits `/api/external/...` on the same origin; the Worker proxies once, caches in KV, serves subsequent requests sub-30ms.

Successful fetches are cached in `localStorage["aitelier-fork-cache-v1"]` as raw markdown, capped at 5 snapshots per fork. Freshness badges (`fresh`, `N ahead`, `stale`, `error`) are computed lazily per row with a 5-minute `sessionStorage` debounce.

To publish your `~/.claude` as a fork others can browse:

```bash
cd ~/.claude
gh repo create .aitelier --public --source=. --remote=origin --push
```

Scrub `.env`, `*.log`, `history.jsonl`, anything with secrets. Keep `prompts/`, `skills/`, `agents/`, `hooks/` at the repo root, that is the layout Aitelier reads.

### Speeding up External: the `_bundle.br` file

If you publish your fork, you can also publish one extra file at the repo root called `_bundle.br`. It is **optional**. If it is there, anyone browsing your fork loads it faster. If it is not, nothing breaks - the dashboard falls back to the old way of loading.

#### What is `_bundle.br`?

It is one file that contains **all your prompts, skills, agents, and hooks packed together** and compressed. Think of it like a zip file, but using the brotli compression format that every modern browser can unpack natively without any extra library.

The format inside is plain: for each file we write the filename, then the file's contents, one after another. The browser reads through it once and gets a map of `path → content`. That is it.

#### Why does it exist?

Without the bundle, opening someone's fork makes the browser ask GitHub for a lot of things in sequence:

1. "What is the latest commit on this repo?" (1 call)
2. "List every file under prompts/, skills/, agents/, hooks/" (1 call)
3. "Give me the contents of file A, file B, file C, ..." (one call per file)

On a small library that is **about 10–14 separate network calls**. Each one is a round-trip to GitHub. On a slow or far-away connection every round-trip costs hundreds of milliseconds. Also, GitHub limits unauthenticated users to 60 requests per hour per IP address. Burn through 14 of those just to open one fork and you can only open four forks an hour.

With the bundle, the browser only asks GitHub for **two things**: the latest commit, and the bundle file. Total: 2 network calls. The browser unpacks the bundle in memory and pulls every file from there - no more calls.

#### What it improves (measured on the real `noelruault/.aitelier` fork)

| measurement            | without bundle | with bundle | change |
|------------------------|---------------:|------------:|-------:|
| network requests       | 14             | 2           | -85%   |
| cold load time         | ~1100 ms       | ~830 ms     | -26%   |
| time after warmup      | ~125 ms        | ~60 ms      | -52%   |
| GitHub rate-limit cost | 14/60 per hour | 2/60        | 7×     |

These numbers come from one small library (about 8 visible entities, 33 underlying files, ~220 KB raw text). They are good enough to show the shape of the improvement, but they are not the final word. On a heavier corpus - hundreds of entities, larger markdown bodies, or a slow mobile connection - the gap between "with bundle" and "without bundle" usually grows, because the old path adds one round-trip per file while the bundle path stays at two round-trips regardless of how many files you ship. Re-run `bun run scripts/bench-external.ts --slug <fork> --label <name>` against your own fork to see real numbers for your setup; results are appended to `.bench/live-results.jsonl` so you can compare runs over time.

The practical wins:

- **Faster first paint** for visitors on mobile or far-away networks.
- **Fewer rate-limit errors** when someone clicks around several forks.
- **Less load on GitHub** for everyone.

#### Where in the pipeline it lives

When the dashboard loads an external fork, the transport code (`src/data/transport-direct.js` for direct GitHub, `src/data/transport-worker.js` when a Cloudflare Worker is in front) does this:

```
1. Ask GitHub for the latest commit on the fork.
2. Try to download `_bundle.br` at that commit.
       ├─ found  →  unpack it, you are done. (the fast path)
       └─ 404    →  fall back to the old way:
                       - ask for the recursive file tree
                       - download every entity file in parallel
```

The fallback is the safety net: forks that never publish a bundle work exactly as before. Forks that do publish one get the fast path automatically. The consumer (the browser) does not need to know which way it got the data - both paths end with the same in-memory map of files.

#### How to publish one for your own fork

In your fork's checkout (the public repo, the one you `git push` for others to browse):

```bash
bun run scripts/build-bundle.ts    # writes _bundle.br at repo root
git add _bundle.br
git commit -m "publish _bundle.br"
git push
```

That is the whole workflow. The script walks `prompts/`, `skills/`, `agents/`, `hooks/`, packs them, runs `brotli -q 11` on the result, and writes the file. It takes a second or two.

If you forget to rebuild after changing an entity, no harm done - the consumer's commit-pinned cache key means a stale bundle is never served against a newer commit. The bundle either matches the commit exactly (used) or it does not (consumer falls back automatically).

You can wire this into your push flow with a git pre-push hook or a CI step if you want it to stay fresh without thinking about it.

#### What it does **not** do

- It is **not encryption** - anyone can unpack the bundle. Do not put anything in your fork you would not want public.
- It is **not magic compression** - the bundle is small because brotli is good at compressing text, not because of anything clever in the format.
- It is **not required** - your fork works fine without it, just a little slower.
- It does not change which files are loaded - it changes **how** they are delivered.

For the full measurement walkthrough (which compression formats were considered, which lost, why brotli won) see `.bench/REPORT.md`. That report was produced by a reusable benchmarking agent published at [noelruault/research - compression-engineer](https://github.com/noelruault/research/tree/main/.ai/agents/compression#compression-engineer); the agent runs a measure-first loop (fixed metric, fixed time budget, bootstrap confidence intervals) and can be pointed at any other corpus to repeat this kind of comparison.

## License

MIT.
