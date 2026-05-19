A PreToolUse hook that intercepts every Bash invocation and, when the
command line mutates HashiCorp Vault state, asks the user to confirm
before the call goes through.

Subcommands that trigger the prompt:

```
write    delete    kv put / delete / destroy / metadata
policy write / delete    auth enable / disable / tune
secrets enable / disable / tune    lease revoke    token revoke
operator unseal / seal / generate-root / rotate / rekey
namespace create / delete
```

Read paths (`read`, `kv get`, `list`, `kv list`, `status`, `policy
read`, `policy list`, `token lookup`, ...) pass through silently.

## How the prompt works

The hook emits a `permissionDecision: "ask"` response, the documented
way for a Claude Code hook to defer to the user. Claude Code shows the
standard permission prompt with the reason string; the user picks allow
or deny.

## Why

Vault edits are usually irreversible (or only reversible with audit
work). Auth method or policy changes can lock out humans as well as
machines. Sealing a Vault on the wrong cluster takes the whole
environment offline. The hook makes a confirm-before-edit the default.

## Tuning

If you script a routine, expected `vault write` (lease renewal, dynamic
secret cycle, etc.), narrow the regex to exempt that specific path
prefix, or move the operation behind a wrapper script your prompts call
by name.
