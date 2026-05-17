# Codex Runner State/Action Integration Plan

Issues: #421, #422, #426

## Status

Draft plan only. This document does not restart or mutate production
`state-daemon`, launchd, DB config, bot registry, or runtime supervision.

Implementation and production rollout remain gated on #421 L1/L2 review.

## Goal

Connect the #422 `aun codex-runner` receive loop to the #421 state/action
trigger without changing the runner's public lifecycle contract:

```text
pending DB row -> state/action planner -> Codex runner handoff
runner claim -> retained queue_id/message_id -> reply --no-close progress
final result -> reply --close --queue-id --message-id
```

The integration must keep DB state primary. It must not use natural-language
tmux prompt injection, `inbox`, Discord projection, or free-form prose as the
source of truth for work state.

## Current Baseline

`aun codex-runner` already provides the #422 local runner tick:

- claims work through the existing `aun drain` path
- enforces `AGENT_ID == AGENT_COM_EXPECTED_AGENT_ID`
- retains `queue_id` and `message_id`
- optionally emits ACK/progress through `reply --no-close`
- leaves final completion to explicit
  `reply --close --queue-id <id> --message-id <uuid>`

The #421 action planner currently distinguishes state outcomes such as
`wake_pending`, `observe_busy`, `reclaim_expired`, `runtime_skip`, and
`tmux_missing`. That works for TUI agents, where the daemon wakes a tmux pane.
Codex needs a separate runner action because Codex receive is script-driven.

## Proposed Boundary

Add an explicit Codex runner handoff action after #421 approval. The action
should be distinct from `wake_pending` so TUI wake behavior and Codex runner
behavior stay independently testable.

Proposed action name:

```text
invoke_codex_runner
```

The planner should produce this action only when all of the following are true:

- the queue row is `pending`
- the target agent exists
- the target agent runtime is the configured Codex runner runtime
- there is no active `received` or `in_progress` claim for the same agent

For Codex runtime, missing `tmux_session` must not become the blocker. Codex is
script-driven, so the runner handoff replaces tmux wake for that runtime.

The daemon execution layer should call a small runner adapter rather than build
shell strings inline. The adapter owns:

- command argv construction
- required environment variables
- timeout handling
- result metric labels
- logging without message-body leakage

Minimum adapter invocation:

```bash
AGENT_ID=<agent_id> \
AGENT_COM_EXPECTED_AGENT_ID=<agent_id> \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun bin/aun.ts codex-runner --agent-id <agent_id> --limit 1
```

ACK content should not be hard-coded into the production daemon in the first
split. The runner can claim and retain work first; Codex can then emit the
human-readable ACK/progress using `reply --no-close` from the active turn. If an
automatic ACK is later approved, it should be a typed lifecycle event from #426,
not an opaque daemon-authored prose reply.

## State/Action Mapping

| Queue state and context | Planned action | Expected effect |
|---|---|---|
| terminal status | `terminal_noop` | no runner or wake |
| `received` with live claim | `observe_received` | no duplicate handoff |
| `received` with expired claim | `reclaim_expired` | row returns to `pending`; next tick can hand off |
| `in_progress` | `observe_in_progress` | no duplicate handoff |
| `pending` with missing agent | `agent_missing` | alert/metric only |
| `pending` TUI runtime without tmux | `tmux_missing` | existing TUI diagnostic |
| `pending` TUI runtime with tmux | `wake_pending` | existing tmux wake path |
| `pending` Codex runtime with active claim | `observe_busy` | no duplicate handoff |
| `pending` Codex runtime without active claim | `invoke_codex_runner` | run one Codex runner tick |

This preserves the current TUI behavior while giving Codex a DB-primary
delivery mechanism.

## Non-Production Smoke Plan

Run only after #421 L1/L2 approval for the action boundary.

1. Use an isolated test DB or fixture schema, not the production DB.
2. Use a dedicated clean checkout for the smoke harness.
3. Seed a `pending` queue row for a Codex-runtime agent.
4. Seed the agent with no `tmux_session` to prove Codex does not depend on
   tmux wake.
5. Run the state/action planner or daemon harness with a fake runner executor.
6. Assert the planner emits `invoke_codex_runner`, not `tmux_missing` or
   `runtime_skip`.
7. Assert the adapter command includes matching `AGENT_ID` and
   `AGENT_COM_EXPECTED_AGENT_ID`.
8. Run `aun codex-runner --agent-id <agent> --limit 1` against the fixture DB.
9. Assert the row is claimed and the runner output retains `queue_id` and
   `message_id`.
10. Emit a fixture ACK with `reply --no-close` and assert
    `work_closed=false`.
11. Emit fixture completion with
    `reply --close --queue-id <id> --message-id <uuid>` and assert
    `work_closed=true`.
12. Verify no `STALE_DISPATCH` rows, no production launchd change, and no bot
    registry mutation.

## Test Plan

Unit tests:

- planner returns `invoke_codex_runner` for `pending` Codex runtime with no
  active claim
- planner returns `observe_busy` for Codex runtime with an active claim
- planner keeps existing TUI `wake_pending` and `tmux_missing` behavior
- planner keeps `received`, `in_progress`, terminal, and unknown-state
  observations unchanged

Adapter tests:

- command argv is structured, not natural-language tmux input
- `AGENT_ID` and `AGENT_COM_EXPECTED_AGENT_ID` are equal
- `DATABASE_URL` can be injected by the caller and defaults to the approved
  socket form in local smoke docs
- non-zero runner exit maps to a non-terminal metric/result label
- logs redact message body content

Integration fixture:

- isolated DB seed creates one pending Codex row
- runner tick claims exactly that row
- retained metadata includes `queue_id` and `message_id`
- `reply --no-close` does not close work
- final `reply --close` closes the intended queue row

Manual non-production smoke:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun bin/aun.ts codex-runner --agent-id codex-aun --limit 1
```

Production restart is not part of this smoke.

## Risks And Dependencies

- #421 must approve the new action kind and execution boundary before daemon
  implementation.
- #426 should supply typed lifecycle events before automatic daemon-authored
  ACKs are enabled.
- The runner adapter must avoid duplicate claims when the daemon loops quickly;
  the existing active-claim check remains the first guard.
- A daemon supervisor or restart-readiness issue can block rollout even if this
  action plan is correct.
- Production `state-daemon` restart remains separate operational work.

## Future Implementation Files

Likely implementation touch points after approval:

- `core/state-daemon/action-planner.ts`
- `core/state-daemon/index.ts`
- new `core/state-daemon/codex-runner-adapter.ts`
- `bin/aun/codex-runner.ts`
- `tests/contract/state-daemon/test_state_action_matrix.test.ts`
- new runner adapter contract tests under `tests/contract/state-daemon/`

## Acceptance Criteria

- Codex pending rows are handled by runner handoff, not tmux wake.
- TUI agents keep the existing wake path.
- Codex runner handoff is non-terminal and idempotent under active-claim
  observation.
- Runner output preserves `queue_id/message_id` through final close.
- ACK/progress use `reply --no-close`; only final completion uses
  `reply --close`.
- Smoke and tests run against isolated fixtures and do not mutate production
  daemon state.
