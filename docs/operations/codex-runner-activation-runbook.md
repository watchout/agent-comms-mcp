# Codex Runner Activation Runbook

> Issue: #422 Codex runtime auto-receive runner
> Status: docs-only activation packet slice.
> Cell: R5 operator activation runbook.
> Last updated: 2026-06-08

This runbook defines how an operator prepares, requests approval for, and
executes a bounded Codex runner activation after the relevant implementation
PRs have passed audit and merge gates.

It is not an activation approval. It does not authorize live queue mutation,
state_daemon restart, LaunchAgent or launchctl mutation, live Discord writes,
secret changes, schema migration, queue drain, or runtime expansion.

## Safety Boundary

The pre-approval path is read-only or dry-run only.

Do not perform any of these actions while preparing the packet:

- restart `state_daemon`
- run `launchctl bootstrap`, `launchctl kickstart`, or equivalent supervisor
  activation
- enable or widen `STATE_DAEMON_CODEX_RUNNER_ENABLED` /
  `STATE_DAEMON_AGENT_ALLOWLIST`
- change `agents.runtime`, `agents.metadata`, connector bindings, credentials,
  `.mcp.json`, LaunchAgent plist, or bot registry files
- call `next`, `inbox`, or FIFO drain to reach a target queue row
- ask an LLM by prompt to claim, close, skip, or clean up queue rows
- run live `aun codex-runner` against production DB
- insert canary rows, close active rows, terminalize no-reply rows, or repair
  queue state
- send live Discord traffic or run a Discord smoke
- print secrets, provider tokens, raw message payloads, or full queue content

Any operation above requires a separate approval that names the exact agent,
channel, queue row, runtime phase, command, rollback trigger, and evidence file.

## Activation Scope

Every activation request must define an exact scope before any command is run.

```json
{
  "scope_name": "codex-runner-canary-codex-aun-agent-com",
  "agents": ["codex-aun"],
  "channel_ids": ["1487368919613444156"],
  "runtime_kinds": ["codex", "codex-runner"],
  "runner_phases": ["receive", "process", "completion"],
  "max_canary_count": 1,
  "fallback_allowed": false,
  "production_mutation_allowed": false
}
```

Rules:

- first activation is canary-only; fleet-wide activation is forbidden
- `agents`, `channel_ids`, `runtime_kinds`, and `runner_phases` are exact
- `max_canary_count` starts at 1
- `fallback_allowed` is false unless a later approval explicitly changes it
- approval for one scope never authorizes another agent, channel, runtime kind,
  or runner phase

## Preconditions

An activation packet is eligible for review only when all of these are true:

1. Relevant #422 implementation PRs have L1/L2/L3 and merge evidence, or the
   activation request explicitly states the remaining unmerged PRs and limits
   itself to read-only planning.
2. `origin/main` contains the exact runner code being proposed for activation.
3. The deployed checkout, if any, can be identified by full commit SHA and path.
4. The target agent identity is locked:
   `AGENT_ID == AGENT_COM_EXPECTED_AGENT_ID`.
5. The target runtime is intentionally `codex` or `codex-runner`; TUI fallback
   is not counted as Codex runner activation.
6. Queue readiness for the exact agent has no blocker findings.
7. Runtime memory-ready evidence is current, bounded, and tied to the expected
   runtime instance.
8. Any direct-mention Discord path has DB-backed routing evidence; Discord is
   projection only, not source of truth.
9. The command packet can prove it will not use `next`, `inbox`, FIFO drain, or
   prompt injection.

## Read-Only Evidence Packet

Prepare one directory for the approval packet:

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
PACKET_DIR="./artifacts/codex-runner-activation-${RUN_ID}"
mkdir -p "$PACKET_DIR"
```

Capture repository and deployment identity:

```bash
git rev-parse HEAD > "$PACKET_DIR/repo-head.txt"
git status --short --branch > "$PACKET_DIR/repo-status.txt"
git log -1 --format='%H %cI %s' > "$PACKET_DIR/repo-last-commit.txt"
```

Capture queue and runtime readiness using read-only commands only:

```bash
agent-com queue preflight \
  --agent-id codex-aun \
  --format json > "$PACKET_DIR/queue-preflight.json"

agent-com state-daemon queue-readiness \
  --agent-id codex-aun \
  --format json > "$PACKET_DIR/state-daemon-queue-readiness.json"
```

When the #422 R3 preflight command is present, prefer it:

```bash
bun bin/aun.ts codex-runner-preflight \
  --agent-id codex-aun \
  --max-inspect 10 > "$PACKET_DIR/codex-runner-preflight.json"
```

If that command is not present in the reviewed deployment, do not substitute a
live runner invocation. Use existing read-only evidence instead:

```bash
bun bin/aun.ts receive-actionable \
  --agent-id codex-aun \
  --max-inspect 10 \
  --dry-run > "$PACKET_DIR/receive-actionable-dry-run.json"
```

For a Discord-facing scope, add projection diagnostics before requesting any
live smoke:

```bash
agent-com diagnose-projection \
  --channel 1487368919613444156 \
  --from codex-aun \
  --to ceo \
  --format json > "$PACKET_DIR/projection-diagnostic.json"
```

Every captured report must redact secrets and must not include raw message
payloads or full content. A content hash, byte length, queue id, message id,
channel id, route reason, and typed blocker code are acceptable.

## Approval Request

The approval request must include:

- exact repository head SHA and deployed checkout SHA
- target agent ids and channel ids
- runtime kind and expected `AGENT_ID` / `AGENT_COM_EXPECTED_AGENT_ID`
- current runner env flags that would be enabled or changed
- the read-only evidence packet path
- queue ids involved in any proposed canary
- expected state transitions for the canary
- rollback trigger list
- explicit statement that no live operation has been performed yet

Example request:

```text
APPROVAL REQUEST - #422 Codex runner canary activation

Scope:
- agent: codex-aun
- channel_id: 1487368919613444156
- runtime: codex-runner
- phases: receive, process, completion
- max_canary_count: 1
- fallback_allowed: false

Evidence packet:
- repo head: <full_sha>
- deployed checkout: <full_sha_or_none>
- queue preflight: <packet>/queue-preflight.json
- state-daemon queue readiness: <packet>/state-daemon-queue-readiness.json
- runner preflight or receive dry-run: <packet>/<file>.json
- projection diagnostic: <packet>/projection-diagnostic.json

Requested live actions after approval:
1. enable exact canary scope only
2. insert or select one approved canary row
3. allow deterministic runner claim/process/completion for that row only
4. capture recovery-proof/v1 evidence

Rollback:
- disable canary scope immediately on any rollback trigger
- do not bulk-close active rows
- do not prompt an LLM to repair
- do not use state_daemon restart as repair
```

## Approved Canary Execution Shape

After approval, the first canary must prove exactly one row through the full
path:

```text
inbound evidence
  -> message_queue row for exact agent
  -> deterministic actionable routing evidence
  -> codex runner exact claim
  -> typed runner result
  -> deterministic terminal application or bounded blocker
  -> outbound/projection evidence if reply is expected
  -> queue readiness returns clean for the scope
```

The runner must use exact `queue_id` and `message_id` evidence. If a targeted
row is proposed, no FIFO drain or ambient `next` call may be used to reach it.

ACK/progress evidence is non-terminal. A canary is not successful until the
same row reaches the intended terminal state or emits an approved bounded
blocker with stable code.

## Recovery-Proof Artifact

The canary result must be recorded as `recovery-proof/v1` in a PR comment or
durable artifact:

```json
{
  "schema": "recovery-proof/v1",
  "scope_name": "codex-runner-canary-codex-aun-agent-com",
  "repo_head": "<full_sha>",
  "deployed_checkout": "<full_sha>",
  "agent_id": "codex-aun",
  "channel_id": "1487368919613444156",
  "queue_id": "<queue_id>",
  "message_id": "<message_id>",
  "routing_decision": "wake_agent",
  "route_reason": "direct_mention",
  "claim": {
    "claimed_by": "codex-aun",
    "status_before": "pending",
    "status_after": "received"
  },
  "runner_result": {
    "result_status": "completed_reply",
    "queue_id": "<queue_id>",
    "message_id": "<message_id>"
  },
  "terminal_state": {
    "status": "replied",
    "replied_with": "<message_id_or_null>",
    "reason": "<typed_reason_or_null>"
  },
  "projection": {
    "outbound_id": "<outbound_id_or_null>",
    "consumer_agent_id": "codex-aun",
    "consumer_source": "sender_token_evidence"
  },
  "rollback_triggered": false,
  "mutation_scope": "approved_canary_only"
}
```

Do not call AUN fully recovered from an ACK, queue number, generated sentence,
or script output. Recovery requires the durable artifact plus user-visible
outcome evidence when a reply is expected.

## Rollback Triggers

Any of these immediately pauses or disables the canary scope:

| Code | Required response |
|---|---|
| `PREFLIGHT_BLOCKED` | Do not activate; retain packet evidence. |
| `IDENTITY_MISMATCH` | Stop activation; correct identity in a separate reviewed change. |
| `UNAPPROVED_SCOPE` | Disable scope; request a new approval. |
| `FIFO_DRAIN_DETECTED` | Pause scheduler; quarantine affected evidence for audit. |
| `PROMPT_INJECTION_DETECTED` | Disable canary; do not ask the LLM to repair itself. |
| `RUNNER_RESULT_MISSING` | Keep row recoverable; surface bounded blocker. |
| `COMPLETION_PATH_MISSING` | Keep row recoverable; surface bounded blocker. |
| `DUPLICATE_TERMINAL_APPLY` | Stop expansion; verify idempotency evidence. |
| `DISCORD_FALLBACK_USED` | Stop Discord expansion; keep DB truth. |
| `PROJECTION_EVIDENCE_MISSING` | Do not count user-visible success. |
| `ACTIVE_CLAIM_STUCK` | Stop expansion; use exact reclaim plan only after approval. |
| `SECRET_OR_PAYLOAD_LEAK` | Stop immediately; rotate/repair under incident process. |

Rollback must not delete queue evidence, bulk-close active rows, drain queue
work, or restart state_daemon as repair.

## Expansion Gate

Expansion beyond the first canary requires a new packet and approval. The new
packet must reference:

- prior recovery-proof/v1 artifact
- current queue readiness for the expanded scope
- current runner preflight or equivalent read-only evidence
- exact agents/channels/phases to add
- new rollback triggers and stop conditions

Expansion is denied if the previous canary used fallback routing, had missing
projection evidence, emitted only ACK/progress, or required manual LLM prompt
repair.

## Status Language

Use precise status language:

- `planning`: read-only packet exists; no live action approved
- `approved_canary_pending`: approval exists; canary not yet executed
- `canary_passed`: recovery-proof/v1 exists for the approved scope
- `expanded`: a later approved packet widened the scope
- `paused`: rollback trigger fired and scheduler scope is disabled
- `partial_recovery`: internal path improved but user-outcome proof is missing
- `complete_recovery`: all required canaries and recovery-proof artifacts pass

Do not use `complete_recovery` for docs, dry-run output, queue counts,
generated text, or operator intention alone.
