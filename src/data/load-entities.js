import { parseFrontmatter, parseSteps } from "../lib/parse-frontmatter.js";
import { TransportLocal } from "./transport-local.js";
import { ENTITY_FOLDERS, emptyGrouping } from "../lib/group-entities.js";

/* Entity loader orchestrator. Decoupled from the actual transport so the
 * same parsing + build path serves the local source and external forks.
 *
 * Source of truth for the local case = per-entity canonical files under
 *   prompts/<name>.md, skills/<name>/SKILL.md, agents/<name>.md, hooks/<name>.md
 * The canonical file holds Claude-spec frontmatter only (`name`,
 * `description`, plus any Claude-spec extras per type). Aitelier-only
 * metadata (`category`, `tags`, `source`, `steps`, `related`) lives in an
 * optional sidecar `aitelier.json` adjacent to the canonical file:
 *   prompts/<name>.aitelier.json
 *   skills/<name>/aitelier.json
 *   agents/<name>.aitelier.json
 *   hooks/<name>.aitelier.json   (Phase 1 - Phase 2 moves to hooks/<name>/aitelier.json)
 * Sidecar absent ⇒ entity.category is undefined; card omits the swatch;
 * cat-rail buckets the entry under "Uncategorized".
 *
 * A transport implements:
 *   list(folder)            -> Promise<string[] slugs>
 *   fetch(folder, slug)     -> Promise<string raw markdown>
 *   fetchSidecar?(folder, slug) -> Promise<object|null>   // optional
 *
 * Dual-read fallback: builders accept the new Claude-spec keys
 * (`name`/`description`) and also fall back to the old Aitelier keys
 * (`id`/`title`/`summary`) when present. The fallback covers entries that
 * may have escaped the seed migration; once every entry has been verified
 * migrated, the fallback can be dropped. */

export const PROMPTS = [];
export const SKILLS = [];
export const AGENTS = [];
export const HOOKS = [];
export const RELATED = {};

export const BUILTINS = { prompts: PROMPTS, skills: SKILLS, agents: AGENTS, hooks: HOOKS };

export const ENTITY_SHAPES = emptyGrouping();

/* Shared core fields. Builders extend this with type-specific bits.
 * Sidecar payload (when present) supplies category/tags/source/steps/related.
 * `id` is kept as an alias of `name` so router/storage/galaxy keep
 * functioning without touching every consumer; new code reads `.name`. */
function buildBase({ meta }, fallbackSlug, sidecar) {
  const name = meta.name || meta.id || fallbackSlug;
  const description = meta.description || meta.summary || "";
  const side = sidecar || {};
  const out = {
    name,
    id: name, // alias for routing/storage continuity
    description,
    tags: Array.isArray(side.tags) ? side.tags : []
  };
  if (side.category !== undefined) out.category = side.category;
  if (side.source !== undefined) out.source = side.source;
  return out;
}

export function buildPrompt(parsed, fallbackSlug, sidecar) {
  const e = buildBase(parsed, fallbackSlug, sidecar);
  const { meta, body } = parsed;
  if (meta.slash) e.slash = meta.slash;
  // Sidecar steps[] (when present) drives the multi-step view. The
  // canonical .md body remains a valid single-prompt slash command - we
  // intentionally do not re-derive steps from the body when a sidecar
  // exists. Legacy: when meta.multi_step is set and no sidecar steps, fall
  // back to body splitting via parseSteps so unmigrated seeds still work.
  if (sidecar && Array.isArray(sidecar.steps) && sidecar.steps.length) {
    e.steps = sidecar.steps;
  } else if (meta.multi_step) {
    e.steps = parseSteps(body);
  }
  e.body = String(body).trim();
  return e;
}

export function buildSkill(parsed, fallbackSlug, sidecar) {
  const { meta, body } = parsed;
  const base = buildBase(parsed, fallbackSlug, sidecar);
  // Skill invocation is structurally `/<name>` per Claude Code. Keep an
  // explicit override for frontmatter `slash:` (legacy seeds) but otherwise
  // derive it so the canonical file does not need to carry it.
  const slash = meta.slash || `/${base.name}`;
  return { ...base, slash, body: String(body).trim() };
}

export function buildAgent(parsed, fallbackSlug, sidecar) {
  const { meta, body } = parsed;
  const e = buildBase(parsed, fallbackSlug, sidecar);
  e.model = meta.model || "inherit";
  e.tools = meta.tools || "*";
  e.body = String(body).trim();
  return e;
}

export function buildHook(parsed, fallbackSlug, sidecar, prose) {
  // Phase 2: hooks are folder-shaped. transport.fetch returns hook.json
  // verbatim (JSON string); `prose` carries README.md content when present.
  // We detect "new shape" by attempting JSON.parse on the raw input; legacy
  // flat hooks/<name>.md falls through to the frontmatter-based path.
  const rawSrc = parsed.__rawSource;
  if (rawSrc && tryParseHookJson(rawSrc)) {
    const sideInstall = sidecar && sidecar.install && typeof sidecar.install === "object" ? sidecar.install : {};
    const proseParsed = prose ? parseFrontmatter(prose) : { meta: {}, body: "" };
    // README.md is plain prose per plan §"Hook" - no frontmatter expected,
    // but if a user adds one we ignore it; the body is what matters.
    const e = {
      name: (sidecar && sidecar.name) || fallbackSlug,
      id: (sidecar && sidecar.name) || fallbackSlug,
      description: (sidecar && sidecar.description) || "",
      tags: Array.isArray(sidecar && sidecar.tags) ? sidecar.tags : []
    };
    if (sidecar && sidecar.category !== undefined) e.category = sidecar.category;
    if (sidecar && sidecar.source !== undefined) e.source = sidecar.source;
    e.installScope = sideInstall.scope || "user"; // default per plan: hook scripts land in user scope
    e.installPath = sideInstall.path || "";
    e.snippetRaw = rawSrc.trim();
    e.body = prose ? String(proseParsed.body || prose).trim() : "";
    // event/matcher derived from hook.json on render; do not duplicate here.
    e.event = "";
    e.matcher = "";
    return e;
  }
  // Legacy flat hooks/<name>.md path. Old frontmatter carried name/desc/
  // event/matcher/install plus inline JSON fence in the body.
  const { meta, body } = parsed;
  const install = meta.install && typeof meta.install === "object" ? meta.install : {};
  const e = buildBase(parsed, fallbackSlug, sidecar);
  e.event = meta.event || "";
  e.matcher = meta.matcher || "";
  e.installScope = install.scope || "";
  e.installPath = install.path || "";
  e.body = String(body).trim();
  return e;
}

function tryParseHookJson(raw) {
  const s = String(raw || "").trim();
  if (!s.startsWith("{")) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

export const BUILDERS = { prompts: buildPrompt, skills: buildSkill, agents: buildAgent, hooks: buildHook };

export async function loadFolder(transport, folder, build, sink, relatedSink) {
  const slugs = await transport.list(folder);
  slugs.sort();
  const raws = await Promise.all(slugs.map(s => transport.fetch(folder, s)));
  const sidecars = await Promise.all(slugs.map(s =>
    typeof transport.fetchSidecar === "function" ? transport.fetchSidecar(folder, s) : Promise.resolve(null)
  ));
  // Phase 2: hooks may ship prose in a sibling README.md (shape C). Pull
  // it now so buildHook can attach it as entity.body.
  const proses = await Promise.all(slugs.map(s =>
    typeof transport.fetchProse === "function" ? transport.fetchProse(folder, s) : Promise.resolve(null)
  ));
  raws.forEach((raw, i) => {
    const parsed = parseFrontmatter(raw);
    parsed.__rawSource = raw; // hook builder peeks at the original to detect hook.json shape
    const sidecar = sidecars[i] || null;
    const prose = proses[i] || null;
    sink.push(build(parsed, slugs[i], sidecar, prose));
    const rel = (sidecar && Array.isArray(sidecar.related)) ? sidecar.related
      : (Array.isArray(parsed.meta.related) ? parsed.meta.related : null);
    if (rel && rel.length) relatedSink[slugs[i]] = rel;
  });
}

export async function loadEntities(transport, sinks) {
  const { related, shapes } = sinks;
  const jobs = [];
  for (const folder of ENTITY_FOLDERS) {
    const sink = sinks[folder];
    if (!sink) continue;
    jobs.push(loadFolder(transport, folder, BUILDERS[folder], sink, related));
  }
  await Promise.all(jobs);
  if (shapes && typeof transport.shapes === "function") {
    try {
      const grouped = await transport.shapes();
      for (const f of Object.keys(shapes)) shapes[f].length = 0;
      for (const f of Object.keys(grouped || {})) {
        if (!shapes[f]) continue;
        for (const e of grouped[f]) shapes[f].push(e);
      }
    } catch (e) {
      console.warn("transport.shapes failed:", e);
    }
  }
}

// Module-level boot. Pure builders above are imported by tests under Bun,
// which has no `window`; guard so the test harness does not trip. The
// `__atelierSkipBoot` flag lets standalone tools (e.g. demo/galaxy.html)
// inject their own entities without firing a real manifest fetch.
if (typeof window !== "undefined" && !window.__atelierSkipBoot) {
  window.loadEntities = loadEntities;
  window.buildPrompt = buildPrompt;
  window.buildSkill = buildSkill;
  window.buildAgent = buildAgent;
  window.buildHook = buildHook;

  window.__dataReady = loadEntities(TransportLocal, {
    ...BUILTINS, related: RELATED, shapes: ENTITY_SHAPES
  }).catch(err => {
    console.error("Entity load failed:", err);
    throw err;
  });
} else if (typeof window !== "undefined") {
  // Tools that skip boot still want a resolved __dataReady so other code paths
  // awaiting it don't hang.
  window.__dataReady = Promise.resolve();
}
