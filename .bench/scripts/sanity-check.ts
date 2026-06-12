#!/usr/bin/env bun
/**
 * sanity-check.ts - verify each (container × codec) cell round-trips correctly.
 * Decodes the artifact, parses it, and confirms it produces exactly 33 entries
 * matching the original corpus file-by-file. Aborts on any mismatch.
 */

import { readFileSync, statSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { join, relative } from "path";

const REPO = "/Users/noelruault/go/src/github.com/noelruault/aitelier";
const ART = join(REPO, ".bench/artifacts");

// Build reference map from the actual files
function walk(dir: string, out: string[] = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) {
      const dot = ent.name.lastIndexOf(".");
      const ext = dot >= 0 ? ent.name.slice(dot) : "";
      if (new Set([".md", ".sh", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".toml"]).has(ext))
        out.push(p);
    }
  }
  return out;
}
const ref = new Map<string, string>();
for (const root of ["prompts", "skills", "agents", "hooks"]) {
  for (const abs of walk(join(REPO, root)).sort()) {
    ref.set(relative(REPO, abs), readFileSync(abs, "utf8"));
  }
}
console.log("# reference: " + ref.size + " files");

async function streamGzip(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  // @ts-ignore
  for await (const c of stream) chunks.push(c);
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function streamBrotli(b: Uint8Array): Promise<Uint8Array | null> {
  try {
    // @ts-ignore
    const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream("brotli"));
    const chunks: Uint8Array[] = [];
    // @ts-ignore
    for await (const c of stream) chunks.push(c);
    let n = 0; for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  } catch { return null; }
}

const brTest = await streamBrotli(new Uint8Array(readFileSync(join(ART, "bundle.json.br"))));
console.log("# DecompressionStream brotli support in Bun: " + (brTest ? "YES (n=" + brTest.length + ")" : "NO"));

// Sanity-check parsers
import {
  // we'll just inline trivial parsers here to avoid module duplication
} from "fs";

function parseJsonObject(text: string): Map<string, string> {
  return new Map(Object.entries(JSON.parse(text)));
}
function parseNdjson(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const o = JSON.parse(line);
    out.set(o.path, o.body);
  }
  return out;
}
function parseSentinel(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>(); const td = new TextDecoder();
  let i = 0;
  while (i < bytes.length) {
    i++; let j = i; while (bytes[j] !== 0) j++;
    const path = td.decode(bytes.subarray(i, j));
    i = j + 1; j = i; while (bytes[j] !== 0) j++;
    const len = Number(td.decode(bytes.subarray(i, j)));
    i = j + 1;
    out.set(path, td.decode(bytes.subarray(i, i + len)));
    i += len;
  }
  return out;
}
function parseLp(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>(); const td = new TextDecoder();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < bytes.length) {
    const pl = dv.getUint16(i, true), bl = dv.getUint32(i + 2, true);
    i += 6;
    const path = td.decode(bytes.subarray(i, i + pl)); i += pl;
    out.set(path, td.decode(bytes.subarray(i, i + bl))); i += bl;
  }
  return out;
}
function parseTar(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>(); const td = new TextDecoder();
  let i = 0;
  while (i + 512 <= bytes.length) {
    let allZero = true;
    for (let k = 0; k < 512; k++) if (bytes[i + k] !== 0) { allZero = false; break; }
    if (allZero) break;
    let ne = 0; while (ne < 100 && bytes[i + ne] !== 0) ne++;
    const name = td.decode(bytes.subarray(i, i + ne));
    const sz = parseInt(td.decode(bytes.subarray(i + 124, i + 136)).replace(/[\0 ]/g, ""), 8);
    i += 512;
    out.set(name, td.decode(bytes.subarray(i, i + sz)));
    i += Math.ceil(sz / 512) * 512;
  }
  return out;
}

function eqMap(label: string, got: Map<string, string>) {
  if (got.size !== ref.size) { throw new Error(`${label}: size ${got.size} != ref ${ref.size}`); }
  for (const [k, v] of ref) {
    const g = got.get(k);
    if (g === undefined) throw new Error(`${label}: missing ${k}`);
    if (g.length !== v.length) throw new Error(`${label}: ${k} length ${g.length} != ${v.length}`);
    if (g !== v) {
      // Find first mismatched char for a hint
      let i = 0; while (i < v.length && i < g.length && g[i] === v[i]) i++;
      throw new Error(`${label}: ${k} byte ${i} mismatch (ref=${JSON.stringify(v.slice(i, i + 20))} got=${JSON.stringify(g.slice(i, i + 20))})`);
    }
  }
  console.log(`  ${label}: OK`);
}

function cliDecompress(cmd: string[], bytes: Uint8Array): Uint8Array {
  const r = spawnSync(cmd[0], cmd.slice(1), { input: Buffer.from(bytes), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("decompress failed: " + r.stderr?.toString());
  return new Uint8Array(r.stdout);
}

console.log("# round-trip checks");
const td = new TextDecoder();

// json-object
eqMap("json-object × identity",  parseJsonObject(readFileSync(join(ART, "bundle.json.raw"), "utf8")));
eqMap("json-object × gzip-9",    parseJsonObject(td.decode(await streamGzip(new Uint8Array(readFileSync(join(ART, "bundle.json.gz")))))));
if (brTest) {
  eqMap("json-object × brotli-11", parseJsonObject(td.decode((await streamBrotli(new Uint8Array(readFileSync(join(ART, "bundle.json.br"))))) as Uint8Array)));
}
eqMap("json-object × zstd-22",   parseJsonObject(td.decode(cliDecompress(["zstd", "-dc"], new Uint8Array(readFileSync(join(ART, "bundle.json.zst")))))));
eqMap("json-object × zstd-22-dict", parseJsonObject(td.decode(cliDecompress(["zstd", "-dc", "-D", join(ART, "zstd.dict")], new Uint8Array(readFileSync(join(ART, "bundle.json.zstd")))))));
eqMap("json-object × brotli-11-shared", parseJsonObject(td.decode(cliDecompress(["brotli", "-dc", "-D", join(ART, "brotli.dict")], new Uint8Array(readFileSync(join(ART, "bundle.json.brd")))))));

// ndjson
eqMap("ndjson × identity",       parseNdjson(readFileSync(join(ART, "bundle.ndjson.raw"), "utf8")));
eqMap("ndjson × gzip-9",         parseNdjson(td.decode(await streamGzip(new Uint8Array(readFileSync(join(ART, "bundle.ndjson.gz")))))));

// sentinel-cat
eqMap("sentinel-cat × identity", parseSentinel(new Uint8Array(readFileSync(join(ART, "bundle.cat.raw")))));
eqMap("sentinel-cat × gzip-9",   parseSentinel(await streamGzip(new Uint8Array(readFileSync(join(ART, "bundle.cat.gz"))))));

// len-prefixed
eqMap("len-prefixed × identity", parseLp(new Uint8Array(readFileSync(join(ART, "bundle.lp.raw")))));
eqMap("len-prefixed × gzip-9",   parseLp(await streamGzip(new Uint8Array(readFileSync(join(ART, "bundle.lp.gz"))))));

// tar
eqMap("tar × identity",          parseTar(new Uint8Array(readFileSync(join(ART, "bundle.tar.raw")))));
eqMap("tar × gzip-9",            parseTar(await streamGzip(new Uint8Array(readFileSync(join(ART, "bundle.tar.gz"))))));

console.log("\nAll cells round-trip. Safe to bench decode timing.");
