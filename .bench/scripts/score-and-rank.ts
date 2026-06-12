#!/usr/bin/env bun
/**
 * score-and-rank.ts - apply the metric defined in SCOPE.md to all candidates
 * and produce a sorted ranking + dual-format CI (bytes + percent) against the
 * baseline candidate `json-object × gzip-9`.
 *
 * score = wire_bytes + 0.05·compress_ms_p50 + 0.5·decode_ms_p50
 *
 * Also computes the wire-time sanity check at 1 Mbps / 25 Mbps.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const RES = "/Users/noelruault/go/src/github.com/noelruault/aitelier/.bench/results";
const rows = JSON.parse(readFileSync(join(RES, "decode-bench.json"), "utf8")) as any[];

const ALPHA = 0.05;
const BETA  = 0.50;

function scoreOf(r: any): number {
  return r.bytes + ALPHA * r.compress_ms_p50 + BETA * r.decode_ms_p50;
}

// Bootstrap CI on per-sample decode differences vs baseline
function bootstrapCIDelta(candSamples: number[], baseSamples: number[], reps = 10000, alpha = 0.05, seed = 0xc0ffee) {
  let s = seed >>> 0;
  function rnd() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const n = Math.min(candSamples.length, baseSamples.length);
  const means: number[] = new Array(reps);
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = (rnd() * n) | 0;
      sum += candSamples[idx] - baseSamples[idx];
    }
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(reps * alpha / 2)], hi: means[Math.floor(reps * (1 - alpha / 2))] };
}

const baseline = rows.find((r) => r.container === "json-object" && r.codec === "gzip-9");
if (!baseline) throw new Error("no baseline");

const baseScore = scoreOf(baseline);
const baseBytes = baseline.bytes;
console.log("# Baseline: json-object × gzip-9");
console.log(`#   bytes = ${baseline.bytes}`);
console.log(`#   compress_ms_p50 = ${baseline.compress_ms_p50.toFixed(2)}`);
console.log(`#   decode_ms_p50 = ${baseline.decode_ms_p50.toFixed(3)}`);
console.log(`#   score = ${baseScore.toFixed(2)}`);
console.log();

const ranked: any[] = [];
for (const r of rows) {
  const sc = scoreOf(r);
  const dScore = sc - baseScore;
  const dBytes = r.bytes - baseBytes;
  const dBytesPct = (r.bytes - baseBytes) / baseBytes * 100;
  // Decode CI (delta against baseline decode samples)
  const decCI = bootstrapCIDelta(r.raw_decode_samples, baseline.raw_decode_samples);
  // Wire latency at two link rates (bytes * 8 bits / link_bps * 1000 ms/s)
  const wire_1mbps_ms = (r.bytes * 8) / 1_000_000 * 1000;     // 1 Mbps
  const wire_25mbps_ms = (r.bytes * 8) / 25_000_000 * 1000;   // 25 Mbps
  const total_1mbps = wire_1mbps_ms + r.decode_ms_p50;
  const total_25mbps = wire_25mbps_ms + r.decode_ms_p50;
  ranked.push({
    candidate: `${r.container}×${r.codec}`,
    container: r.container,
    codec: r.codec,
    browser_ok: r.browser_ok,
    bytes: r.bytes,
    bytes_pct_vs_base: dBytesPct,
    compress_ms_p50: r.compress_ms_p50,
    decode_ms_p50: r.decode_ms_p50,
    decode_ms_p95: r.decode_ms_p95,
    decode_ci_lo: r.decode_ci_lo,
    decode_ci_hi: r.decode_ci_hi,
    decode_delta_ci_lo: decCI.lo,
    decode_delta_ci_hi: decCI.hi,
    score: sc,
    score_delta: dScore,
    score_delta_pct: (dScore / baseScore) * 100,
    bytes_delta: dBytes,
    wire_1mbps_ms,
    wire_25mbps_ms,
    total_1mbps_ms: total_1mbps,
    total_25mbps_ms: total_25mbps,
  });
}

ranked.sort((a, b) => a.score - b.score);

console.log("# Ranking by score (lower = better). Baseline is json-object × gzip-9.");
console.log("# rank  candidate                        bytes    Δbytes%   dec ms  score        Δscore     CI95 decode(ms)        browser_ok");
let rnk = 1;
for (const r of ranked) {
  const ciStr = `[${r.decode_delta_ci_lo.toFixed(3)}, ${r.decode_delta_ci_hi.toFixed(3)}]`;
  console.log(
    `# ${String(rnk++).padStart(2)}  ${r.candidate.padEnd(32)} ${String(r.bytes).padStart(6)}  ${r.bytes_pct_vs_base.toFixed(2).padStart(7)}%  ${r.decode_ms_p50.toFixed(3).padStart(6)}  ${r.score.toFixed(2).padStart(10)}  ${r.score_delta.toFixed(2).padStart(9)}  ${ciStr.padEnd(22)}  ${r.browser_ok}`
  );
}

writeFileSync(join(RES, "ranked.json"), JSON.stringify(ranked, null, 2));

console.log("\n# Wire-time sanity check (decode + transfer)");
console.log("# candidate                        bytes   t_1Mbps  t_25Mbps  total_1Mbps  total_25Mbps");
for (const r of ranked.slice(0, 10)) {
  console.log(
    `# ${r.candidate.padEnd(32)} ${String(r.bytes).padStart(6)}  ${r.wire_1mbps_ms.toFixed(0).padStart(7)} ${r.wire_25mbps_ms.toFixed(1).padStart(8)}  ${r.total_1mbps_ms.toFixed(0).padStart(11)}  ${r.total_25mbps_ms.toFixed(2).padStart(11)}`
  );
}
