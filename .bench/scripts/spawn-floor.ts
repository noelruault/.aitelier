#!/usr/bin/env bun
/**
 * spawn-floor.ts - measure fork/exec overhead so we can subtract it from
 * the CLI-backed zstd/brotli-shared decode timings.
 *
 * We run `cat` 9 times with the smallest payload (60 KB) and a no-op output.
 * That gives a baseline cost per spawnSync round-trip.
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const ART = "/Users/noelruault/go/src/github.com/noelruault/aitelier/.bench/artifacts";
const bytes = readFileSync(join(ART, "bundle.lp.br")); // ~60 KB

const RUNS = 30;
const WARMUPS = 3;

for (let i = 0; i < WARMUPS; i++) spawnSync("cat", [], { input: bytes });

const ts: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const r = spawnSync("cat", [], { input: bytes });
  if (r.status !== 0) throw new Error("cat failed");
  const t1 = performance.now();
  ts.push(t1 - t0);
}
ts.sort((a, b) => a - b);
const p50 = ts[Math.floor(ts.length * 0.5)];
const p95 = ts[Math.floor(ts.length * 0.95)];
console.log(`spawnSync(cat) over ${bytes.length} B:  p50 = ${p50.toFixed(3)} ms,  p95 = ${p95.toFixed(3)} ms`);
console.log(`  this is the floor that must be subtracted from CLI-backed decode timings`);
