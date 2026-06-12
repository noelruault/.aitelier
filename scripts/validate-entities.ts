#!/usr/bin/env bun
/* Validate library content against the entity conventions before publishing.
 *
 * Checks, per entity type:
 *   prompts/*.md, agents/*.md, skills/<slug>/SKILL.md, skills/*.md (flat):
 *     - frontmatter present, `name` and `description` non-empty
 *     - no pre-migration keys (id, title, type, summary, category, tags,
 *       related, slash) - those belong in the aitelier.json sidecar
 *   hooks/<slug>/hook.json:
 *     - valid JSON with a `hooks` object keyed by lifecycle event
 *
 * Exit 0 when clean, exit 1 with a per-file report otherwise. Run from the
 * repo/site root: `bun run scripts/validate-entities.ts [root]`.
 *
 * Used by .github/workflows/publish-library.yml so a consumer repo fails
 * its publish with a readable report instead of deploying blank cards.
 * Keep in sync with `ENTITY_FOLDERS` in src/lib/group-entities.js (TS
 * cross-boundary exception, CLAUDE.md rule 2).
 */

import { readFileSync } from "fs";
import { join } from "path";
// Bun resolves the ESM .js module directly; no build step.
import { parseFrontmatter } from "../src/lib/parse-frontmatter.js";

const ROOT = process.argv[2] ?? join(import.meta.dir, "..");
const LEGACY_KEYS = ["id", "title", "type", "summary", "category", "tags", "related", "slash"];

const glob = (pattern: string) => Array.from(new Bun.Glob(pattern).scanSync({ cwd: ROOT })).sort();

function checkMarkdown(rel: string): string[] {
  const { meta } = parseFrontmatter(readFileSync(join(ROOT, rel), "utf8"));
  const issues: string[] = [];
  if (!Object.keys(meta).length) return ["no frontmatter"];
  if (!meta.name) issues.push("missing `name`");
  if (!meta.description) issues.push("missing `description`");
  const legacy = LEGACY_KEYS.filter(k => k in meta);
  if (legacy.length) issues.push(`legacy keys (move to sidecar): ${legacy.join(", ")}`);
  return issues;
}

function checkHookJson(rel: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  } catch (e) {
    return [`invalid JSON: ${(e as Error).message}`];
  }
  const hooks = (parsed as Record<string, unknown>)?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return ["missing top-level `hooks` object keyed by lifecycle event"];
  }
  if (!Object.keys(hooks).length) return ["`hooks` object is empty"];
  return [];
}

const failures: Array<[string, string[]]> = [];
let checked = 0;

for (const rel of [...glob("prompts/*.md"), ...glob("agents/*.md"), ...glob("skills/*.md"), ...glob("skills/*/SKILL.md")]) {
  checked++;
  const issues = checkMarkdown(rel);
  if (issues.length) failures.push([rel, issues]);
}
for (const rel of glob("hooks/*/hook.json")) {
  checked++;
  const issues = checkHookJson(rel);
  if (issues.length) failures.push([rel, issues]);
}

if (failures.length) {
  console.error(`validate-entities: ${failures.length} of ${checked} files failed\n`);
  for (const [rel, issues] of failures) {
    for (const issue of issues) console.error(`  ${rel}: ${issue}`);
  }
  console.error("\nConvention: frontmatter needs `name` + `description`; category/tags/related live in the aitelier.json sidecar. See the aitelier-onboarding skill.");
  process.exit(1);
}
console.log(`validate-entities: ${checked} files OK`);
