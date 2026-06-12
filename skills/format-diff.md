---
name: format-diff
description: Reformat a pasted unified diff into a side-by-side or annotated view, mark what changed semantically, and call out anything that looks unintentional.
---

The user pastes a unified diff (typically from `git diff`, `gh pr diff`, or a code-review tool). Your job is to make it readable and surface what matters.

## What to do

1. **Re-render in side-by-side form** when the diff fits in <120 columns: left = before, right = after, one row per changed line, blanks aligned. If too wide, fall back to compact unified format with semantic annotations (see step 3).
2. **Group by file**, headed with the path. Skip files with only whitespace or import-order churn unless the user asks otherwise.
3. **Annotate semantically.** Below each hunk, write one line saying what changed (e.g. "extracted helper", "swapped strict equality for loose", "added null guard"). Not what the lines say, what the change *does*.
4. **Flag suspicious moves.** Anything that looks like an accidental revert, an unrelated edit slipped in, a TODO removed without addressing it, a swallowed exception, a logging or debug statement left behind. One line each, prefixed with `⚠`.

## What not to do

- Don't re-explain syntax the user obviously already knows.
- Don't comment on style unless something is clearly wrong (e.g., indentation inconsistent within the same function).
- Don't make moral judgments about choices. Stick to factual observations.

## Output shape

```
<path/to/file>
  before  │  after
  ────────┼────────
  …       │  …
  Change: <one line semantic summary>
  ⚠ <flag, if any>

<next file>
  …
```

If the diff is genuinely trivial (a typo fix, a version bump), say so in one line and stop.
