A PreToolUse hook that intercepts every Bash invocation and asks the user to confirm before any `rm` command running with both recursive **and** force flags actually executes.

The classic accident is `rm -rf "$DIR"` where `$DIR` is empty or expands to `/`. This hook catches the pattern before the shell does.

Triggers on any combination of:

```
rm -rf    rm -fr    rm -Rf    rm -fR
rm -rvf   rm -rfv   ... (any -[a-z]*r[a-z]*f variant)
```

Reads (`rm` alone, `rm <file>`, `rm -f <file>`) pass through silently. Only the recursive+force combination is intercepted.

Drop into `~/.claude/settings.json` via the Copy snippet button on the deep-dive.
