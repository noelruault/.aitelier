---
name: comment-doctrine
description: The operative rule set for code comments — explain WHY, never WHAT — injected at session start and applied by the comments-why sweep.
---

# Comment doctrine

Only the block between the operative markers below is injected into a live session; everything after it is reference for humans and for a `comments-why`-style sweep.

<!-- COMMENTS:OPERATIVE:START -->
COMMENT DOCTRINE ACTIVE. Comments explain WHY, never WHAT. Verbose commenting is a defect, not thoroughness.

- Comments are a code smell by default, so default to zero. The code already says what it does; a comment earns its place only by saying why: the constraint, the tradeoff, the invariant, the bug it prevents, the reason a non-obvious choice is the right one.
- Every edit reviews the comments in the code it touches: still necessary, still accurate, still describing this code? Fix or delete the ones that fail in the same change; a stale comment shipped beside fresh code is a defect of that change.
- Never restate the code. `// increment counter`, `// Foo does foo with bar`, and step-by-step tours of the next lines are noise. Delete them.
- Fix readability in the code, not in prose beside it: meaningful names (`yearCounter`, not `i`), straight control flow, small functions. A comment is neither a patch nor an apology for unclear code; if the code can be made clear enough to drop the comment, improve the code and drop it.
- Keep it short. One sentence per line, no hard-wrapping to a column. If the rationale needs a paragraph, the design is wrong or it belongs in the commit message, a doc, or an ADR.
- A doc comment on a declaration STARTS with the identifier it documents (`// VersionOf returns ...`, Go's convention, and the equivalent in every doc-generating ecosystem). Leading with the name is not permission to restate the signature: name it, then say what a caller could get wrong. A doc comment that opens mid-thought reads as a contradiction of the convention and breaks generated docs.
- Every comment stands alone. Never "same as above", "likewise", "ditto", "see previous", or a rewrite that only makes sense next to its neighbour: the next edit inserts a declaration between them and the reference silently points at the wrong thing.
- Never put history in a comment: no author, no date, no changelog, no "modified by X". Git stores that accurately; comment history rots and nothing enforces it.
- Do not comment out code. Delete it, git has it.
- Keep only what the code cannot say: a non-obvious business rule or invariant, an external limitation or non-obvious SDK/platform behaviour, an intentional trade-off or rejected alternative, a decision forced by priorities, operations, security, or history that still shapes the code, contract semantics a caller branches on, subtle ordering or preconditions, and a named ceiling on a deliberate shortcut.
- A kept comment is a decision record: state the constraint and what breaks if the shape is "simplified", clearly enough that the next developer or coding agent does not refactor the oddity away without knowing it was intentional.
- A comment is never evidence that the code is correct. It states intent; the implementation and its tests decide behaviour. When they disagree, investigate the code first and treat the comment as stale until proven otherwise. Do not lower your uncertainty about unverified code because its comment sounds authoritative.
- The test before writing one: would removing this let a future reader make an assumption that breaks the code? No → do not write it. Same test when reviewing: a 4-line comment cut to 1 line, or to none, is an improvement whenever the warning survives.
<!-- COMMENTS:OPERATIVE:END -->

## The canonical example

```js
(cachedResult, timestamp) = getAccountStatusFromCache();
if ((now() - timestamp).inMinutes() < 1)
  return cachedResult;
else
  return fetchAccountStatusFromServer();
```

Bad, restates code that is already clear:

```js
// Get the account status from the cache, and return that if it's
// less than a minute old, otherwise fetch from the server.
```

Good, gives the reason the code cannot give:

```js
// Cached because this is called on every request and hitting the account
// service that often gets us rate-limited.
```

## Why history belongs in the SCM, not the source

Author and date tags duplicate what source control already records, less reliably: nothing enforces that a comment stays true, so the tag rots while `git blame`/`git log` stays exact. "Who wrote this" and "when did this change" are one command away. Code that survived 15 years untouched is evidence of stability, not a reason to fear it; the fear argument for date stamps is an argument for reading the history properly.

## References

- <https://blog.codinghorror.com/code-tells-you-how-comments-tell-you-why/>
- <https://softwareengineering.stackexchange.com/questions/1/comments-are-a-code-smell>

## Related

- A `/comments-why`-style sweep applies this doctrine on demand over existing code, any language, scoped to a PR, a git range, paths, or the uncommitted diff. Edits comments only; a comment that contradicts its code, or that apologises for unclear code, comes back as a finding for a human instead of a silent edit.
