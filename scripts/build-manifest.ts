#!/usr/bin/env bun
/*
 * build-manifest.ts - emit _manifest.json listing every entity file
 * under prompts/, skills/, agents/, hooks/ at the repo root.
 *
 * Consumed by the Worker's lazy seed (worker/src/library.ts): on first
 * request, the Worker reads _manifest.json via env.ASSETS.fetch and
 * copies each listed key into R2 if missing.
 *
 * Output shape (plan §3.6):
 *   {
 *     "version": "sha256:<hex>",
 *     "files": ["prompts/foo.md", ...],
 *     "sizes": { "prompts/foo.md": 1234, ... }      // bytes per file
 *   }
 *
 * The `sizes` map is optional from the consumer side: the Worker only
 * needs `files` to seed R2 (R2 already knows the byte length post-PUT),
 * but the SPA uses `sizes` to label attachments in the deep-dive view.
 *
 * Walks recursively so folder-shaped entities (e.g.
 * skills/complex/SKILL.md + skills/complex/scripts/run.py) are picked up.
 * The extension allowlist matches the Worker validator (plan §4.1).
 *
 * version = sha256 over the sorted list of "<path>:<mtimeNs>" entries.
 * Stable across re-runs that don't touch any input file.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Keep in sync with ENTITY_FOLDERS in src/lib/group-entities.js. This
// script runs under Bun outside the SPA's module graph, so importing the
// JS module is avoided to keep the build trivially portable.
const FOLDERS = ["prompts", "skills", "agents", "hooks"];
const ALLOWED_EXT = new Set([
  ".md", ".sh", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".toml"
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walk(p));
    } else if (ent.isFile() && ALLOWED_EXT.has(extOf(ent.name))) {
      out.push(p);
    }
  }
  return out;
}

const collected: { rel: string; mtimeNs: bigint; size: number }[] = [];
for (const folder of FOLDERS) {
  const abs = join(repoRoot, folder);
  for (const file of walk(abs)) {
    const rel = relative(repoRoot, file).split(sep).join("/");
    const st = statSync(file);
    collected.push({ rel, mtimeNs: st.mtimeNs, size: st.size });
  }
}

collected.sort((a, b) => a.rel.localeCompare(b.rel));

const hash = createHash("sha256");
for (const { rel, mtimeNs } of collected) {
  hash.update(`${rel}:${mtimeNs}\n`);
}
const version = `sha256:${hash.digest("hex")}`;
const files = collected.map((c) => c.rel);
const sizes: Record<string, number> = {};
for (const { rel, size } of collected) sizes[rel] = size;

const manifest = { version, files, sizes };
const outPath = join(repoRoot, "_manifest.json");
await Bun.write(outPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`wrote _manifest.json with ${files.length} files (version ${version})`);
