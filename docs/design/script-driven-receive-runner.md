# Script-Driven Receive Runner

Development principles: [`aun-development-principles.md`](./aun-development-principles.md).

## Decision

AUN receive must be script-driven and spec-driven.

The durable queue state is owned by the database and advanced by runner code, not
by an LLM choosing a tool from a natural-language prompt.

```text
pending -> receive runner -> next -> received
received -> process runner -> processing -> in_progress
in_progress -> completion runner -> done -> send -> replied
```

`state-daemon` remains the DB-state observer and scheduler. It must not be a
Claude/Codex UI operator. Its primary job is to detect state that needs action
and invoke a configured runner for that agent/runtime.

This document is a proposed migration target for the receive path. Until the
implementation PR lands, the existing `queue-state-polling-daemon.md` and
`state-daemon-6section-elements.md` contracts remain the active production
contract. `next-only-receive-flow.md` also remains the active contract for the
claim surface: receive still means `pending -> next -> received`, and `inbox`
stays history/diagnostics only. This document supersedes only the
natural-language receive handoff after the runner implementation provides
equivalent tests and rollout steps.

Where `next-only-receive-flow.md` describes `done` as a direct no-reply close,
that statement is treated as the current CLI compatibility surface, not a new
state-model authority. The v0.9 state-daemon model remains authoritative for
completion semantics until a separate migration changes it: `done` is
non-terminal internal completion, and `done -> replied` is valid. The
implementation PR must either preserve this bridge or update both documents in
one atomic change.

## Core Principles

1. DB is canonical.
2. Queue state transitions are performed by scripts, hooks, or daemon-owned
   runner code.
3. LLMs receive already-claimed work; they do not decide how to claim it.
4. Chat UIs are projections, not the receive path.
5. Runtime differences live behind adapters.
6. Natural-language wake injection is a fallback, not the primary mechanism.
7. Transport limits must not change durable message identity.
8. Targeted audit, recovery, and bridge work uses exact `queue_id` claim, not
   FIFO drain-to-target behavior.

## State Ownership

| State | Meaning | Owner for next transition |
|---|---|---|
| `pending` | Work exists for a target agent but is not claimed. | receive runner |
| `received` | `next` claimed the row for the target agent. | process runner |
| `in_progress` | Runtime is actively processing the claimed work. | completion runner / runtime adapter |
| `done` | Runtime finished internal work and a reply/no-reply decision still needs to be finalized. | completion runner / runtime adapter |
| `replied` | Terminal: response was sent with `send`. | none |

`read` is legacy vocabulary for `received`. New runner code must use
`received` after the next-only receive contract lands.

`done` keeps the existing v0.9 meaning from the state-daemon spec: internal
processing is complete, but the queue is not terminal yet. A normal reply path
may still transition `done -> replied`. A no-reply completion must be explicit
and auditable in the runtime result; it must not silently strand rows in `done`.

## Runner Responsibilities

### Receive Runner

Input: `agent_id`, optionally `queue_id`

Behavior:

- call the same deterministic claim path as `agent-com next`
- claim at most one `pending` row per invocation
- when `queue_id` is provided, claim only that row
- fail closed if the provided `queue_id` is not pending for the expected
  `agent_id`
- fail closed if runtime identity does not match expected `agent_id`
- emit structured logs with `agent_id`, `queue_id`, `message_id`, and result

This runner is safe to invoke repeatedly. If no work exists, it exits cleanly.
If a targeted row is not claimable, the runner returns the stable failure
reason and leaves other pending rows untouched.

### Targeted Receive Runner

Input: `agent_id`, `queue_id`

Behavior:

- load the exact `message_queue` row by id inside the receive transaction
- verify agent ownership, channel/thread scope, current state, and claim
  eligibility before changing state
- transition only that row from `pending -> received`
- return the canonical logical message body, baton/conversation context, and
  claim evidence for that row
- never loop through `next` or any FIFO primitive to reach the target row

This path is required for audit, L3 merge, bridge, and recovery workflows. A
human or scheduler may know the row that must be handled; the system must not
ask a runtime to consume unrelated work just to reach it.

### Batch Receive Runner

Input: `agent_id`

Behavior:

- repeatedly call the deterministic claim path until no immediately claimable
  `pending` row remains, or until a configured batch limit is reached
- return a structured batch result containing every claimed `queue_id`
- preserve per-row ownership and claim TTLs
- never depend on an LLM deciding how many times to call `next`

The single-row `next` primitive remains useful for compatibility and simple
manual operation. Automated runtimes should prefer the batch runner so a burst
of messages is drained by script policy instead of natural-language retry loops.

### Process Runner

Detailed turn ledger contract:
[`../spec/aun-agent-turn-ledger-contract.md`](../spec/aun-agent-turn-ledger-contract.md).

Input: claimed `queue_id` or `agent_id`

Behavior:

- create durable agent turn evidence before invoking an LLM runtime
- move `received -> in_progress` after turn creation and before runtime launch
- pass the claimed message body and metadata to the runtime adapter
- never let the runtime preview unrelated pending messages

### Completion Runner

Detailed typed outcome contract:
[`../spec/aun-typed-completion-outcome-contract.md`](../spec/aun-typed-completion-outcome-contract.md).

Input: runtime result and claim identity

Behavior:

- record one durable typed completion outcome for the active turn
- reject free-form runtime prose that cannot be parsed into a typed outcome
- apply reply/no-reply/handoff/escalate/retry/quarantine through deterministic
  code, not through runtime-authored lifecycle commands
- if the outcome is `reply`, send with the original `source_queue_id` and close
  only after outbound success or typed send-failure evidence
- if the outcome is `no_reply`, close through an explicit reason code and audit
  event; the row must not remain active indefinitely
- if the outcome is `handoff` or `escalate`, transfer/create baton or child
  request with typed target and parent evidence
- if the outcome is `retry` or `quarantine`, keep the work recoverable or
  blocked under bounded, auditable policy

`failed` and `skipped` are legacy vocabulary in the v0.9 receive path. New
runner code must not introduce new `failed` or `skipped` transitions as the
primary failure model.

## State-Daemon Role

`state-daemon` should migrate toward a runner scheduler:

- observe `message_queue` and `agents`
- suppress duplicate runner starts while an agent has active work
- invoke the configured receive/process/completion runner
- detect stuck rows and enqueue recovery actions
- write operational logs and metrics

During migration, existing tmux wake / natural-language prompt injection remains
the compatibility fallback for TUI agents. The implementation PR must define the
cutover gate before making runner invocation primary. After cutover, `check
inbox` injection must not be the primary receive mechanism.

## Restart Preflight Gate

`state_daemon` must not be restarted only because pending rows exist. Restart is
allowed only after the script-level queue preflight is clean:

```bash
agent-com queue preflight --agent-id <agent_id> --format text
```

The preflight uses the same deterministic `queue doctor` checks and exits
non-zero while blocker findings remain. Natural-language loop prompts such as
operator-injected `next` / `processing` instructions are a blocker class. They
must be closed or repaired by explicit `queue_id` before daemon activation; do
not drain them by calling `next` from an LLM prompt.

For obsolete loop prompts, the safe repair path is:

```bash
agent-com queue close-obsolete \
  --agent-id <agent_id> \
  --queue-id <queue_id> \
  --reason LOOP_PROMPT_BACKLOG \
  --execute
```

If the single obsolete row is already `received` or `in_progress`, the operator
must add `--include-active` and still provide the exact `--queue-id`. Bulk
active-row closure remains disallowed.

## Durable Message vs Chat Projection

Detailed contract:
[`../spec/aun-canonical-message-presentation-contract.md`](../spec/aun-canonical-message-presentation-contract.md).

AUN must store one canonical logical message in the database. Discord, Slack,
Telegram, terminal UIs, and future proprietary UIs may impose transport-specific
message length limits, but those limits are projection concerns only.

The canonical receive path must not split one logical message into multiple
`message_queue` work items just because a chat adapter needs multiple outbound
posts. Splitting is allowed only in the outbound projection layer, where each
chunk points back to the same canonical `message_id`.

Required model:

- `agent_messages` stores the complete logical message body and metadata.
- `message_queue` stores delivery/claim state for that logical message.
- chat/outbound adapters may create transport chunks, but chunks are not
  independent work items for the receiving LLM.
- receive/process runners pass the reassembled canonical body to the runtime.
- a targeted `queue_id` receive must fail closed if the selected row is only a
  non-claimable transport fragment.

If a transport adapter receives an externally chunked message, it must either
reassemble the chunks before creating the canonical message or mark the chunks
with a stable grouping key so the receive runner can present one logical
message to the runtime. Incomplete or conflicting groups must fail closed before
runtime invocation.

This keeps DB semantics independent from Discord-specific limits and prevents
LLM-visible noise such as `1/3`, `2/3`, `3/3` becoming three separate tasks.

## Runtime Adapter Boundary

| Runtime | Primary receive mechanism |
|---|---|
| Codex | receive runner plus a Codex runner adapter |
| Claude Code | hook or script invocation first; TUI text injection only as fallback |
| Claude Code | receive runner plus a Claude runner adapter; TUI text injection only as fallback |
| OpenClaw / other orchestrators | adapter invokes AUN runner API and maps task results back to AUN states |

Runner configuration must be addressable by `agent_id` and use the existing
`agents` table as the authoritative registry. Runtime-specific values may live
in `agents.metadata` or in an operational config file keyed by `agent_id`, but
that file is only a launcher overlay and must not become an independent bot
registry. New `bot_registry` tables or daemon reads from `bot-registry.txt` are
out of scope and remain forbidden by the state-daemon SSOT.

The same `agents`/channel registry should later feed the UI that manages
channel members and agent routing.

Claude Code must normalize through the same runtime runner adapter contract
before scheduler activation. The table above preserves the current migration
fallback wording while CP-40B pins the future adapter boundary.

Runtime adapters may differ in launch, IO transport, timeout enforcement, and
result parsing. They must not implement their own queue claim policy, baton
ownership policy, retry policy, or completion state transitions.

## Acceptance Criteria

- A pending row can be claimed without any LLM tool-choice decision.
- A specific audit or recovery row can be claimed by exact `queue_id` without
  draining older pending rows.
- `pending -> next -> received` from `next-only-receive-flow.md` remains the
  receive claim contract.
- `inbox` cannot advance queue state and cannot be required for receive.
- A busy agent can accumulate pending rows without repeated UI prompt injection.
- A crashed runner leaves enough DB state for deterministic reclaim.
- Codex and Claude use the same state machine, differing only at the runtime
  adapter boundary.
- Existing v0.9 `done -> replied` semantics remain valid unless a separate
  migration explicitly changes the state model.
- Runner configuration uses `agents` as SSOT and does not introduce a parallel
  bot registry.
