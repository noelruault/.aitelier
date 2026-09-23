#!/usr/bin/env bun
/**
 * emit-csv.ts - produce sizes.csv in the schema requested by the user:
 *   candidate,container,codec,bytes,ratio,compress_ms_p50,decode_ms_p50,
 *   decode_ms_p95,decode_ci_lo,decode_ci_hi
 *
 * Pulls data from .bench/results/decode-bench.json.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const RES = "/Users/noelruault/go/src/github.com/noelruault/aitelier/.bench/results";
const rows = JSON.parse(readFileSync(join(RES, "decode-bench.json"), "utf8")) as any[];

const lines: string[] = [];
lines.push("candidate,container,codec,bytes,ratio,compress_ms_p50,decode_ms_p50,decode_ms_p95,decode_ci_lo,decode_ci_hi,browser_ok");
for (const r of rows) {
  const cand = `${r.container}×${r.codec}`;
  lines.push([
    cand,
    r.container,
    r.codec,
    r.bytes,
    r.ratio.toFixed(4),
    r.compress_ms_p50.toFixed(2),
    r.decode_ms_p50.toFixed(3),
    r.decode_ms_p95.toFixed(3),
    r.decode_ci_lo.toFixed(3),
    r.decode_ci_hi.toFixed(3),
    r.browser_ok,
  ].join(","));
}
writeFileSync("/Users/noelruault/go/src/github.com/noelruault/aitelier/.bench/sizes.csv", lines.join("\n") + "\n");
console.log("wrote .bench/sizes.csv with " + (lines.length - 1) + " rows");
