# Bundle work - follow-ups and next experiments

This file is the capsule of what we built, what we measured, and what is worth trying next. Keep it next to `REPORT.md` (the original investigation) and `live-results.jsonl` (the running bench history). When somebody else picks this up, they should be able to read this file and pick up where we left off.

## What is already in place

- `scripts/build-bundle.ts` - publisher script. Walks `prompts/`, `skills/`, `agents/`, `hooks/`, packs every file into a length-prefixed binary, runs `brotli -q 11`, writes `_bundle.br` at repo root.
- `src/lib/bundle.js` - browser-side decoder. About 25 lines. Uses native `DecompressionStream("brotli")`; no external library.
- `src/data/transport-direct.js` and `src/data/transport-worker.js` - both transports now try the bundle first, then fall back to a single recursive git-trees call, then per-file blobs.
- `worker/src/transport-github.ts` and `worker/src/index.ts` - Worker route `/api/external/:o/:r/bundle/:sha` proxies the raw bundle and caches it in KV.
- `tests/external-perf.test.js` - synthetic test that gates the optimisation: asserts the bundle path uses two network calls and is at least 30% faster than the fallback path at uniform 10 ms RTT.
- `scripts/bench-external.ts` - live bench against a real fork. Accepts `--slug`, `--label`, `--iters`, `--history-only`. Appends results to `live-results.jsonl`.

## What we measured (so far)

On the small `noelruault/.aitelier` fork (8 visible entities, 33 underlying files, ~220 KB raw text):

| label                       | requests | total p50 |
|-----------------------------|---------:|----------:|
| baseline (before changes)   |       14 |  ~1100 ms |
| after skip-default-branch   |       13 |   ~894 ms |
| after recursive trees       |       10 |   ~947 ms |
| tree-fallback with bundle probe (no bundle) | 11 | ~124 ms warm |
| **bundle-hit (live)**       |    **2** | **~143 ms warm**, ~830 ms cold |

This is one fork. It is not enough data to generalise. The point of this file is to enumerate what to test next.

## Limits of the current numbers

Things you should not over-interpret:

- **Corpus is small.** Three markdown files account for ~72% of the bytes. A fork with very different shape (many small files, lots of JSON sidecars, binary payloads) may compress differently.
- **One client, one network.** Bench runs from a single laptop on one connection. No mobile, no slow link, no different geographies. Real users vary wildly.
- **Bun ≈ V8, not exact.** Decode timings come from Bun. Chrome and Safari will be in the same ballpark but not identical.
- **No CDN warm-up modelled.** Cold load includes TLS to api.github.com and raw.githubusercontent.com. Real cold loads have other variables (DNS, ISP routing).
- **Cache effects between iterations.** Iter 1 is the only real "cold" data point per run; iter 2 onward enjoys HTTP/2 connection reuse. The script does not currently force a clean process per iteration.

If you change something and want to claim it is faster, re-run the bench against the same fork, capture both labels, and look at the deltas - not the absolute numbers.

## Things worth trying next

Ordered by rough effort × expected payoff. Each item has a hypothesis, a way to test it, and what could go wrong.

### 1. Skip the head call on warm revisits

**What.** Today we still hit `api.github.com/.../commits` once per fork load to learn the latest commit sha. That single round-trip dominates the warm-load timing (about 40 ms in our bench).

**Hypothesis.** If the browser already saw this fork in the last few minutes, we can serve it from `localStorage`'s `aitelier-fork-cache-v1` without going to GitHub at all - fall back to a background refresh that updates the cached sha for next time.

**How to test.** Add a "warm revisit" mode to the bench (call `loadEntities` once, sleep 1 ms, call again, time only the second). Compare with and without the cache short-circuit.

**Risk.** A user who just pushed a new entity opens their own dashboard and sees yesterday's snapshot. Mitigation: refresh in the background and swap the entity list when the new sha differs. The pattern is already used elsewhere in the SPA (see `fork-staleness.js`).

**Expected payoff.** Warm load goes from ~140 ms to ~30 ms (parse + render only).

### 2. Re-bench against bigger and stranger corpora

**What.** Our numbers come from one small text-heavy library. Find out where the bundle path stops helping.

**Hypothesis.** As entity count grows, the bundle path stays at two round-trips while the fallback path grows linearly. The relative win should increase, not decrease.

**How to test.** Generate a synthetic fork with N entities (10, 100, 1000). Run the bench against each. Plot total time vs N for both paths.

**Risk.** Hitting GitHub's `truncated:true` on the recursive trees endpoint (only at >100k entries - unlikely). Hitting brotli's quality-11 publish time becoming unpleasant for huge libraries (already 2–3 seconds at our scale).

**Expected payoff.** Confidence that the optimisation scales, and concrete numbers for the README to replace "small library only" caveats.

### 3. Try Brotli quality 9 instead of 11

**What.** `brotli -q 11` is the highest setting. The publisher cost is small for our corpus, but it grows with `O(input × dictionary_search)`. On a big library it could become annoying.

**Hypothesis.** `-q 9` is much faster to compress and yields almost the same output size on text (typically within 1–2%).

**How to test.** Rebuild the same `_bundle.br` at `-q 9`, `-q 10`, `-q 11`. Compare file size and publish time. Decompression time is independent of the encode quality - only output size matters.

**Risk.** None real. Worst case the file is a few hundred bytes bigger.

**Expected payoff.** Faster publisher pipelines on large forks. Possibly a faster CI step.

### 4. Streaming decode

**What.** The current decoder reads the entire decompressed buffer into memory, then parses frames. Fine for ~200 KB. Less fine if a library ever ships 10 MB.

**Hypothesis.** A `TransformStream` parser that yields `{ path, body }` as soon as the frame headers and body are in hand would let the dashboard render the first entity card before the bundle finishes downloading.

**How to test.** Write a streaming version in `src/lib/bundle.js`. Decode a synthetic 10 MB bundle and measure "time to first entity available" vs the buffer-then-parse approach.

**Risk.** Browser support for `TransformStream` is universal but the code is fiddlier than the current ~25-line version. Bug surface increases.

**Expected payoff.** Above a few MB this matters; below that it does not.

### 5. Switch codec to Zstd when browser support hits

**What.** Zstd compresses text 5–15% better than Brotli at comparable speed. `DecompressionStream("zstd")` is currently Chrome-only (Chrome 143+) and not in Firefox or Safari as of 2026-05.

**Hypothesis.** When all three browsers ship zstd in `DecompressionStream`, swapping the codec is a two-line change in `build-bundle.ts` plus updating `bundle.js` to detect the format.

**How to test.** Check the four engine release notes once a quarter. When ready, rebench against the same corpus and the bigger synthetic ones from item 2.

**Risk.** Browser baseline. Until all three ship it, going zstd-only is a regression. A hybrid (serve both files, pick best supported) is possible but doubles publisher work.

**Expected payoff.** 5–15% smaller bundle, no decode-cost increase.

### 6. Shared dictionaries

**What.** Train a brotli or zstd dictionary on a representative corpus of catalogs, ship the dictionary once (cacheable for a year), then per-release ship only the delta against the dictionary.

**Hypothesis.** Works well at scale. Earlier investigation showed it loses to plain brotli-11 at our current 60 KB scale because the dictionary itself is a similar size. Worth revisiting once forks regularly cross a few hundred KB.

**How to test.** `zstd --train` against a folder of N catalogs, then compress one fork with and without the dictionary. Compare ratio when the dictionary is counted (cold cache) and when it is amortised (warm cache).

**Risk.** `raw.githubusercontent.com` does not serve `Use-As-Dictionary` headers. Without a Worker in front to handle dictionary negotiation, this is Worker-only.

**Expected payoff.** 10–25% smaller per-release artifact, but only after you have shipped the dictionary at least once. Pure overhead for one-shot visitors.

### 7. Worker prefetch on probe

**What.** When a visitor hits the External pill on a Worker-hosted instance, the first thing the SPA does is call `/api/external/ping`. The Worker could opportunistically warm its KV with the user's last few visited forks while the SPA is still booting.

**Hypothesis.** Reduces the "first click on fork" delay because KV is already populated.

**How to test.** Add a `recent_forks` cookie or `sessionStorage` value the SPA sends with the ping. Worker reads it, kicks off background fetches with `ctx.waitUntil`. Measure time-from-ping to first-entity-rendered.

**Risk.** Privacy - sending a list of forks the user has browsed in a header. Mitigation: only send for forks the user has explicitly bookmarked.

**Expected payoff.** Felt smoothness on repeat visits. Hard to put a number on without instrumenting real users.

### 8. Make `_bundle.br` rebuild automatic on push

**What.** Today you have to remember to run `bun run scripts/build-bundle.ts` before `git push`. A stale bundle does not break anything (consumer falls back to tree) but it means slow loads.

**Hypothesis.** A pre-push git hook or a GitHub Action that rebuilds and commits `_bundle.br` on every change to `prompts/`, `skills/`, `agents/`, or `hooks/` keeps it fresh without thinking.

**How to test.** Add the hook, change an entity, push, confirm the new `_bundle.br` blob sha matches the entity content.

**Risk.** Commit churn if every entity change generates a bundle commit. Mitigation: amend the commit that touched the entity rather than create a new one.

**Expected payoff.** Fewer stale bundles in the wild.

## How to re-run the bench

Local file with current numbers:

```bash
# show the table
bun run scripts/bench-external.ts --history-only true

# add a new row (real network)
bun run scripts/bench-external.ts --slug <fork> --iters 3 --label "<descriptive-name>"
```

A row is appended to `.bench/live-results.jsonl`. Labels do not need to be unique - re-running the same label is the normal way to see whether a change moved the number.

To compare two branches, run the bench on each, label them clearly (`pre-X`, `post-X`), and look at the deltas.

## When to revisit this work

Trigger points where it is worth re-opening the investigation:

- **A real fork crosses 500 KB raw** (10× the corpus we measured). The size-vs-time curves may bend differently.
- **A new compression codec hits browser baseline** (zstd in all three browsers; or whatever comes after).
- **A user complains about a slow load** on a specific fork. Run the bench against that fork before assuming the problem is on our side.
- **GitHub changes the rate limit or adds authenticated public access.** The "60 per hour per IP" constraint is the main reason we batched into a bundle; if it goes away, the calculus shifts.
- **The Worker starts hosting many small forks** and KV writes become the bottleneck. Bundle-as-a-KV-blob may need a different storage layer (R2).

## Related files

- `.bench/REPORT.md` - the original investigation that picked the wire format
- `.bench/SCOPE.md` - the metric and budget the original investigation used
- `.bench/EXPERIMENTS.md` - append-only log of every experiment from the original investigation
- `.bench/live-results.jsonl` - bench history, one JSON line per run
- `README.md` - the user-facing description of what `_bundle.br` is and how to publish one
- [noelruault/research - compression-engineer](https://github.com/noelruault/research/tree/main/.ai/agents/compression#compression-engineer) - the reusable benchmarking agent used to produce the original report
