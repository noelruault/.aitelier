#!/usr/bin/env bun
/**
 * compress-matrix.ts - for each (container × codec), produce a compressed
 * artifact, record bytes + wall-clock compress time, and emit a CSV row.
 *
 * Outputs:
 *   .bench/artifacts/<container>.<codec>           - compressed bytes
 *   .bench/results/compress-matrix.json            - full record
 *   prints CSV rows to stdout
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const REPO = "/Users/noelruault/go/src/github.com/noelruault/aitelier";
const ART = join(REPO, ".bench/artifacts");
const RES = join(REPO, ".bench/results");

const CONTAINERS = [
  { id: "json-object",   file: "bundle.json"   },
  { id: "ndjson",        file: "bundle.ndjson" },
  { id: "sentinel-cat",  file: "bundle.cat"    },
  { id: "len-prefixed",  file: "bundle.lp"     },
  { id: "tar",           file: "bundle.tar"    },
];

const ZSTD_DICT   = join(ART, "zstd.dict");
const BROTLI_DICT = join(ART, "brotli.dict");

interface Codec {
  id: string;
  ext: string;
  encode: (inFile: string, outFile: string) => string[];
  decode: (inFile: string) => string[]; // command pipeline writing to stdout
}

const CODECS: Codec[] = [
  {
    id: "identity",
    ext: "raw",
    encode: (i, o) => ["cp", i, o],
    decode: (i) => ["cat", i],
  },
  {
    id: "gzip-9",
    ext: "gz",
    encode: (i, o) => ["sh", "-c", `gzip -9 -c "${i}" > "${o}"`],
    decode: (i) => ["sh", "-c", `gzip -dc "${i}"`],
  },
  {
    id: "brotli-11",
    ext: "br",
    encode: (i, o) => ["sh", "-c", `brotli -q 11 -c "${i}" > "${o}"`],
    decode: (i) => ["sh", "-c", `brotli -dc "${i}"`],
  },
  {
    id: "zstd-22",
    ext: "zst",
    encode: (i, o) => ["sh", "-c", `zstd --ultra -22 -q -c "${i}" > "${o}"`],
    decode: (i) => ["sh", "-c", `zstd -dc "${i}"`],
  },
  {
    id: "zstd-22-dict",
    ext: "zstd",
    encode: (i, o) => ["sh", "-c", `zstd --ultra -22 -q -D "${ZSTD_DICT}" -c "${i}" > "${o}"`],
    decode: (i) => ["sh", "-c", `zstd -dc -D "${ZSTD_DICT}" "${i}"`],
  },
  {
    id: "brotli-11-shared",
    ext: "brd",
    // brotli CLI -D takes a raw dictionary file; max size 16 MB
    encode: (i, o) => ["sh", "-c", `brotli -q 11 -D "${BROTLI_DICT}" -c "${i}" > "${o}"`],
    decode: (i) => ["sh", "-c", `brotli -dc -D "${BROTLI_DICT}" "${i}"`],
  },
];

const RUNS = 5;

function timeIt(cmd: string[], runs: number): { p50_ms: number; p95_ms: number; ok: boolean; err?: string } {
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    const t1 = performance.now();
    if (r.status !== 0) return { p50_ms: 0, p95_ms: 0, ok: false, err: r.stderr?.toString() || "exit " + r.status };
    ts.push(t1 - t0);
  }
  ts.sort((a, b) => a - b);
  const p = (q: number) => ts[Math.min(ts.length - 1, Math.floor(ts.length * q))];
  return { p50_ms: p(0.5), p95_ms: p(0.95), ok: true };
}

const ROWS: any[] = [];
const RAW_TOTAL = 222569; // from build-containers output

console.log("container,codec,bytes,ratio_vs_raw,compress_ms_p50,compress_ms_p95");
for (const ctn of CONTAINERS) {
  const inFile = join(ART, ctn.file);
  for (const cd of CODECS) {
    const outFile = join(ART, `${ctn.file}.${cd.ext}`);
    // Skip dict codecs on text formats that won't benefit and to bound the matrix
    // (we still run all 30 cells; this is a placeholder if we ever prune).
    const t = timeIt(cd.encode(inFile, outFile), RUNS);
    if (!t.ok) {
      console.error(`# FAIL ${ctn.id} × ${cd.id}: ${t.err}`);
      continue;
    }
    const bytes = statSync(outFile).size;
    const ratio = bytes / RAW_TOTAL;
    console.log(`${ctn.id},${cd.id},${bytes},${ratio.toFixed(4)},${t.p50_ms.toFixed(2)},${t.p95_ms.toFixed(2)}`);
    ROWS.push({ container: ctn.id, codec: cd.id, bytes, ratio_vs_raw: ratio, compress_ms_p50: t.p50_ms, compress_ms_p95: t.p95_ms });
  }
}

writeFileSync(join(RES, "compress-matrix.json"), JSON.stringify(ROWS, null, 2));
console.error(`\n# wrote ${ROWS.length} rows to .bench/results/compress-matrix.json`);
