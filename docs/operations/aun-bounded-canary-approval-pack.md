# AUN Bounded Canary And Live Smoke Approval Pack

> Issue: #602
> Status: approval-prep runbook; no execution authority.
> Last updated: 2026-06-02

This pack prepares the final bounded canary and live-smoke approval request for
terminal reboot recovery. It is not an execution PR and does not authorize
state_daemon restart, launchd bootstrap/kickstart, Discord writes, queue drain,
DB mutation, schema migration, or live runtime calls.

## Non-Execution Boundary

Do not run any mutating or live command while preparing this packet:

- no state_daemon restart
- no `launchctl bootstrap`
- no `launchctl kickstart`
- no Discord activation or live Discord write
- no `next`, `inbox`, or FIFO drain
- no DB/schema migration
- no live Codex, Claude, or other runtime call
- no automatic retry loop

Every command in this document is either read-only or a template to paste into a
separate approval request. Any command that can create work, send a message,
start/restart a process, or mutate DB state requires separate explicit approval.

## Exact Canary Scope

The first recovery canary is a single-message, single-agent, single-channel
scope:

```json
{
  "scope_label": "cp80-recovery-canary-602",
  "issue": "#602",
  "max_canary_count": 1,
  "agents": ["codex-cto"],
  "channel_ids": ["1487368919613444156"],
  "runtime_kinds": ["codex"],
  "runner_phases": ["receive", "process", "completion", "projection", "audit"],
  "fallback_allowed": false,
  "expected_projection": {
    "from_agent": "codex-cto",
    "to_agent": "ceo",
    "channel_id": "1487368919613444156",
    "consumer_agent_id": "codex-cto",
    "consumer_source": "sender_token_evidence"
  },
  "prohibited": [
    "fifo_drain",
    "prompt_driven_next",
    "prompt_driven_inbox",
    "tui_prompt_injection",
    "automatic_retry_loop",
    "fleet_wide_activation"
  ]
}
```

Scope changes require a new approval packet. Do not expand to another agent,
channel, runtime kind, or second queue row during this canary.

Save this exact scope before capturing CP-80 reports:

```bash
mkdir -p evidence
cat > evidence/recovery-scope.json <<'JSON'
{
  "scope_label": "cp80-recovery-canary-602",
  "issue": "#602",
  "max_canary_count": 1,
  "agents": ["codex-cto"],
  "channel_ids": ["1487368919613444156"],
  "runtime_kinds": ["codex"],
  "runner_phases": ["receive", "process", "completion", "projection", "audit"],
  "fallback_allowed": false,
  "expected_projection": {
    "from_agent": "codex-cto",
    "to_agent": "ceo",
    "channel_id": "1487368919613444156",
    "consumer_agent_id": "codex-cto",
    "consumer_source": "sender_token_evidence"
  },
  "prohibited": [
    "fifo_drain",
    "prompt_driven_next",
    "prompt_driven_inbox",
    "tui_prompt_injection",
    "automatic_retry_loop",
    "fleet_wide_activation"
  ]
}
JSON
```

## Required Preflight Inputs

All inputs must be GO for the exact canary scope before requesting live-smoke
approval:

| Input | Required result | Required file |
|---|---|---|
| CP-70 preflight | `go_no_go=GO`, zero blockers | `evidence/cp70-preflight.json` |
| CP-80 recovery readiness | `ok=true`, `go_no_go=GO`, `mutation_performed=false` | `evidence/recovery-readiness.json` |
| CP-80 activation-plan dry-run | `ok=true`, `go_no_go=GO`, `mutation_performed=false` | `evidence/activation-plan.json` |
| Discord projection diagnostic | `ok=true`, direct delivery, `fallback_allowed=false` | `evidence/discord-projection.json` |
| state-daemon readiness | `ok=true`, persistent path GO, `restart_performed=false` | `evidence/state-daemon-readiness.json` |
| state-daemon install-plan dry-run | `ok=true`, `go_no_go=GO`, `mutation_performed=false`, `restart_performed=false` | `evidence/install-plan.json` |

If any input is missing, stale, NO-GO, or scoped differently, stop. Do not
substitute operator intuition, Discord visibility, or LLM prose for these
reports. If the install-plan CLI from #672 is not available in the checked-out
build, `evidence/install-plan.json` must record that dependency as NO-GO rather
than silently skipping it.

## Read-Only Evidence Capture Commands

Preferred pack command:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun scripts/recovery-readonly-gate-pack.ts \
    --output-dir evidence \
    --agent-id codex-cto \
    --to-agent ceo \
    --channel-id 1487368919613444156 \
    --install-plan-commit "$(git rev-parse HEAD)"
```

This command writes the exact read-only gate layout:

```text
evidence/recovery-scope.json
evidence/cp70-preflight.json
evidence/recovery-readiness.json
evidence/activation-plan.json
evidence/discord-projection.json
evidence/state-daemon-readiness.json
evidence/install-plan.json
evidence/summary.json
```

`evidence/summary.json` is the GO/NO-GO classifier. It is GO only when every
required report is GO and every report confirms `mutation_performed=false` and
`restart_performed=false`. It is NO-GO for any blocker, command failure,
missing positive GO evidence, unavailable #672 install-plan dependency, mutation
evidence, or restart evidence. It records exact blocker codes with their source
report names plus the current `origin/main` SHA and PR dependency status.

Manual capture is allowed when the runner script is unavailable, but it must
produce the same files and the same fail-closed summary logic.

Create a local evidence directory for a manual approval packet:

```bash
mkdir -p evidence
test -s evidence/recovery-scope.json
```

Record the exact repo and DB context:

```bash
git rev-parse HEAD > evidence/repo-head.txt
git rev-parse origin/main > evidence/origin-main.txt
printf '%s\n' "${DATABASE_URL:-unset}" > evidence/database-url.txt
```

Capture the CP-70 preflight:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  agent-com queue cp70-preflight \
    --agent-id codex-cto \
    --format json > evidence/cp70-preflight.json
```

Capture Discord projection diagnostic evidence. This is read-only and must not
send a Discord message:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  agent-com diagnose-projection \
    --channel-id 1487368919613444156 \
    --from-agent codex-cto \
    --to ceo \
    --format json > evidence/discord-projection.json
```

Capture state-daemon readiness. Prefer the dedicated CLI when available:

```bash
agent-com state-daemon readiness \
  --format json > evidence/state-daemon-readiness.json
```

If that CLI is not available in the checked-out build, use the older read-only
LaunchAgent preflight helper and name the substitution in the approval request:

```bash
bun scripts/state-daemon-launchagent.ts preflight \
  --plist ~/Library/LaunchAgents/com.agent-comms.state-daemon.plist \
  > evidence/state-daemon-launchagent-preflight.txt
```

Capture CP-80 readiness for the exact scope:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  agent-com recovery readiness \
    --scope-file evidence/recovery-scope.json \
    --format json > evidence/recovery-readiness.json
```

Capture the activation-plan dry-run:

```bash
agent-com recovery activation-plan \
  --scope-file evidence/recovery-scope.json \
  --readiness-report evidence/recovery-readiness.json \
  --format json > evidence/activation-plan.json
```

Capture the state-daemon install-plan dry-run when the #672 CLI is available:

```bash
agent-com state-daemon install-plan \
  --commit "$(git rev-parse HEAD)" \
  --format json > evidence/install-plan.json
```

If that CLI is not available, write a NO-GO dependency report instead of
declaring the approval pack complete:

```json
{
  "ok": false,
  "go_no_go": "NO_GO",
  "report": "install-plan",
  "dependency_unavailable": true,
  "dependency": {
    "pr": 672,
    "command": "agent-com state-daemon install-plan"
  },
  "mutation_performed": false,
  "restart_performed": false,
  "blockers": [
    {
      "code": "INSTALL_PLAN_UNAVAILABLE_PR_672_PENDING"
    }
  ]
}
```

Do not run canary execution, state_daemon restart, launchctl activation,
Discord send, `next`, `inbox`, or runtime invocation from this packet.

## JSON Fields To Save

Save the raw JSON files and copy these fields into the approval request.

### CP-70 Preflight

- `ok`
- `go_no_go`
- `scope`
- `finding_counts`
- `blockers`
- `exact_ids`
- `mutation_performed`
- `recommended_next_commands`

### CP-80 Recovery Readiness

- `ok`
- `go_no_go`
- `scope`
- `cp70`
- `launchagent`
- `queue`
- `projection`
- `blockers`
- `recommended_next_commands`
- `mutation_performed`

### CP-80 Activation Plan

- `ok`
- `go_no_go`
- `scope`
- `phases`
- `required_evidence`
- `rollback_triggers`
- `non_goals`
- `mutation_performed`

### Discord Projection Diagnostic

- `ok`
- `go_no_go`
- `consumer_agent_id`
- `projection_identity_id`
- `delivery_connector_instance_id`
- `channel_binding_id`
- `credential_status`
- `provider_write_capability`
- `fallback_allowed`
- `fallback_reason`
- `decision_source`
- `mutation_performed`

Required decision:

```json
{
  "consumer_agent_id": "codex-cto",
  "consumer_source": "sender_token_evidence",
  "fallback_allowed": false,
  "fallback_reason": null
}
```

If sender credentials are usable and the diagnostic chooses AUN/router fallback,
the canary is NO-GO.

### state-daemon Readiness

- `ok`
- `go_no_go`
- `scope`
- `launchagent.plist_path`
- `launchagent.program_arguments`
- `launchagent.working_directory`
- `paths`
- `identity`
- `launchd.loaded`
- `launchd.running`
- `blockers`
- `mutation_performed`
- `restart_performed`

Required decision:

```json
{
  "mutation_performed": false,
  "restart_performed": false
}
```

### state-daemon Install Plan

- `ok`
- `go_no_go`
- `target_commit`
- `persistent_paths`
- `launchagent`
- `atomic_update_plan`
- `cleanup_protection`
- `supervisor_evidence`
- `blockers`
- `mutation_performed`
- `restart_performed`

Required decision:

```json
{
  "go_no_go": "GO",
  "mutation_performed": false,
  "restart_performed": false
}
```

If #672 is still unavailable in the checked-out build, the install-plan report
must be `NO_GO` with blocker `INSTALL_PLAN_UNAVAILABLE_PR_672_PENDING`.

## Required DB / Projection / Connector Evidence

The approval packet must identify exact evidence, not screenshots or prose:

- queue row IDs selected for the future canary, or an explicit statement that
  the future canary will create/select exactly one row after approval
- source `agent_messages.message_id`
- `message_queue.id`
- `message_queue.agent_id=codex-cto`
- `message_queue.status` transition evidence after the future canary
- turn/result/audit IDs if the activation plan requires them
- outbound row ID and source queue/result linkage for any future reply
- `consumer_agent_id=codex-cto`
- `consumer_source=sender_token_evidence`
- `projection_identity_id`
- `delivery_connector_instance_id`
- `channel_binding_id`
- `credential_status`
- `provider_write_capability`
- `fallback_allowed=false`
- `fallback_reason=null`

Discord visibility alone is not success. A visible Discord message without DB
queue/result/outbound/projection/audit evidence is incomplete.

## Rollback Trigger Checklist

Stop on the first blocker. Do not retry automatically.

| Trigger | Stop action |
|---|---|
| FIFO drain detected | stop canary, preserve logs, mark scope NO-GO |
| loop prompt detected | stop canary, rerun CP-70 doctor, do not prompt LLM |
| wrong `AGENT_ID` / listener identity | stop canary, keep endpoint evidence, no restart without new approval |
| Discord fallback to AUN/router when direct expected | stop canary, keep projection diagnostic, do not send fallback |
| projection evidence missing | stop canary, classify as projection failure, not success |
| queue row stuck | stop canary, capture exact queue ID and lifecycle state |
| duplicate active work | stop canary, capture exact queue/turn/baton IDs |
| prompt-driven `next` / `inbox` request appears | stop canary, record prompt artifact, rerun CP-70 |
| state_daemon restart requested as repair | stop canary, require separate supervisor approval packet |
| live Discord send fails | stop canary, record typed send/projection failure, no retry loop |

Rollback means disabling or pausing the exact activation scope and preserving
evidence. Rollback does not delete rows, bulk-close active work, restart
state_daemon as repair, or ask an LLM to process more queue rows.

## Live Smoke Approval Template

Use this template only after every required preflight input is GO.

```text
LIVE SMOKE APPROVAL REQUEST - #602 bounded canary

Requested action:
- Run one bounded recovery canary for issue #602.
- One channel: 1487368919613444156.
- One active agent: codex-cto.
- One target: ceo.
- One runtime kind: codex.
- max_canary_count: 1.
- fallback_allowed: false.
- No automatic retry loop.
- Stop on first blocker.

Preflight evidence:
- CP-70 preflight GO: <path-or-artifact-id>
- CP-80 recovery readiness GO: <path-or-artifact-id>
- CP-80 activation-plan dry-run GO: <path-or-artifact-id>
- Discord projection diagnostic GO: <path-or-artifact-id>
- state-daemon readiness GO: <path-or-artifact-id>

Expected direct delivery:
- consumer_agent_id: codex-cto
- consumer_source: sender_token_evidence
- channel_id: 1487368919613444156
- fallback_allowed: false

Allowed live action after approval:
- Process exactly one canary message/queue item in the named scope.
- Capture DB queue/result/outbound/projection/audit evidence.
- Count Discord visibility only as secondary evidence.

Explicitly not approved:
- state_daemon restart
- launchctl bootstrap/kickstart
- Discord fleet activation
- more than one live Discord message
- next/inbox/FIFO drain
- prompt-driven processing
- automatic retry loop
- DB/schema migration
- live runtime calls outside the canary scope

Rollback triggers:
- FIFO drain detected
- loop prompt detected
- wrong AGENT_ID/listener
- Discord fallback to AUN/router
- projection evidence missing
- queue row stuck or duplicate active work
- prompt-driven next/inbox request
- any second canary item or retry attempt

Approval:
- Approved by: <name>
- Approval id: <id>
- Approved at: <timestamp>
- Exact scope hash: <hash>
```

No one should infer approval from a Discord reaction, a casual chat reply, or
free-form LLM text. Approval must explicitly name the scope, one-message limit,
and rollback triggers.
