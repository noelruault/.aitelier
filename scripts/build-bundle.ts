#!/usr/bin/env bun
/*
 * build-bundle.ts — pack the entity catalog into `_bundle.br`.
 *
 * Wire format (per .bench/REPORT.md investigation):
 *   brotli( [u16 LE path_len][utf8 path][u32 LE body_len][bytes body] )*
 *
 * Repeating frames, no terminator. Decoder reads until the buffer is
 * exhausted. Binary-safe: scripts, JSON, markdown all share the same path.
 *
 * The artifact is OPTIONAL on the consumer side. Forks that publish a
 * `_bundle.br` get the fast path (one raw fetch + decompress); forks that
 * don't fall back to the recursive trees endpoint automatically. Publishing
 * is therefore the publisher's choice, not a requirement.
 *
 * Keep folder list in sync with ENTITY_FOLDERS (src/lib/group-entities.js).
 * The ALLOWED_EXT list matches scripts/build-manifest.ts so both bundles
 * and the lazy R2 seed include the same files.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FOLDERS = ["prompts", "skills", "agents", "hooks"];
const ALLOWED_EXT = new Set([
  ".md", ".sh", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".toml"
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Script lives at the repo root, so scriptDir IS the repo root.
const repoRoot = resolve(scriptDir, "..");

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && ALLOWED_EXT.has(extOf(ent.name))) out.push(p);
  }
  return out;
}

const collected: { rel: string; bytes: Uint8Array }[] = [];
for (const folder of FOLDERS) {
  for (const file of walk(join(repoRoot, folder))) {
    const rel = relative(repoRoot, file).split(sep).join("/");
    collected.push({ rel, bytes: new Uint8Array(await Bun.file(file).arrayBuffer()) });
  }
}
collected.sort((a, b) => a.rel.localeCompare(b.rel));

const enc = new TextEncoder();
let total = 0;
const frames: { path: Uint8Array; body: Uint8Array }[] = [];
for (const { rel, bytes } of collected) {
  const path = enc.encode(rel);
  if (path.length > 0xFFFF) throw new Error(`path too long: ${rel}`);
  if (bytes.length > 0xFFFFFFFF) throw new Error(`body too large: ${rel}`);
  frames.push({ path, body: bytes });
  total += 2 + path.length + 4 + bytes.length;
}

const raw = new Uint8Array(total);
const dv = new DataView(raw.buffer);
let off = 0;
for (const { path, body } of frames) {
  dv.setUint16(off, path.length, true); off += 2;
  raw.set(path, off); off += path.length;
  dv.setUint32(off, body.length, true); off += 4;
  raw.set(body, off); off += body.length;
}

// Brotli quality 11 (max). Publishing happens once per release; the extra
// seconds at pack time buy permanent wire-byte savings.
const proc = Bun.spawn(["brotli", "-q", "11", "-c"], {
  stdin: new Response(raw).body!,
  stdout: "pipe",
});
const compressed = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
await proc.exited;
if (proc.exitCode !== 0) throw new Error(`brotli exited ${proc.exitCode}`);

const outPath = join(repoRoot, "_bundle.br");
await Bun.write(outPath, compressed);

const ratio = (compressed.length / raw.length) * 100;
console.log(
  `wrote _bundle.br: ${collected.length} files, ${raw.length} B raw -> ${compressed.length} B brotli (${ratio.toFixed(1)}%)`
);
