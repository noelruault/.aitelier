A PreToolUse hook that intercepts every Bash invocation and, when the
command line contains a `kubectl` verb that mutates cluster state, asks
the user to confirm before the call goes through.

Verbs that trigger the prompt:

```
apply  create  delete  patch  scale  edit  replace
label  annotate  rollout  cordon  uncordon  drain
taint  expose  set  autoscale
```

Read-only verbs (`get`, `describe`, `logs`, `top`, `explain`, `wait`,
`auth can-i`, ...) pass through silently.

## How the prompt works

The hook emits a `permissionDecision: "ask"` response, which is the
documented way for a Claude Code hook to delegate a yes/no decision to
the user. Claude Code shows the standard permission prompt with the
reason string from the hook; the user picks allow or deny.

## Why

`kubectl apply -f everything.yaml` against the wrong context will
happily rewrite production. The hook makes that one extra confirmation
the default for every mutating verb. Read paths stay frictionless.

## Tuning

If your daily workflow includes a verb you do not want to confirm (for
example `label` on namespaces you own), drop it from the regex in
`hook.json`. The hook is intentionally on the noisy side - extra
prompts beat silent disasters.
