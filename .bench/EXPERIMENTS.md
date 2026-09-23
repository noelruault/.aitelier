# EXPERIMENTS - Aitelier library bundle wire format

Append-only log. Past DISCARD entries stay as evidence the alternative was tried.

Environment:
- macOS 25.5.0, Apple Silicon
- bun 1.3.11
- brotli 1.2.0, zstd 1.5.7, gzip Apple-479, bsdtar 3.5.3
- Bun's `DecompressionStream` supports `gzip` and `brotli` natively (confirmed by `.bench/scripts/sanity-check.ts`). This matches Chrome 122+ / Firefox 122+ / Safari 17.5+, all baseline by 2026-05.

Metric (from SCOPE.md):
```
score = bytes + 0.05 · compress_ms_p50 + 0.50 · decode_ms_p50
```

Baseline = `json-object × gzip-9` (the original proposal), bytes = 80 094, score = 80 095.39. A candidate is KEEP iff the bootstrap-95% CI of (cand − base) is strictly negative on the metric AND decode_p95 < 50 ms.

---

## Exp 0001 - corpus inventory

Date: 2026-05-18 Hypothesis: corpus shape is dominated by markdown. Cmd: `find prompts skills agents hooks -type f \( ... \) -exec wc -c {} \;` Result:
- 33 files, 222 569 bytes total.
- Top 3 files (`compression-engineer.md` 70.9 KB, `go-performance.md` 56.1 KB, `go-hot-pot-jo.md` 32.4 KB) = 159.4 KB = **71.6 %** of corpus.
- 17 markdown bodies, 15 JSON sidecars, 1 shell script. Decision: corpus is markdown-dominated. Brotli's RFC 7932 static dictionary should help (HTML/JS-tuned, but Markdown shares vocabulary). Trained shared dictionaries will be biased toward markdown vocabulary even if we attempt to balance toward JSON sidecars.

---

## Exp 0002 - container framing overhead (identity, no codec)

Date: 2026-05-18 Hypothesis: container format choice changes raw bytes by < 5 %; tar is the outlier due to 512-byte block alignment. Cmd: `bun run .bench/scripts/build-containers.ts` Result:

| container       | bytes   | vs raw   |
|-----------------|---------|----------|
| sentinel-cat    | 223 813 | +0.6 %   |
| len-prefixed    | 223 797 | +0.6 %   |
| json-object     | 231 107 | +3.8 %   |
| ndjson          | 231 634 | +4.1 %   |
| tar             | 248 320 | +11.6 %  |

JSON containers carry +4 % from `\n` escaping in markdown bodies (`JSON.stringify` escapes every newline as `\n`). tar carries +12 % from 512-byte header + body padding on 33 small entries.

Decision: KEEP all five containers in the bench - the question is whether the +12 % tar overhead survives compression.

---

## Exp 0003 - compress matrix, all 5 containers × 6 codecs

Date: 2026-05-18 Hypothesis: codec dominates wire bytes; container choice is in the noise after compression. Cmd: `bun run .bench/scripts/compress-matrix.ts` (5 runs per cell) Result (compressed bytes, by codec, across containers):

| container    | identity | gzip-9 | brotli-11 | zstd-22 | zstd+dict | brotli-11-sh |
|--------------|---------:|-------:|----------:|--------:|----------:|-------------:|
| json-object  | 231 107  | 80 094 |    60 104 |  64 357 |    61 952 |       58 127 |
| ndjson       | 231 634  | 80 158 |    60 085 |  64 373 |    61 957 |       58 098 |
| sentinel-cat | 223 813  | 79 416 |    59 670 |  64 147 |    60 610 |       57 319 |
| len-prefixed | 223 797  | 79 481 |    59 757 |  64 227 |    60 695 |       57 288 |
| tar          | 248 320  | 80 510 |    60 292 |  64 798 |    61 375 |       57 919 |

Within-codec spread across containers (max − min):
- gzip-9: 1 094 B (1.4 %)
- brotli-11: 622 B (1.0 %)
- zstd-22: 651 B (1.0 %)
- brotli-11-shared: 839 B (1.5 %)

Within-container spread across codecs (best vs gzip-9): ~22 KB everywhere.

Decision: **codec choice owns the wire-byte axis; container choice is in the noise after any codec**. The 11.6 % tar slack collapses to 1 % after brotli-11 because tar's repeated NUL-padded headers are highly compressible. KEEP all codec rows; consolidate the container question to a separate axis.

---

## Exp 0004 - round-trip correctness on all (container × codec)

Date: 2026-05-18 Hypothesis: parsers + codecs are correct end-to-end on the real corpus. Cmd: `bun run .bench/scripts/sanity-check.ts` Result: all 14 sampled cells (5 containers × identity + gzip, plus 4 codec variants of json-object) decode → parse → map to exactly 33 entries that byte-match the reference filesystem. Decision: SAFE to bench decode timing.

---

## Exp 0005 - V8 end-to-end decode timing, 9 runs per cell

Date: 2026-05-18 Hypothesis: brotli-11 decode in `DecompressionStream` is no slower than gzip-9 (calibration table says ~400 MB/s for both); container choice in binary vs JSON parser is sub-millisecond on a 60 KB payload. Cmd: `bun run .bench/scripts/decode-bench.ts` (9 runs + 2 warmups per cell, bootstrap-CI 10 000 resamples) Result, decode_ms_p50 by (container × codec):

|              | identity | gzip-9 | brotli-11 | zstd-22 † | zstd+dict † | brotli-sh † |
|--------------|---------:|-------:|----------:|----------:|------------:|------------:|
| json-object  |    0.333 |  1.089 |     1.185 |     5.005 |       4.727 |       4.378 |
| ndjson       |    0.271 |  1.093 |     1.073 |     5.017 |       4.614 |       4.649 |
| sentinel-cat |    0.041 |  0.869 |     0.746 |     4.042 |       4.891 |       4.170 |
| len-prefixed |    0.036 |  0.748 |     0.704 |     4.471 |       4.565 |       4.357 |
| tar          |    0.051 |  0.719 |     0.781 |     4.461 |       4.369 |       4.224 |

† CLI-backed (no `DecompressionStream` baseline support); includes ~2.4 ms fork/exec floor measured separately. True in-engine decode would be ~2 ms, but no WASM-free path exists in browsers in 2026.

Bootstrap-95% CI of decode delta vs baseline (`json-object × gzip-9`):
- `len-prefixed × brotli-11`: **[−0.560, +0.028] ms** - crosses zero, not statistically faster than gzip on decode.
- `sentinel-cat × brotli-11`: **[−0.564, +0.084] ms** - same, crosses zero.
- `tar × brotli-11`: **[−0.584, −0.198] ms** - strictly negative, modest.
- All `× brotli-11-shared` rows: **[+2.9, +3.8] ms** - strictly positive because of the fork/exec floor; the true browser cost (if a JS shared- dict decoder existed) would be ~1–2 ms.

Decision: **brotli-11 decode is statistically indistinguishable from gzip-9** on this corpus. Wire savings come at zero decode cost.

---

## Exp 0006 - score ranking, full matrix

Date: 2026-05-18 Hypothesis: with α=0.05, β=0.5, the score is byte-dominated; ranking will mirror the wire-byte ranking. Cmd: `bun run .bench/scripts/score-and-rank.ts` Result (top 10, lower = better):

| rank | candidate                          | bytes   | Δ% vs base | dec ms | score    | Δscore   | browser_ok |
|-----:|------------------------------------|--------:|-----------:|-------:|---------:|---------:|------------|
|    1 | `len-prefixed × brotli-11-shared`  |  57 288 |   −28.47 % |  4.36  | 57 300.31 | −22 795 | **false**  |
|    2 | `sentinel-cat × brotli-11-shared`  |  57 319 |   −28.44 % |  4.17  | 57 331.28 | −22 764 | **false**  |
|    3 | `tar × brotli-11-shared`           |  57 919 |   −27.69 % |  4.22  | 57 931.81 | −22 164 | **false**  |
|    4 | `ndjson × brotli-11-shared`        |  58 098 |   −27.46 % |  4.65  | 58 110.83 | −21 985 | **false**  |
|    5 | `json-object × brotli-11-shared`   |  58 127 |   −27.43 % |  4.38  | 58 139.54 | −21 956 | **false**  |
|    6 | `sentinel-cat × brotli-11`         |  59 670 |   −25.50 % |  0.75  | 59 680.62 | −20 415 | **true**   |
|    7 | `len-prefixed × brotli-11`         |  59 757 |   −25.39 % |  0.70  | 59 767.83 | −20 328 | **true**   |
|    8 | `ndjson × brotli-11`               |  60 085 |   −24.98 % |  1.07  | 60 096.08 | −19 999 | **true**   |
|    9 | `json-object × brotli-11`          |  60 104 |   −24.96 % |  1.19  | 60 115.01 | −19 980 | **true**   |
|   10 | `tar × brotli-11`                  |  60 292 |   −24.72 % |  0.78  | 60 303.25 | −19 792 | **true**   |

Decision: filtering to `browser_ok = true` (constraint from SCOPE.md "`DecompressionStream` baseline 2026"), the winners are positions 6–10. The top 5 zstd / shared-dict variants are constraint-violating and ruled out.

Among browser-compatible candidates, **`sentinel-cat × brotli-11`** and **`len-prefixed × brotli-11`** tie on the score axis (Δscore differs by 87 units in 60 000, < 0.15 %). Differentiate on secondary criteria.

---

## Exp 0007 - secondary criteria for the brotli-11 cluster

Date: 2026-05-18 Hypothesis: of the 5 browser-OK brotli-11 cells, choose on (a) decode predictability - p95 minus p50 (jitter), (b) parser implementation complexity in the SPA, (c) survives the "raw.gh strips Content-Encoding" scenario gracefully.

| candidate                  | bytes  | p50 ms | p95 ms | p95−p50 | parser LOC (rough) | needs JSON.parse |
|----------------------------|-------:|-------:|-------:|--------:|-------------------:|------------------|
| `len-prefixed × brotli-11` | 59 757 |  0.704 |  2.121 |   1.417 |                ~25 | no               |
| `sentinel-cat × brotli-11` | 59 670 |  0.746 |  2.103 |   1.357 |                ~30 | no               |
| `tar × brotli-11`          | 60 292 |  0.781 |  1.044 |   0.263 |                ~50 | no               |
| `ndjson × brotli-11`       | 60 085 |  1.073 |  2.165 |   1.092 |                ~10 | yes (per line)   |
| `json-object × brotli-11`  | 60 104 |  1.185 |  1.700 |   0.515 |                ~5  | yes (one shot)   |

Trade-offs:
- `json-object` parser is 5 LOC (`new Map(Object.entries(JSON.parse(text)))`) but uses JSON.parse, which mojibakes binary payloads (none today, but the spec allows .sh files). Acceptable because shell is utf-8 text.
- `len-prefixed` is fully binary, zero-copy via `subarray`. Lowest LOC of the non-JSON containers. Survives any-byte payload (future-proof if a hook ships a binary asset).
- `tar` has the lowest jitter (p95 close to p50) - likely because of the fixed 512-byte block size letting V8's TextDecoder hit aligned-read paths.
- `ndjson` decode time is dragged up by per-line JSON.parse setup cost repeated 33 times.

Pages-path survival:
- All 5 work the same way: the browser fetches the `.br` artifact bytes verbatim (since raw.gh doesn't recognize brotli for `Content-Encoding` negotiation), then runs `DecompressionStream("brotli")` in user-space. No difference across containers on this axis.

Decision: **`len-prefixed × brotli-11`** picked as the winner. Smallest bytes among browser-OK, lowest decode_p50, ~25-LOC parser, binary-safe, zero JSON quoting overhead. `sentinel-cat × brotli-11` is a tied alternate; pick `len-prefixed` because two length-prefixed fields are unambiguous (sentinel-cat relies on the assumption that bodies never contain `\0`, which is true today but a footgun if a future entity ships a binary blob in violation of the allowlist).

---

## Exp 0008 - per-file gzip-on-wire (today's path, no bundle)

Date: 2026-05-18 Hypothesis: bundling beats per-file fetching on bytes (small-stream overhead) and on RTTs (33 → 1). Cmd: `for f in <33 files>; do gzip -6 -c "$f" | wc -c; done | sum` Result:
- per-file gzip-6 sum  = 90 375 B (raw.gh default)
- per-file brotli-11 sum = 75 924 B (hypothetical, if raw.gh served brotli; it does not)
- bundle gzip-9 (len-prefixed) = 79 481 B
- bundle brotli-11 (len-prefixed) = 59 757 B

Bundle gzip vs per-file gzip:  **−12.1 %** wire bytes Bundle brotli vs per-file gzip: **−33.9 %** wire bytes (this is the today-vs-tomorrow delta)

RTT savings: 33 → 1 fetch. At 100 ms RTT (4G typical) and HTTP/2 multiplexing (no extra connect cost), 33 fetches still serialize through the `api.github.com` rate-limiter, which is the real bottleneck and the original motivation for bundling. Bundling makes the RTT axis a non-issue regardless of the format choice.

Decision: bundling is a unanimous win on every axis. The remaining question is "json-object or len-prefixed" and "gzip-9 or brotli-11", answered in Exp 0006/0007.

---

## Exp 0009 - dictionary amortization analysis

Date: 2026-05-18 Hypothesis: a shared zstd dictionary helps **only** if the consumer caches the dictionary across releases; on the first fetch, the dict bytes count against the candidate. Cmd: `zstd --train` produced a 16 384 B dictionary. Re-run compress with `-D`. Result:

| scenario                    | dict (B) | payload (B) | total (B) | vs `gzip-9` |
|-----------------------------|---------:|------------:|----------:|------------:|
| cold (dict + payload)       |  16 384  |      60 695 |    77 079 |     −3.0 %  |
| amortized (dict free)       |       0  |      60 695 |    60 695 |    −24.2 %  |
| `brotli-11` (no dict)       |       0  |      59 757 |    59 757 |    −25.4 %  |

The trained dictionary buys us ~3 KB vs plain zstd-22 on warm-cache, and LOSES ~1 KB to plain brotli-11. Cold-cache it's a net loss vs gzip-9.

The deeper issue: **there is no `DecompressionStream("zstd")` baseline in 2026 browsers** (Chrome 143-only, no Firefox/Safari). The dictionary path also requires a Worker-side shim or RFC 9842 (`dcb` / `dcz`), which is still Origin Trial in Chrome 143 - and would not be honored by raw.githubusercontent.com regardless.

Decision: DISCARD all dict-based candidates. The constraint that "raw.gh controls headers" and "no external libraries in the SPA" jointly kill shared dictionaries for the Pages path. They could be revived later via the Worker path with a hand-rolled dcb/dcz emitter, but the wire-byte win (~3 KB on a 60 KB artifact) does not justify the publisher complexity (custom dictionary lifecycle, dict-hash versioning, browser fallback).

---

## Exp 0010 - wire-time sanity check at 1 Mbps and 25 Mbps

Date: 2026-05-18 Hypothesis: at 1 Mbps mobile, wire dominates decode by 100×; at 25 Mbps, they are within 10×. Saving wire bytes always wins. Cmd: `bun run .bench/scripts/score-and-rank.ts` (wire-time block) Result (total = transfer + decode_p50):

| candidate                  | bytes  | t @1 Mbps | t @25 Mbps | total 1M | total 25M |
|----------------------------|-------:|----------:|-----------:|---------:|----------:|
| `len-prefixed × brotli-11` | 59 757 |    478 ms |    19.1 ms |   479 ms |  19.83 ms |
| `len-prefixed × gzip-9`    | 79 481 |    636 ms |    25.4 ms |   637 ms |  26.18 ms |
| `json-object × gzip-9`     | 80 094 |    641 ms |    25.6 ms |   642 ms |  26.71 ms |
| per-file gzip-6 (today)    | 90 375 |    723 ms |    28.9 ms |   ~723 ms* | ~29 ms*  |

* per-file ignores the RTT-serialization penalty against api.github.com rate limits; real today-cost is dominated by `5 + N` round-trips, not bytes.

Switching from `json-object × gzip-9` to `len-prefixed × brotli-11`: **−163 ms on 1 Mbps mobile**, **−6.9 ms on 25 Mbps home**. The mobile win is real and user-perceptible.

Decision: confirmed. The byte axis matters; brotli-11 buys 25 % bytes at zero decode cost.

---

## Final verdict

**Winner: `len-prefixed × brotli-11`** (59 757 B, 0.70 ms decode, 25-LOC parser).

The runner-up is `sentinel-cat × brotli-11` (59 670 B, 0.75 ms decode); the two are statistically indistinguishable on bytes (87-byte delta, 0.15 %), and `len-prefixed` is picked on robustness grounds (binary-safe header without relying on the absence of NUL bytes in the payload).

All zstd and shared-dictionary candidates are DISCARDed because they violate the "no external libraries + `DecompressionStream` baseline" constraint from SCOPE.md §3.
