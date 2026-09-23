# Bench scope - Aitelier library bundle wire format

## Problem statement

We will publish a single "bundle" artifact per release in each `.aitelier`-shaped GitHub fork. The browser today does `5 + N` HTTP round-trips against the GitHub APIs to walk a fork; the bundle replaces that with **one** raw fetch.

The decision to bundle is made. The open question is **what wire format and codec** to use. This bench answers that with measurements, not opinions.

## Fixed metric (do not change mid-session)

```
score = wire_bytes
      + 0.05 · compress_ms_p50    (publisher pays once, cached forever)
      + 0.50 · decode_ms_p50      (browser pays once per visit; dominates UX)
```

Rationale per `compression-engineer.md` §4.1: `α = 0.05`, `β = 0.5`. Encode is amortized across visits via the release artifact in the fork repo; decode is paid by every cold visit.

**Auxiliary metric** for the wire-time sanity check:

```
total_latency_4g_ms  = decode_ms_p50 + (wire_bytes / (1_000_000 / 8))   # 1 Mbps
total_latency_home_ms = decode_ms_p50 + (wire_bytes / (25_000_000 / 8)) # 25 Mbps
```

These are reported alongside the primary score in `REPORT.md` so the reader can sanity-check that "saved 10 KB at +50 ms decode" is the wrong trade on home wifi.

## Bench budget

- 30 s wall-clock per (container × codec) candidate for decode timing
- 9 runs per candidate (5 minimum required, target 9 for better bootstrap CI), bootstrap-CI with 10 000 resamples
- Compress timing is captured but not gated (it is publisher cost, not user cost)

## Corpus

Real corpus in this repo:

- 33 files, 222 569 bytes uncompressed
- 17 markdown files (entity bodies + READMEs), bulk of bytes
- 15 JSON sidecars (`aitelier.json` per entity, `hook.json` for hooks)
- 1 shell script (`skills/dummy-skill/scripts/hello.sh`)

Skew: the three largest markdown files (`compression-engineer.md` 70.9 KB, `go-performance.md` 56.1 KB, `go-hot-pot-jo.md` 32.4 KB) hold 71 % of the bytes. The remaining 30 files are tiny (most < 1 KB).

Implication: a shared dictionary trained on this corpus will be **dominated by markdown vocabulary** even if we deliberately oversample the JSON sidecars. The bench reports the dict-trained variant honestly: amortized (dict cached for a year) and cold (dict + bundle both shipped).

Allowlist matches `scripts/build-manifest.ts`: `.md, .sh, .py, .js, .ts, .json, .yaml, .yml, .txt, .toml`.

## Candidates

### Containers
| id                | description                                                |
|-------------------|------------------------------------------------------------|
| `json-object`     | `{ "path/foo.md": "raw text", … }` (current proposal)      |
| `ndjson`          | one `{"path":"…","body":"…"}` per line                     |
| `sentinel-cat`    | `\0path\0length\0body…` repeating (NUL-delimited)          |
| `len-prefixed`    | `[path_len u16 LE][path utf8][body_len u32 LE][body bytes]`|
| `tar`             | POSIX/ustar tar archive (512-byte headers)                 |

CBOR is dropped: it requires a non-trivial decoder (≈500 LOC for the subset we'd need); the constraint says "no external libraries" and we will not maintain a CBOR parser in the SPA.

### Codecs
| id                  | description                                                  |
|---------------------|--------------------------------------------------------------|
| `identity`          | no compression (baseline + control)                          |
| `gzip-9`            | `gzip -9` - what raw.githubusercontent.com serves today      |
| `brotli-11`         | `brotli -q 11` - best static codec; `DecompressionStream`    |
| `zstd-22`           | `zstd --ultra -22` - for completeness; **no browser decoder**|
| `zstd-22-dict`      | `zstd --ultra -22 -D dict` - trained dict; **no browser dec**|
| `brotli-11-shared`  | `brotli -q 11 -D dict` - RFC 9842 dcb framing                |

Note: `DecompressionStream` does NOT support zstd as of 2026. Zstd is benched anyway because the user asked "why not zstd?"; the report calls out the gap explicitly. Brotli's CLI does not support `-D` for raw shared dictionaries the same way zstd does - RFC 9842 `dcb` framing is a Worker- emitted prepend on top of a brotli-compressed body, not a CLI mode. The bench treats the brotli-shared-dict variant as an end-to-end measurement (prepend hash, decompress with the dict pre-fed into the brotli decoder).

### Special experiments
| id                  | description                                                  |
|---------------------|--------------------------------------------------------------|
| `per-file-parallel` | 33 parallel HTTP/2 fetches with gzip-on-wire (today's path)  |
| `dict-amortized`    | `zstd --ultra -22 -D dict` ratio assuming dict is free       |
| `dict-cold`         | `zstd --ultra -22 -D dict` ratio counting dict + payload     |

## Delivery constraints (the operating environment)

1. **raw.githubusercontent.com** decides `Content-Encoding`; we do not.
   - Confirmed empirically: raw.gh responds with `Content-Encoding: gzip` when the client sends `Accept-Encoding: gzip`. We cannot force `br` or `zstd` on the wire for the Pages path.
   - **Implication**: if our committed artifact is already `*.br`, raw.gh serves the bytes verbatim (no double-encode), and `Content-Encoding` is absent. The browser sees the raw brotli bytes and must decode them in user-space via `DecompressionStream`.
2. **Cloudflare Worker** path can set any header but stores whatever raw.gh served. KV cache stores the body the Worker downloaded.
3. **Browser-side decompression** restricted to `DecompressionStream` + native `JSON.parse` + `TextDecoder`. No external libraries.
4. **Browser support floor**: evergreen 2026. Brotli in `DecompressionStream` is baseline since Chrome 122 / Firefox 122 / Safari 17.5 (Q1 2024). Zstd in `DecompressionStream` is **NOT** baseline yet (Chrome 143 only, no Firefox, no Safari as of 2026-05).
5. Publisher tooling: Bun + native CLIs. Output is committed to the fork repo.

## Exclusions / non-goals

- We are not benchmarking incremental update / dictionary-against-prior- release. That is a Phase B optimization.
- We are not benchmarking client-side caching strategy. The bundle is versioned by repo SHA; cache hit-rate is 100 % within a release.
- We are not benchmarking the Worker KV cache. KV reads are sub-ms and not on the critical path for the format choice.
- Security review (BREACH/CRIME) is N/A: this is static, public, non- reflective content; no secrets, no per-user variation.

## Verdict rule

A candidate is **kept** iff bootstrap 95 % CI of `score(candidate) - score(json-object × gzip-9)` is strictly negative on the wire-bytes axis AND decode does not blow the budget (decode_ms_p95 < 50 ms, an arbitrary "feels instant" floor for cold-start UX).

The baseline is `json-object × gzip-9` because that is the proposal we are testing against. Any winner must beat it on the metric with non-overlapping CIs.
