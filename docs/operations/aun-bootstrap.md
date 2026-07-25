# AUN one-command bootstrap

`aun bootstrap` turns an already-started Codex or Claude runtime into a
provider-registered, ordinary-receive-capable AUN seat. It is deterministic,
idempotent, resumable, and fail-closed. It does not enable Shirube D1, release
the D1 kill switch, add a protected target, or perform an external-effect
smoke.

## Commands

Plan without changing provider configuration, the database, an agent profile,
or launchd:

```bash
aun bootstrap --agent-id <id> --runtime auto --dry-run --json
```

Apply the plan:

```bash
aun bootstrap --agent-id <id> --runtime auto --json
```

If auto-detection is impossible, explicitly choose the runtime. An explicit
choice still fails if live process identity contradicts it:

```bash
aun bootstrap --agent-id <id> --runtime codex --json
aun bootstrap --agent-id <id> --runtime claude --json
```

Resume the exact failed run after resolving its reported predicate, or roll
back only mutations owned by that run:

```bash
aun bootstrap --agent-id <id> --runtime <resolved> --resume <run_id> --json
aun bootstrap --agent-id <id> --runtime <resolved> --rollback <run_id> --json
```

Inspect the latest bootstrap status without printing journal contents:

```bash
aun status
```

## B0–B8 lifecycle

| Stage | Required proof |
| --- | --- |
| B0 lock and snapshot | One per-agent lock, exact repository head, redacted pre-state journal |
| B1 dependency preflight | Bun, Node, Git, tmux, launchd, selected provider CLI, unambiguous live provider identity |
| B2 database migration | Successful migration and successful identical rerun |
| B3 agent profile | Exact agent/runtime/workspace/tmux/port tuple and provider-native readback |
| B4 MCP registration | `codex mcp add` or `claude mcp add`, followed by provider-native list readback |
| B5 memory readiness | Current runtime receipt and current Wasurezu recovery-readiness evidence |
| B6 ordinary daemon | Durable checkout, valid plist, one launchd daemon, matching runtime identity, safe D1 values |
| B7 queue smoke | One no-effect row, one claim, one terminal result, no duplicate or external effect |
| B8 READY readback | Identity, MCP, memory, process, endpoint, queue progression, and safe-D1 evidence agree |

The command emits `READY` only after B8. `IDEMPOTENT_READY` means an identical
prior run was found and a fresh B8 readback passed without a new profile, MCP
registration, daemon, migration, port lease, or smoke row. Any missing or
stale proof returns an exact `NO_GO_*` code and a bounded resume command.

## Safe defaults

Every daemon plan created by bootstrap contains these exact values:

```text
SHIRUBE_D1_ENABLED=0
SHIRUBE_D1_KILL_SWITCH=1
SHIRUBE_D1_TARGET_ALLOWLIST=[]
STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED=0
```

Changing any of them requires a separate protected owner gate. Bootstrap
never treats a live process, an open port, or a placed config file as READY by
itself.

## Runtime selection

`--runtime auto` accepts either:

1. one exact agent-profile provider that agrees with one verified current
   process identity; or
2. one verified current process identity when no profile exists.

Version output is dependency evidence only and never selects a provider.
Conflicting Codex/Claude evidence returns `NO_GO_RUNTIME_AMBIGUOUS`; missing
live identity returns `NO_GO_RUNTIME_UNDETECTED`.

Codex configuration is changed only through `codex mcp add aun` and read back
with `codex mcp list`. Claude configuration uses the existing `aun init`
registration shape through `claude mcp add --scope user --transport stdio`
and is read back with `claude mcp list`. The bootstrap journal stores hashes
and redacted identities, not provider configuration bodies or credentials.

## Journal, resume, and rollback

Each non-dry run is stored at:

```text
${AUN_HOME:-~/.aun}/bootstrap/<agent_id>/<run_id>.json
```

Directories are private and run files are mode `0600`. The journal records
stage results and an append-only mutation manifest. Resume is accepted only
when the agent, repository head, original requested runtime, safe defaults,
and stage-input digest match. Rollback runs in reverse order and refuses
cross-run or unowned deletion. If any recorded rollback cannot be verified,
the terminal status is `PARTIAL_ROLLBACK_NO_GO`, never success.

## Operational boundary

Run bootstrap only on the seat being installed. Do not use it as a fleet
activation command. Merge, distribution inclusion, D1 activation, protected
target changes, and production rollout remain separate owner decisions.
