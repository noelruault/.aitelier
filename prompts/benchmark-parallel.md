---
id: benchmark-parallel
title: Benchmark parallel
type: prompt
category: performance
tags: [benchmark, parallel-agents, worktree, multi-step]
summary: Step 1, profile + brainstorm. Step 2, spawn 3 parallel worktree agents, compare, pick winner.
multi_step: true
related: [benchmark-first, general-purpose, Plan]
---

## Step 1, Profile + brainstorm

STEP 1 of 2, PHASE: Profile + Brainstorm

ROLE: You are a senior performance engineer running a disciplined profiling
pass. You measure, then hypothesize. You do not implement in this step.

Before you start, interview me. Ask ONE focused question at a time:
1. Target: the exact file / function / endpoint / service that's
   underperforming (e.g. cmd/api/handler.go:SearchHotels).
2. Workload: RPS, payload, duration, concurrency to reproduce the slowness
   (e.g. 1000 RPS, 30s, 50 concurrent).
3. Metrics to capture: p50/p95/p99 latency, allocs/op, CPU%, RSS,
   throughput, anything else relevant.
4. Profiling tool: pprof, go test -bench, k6, wrk, py-spy, perf.
5. Minimum number of hypotheses to brainstorm (default: 5).
6. Public API stability: must it stay frozen?
7. Correctness suite that must continue to pass.
8. Anything explicitly out of scope.

When you have all answers, restate the brief in 3 lines so I can confirm.

Then execute:
- Profile the target under the agreed workload using the agreed tool.
- Save raw artifacts (profiles, flamegraphs, raw bench output) under
  ./perf/baseline/, plus a baseline/summary.md with headline numbers.
- Brainstorm at least N optimization hypotheses, ranked by estimated
  impact / implementation cost.
- Write ./perf/hypotheses.md with one row per hypothesis and columns:
id | hypothesis | mechanism | expected gain | risk | files touched | est LOC

Halt at: hypotheses.md written. Do NOT modify production code yet. Wait
for my review and my selection of which 3 hypotheses to take into Step 2.

Conventions:
- All artifacts under ./perf/.
- Respect the "out of scope" list strictly.
- If a profiling step would mutate production data, stop and ask first.

## Step 2, Parallel agents on worktrees

STEP 2 of 2, PHASE: Parallel Implementation + Benchmark

ROLE: You are the orchestrator of 3 parallel performance experiments. Each
selected hypothesis from Step 1 gets its own isolated git worktree and its
own subagent. Results must be directly comparable. You do NOT implement
the hypotheses yourself; the subagents do.

Before you start, interview me. Ask ONE focused question at a time:
1. The 3 hypothesis IDs to take into Step 2 (from ./perf/hypotheses.md).
2. Subagent type per agent (general-purpose / Plan / Explore).
3. Model per agent (inherit / opus / sonnet / haiku).
4. Exact benchmark command, reproducible, IDENTICAL for every agent
   (e.g. go test -bench=BenchmarkX -benchmem -count=10 ./...).
5. Correctness gate every variant must pass (e.g. go test ./... -race).
6. Winner rule (e.g. "largest p95 improvement with tests green and
   LOC < 200, else flag none").

When you have all answers, restate the brief in 3 lines so I can confirm
before any agent is spawned.

Then execute, in a SINGLE message:
- Spawn 3 parallel Agent calls (one per hypothesis). Each agent uses:
* subagent_type: <as agreed>
* isolation: "worktree"
* model: <as agreed>
- Identical prompt template per agent. Each agent receives:
* Hypothesis ID + full text from ./perf/hypotheses.md
* Target files from the hypothesis row
* Baseline numbers copied from ./perf/baseline/summary.md
* The exact benchmark command
* The correctness gate
* Required return payload (markdown), each section labelled:
    - SENT: echo of the brief you (orchestrator) sent
    - DID: commit list + diff summary (files, +/- LOC)
    - BENCH: new numbers (same metrics as baseline)
    - DELTA: vs baseline (absolute + %)
    - TRADEOFFS: risks introduced, edge cases changed
    - WORKTREE: absolute path
    - GATE: pass / fail on the correctness gate

- Record per-agent payloads under ./perf/agents/<HID>/return.md.
- After all agents return, write ./perf/results.md with one row per
  hypothesis:
HID | SENT (one line) | DID (one line) | Δlatency | Δalloc | Δthroughput | LOC | risk | tests pass

- Recommend a winner using the agreed winner rule, plus a one-paragraph
  rationale comparing the three so I can decide.

Halt at: results.md written + winner recommended. Do NOT merge any
worktree, do NOT push, do NOT delete any worktree. Wait for my approval.

Conventions:
- All artifacts under ./perf/ (per-agent payloads under ./perf/agents/<HID>/).
- Worktrees stay isolated until I approve a merge.
- Never touch production data or external services from inside a benchmark.
