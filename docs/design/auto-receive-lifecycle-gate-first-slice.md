# Auto-Receive Lifecycle Gate First Slice

Issue: #439
Parent: #426
Related: #420, #421, #422, #443

## Status

Draft implementation/design slice. This document does not activate a runtime,
restart `state_daemon`, mutate production DB identity rows, edit broad
`.mcp.json`, change bot registry, or migrate CTO tokens.

## Status: Doc-Only Contract

This PR is a doc-only design/contract slice. It is not the state_daemon
execution implementation and does not make auto-receive production-ready by
itself.

The implemented code path still requires follow-up implementation PRs that add
state_daemon planner/action execution boundaries and adapters. Until those code
PRs are merged and separately activated, production state_daemon behavior is
unchanged.

## Goal

Make the first public-release auto-receive loop script-controlled while keeping
request lifecycle semantics separate from delivery transport:

```text
pending delivery row
  -> script-controlled codex-runner claim
  -> retained queue_id/message_id
  -> ACK via reply --no-close
  -> explicit final reply --close --queue-id --message-id
```

The LLM may decide the content of the ACK, progress, result, or final reply. It
must not decide whether the delivery row is claimable, whether ACK closes work,
or which row final close targets.

## Scope

First slice only:

- Codex runner path for one agent identity.
- `pending -> received` claim through the existing deterministic `aun drain`
  path used by `aun codex-runner`.
- Optional ACK/progress through `reply --no-close`.
- Durable retention of `queue_id` and `message_id` for final close.
- Final completion through explicit
  `reply --close --queue-id <id> --message-id <uuid>`.

Out of scope:

- Broad #426 lifecycle schema migration.
- UI/project management semantics.
- Shirube-style tasks, backlog, milestone, priority, or capacity state.
- Production `state_daemon` restart or launchd mutation.
- CTO Discord token or identity migration.
- Bot-registry or broad MCP config mutation.
- Automatic daemon-authored prose ACKs.

## Current Baseline

The #422 runner already provides the transport-safe core:

- `aun codex-runner --agent-id <agent> --limit <n>` claims through `drain`.
- Runtime identity fails closed when `AGENT_ID` and
  `AGENT_COM_EXPECTED_AGENT_ID` do not match.
- Runner output retains `queue_id` and `message_id`.
- `--ack-mentions` plus `--ack-content` emits `reply --no-close`.
- Final close remains explicit and separate.

#443 removed the fresh `aun` namespace instruction blocker at the user-facing
MCP instruction layer. The remaining #439 work is the script-controlled
receive/lifecycle path, not naming.

## Minimal Runner Contract

Invocation:

```bash
AGENT_ID=<agent_id> \
AGENT_COM_EXPECTED_AGENT_ID=<agent_id> \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun bin/aun.ts codex-runner \
  --agent-id <agent_id> \
  --limit 1 \
  --ack-mentions <requester_agent_id> \
  --ack-content "<typed ACK/progress text>"
```

Required output fields:

- `agent_id`
- `expected_agent_id`
- `retained[]`
- `retained[].queue_id`
- `retained[].message_id`
- `retained[].channel_id`
- `retained[].thread_id`
- `retained[].from`
- `acked_count`
- `acks[].stdout.work_closed`
- `acks[].stdout.close_mode`
- `final_close_contract`

Required behavior:

- no pending row: exit successfully with `retained_count=0`
- identity mismatch: fail before claim
- invalid ACK arguments: fail before claim
- successful claim: row becomes `received`, not terminal
- ACK/progress: `work_closed=false`, `close_mode=none`
- final close: explicit `--close --queue-id --message-id` only

## Lifecycle Interpretation

This slice maps delivery transport to lifecycle intent without introducing a
new lifecycle schema yet.

| Transport event | Lifecycle intent | Terminal |
|---|---|---:|
| runner retained row | request accepted for processing | no |
| `reply --no-close` ACK | `ack` / `progress` | no |
| `reply --no-close` result | `result` awaiting requester or explicit close | no |
| `reply --close --queue-id --message-id` | `close` | yes |
| `notify` fallback | notice/fallback evidence only | no |

`notify` must not satisfy or close the original request. If a workflow uses
notify fallback to report PASS, the original queue row remains unresolved until
a lifecycle view or explicit close links that fallback to the original request.

## Execution-State Boundary

The Phase 1 auto-receive gate must cover the full communication execution path,
not only initial pending delivery:

| State | Boundary | Terminal? |
|---|---|---:|
| `pending` | `codex-runner` claims through existing `next`/`drain` semantics, retains `queue_id/message_id`, and emits ACK/progress with `reply --no-close` | no |
| `received` | processing/start runner boundary moves work toward explicit `in_progress` ownership | no |
| `in_progress` | result/done-ready boundary records that the assignee produced a result, but does not close the request automatically | no |
| `done` / result-ready | final `reply --close --queue-id <id> --message-id <uuid>` only when explicit close intent exists | yes, only with explicit close |
| failure/stall | emit diagnostic / `needs_info` / escalation; do not terminal-fail by age alone | no by default |

ACK, progress, and result are communication lifecycle events. They must not be
inferred from free-form LLM prose, Discord projection, or notify fallback. Final
closure requires explicit close/cancel/supersede/fail semantics per #426.

## Current Implementation Gap

As of this PR, state_daemon still observes live `received` / `in_progress` work
and reclaims expired `received` claims, but it does not execute the full control
path:

```text
received -> in_progress -> done/result-ready -> replied/closed
```

The current daemon can wake or observe queue rows, but it does not yet own a
Codex processing runner boundary for `received`, `in_progress`, or result-ready
work.

#433 / `invoke_codex_runner` references are design intent unless and until a
separate implementation PR lands the actual planner/action/adapter code. This
PR alone must not be treated as production activation.

## Actionable Selection Policy

First slice keeps FIFO claim semantics for transport compatibility, but the
runner result must make actionable retained work visible:

- `message_type='instruction'` and request-like messages are considered
  actionable.
- Ordinary notices and chats may still be claimed by FIFO in this slice.
- If older non-action rows hide a newer actionable request, the runner must not
  silently claim and ignore the older row. It should either ACK/process it or
  report a visible policy gap.

Follow-up #426/#439 work should add a lifecycle-aware view that can answer:

```text
What actionable communication item is waiting on this agent?
```

without overloading `message_queue.status` or turning all chat into tasks.

## Implementation Plan

1. Keep `aun codex-runner` as the public script entrypoint.
2. Add a small lifecycle-oriented wrapper or mode only after #426 event names
   are approved. Until then, use `reply --no-close` as the ACK/progress bridge.
3. Persist retained work in runner-local state before invoking long-running
   Codex work.
4. Teach the caller/harness to require explicit final close using retained
   `queue_id/message_id`.
5. Add diagnostics that report unresolved retained rows and notify fallback
   rows that did not close the original request.

Likely implementation touch points:

- `bin/aun/codex-runner.ts`
- `bin/aun/reply.ts`
- `tests/contract/test_aun_codex_runner.test.ts`
- new diagnostics or lifecycle view tests under `tests/contract/`
- later #426 lifecycle module under `core/`

## Next Code PR Target

The next #439 implementation PR should add actual state_daemon planner/action
boundaries and execution adapters:

- `invoke_codex_runner` for `pending + eligible/idle Codex runtime`
- `invoke_processing_runner` or equivalent for `received -> in_progress`
- `invoke_result_runner` / `invoke_final_reply` or equivalent for result-ready
  / explicit-close handling
- duplicate runner prevention for busy/open-claim agents
- controlled adapter command construction, no natural-language tmux prompt for
  Codex runtime
- failure/stall path as diagnostic / `needs_info` / escalation, not age-based
  terminal fail
- tests for planner selection and execution boundaries across `pending`,
  `received`, `in_progress`, and done/result-ready states

Suggested implementation files:

- `core/state-daemon/action-planner.ts`
- `core/state-daemon/index.ts`
- `core/state-daemon/types.ts`
- new `core/state-daemon/codex-runner-adapter.ts`
- `bin/state-daemon.ts`

Suggested tests:

- `tests/contract/state-daemon/test_state_action_matrix.test.ts`
- new `tests/contract/state-daemon/test_codex_runner_adapter.test.ts`
- new `tests/contract/state-daemon/test_codex_runner_dispatch.test.ts`
- tests covering `received`, `in_progress`, and done/result-ready paths
- existing TUI wake tests proving `wake_pending` is unchanged

## Product Boundary

AUN owns communication completeness only: who has the next communication
responsibility, whether a request/question/result is still open, and which
explicit lifecycle event closes it.

AUN must not absorb Shirube-style project management semantics such as backlog
ownership, project decomposition, priority planning, capacity, milestones, or
long-running workflow orchestration outside a specific AUN communication
thread.

## Test Plan

Existing tests already cover the transport minimum:

- pending work is claimed and retained by `aun codex-runner`
- optional ACK uses `--no-close`
- final close remains explicit after ACK/progress
- identity mismatch fails before receiving work
- partial ACK arguments fail before receiving work

First #439 additions should add:

- retained `message_type='instruction'` is surfaced as actionable in runner
  output
- older non-action row before newer instruction is visible in diagnostics
- notify fallback linked to a request does not close the original queue row
- unresolved retained row can be reported by `queue_id/message_id`
- final close after long work uses the retained IDs, not current active claim

## Acceptance For This Slice

- Fresh `aun` namespace instructions and hooks no longer point users only at
  legacy `agent-comms` tool names.
- A script can claim one pending Codex row without an LLM tool-choice decision.
- ACK/progress cannot close the row.
- The original `queue_id/message_id` remains available for final explicit close.
- Notify fallback remains non-terminal and visible.
- The design does not introduce broad work-management semantics into AUN.
