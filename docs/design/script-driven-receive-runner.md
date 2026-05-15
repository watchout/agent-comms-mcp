# Script-Driven Receive Runner

## Decision

AUN receive must be script-driven and spec-driven.

The durable queue state is owned by the database and advanced by runner code, not
by an LLM choosing a tool from a natural-language prompt.

```text
pending -> receive runner -> next -> received
received -> process runner -> processing -> in_progress
in_progress -> completion runner -> send/done -> replied/done
```

`state-daemon` remains the DB-state observer and scheduler. It must not be a
Claude/Codex UI operator. Its primary job is to detect state that needs action
and invoke a configured runner for that agent/runtime.

## Core Principles

1. DB is canonical.
2. Queue state transitions are performed by scripts, hooks, or daemon-owned
   runner code.
3. LLMs receive already-claimed work; they do not decide how to claim it.
4. Chat UIs are projections, not the receive path.
5. Runtime differences live behind adapters.
6. Natural-language wake injection is a fallback, not the primary mechanism.

## State Ownership

| State | Meaning | Owner for next transition |
|---|---|---|
| `pending` | Work exists for a target agent but is not claimed. | receive runner |
| `received` | `next` claimed the row for the target agent. | process runner |
| `in_progress` | Runtime is actively processing the claimed work. | completion runner / runtime adapter |
| `replied` | Terminal: response was sent with `send`. | none |
| `done` | Terminal: work completed without a reply. | none |

`read` is legacy vocabulary for `received`. New runner code must use
`received` after the next-only receive contract lands.

## Runner Responsibilities

### Receive Runner

Input: `agent_id`

Behavior:

- call the same deterministic claim path as `agent-com next`
- claim at most one `pending` row per invocation
- fail closed if runtime identity does not match expected `agent_id`
- emit structured logs with `agent_id`, `queue_id`, `message_id`, and result

This runner is safe to invoke repeatedly. If no work exists, it exits cleanly.

### Process Runner

Input: claimed `queue_id` or `agent_id`

Behavior:

- move `received -> in_progress` before invoking an LLM runtime
- pass the claimed message body and metadata to the runtime adapter
- never let the runtime preview unrelated pending messages

### Completion Runner

Input: runtime result and claim identity

Behavior:

- if the result contains a reply, call `send` and close as `replied`
- if the result is explicitly no-reply, call `done` and close as `done`
- if the runtime fails, leave an auditable failure state or use the existing
  fail/skip path according to the failure policy

`done -> replied` is not a valid normal transition. `done` is terminal.

## State-Daemon Role

`state-daemon` should be redefined as a runner scheduler:

- observe `message_queue` and `agents`
- suppress duplicate runner starts while an agent has active work
- invoke the configured receive/process/completion runner
- detect stuck rows and enqueue recovery actions
- write operational logs and metrics

It should not inject `check inbox` as the primary receive mechanism.

## Runtime Adapter Boundary

| Runtime | Primary receive mechanism |
|---|---|
| Codex | script invocation of `next` plus a Codex runner adapter |
| Claude Code | hook or script invocation first; TUI text injection only as fallback |
| OpenClaw / other orchestrators | adapter invokes AUN runner API and maps task results back to AUN states |

The runner configuration should be addressable by `agent_id` and stored in one
DB-backed or config-backed registry. The same registry should later feed the UI
that manages channel members and agent routing.

## Acceptance Criteria

- A pending row can be claimed without any LLM tool-choice decision.
- `inbox` cannot advance queue state and cannot be required for receive.
- A busy agent can accumulate pending rows without repeated UI prompt injection.
- A crashed runner leaves enough DB state for deterministic reclaim.
- Codex and Claude use the same state machine, differing only at the runtime
  adapter boundary.
