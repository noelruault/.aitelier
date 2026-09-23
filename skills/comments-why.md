---
name: comments-why
description: >-
  Sweep comments in files, diffs, commits, or PRs down to load-bearing decision records (constraints, invariants, tradeoffs, breakage warnings) and flag comments that contradict the code they describe. Use proactively for narration-heavy diffs or for /comments-why, "clean up the comments", "these comments are useless/verbose", "comment sweep", "why not what", "de-comment this", "too many comments in this PR", "this comment is stale/wrong", or "the comment says X but the code does Y".
---

# comments-why

Comments are a code smell by default. A comment earns its place only by preserving something the code cannot say: why it is shaped this way, never what it does. This sweep deletes the ones that fail that test, rewrites the survivors into decision records, and flags the ones that disagree with the code.

## Doctrine

Comments explain WHY, never WHAT. Two rules govern every decision in this sweep:

- **Necessary:** would removing the comment let a future developer or coding agent make a wrong assumption, or "simplify" away a deliberate shape? No means delete it.
- **Not evidence:** a comment is never proof that the code is correct. It states intent; the code and its tests decide behaviour. Read the code before you judge the comment, and never keep a warning you have not checked is still true.

## Verdicts

Every contiguous comment block gets exactly one verdict.

### KEEP

Information the code cannot reasonably express itself:

- A non-obvious business rule or invariant, where removal silently breaks correctness.
- An external limitation, compatibility constraint, or non-obvious SDK, stdlib, or platform behaviour the code works around.
- An intentional trade-off or a rejected alternative, so nobody re-proposes it.
- A decision forced by priorities, operational constraints, security requirements, or history that still shapes the implementation (the reason, never a changelog).
- Contract semantics a caller branches on: sentinel error meaning, nil behaviour, empty-vs-absent.
- Subtle preconditions, ordering, or timing.
- A named ceiling on a deliberate shortcut and what would lift it, as a plain sentence with no tool or persona tag.
- Strings that are user-facing output, not commentary: metrics `Help:` text, CLI help, error messages, i18n strings. Do not touch these.

A KEEP is a decision record. It must be clear enough that a future developer or agent does not "simplify", refactor, or remove the behaviour without first learning the constraint is intentional. Verify the claim against the code before keeping it; a KEEP that no longer holds is STALE.

### REWRITE

Keep the information, change the words:

- A KEEP longer than one sentence: cut it to one line that names the constraint and what breaks without it.
- A KEEP that explains what and buries why: drop the what, keep the why.
- A doc comment attached to a declaration that restates the signature. The fix is `<Name> <what a caller could get wrong>`, never deleting the name. Go requires the comment to start with the identifier, and every doc-generating ecosystem has the same rule; a doc comment opening mid-thought reads as a contradiction of the convention and renders wrong in generated docs.
- A comment prefixed with a persona, tool, or mode tag (`ponytail:`, `craftsman:`, `caveman:`, `claude:`, `ai:`, anything naming who or what wrote it): strip the tag, keep the sentence. `TODO`, `FIXME`, `NOTE`, `XXX`, `HACK` and `SAFETY` stay; editors and linters index them.

### STALE

The comment and the code disagree: the comment claims X, the code does Y. Trust neither side. Read the code, its callers, and its tests; run the test when it is cheap. Then:

- **Code is right, comment rotted:** REWRITE it to what the code actually guarantees, or DROP it if nothing worth saying is left.
- **Comment states the intended invariant, code violates it:** that is a bug, not a comment problem. Leave both untouched and report it under Findings with `file:line`, the claim, and the observed behaviour. Never edit the comment to match the buggy code; that launders the bug.
- **Cannot tell:** leave it, report it under Findings as unresolved, and say what would settle it.

### APOLOGY

The comment exists because the code is unclear: it translates a cryptic name, walks through tangled control flow, or explains a magic number. The doctrine's answer is to fix the code and delete the comment, and when you are editing that code for another reason, do exactly that. In this sweep the code stays put, because a bulk pass that also refactors is unreviewable and voids the guarantee that a build break means the sweep ate real code. Leave the comment and report it under Findings with the concrete change that would make it deletable: rename `n` to `retriesLeft`, extract the loop into `nextFreeSlot`, name the constant. Apply those changes only when the user asks.

### DROP

- Restatement of the code: what a line, function, or variable does, when the name already says it.
- Step-by-step narration of the next lines, and multi-sentence explanations of obvious control flow.
- Narration that a value was "captured", "computed", "passed", "returned".
- Docstrings on an unexported symbol that restate the name or signature and nothing else. If there is a contract worth stating, REWRITE instead.
- Comments that only make sense next to their neighbour: "same as above", "same, but ...", "likewise", "ditto", "see previous". A later edit inserts a declaration between them and the reference now describes something else. Tests are the worst offender; a new case gets dropped in the middle more often than anywhere else.
- Design rationale that already lives in a plan, ADR, schema doc, or commit message. Do not duplicate it into the source.
- Per-variable docstrings when the type name or an adjacent help string already explains.
- Test docstrings longer than one line; keep one line naming the invariant guarded.
- Author, date, changelog, and "modified by" tags. Git records this accurately and comment history rots.
- Commented-out code. Delete it; git has it.

Torn between KEEP and DROP? Keep it as one line and list it under "Kept on doubt" in the report. Deleting a warning whose loss nobody can see is the wrong default, and the user resolves doubts in one pass instead of being interrupted per comment.

## Examples

```go
// Loop over the items and sum the prices.
for _, it := range items { total += it.Price }
```
DROP: the code says it.

```go
// Cached because this runs on every request and the account service rate-limits us at that volume.
```
KEEP: removing the cache looks like a simplification until you know why it exists.

```go
// Retry 3 times.
const maxAttempts = 5
```
STALE: check callers and tests. If 5 is right, the comment goes; the name already says it. If 3 was the contract, report the bug and touch nothing.

```go
// n is the number of retries left before we give up.
n := cfg.Retries
```
APOLOGY: report "rename `n` to `retriesLeft`, then delete the comment".

```go
// Sorted before Compact on purpose: Compact only removes adjacent duplicates and the input is not guaranteed sorted.
sort.Strings(keys)
keys = slices.Compact(keys)
```
KEEP: swapping those two lines would pass review and break the function.

## Scope

Resolve `$ARGUMENTS` in this order:

| Argument | Scope |
| --- | --- |
| PR number or URL (`1234`, `https://github.com/org/repo/pull/1234`) | `gh pr diff <n> --name-only` |
| Git range (`main..HEAD`, `HEAD~3..`) | `git diff --name-only <range>` |
| File or directory paths | exactly those |
| empty | uncommitted: `git diff --name-only HEAD` plus untracked |

Exclude in every mode: prose docs (`.md`, `.rst`, `.txt`, `.adoc`), lockfiles, vendored and third-party trees (`vendor/`, `node_modules/`, `target/`, `dist/`, `bin/`, `obj/`), and any file carrying a "generated by" or "DO NOT EDIT" marker.

**Hunk restriction, load-bearing on a PR or range:** touch only comments inside the lines that scope actually changed. Sweeping whole files turns a review into an unreadable diff and puts unrelated churn under someone else's name. Get the changed line ranges from `git diff -U0 <range> -- <file>` and stay inside them. In uncommitted or explicit-path mode, the whole file is fair game.

## Process

1. Read each file in scope. Never edit a file you have not read.
2. For each contiguous comment block, read the code it describes first, then assign one verdict. Comment syntax by language: `//` (C-family, Go, Rust, TS/JS, C#, Java, Swift, Zig, Kotlin), `#` (shell, Python, Ruby, YAML, TOML, Terraform, Perl), `--` (SQL, Lua, Haskell), `/* */` (C-family, CSS), `<!-- -->` (HTML, XML, Vue, Svelte), `"""..."""` and `'''...'''` (Python docstrings), `///` and `//!` (Rust and C# doc comments).
3. Apply KEEP, REWRITE, and DROP as edits. STALE and APOLOGY produce Findings, not edits, except the STALE case where the code is verified right and only the comment rotted.
4. One sentence per line. Never hard-wrap to a column width; long single-sentence lines are correct.
5. Preserve shebangs, license and SPDX headers, build tags (`//go:build`), and linter or compiler directives (`nolint`, `eslint-disable`, `noqa`, `# type:`, `#pragma`, `@ts-ignore`, `#nullable`). These are machine-readable, not prose.

Doc comments on **exported public API** are a judgement call, not an automatic drop: a `///` that restates the signature goes, but one documenting a parameter contract, thrown exception, or nil behaviour stays. Where the ecosystem publishes generated docs (Rust `cargo doc`, C# XML docs, Go pkg.go.dev, Swift DocC), an exported symbol's doc comment is user-facing output. Treat it as KEEP unless it is pure restatement.

## Verify

Detect the project's own commands rather than assuming a language: `Makefile`, `justfile`, `package.json` scripts, `go.mod`, `Cargo.toml`, `pyproject.toml`, `*.csproj`, `build.gradle`, `*.xcodeproj`, `build.zig`.

1. Build (`make build`, `go build ./...`, `cargo check`, `bun run build`, `dotnet build`, `swift build`, whichever applies). Must succeed.
2. Test, if a test command exists and runs quickly. Must pass.
3. `git diff --stat`. Expect a net line reduction; if the count grew, something went wrong.

A comments-only sweep cannot change behaviour, so a build break means the sweep ate real code. Fix it before reporting.

If no build or test command can be identified, say so explicitly rather than claiming verification you did not perform.

## Report

Always this shape, so a reviewer can act on it without reading the diff:

- **Touched:** files edited, net lines dropped.
- **Kept:** each KEEP and REWRITE that survived, `file:line` and the one-line reason it is load-bearing.
- **Kept on doubt:** KEEP-or-DROP calls you could not settle, `file:line` each, for the user to decide in one pass.
- **Findings:** STALE bugs and unresolved contradictions first, then APOLOGY comments with the concrete code change that would delete each. `file:line`, the comment's claim, and what the code does or what the fix is. This section needs a human; put it last and never omit it when a STALE case exists.

## Constraints

- Do not touch files outside the scope, or lines outside the changed hunks in PR/range mode.
- Do not add new comments.
- Do not rewrite code. Comments only; code changes are Findings for the user to approve.
- Do not edit a comment to match code you have not verified, and never edit one to match code that looks wrong.
- Do not touch prose docs, plans, or schema files.
- Never push or commit unless asked. Leave the sweep in the working tree for review.
