# Compression Engineer - Aitelier library bundle wire format

## TL;DR

1. **Winner**: `len-prefixed × brotli-11` - 59 757 B on the wire, 0.70 ms p50 decode in V8, ~25-LOC pure-binary parser. Beats the proposed `json-object × gzip-9` by **25.4 %** wire bytes at statistically zero decode cost.
2. **Runner-up**: `sentinel-cat × brotli-11` (87 bytes smaller, identical on decode). Lost only on robustness - assumes no `\0` byte ever appears in any entity body.
3. **Surprise**: `tar × brotli-11` has the **lowest p95 decode** of any candidate despite carrying +11.6 % framing overhead before compression. Brotli compresses the repeating NUL-padded 512-byte headers nearly losslessly, and the fixed-block layout gives V8's TextDecoder cleanly aligned reads. Tar is the strong third pick if third-party tooling (`tar -tvf`) matters later.
4. **Constraint**: zstd is out for the foreseeable future. `DecompressionStream("zstd")` is Chrome 143-only as of 2026-05; no Firefox, no Safari. Even ignoring browser support, zstd-22 is **6.8 % larger** than brotli-11 on this corpus (markdown-dominated, 71.6 % of bytes in 3 files). Shared zstd dictionaries lose to plain brotli-11 amortized; cold-cache they lose to gzip-9. Ruled out.

## What was measured

- 5 containers × 6 codecs = **30 candidates**, each round-trip-validated against the live corpus (33 files, 222 569 B).
- Decode timed in Bun (V8 family, ≈ Chrome ±10–20 %) via the exact browser path: `fetch → DecompressionStream → TextDecoder → parser → Map<path, body>`. 9 runs + 2 warmups per cell, bootstrap-95% CI with 10 000 resamples (seed `0xc0ffee`).
- Bun's `DecompressionStream("brotli")` is supported natively (confirmed in `sanity-check.ts`), matching the Chrome 122+ / Firefox 122+ / Safari 17.5+ baseline.
- Spawn-floor measured separately (~2.4 ms p50): zstd/shared-dict decode numbers are inflated by this floor because no in-engine decoder exists; true browser cost would be ~2 ms IF a WASM decoder were available, which would itself cost +50–200 KB JS.

## Top 3 (browser-OK cells only)

| rank | candidate | bytes | Δ% vs `json-object×gzip-9` | decode p50 | decode p95 | decode CI95 vs base (ms) |
|-----:|-----------|------:|---------------------------:|-----------:|-----------:|--------------------------|
| 1 | `len-prefixed × brotli-11` | **59 757** | **−25.4 %** | 0.704 ms | 2.121 ms | **[−0.560, +0.028]** |
| 2 | `sentinel-cat × brotli-11` | 59 670 | −25.5 % | 0.746 ms | 2.103 ms | [−0.564, +0.084] |
| 3 | `tar × brotli-11` | 60 292 | −24.7 % | 0.781 ms | **1.044 ms** | [−0.584, −0.198] |

Bootstrap-CI of decode delta for #1 and #2 crosses zero → brotli-11 decode is **statistically not slower than gzip-9** on this corpus. Wire-byte savings come at zero decode cost.

## Wire-time sanity check

Total user-perceived latency = transfer + decode_p50:

| candidate | bytes | 1 Mbps mobile | 25 Mbps home |
|-----------|------:|--------------:|-------------:|
| `len-prefixed × brotli-11` | 59 757 | **479 ms** | 19.8 ms |
| `json-object × gzip-9` (proposed) | 80 094 | 642 ms | 26.7 ms |
| per-file gzip-6 (today, no bundle) | 90 375 | 723 ms* | 28.9 ms* |

\* ignores api.github.com RTT serialization (5+N round-trips). Bundle decision is unanimous on every axis. Format choice - brotli-11 over gzip-9 - saves an additional **163 ms on 1 Mbps mobile**, **6.9 ms on home wifi**. User-perceptible on mobile.

## Trade-off matrix (× brotli-11, browser-OK candidates only)

| dimension | json-object | ndjson | sentinel-cat | **len-prefixed** | tar |
|-----------|------------:|-------:|-------------:|-----------------:|----:|
| bytes | 60 104 | 60 085 | 59 670 | **59 757** | 60 292 |
| decode p50 (ms) | 1.185 | 1.073 | 0.746 | **0.704** | 0.781 |
| decode p95 (ms) | 1.700 | 2.165 | 2.103 | 2.121 | **1.044** |
| parser LOC (SPA) | 5 | 10 | 30 | **25** | 50 |
| binary-payload-safe | no (utf8 only) | no | ⚠ (`\0` footgun) | **yes** | yes |
| third-party tooling | `jq` | `jq` | none | none | `tar -tvf` |

`len-prefixed` wins on the two axes that matter most for cold-start UX (wire bytes, decode p50). Loses parser-brevity to `json-object` (5 → 25 LOC) and tooling-introspectability to `tar`. Both acceptable.

## Honest call-outs

- **Corpus skew**: top 3 markdown files = 71.6 % of corpus bytes. A future fork with mostly JSON sidecars or mostly tiny entities will shift codec ratios; re-bench on a representative fork before any format pivot. Harness in `.bench/scripts/` is reusable.
- **Zstd revisit window**: 2027–2028. When `DecompressionStream("zstd")` hits Baseline, codec swap is a 2-line change in the build script; no container migration.
- **Shared dictionaries killed by environment, not by data**: a trained 16 KB dict + zstd-22 saves only ~3 KB amortized and **loses** ~1 KB to plain brotli-11. Cold-cache it's worse than gzip-9 baseline. Plus, raw.githubusercontent.com would not serve `Use-As-Dictionary` headers. Not worth the publisher complexity on a 60 KB artifact.
- **`raw.githubusercontent.com` Content-Encoding**: confirmed serves our `.br` artifact bytes verbatim (`Content-Encoding` is absent, not `br`). The SPA must decompress in user-space via `DecompressionStream`. Detect codec from filename or magic bytes; **do not trust `Content-Encoding`**.
- **What could regress**: a future entity type with binary blobs (e.g. PDF in a skill). `len-prefixed` and `tar` handle it; JSON containers would need base64 (+33 % bytes); `sentinel-cat` would break on a `\0`. Picking `len-prefixed` future-proofs this.

## Recommended layout (one diff)

Artifact name: `_bundle.br` in the fork repo root. Raw container before brotli:

```
repeating, no terminator:
  +-----------+--------------+-----------+--------------+
  | u16 LE    | utf-8 bytes  | u32 LE    | bytes        |
  | path_len  | path         | body_len  | body         |
  +-----------+--------------+-----------+--------------+
```

SPA decode (~25 LOC, drop-in):

```js
async function loadBundle(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("bundle fetch " + res.status);
  const decoded = res.body.pipeThrough(new DecompressionStream("brotli"));
  const buf = new Uint8Array(await new Response(decoded).arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();
  const entries = new Map();
  let i = 0;
  while (i < buf.length) {
    const pathLen = dv.getUint16(i, true);
    const bodyLen = dv.getUint32(i + 2, true);
    i += 6;
    const path = td.decode(buf.subarray(i, i + pathLen)); i += pathLen;
    const body = td.decode(buf.subarray(i, i + bodyLen)); i += bodyLen;
    entries.set(path, body);
  }
  return entries;
}
```

Publisher (Bun, fork CI): walk the four entity folders, pack into the binary layout (~15 LOC, see `.bench/scripts/build-containers.ts`), `brotli -q 11`, commit. One file per release.

## Deliverables

- `.bench/SCOPE.md` - fixed metric, budget, candidates, corpus description, verdict rule
- `.bench/EXPERIMENTS.md` - 10 experiments (0001–0010) with hypotheses, commands, results, KEEP/DISCARD verdicts
- `.bench/sizes.csv` - 30 rows, machine-readable
- `.bench/results/{compress-matrix,decode-bench,ranked}.json` - full per-sample data including raw decode samples for re-CI
- `.bench/scripts/*.ts` - 7 self-contained Bun scripts; `bun run <file>` reproduces every number
- `.bench/artifacts/` - 30 pre-built compressed artifacts (5 containers × 6 codecs) for inspection

Reproducer (from repo root):
```
bun run .bench/scripts/build-containers.ts
bun run .bench/scripts/compress-matrix.ts
bun run .bench/scripts/sanity-check.ts
bun run .bench/scripts/decode-bench.ts
bun run .bench/scripts/score-and-rank.ts
bun run .bench/scripts/emit-csv.ts
```
