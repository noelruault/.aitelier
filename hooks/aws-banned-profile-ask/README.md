A PreToolUse hook that intercepts every Bash invocation and, when the
command line targets a high-blast-radius AWS profile, asks the user to
confirm before the call goes through.

Profiles that trigger the prompt:

```
admin    stage    staging    prod    production
```

Detection covers both common ways the profile gets selected:

- The `--profile <name>` flag on any `aws` subcommand
- The `AWS_PROFILE=<name>` environment-variable prefix

Other profiles (`dev`, `sandbox`, `personal`, ...) pass through with no
prompt.

## How the prompt works

The hook emits a `permissionDecision: "ask"` response, the documented
way for a Claude Code hook to defer to the user. Claude Code shows the
standard permission prompt with the reason string; the user picks allow
or deny.

This is a soft block: the user can still proceed by allowing the
prompt, which is intentional. A truly unconditional ban can be
configured by changing `permissionDecision` to `"deny"` in
`hook.json` - Claude Code will then refuse the call without offering
the override.

## Why

`aws iam` against the wrong profile can hand out or revoke real
permissions; `aws s3 rm` against a prod bucket is unrecoverable; even
a read-only command run with admin credentials shows up in audit
trails in a way that makes incident review noisier. Forcing a confirm
on the named-and-known-risky profiles makes "wrong profile" a
deliberate choice rather than an accident.

## Tuning

If your team uses different names for the same idea (`master`, `live`,
`infra-prod`, ...), add them to the alternation in `hook.json`. The
hook is meant to err on the side of asking too often.
