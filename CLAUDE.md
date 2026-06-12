# CLAUDE.md

Guidance for AI coding agents working in this repo. Read this before editing.

## What this project is

Aitelier is a static SPA (no bundler, native ES modules) that renders a library of prompts, skills, agents, and hooks for Claude Code. Two deployment paths share the same code: GitHub Pages (static) and a Cloudflare Worker (R2-backed editing + KV-cached external-fork proxying). See `README.md` for the deeper tour.

## Hard rules

### 1. Styling: Tailwind-first, native variants for state

All new styling goes inline as Tailwind v4 utility classes on JS template strings. State (pressed/active/hovered/focused/aria-current/data-attribute) uses Tailwind's **native variants** directly on the element:

- `aria-pressed:bg-accent aria-pressed:text-paper`
- `aria-[current=page]:bg-ink aria-[current=page]:text-paper`
- `group/chip` on a parent + `group-aria-pressed/chip:bg-paper` on a child
- `data-active:...`, `data-[state=open]:...`, etc.

Do **not** add `.foo[aria-pressed="true"] { ... }` or similar state-rule blocks to `src/styles/input.css`. The "unlayered tail" cascade-hack is gone. If a Tailwind variant exists for the state, use it.

`src/styles/input.css` is reserved for:
1. `@theme` tokens
2. `@layer base` (body reset, page-gradient, `::selection`)
3. Pseudo-elements (`::before`, `::after`, `::first-letter`) where utilities physically cannot express them
4. Multi-layer / gradient backgrounds, `mask-image`
5. `@keyframes`
6. Deep `.md-body` descendant rules from rendered markdown (no class attribute to inline onto)
7. The legacy `:root` alias block (`--paper`, `--cat-*`, etc.) consumed by inline `style="..."`

If a utility chain repeats >3x and you can't extract it as a JS constant string (see `CHIP_CLS`, `MODE_BTN`, `NAV_LINK` patterns), think again before adding to `input.css`.

### 2. Code: DRY, table-driven on entity folders

The four entity folders (`prompts`, `skills`, `agents`, `hooks`) are enumerated in **one place**: `ENTITY_FOLDERS` in `src/lib/group-entities.js`. Every other JS site that needs to iterate or dispatch on type **must consume that constant** (directly or via the dispatch tables built on top of it).

The canonical dispatch tables are:

- `ENTITY_FOLDERS` (`src/lib/group-entities.js`) - the list itself
- `BUILTINS` (`src/data/load-entities.js`) - `{ prompts: PROMPTS, skills: SKILLS, ... }`
- `BUILDERS` (`src/data/load-entities.js`) - `{ prompts: buildPrompt, ... }`
- `STORAGE` (`src/lib/storage.js`) - per-type localStorage key
- `loadUser(type)` / `saveUser(type, m)` (`src/lib/storage.js`)
- `TYPE_GLYPHS` (`src/components/card.js`)
- `mainFileFor(type)` (`src/lib/group-entities.js`)

Adding a fifth entity type = update these tables + add a markdown folder. Nothing else.

**Do not** write:
- `["prompts", "skills", "agents", "hooks"].includes(t)` - use `ENTITY_FOLDERS.includes(t)`
- `t === "prompts" ? ... : t === "skills" ? ... : ...` - use a table lookup
- `{ prompts: X, skills: Y, agents: Z, hooks: W }[type]` - put `X/Y/Z/W` in a module-level table, indexed by type
- Per-type wrapper functions (`loadUserPrompts`, `loadUserSkills`, ...) **except** as one-line facades kept for back-compat. New consumers call `loadUser(type)`.

The named exports `PROMPTS`, `SKILLS`, `AGENTS`, `HOOKS` (arrays) and `loadUserPrompts`/`saveUserPrompts`/... (functions) are **kept as facades** because many files import them by name. Don't remove the facades; just don't add new ones.

**TS cross-boundary exception:** `worker/src/library.ts` and `scripts/build-manifest.ts` run server-side under their own `tsconfig`. They duplicate the folder list with a "keep in sync with `ENTITY_FOLDERS`" comment instead of importing across the JS/TS boundary. Acceptable; document the choice in code comments.

### 3. UI strings are copy, not code lists

Strings the user sees ("Browsable library of prompts, skills, and agents", placeholders, empty states) are content. Don't refactor them into a `.join(", ")` of `ENTITY_FOLDERS`. Code lists are deduped; copy is not.

### 4. UI copy stays AI/LLM-agnostic

Aitelier is a generic library of prompts, skills, hooks, and agents. The user could be pasting blocks into Claude, ChatGPT, Gemini, a local model, or anything else. **UI copy must not assume the user's AI tool.**

Wrong: `copy & paste into <code>claude</code>`, "paste this into your Claude conversation", "Run with Claude Code". Right: `click to copy`, "paste into your AI/LLM", "Run with your assistant".

**Narrow exception:** the Hooks type is structurally a Claude Code lifecycle handler. Inside the hook deep-dive view (settings.json snippet, "Install into `~/.claude/settings.json`", the install-all curl one-liner targeting `~/.claude/hooks/<slug>/`), Claude-specific paths and product names are accurate and stay. The exception is per-entity-type content, not a license to leak `claude` into shared chrome (dashboard lede, raw-block labels, empty states, search placeholders, etc.).

The same applies to README.md: top-level value prop is tool-agnostic; hook-specific subsections may reference Claude Code where it is structurally true.

### 5. Edit affordances are gated by host capability, not assumed

Edit / Fork / Request edit / Duplicate / Delete (and the "Edit reqs" navbar entry) are **hidden by default** on every deployment. They only render when the host has explicitly opted in:

- The Worker carries an `EDITS_ENABLED` env var declared in `worker/wrangler.toml [vars]`. Default is `"false"`.
- The Worker advertises capability through `GET /api/library/ping` -> `{ ok: true, edits: env.EDITS_ENABLED === "true" }`.
- The SPA primes capabilities once at boot (`src/data/capabilities.js`), persists the result for the tab in `sessionStorage["aitelier-capabilities-v1"]`, and exposes a synchronous `getCapabilitiesSync()` to renderers.
- `getCapabilitiesSync().edits` is consulted in `topActionsFor` (manpage) and `renderNavbar` (Edit reqs button). Pages has no Worker, so the probe fails and `edits` stays `false`.

**Do not** add new edit affordances without consulting `getCapabilitiesSync()`. Pages is structurally read-only: the SPA cannot persist writes there, and surfacing a button that silently drops to `localStorage` confuses users into thinking edits are saved when they are not.

When the day comes to wire the buttons to the Worker's existing `PUT/DELETE /api/library/file/...` endpoints (Phase B in the issue history), the gate stays. Phase B turns the affordances from "localStorage scratchpad" into "R2 writeback", but the visibility rule above does not change.

### 6. Memory file at `~/.claude-work-home/.claude/projects/.../memory/`

There is an auto-memory system feeding rules into agent context. The currently-tracked rules are:

- `tailwind-first.md` - the styling rule above
- `two-repo-split.md` - private `aitelier` holds source; public `.aitelier` is a squash-mirrored demo

Treat both as load-bearing. If a refactor invalidates a memory rule, update the memory file in the same change.

## Commands

- `bun test` - runs `tests/*.test.js` against the real ESM modules in `src/`. No transpiler, no jsdom. The runtime that runs tests is the same that runs the build scripts and the Worker dev server.
- `bun run css` - regenerates `src/styles/library.css` from `src/styles/input.css` (Tailwind v4 CLI).
- `bun run css:watch` - same on file change.
- `bun run scripts/build-manifest.ts` - emits `_manifest.json`. Both the Pages workflow and the Worker `wrangler` build run this.
- `make dev` - builds CSS, then `python3 -m http.server :8000`.
- `make stop` - kills the server.
- `bun run setup:access` - provisions Cloudflare Access in front of a deployed Worker.
- `bun run unwrap-md [--dry] <file...>` - collapses hard-wrapped paragraphs and list items to one line each. Preserves frontmatter, fenced code, headings, lists, tables, and blockquotes. Use after pulling in externally-wrapped markdown so the renderer doesn't have to lean on lazy-continuation rules.

## Verification gates for any non-trivial change

1. `bun test` passes.
2. `bun run css` succeeds (regenerated `library.css` should be committed if it changed).
3. `bun run scripts/build-manifest.ts` produces a manifest with the same `sha256:` version unless content actually changed.
4. Reload `:8000` and exercise the touched feature in a browser. Type-check / test-pass != feature-pass.

## What not to do

- Don't add new files unless the task literally requires one.
- Don't introduce a bundler, framework, or JS dependency that imposes a build step on consumers of the static site.
- Don't add documentation files (`*.md`) unless explicitly asked.
- Don't commit or push without explicit user instruction. Force-push, history rewrite, and structural changes can happen but are user-initiated only.
- Don't skip git hooks (`--no-verify`) or bypass signing. Fix the underlying issue.
