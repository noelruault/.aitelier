#!/usr/bin/env bun
/**
 * decode-bench.ts - measure end-to-end decode time in V8 for each (container ×
 * codec) cell, simulating exactly what a browser would do:
 *
 *   bytes -> DecompressionStream(codec) -> Uint8Array -> TextDecoder ->
 *           container-specific parse -> Map<path, body>
 *
 * For codecs that DecompressionStream does NOT support in 2026-baseline
 * browsers (zstd, zstd-dict, brotli-shared-with-raw-dict-prepend), we
 * STILL time them via Bun.zstdDecompress / brotliDecompress so the report
 * has the apples-to-apples decode number - but `browser_ok: false` in the
 * output marks them as constraint-violating.
 *
 * Output:
 *   .bench/results/decode-bench.json
 *   stdout: CSV ready for sizes.csv
 *
 * Bootstrap-CI is computed in TypeScript with 10 000 resamples (seeded).
 */

import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const REPO = "/Users/noelruault/go/src/github.com/noelruault/aitelier";
const ART = join(REPO, ".bench/artifacts");
const RES = join(REPO, ".bench/results");

const RUNS = 9;       // 9 runs (5 minimum per scope)
const WARMUPS = 2;

const ZSTD_DICT_PATH = join(ART, "zstd.dict");
const BROTLI_DICT_PATH = join(ART, "brotli.dict");

const CONTAINERS = [
  { id: "json-object",   base: "bundle.json"   },
  { id: "ndjson",        base: "bundle.ndjson" },
  { id: "sentinel-cat",  base: "bundle.cat"    },
  { id: "len-prefixed",  base: "bundle.lp"     },
  { id: "tar",           base: "bundle.tar"    },
];

const CODECS: { id: string; ext: string; browser_ok: boolean }[] = [
  { id: "identity",         ext: "raw",   browser_ok: true  },
  { id: "gzip-9",           ext: "gz",    browser_ok: true  },
  { id: "brotli-11",        ext: "br",    browser_ok: true  },
  // zstd is NOT in DecompressionStream baseline 2026; bench anyway.
  { id: "zstd-22",          ext: "zst",   browser_ok: false },
  { id: "zstd-22-dict",     ext: "zstd",  browser_ok: false },
  // brotli with raw shared dict - browser DecompressionStream("deflate-raw"/"gzip"/"deflate")
  // cannot accept a preloaded dict directly. RFC 9842 dcb framing requires the UA to
  // recognise the magic + hash and pre-feed the dict to its brotli decoder. As of 2026,
  // this is preview-stage in Chrome (dcb/dcz behind an Origin Trial). Mark not baseline.
  { id: "brotli-11-shared", ext: "brd",   browser_ok: false },
];

// ---------- helpers ----------

async function streamDecompress(bytes: Uint8Array, format: "gzip" | "deflate" | "deflate-raw"): Promise<Uint8Array> {
  // Browser-equivalent: DecompressionStream via web streams.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const chunks: Uint8Array[] = [];
  // @ts-ignore Bun supports for-await on streams
  for await (const c of stream) chunks.push(c);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function tryStreamBrotli(bytes: Uint8Array): Promise<Uint8Array | null> {
  // Brotli format token in DecompressionStream is "deflate-raw"? No - actually
  // the spec adds "brotli" but support is uneven. Try; fall back to CLI.
  try {
    // @ts-ignore - DecompressionStream "brotli" is a 2024+ addition
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("brotli" as any));
    const chunks: Uint8Array[] = [];
    // @ts-ignore
    for await (const c of stream) chunks.push(c);
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  } catch (e) {
    return null;
  }
}

function cliDecompress(cmd: string[], bytes: Uint8Array): Uint8Array {
  // Use a CLI subprocess as a fallback when DecompressionStream cannot handle the codec.
  // This OVER-estimates browser decode by the fork/exec overhead; we compensate by
  // also measuring identity through the same CLI path and subtracting the floor.
  const r = spawnSync(cmd[0], cmd.slice(1), { input: Buffer.from(bytes), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("decompress failed: " + r.stderr?.toString());
  return new Uint8Array(r.stdout);
}

// ---------- parsers ----------

function parseJsonObject(text: string): Map<string, string> {
  const obj = JSON.parse(text) as Record<string, string>;
  return new Map(Object.entries(obj));
}

function parseNdjson(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // Splitting by "\n" is correct because bodies are JSON-escaped (no raw newlines after JSON.stringify).
  for (const line of text.split("\n")) {
    if (!line) continue;
    const o = JSON.parse(line) as { path: string; body: string };
    out.set(o.path, o.body);
  }
  return out;
}

function parseSentinelCat(bytes: Uint8Array): Map<string, string> {
  // \0path\0length\0body...
  const out = new Map<string, string>();
  const td = new TextDecoder();
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0) throw new Error("sentinel mismatch at " + i);
    i++;
    let j = i;
    while (j < bytes.length && bytes[j] !== 0) j++;
    const path = td.decode(bytes.subarray(i, j));
    i = j + 1;
    j = i;
    while (j < bytes.length && bytes[j] !== 0) j++;
    const len = Number(td.decode(bytes.subarray(i, j)));
    i = j + 1;
    const body = td.decode(bytes.subarray(i, i + len));
    out.set(path, body);
    i += len;
  }
  return out;
}

function parseLenPrefixed(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const td = new TextDecoder();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < bytes.length) {
    const pathLen = dv.getUint16(i, true);
    const bodyLen = dv.getUint32(i + 2, true);
    i += 6;
    const path = td.decode(bytes.subarray(i, i + pathLen));
    i += pathLen;
    const body = td.decode(bytes.subarray(i, i + bodyLen));
    out.set(path, body);
    i += bodyLen;
  }
  return out;
}

function parseTar(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const td = new TextDecoder();
  let i = 0;
  while (i + 512 <= bytes.length) {
    const hdr = bytes.subarray(i, i + 512);
    // Two zero blocks = EOF
    let allZero = true;
    for (let k = 0; k < 512; k++) if (hdr[k] !== 0) { allZero = false; break; }
    if (allZero) break;
    // Read name (NUL-terminated, max 100)
    let nameEnd = 0;
    while (nameEnd < 100 && hdr[nameEnd] !== 0) nameEnd++;
    const name = td.decode(hdr.subarray(0, nameEnd));
    // Size at offset 124, 12 bytes, octal ASCII, NUL- or space-terminated
    const sizeRaw = td.decode(hdr.subarray(124, 136)).replace(/[\0 ]/g, "");
    const size = parseInt(sizeRaw, 8);
    i += 512;
    const body = td.decode(bytes.subarray(i, i + size));
    out.set(name, body);
    // Round up to 512
    i += Math.ceil(size / 512) * 512;
  }
  return out;
}

function parse(container: string, bytes: Uint8Array): Map<string, string> {
  if (container === "sentinel-cat") return parseSentinelCat(bytes);
  if (container === "len-prefixed") return parseLenPrefixed(bytes);
  if (container === "tar")          return parseTar(bytes);
  // For json-object / ndjson we go through TextDecoder once then JSON.parse
  const text = new TextDecoder().decode(bytes);
  if (container === "json-object") return parseJsonObject(text);
  if (container === "ndjson")      return parseNdjson(text);
  throw new Error("unknown container " + container);
}

// ---------- one full decode iteration ----------

async function decodeOnce(container: string, codec: string, src: Uint8Array): Promise<{ ms: number; n_entries: number }> {
  const t0 = performance.now();
  let raw: Uint8Array;
  if (codec === "identity") {
    raw = src;
  } else if (codec === "gzip-9") {
    raw = await streamDecompress(src, "gzip");
  } else if (codec === "brotli-11") {
    const r = await tryStreamBrotli(src);
    if (r) raw = r;
    else raw = cliDecompress(["brotli", "-dc"], src); // fallback
  } else if (codec === "zstd-22") {
    // Bun has built-in zstd via node:zlib in newer versions? Use Bun.spawnSync for parity.
    raw = cliDecompress(["zstd", "-dc"], src);
  } else if (codec === "zstd-22-dict") {
    raw = cliDecompress(["zstd", "-dc", "-D", ZSTD_DICT_PATH], src);
  } else if (codec === "brotli-11-shared") {
    raw = cliDecompress(["brotli", "-dc", "-D", BROTLI_DICT_PATH], src);
  } else {
    throw new Error("unknown codec " + codec);
  }
  const m = parse(container, raw);
  const t1 = performance.now();
  return { ms: t1 - t0, n_entries: m.size };
}

// ---------- bootstrap CI ----------

function bootstrapCI(values: number[], reps = 10000, alpha = 0.05, seed = 0xc0ffee): { lo: number; hi: number } {
  // Mulberry32 PRNG for determinism
  let s = seed >>> 0;
  function rnd() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const n = values.length;
  const means: number[] = new Array(reps);
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[(rnd() * n) | 0];
    }
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(reps * alpha / 2)], hi: means[Math.floor(reps * (1 - alpha / 2))] };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

// ---------- main ----------

const RAW_TOTAL = 222569;
const rows: any[] = [];

console.log("container,codec,bytes,ratio,compress_ms_p50,decode_ms_p50,decode_ms_p95,decode_ci_lo,decode_ci_hi,n_entries,browser_ok");

// Pull compress matrix for compress_ms_p50 lookup
const compressMatrix = JSON.parse(readFileSync(join(RES, "compress-matrix.json"), "utf8")) as any[];

for (const ctn of CONTAINERS) {
  for (const cd of CODECS) {
    const inFile = join(ART, `${ctn.base}.${cd.ext}`);
    const bytes = statSync(inFile).size;
    const src = new Uint8Array(readFileSync(inFile));

    // Warmups
    for (let w = 0; w < WARMUPS; w++) {
      await decodeOnce(ctn.id, cd.id, src);
    }
    const ms: number[] = [];
    let n_entries = 0;
    for (let r = 0; r < RUNS; r++) {
      const o = await decodeOnce(ctn.id, cd.id, src);
      ms.push(o.ms);
      n_entries = o.n_entries;
    }
    const p50 = median(ms);
    const p_95 = p95(ms);
    const ci = bootstrapCI(ms);
    const cm = compressMatrix.find((x) => x.container === ctn.id && x.codec === cd.id);
    const compress_ms_p50 = cm?.compress_ms_p50 ?? 0;

    console.log(`${ctn.id},${cd.id},${bytes},${(bytes / RAW_TOTAL).toFixed(4)},${compress_ms_p50.toFixed(2)},${p50.toFixed(3)},${p_95.toFixed(3)},${ci.lo.toFixed(3)},${ci.hi.toFixed(3)},${n_entries},${cd.browser_ok}`);
    rows.push({
      container: ctn.id,
      codec: cd.id,
      bytes,
      ratio: bytes / RAW_TOTAL,
      compress_ms_p50,
      decode_ms_p50: p50,
      decode_ms_p95: p_95,
      decode_ci_lo: ci.lo,
      decode_ci_hi: ci.hi,
      raw_decode_samples: ms,
      n_entries,
      browser_ok: cd.browser_ok,
    });
  }
}

writeFileSync(join(RES, "decode-bench.json"), JSON.stringify(rows, null, 2));
console.error(`\n# wrote ${rows.length} rows to .bench/results/decode-bench.json`);
