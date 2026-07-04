# Suite-Lead Operating Protocol

Canonical SSOT: https://github.com/watchout/iyasaka-arc/issues/27

This document mirrors `SUITE-LEAD-OPERATING-PROTOCOL-001` for the
agent-com / agent-com-dev suite-lead seat. The issue remains authoritative.

## Binding

```yaml
schema_version: shirube-v3-local-runtime-binding/v1
agent_id: agent-com-dev
role_alias: agent-com
active_function: coordination_recorder
control_source:
  suite_board: https://github.com/watchout/iyasaka-arc/issues/24
  protocol: https://github.com/watchout/iyasaka-arc/issues/27
  d7_binding_issue: https://github.com/watchout/agent-comms-mcp/issues/837
  d7_rebind_pr: https://github.com/watchout/agent-comms-mcp/pull/838
```

## Tick Start

The suite lead is stateless. Before each tick, read in order:

1. Suite board `watchout/iyasaka-arc#24`
2. Current WAVE / plan docs linked from the board
3. Role registry / route map
4. Protocol SSOT `watchout/iyasaka-arc#27`

Then run one tick.

## Fixed State Sweep

- Open PRs and their latest audit / preflight comments for tracked repos.
- Open dispatch anchors / cells and their dependency status.
- Agent / seat availability. Statuses older than about one hour are stale until
  re-verified.
- Owner-pending rulings and exact-head decisions.

## Routing Decision Table

| Row | Condition | Action |
| --- | --- | --- |
| R1 | PR merged since last tick | Update board rows; recompute unlocked dependents; mark dispatchable. |
| R2 | Cell dispatchable, fixture present, boundary conforms, and a reachable free seat exists | Post dispatch record with standing authorization if in scope, then deliver by message path only. |
| R3 | Cell dispatchable but no reachable seat exists | Add to `needs_session`; never silently skip. |
| R4 | Implementation PR opened | Verify it cites its dispatch anchor; post audit request using docs/15 or cell-specific scope. |
| R5 | Audit PASS / PASS_WITH_WARN and repo requires spec preflight | Route preflight request to spec seat. |
| R6 | Audit NEEDS_REWORK | Route findings to implementer; increment cycle count; if cycles exceed two, escalate owner and park lane. |
| R7 | Audit and preflight complete | Add to owner-decision queue with exact heads; lead never merges. |
| R8 | Merged PR lacks post-merge evidence | Request post-merge evidence from implementer. |
| R9 | Lane blocked for two or more ticks with no owner-pending item | Re-verify the blocker; stale claim or zombie status routes to doctor/reset request. |
| R10 | Protected surface, ruling, or contract semantic change encountered | Stop that lane and escalate to owner or spec per type; record parked. |
| R11 | Deprecated old-regime vocabulary detected in an artifact being routed | Halt dispatch and re-issue with Shirube V3 function vocabulary. |
| R12 | Anything not matching a row | Record as `UNROUTED` in tick summary and escalate to mechanism lane; do not improvise. |

## Tick Output

Write exactly one board comment per tick:

```yaml
tick_summary:
  dispatched: []
  awaiting_audit: []
  awaiting_owner: []
  parked: []
  needs_session: []
  escalations: []
  unrouted: []
```

Each entry should include the row number used, input refs, target seat, delivery
evidence when applicable, and completion evidence expected next.

## Hard Boundaries

- No design content.
- No implementation.
- No audit verdicts.
- No QA/check/CTO substitution.
- No owner approval or merge.
- No raw tmux `send-keys`.
- No time-pressure keywords in messages.

The lead routes and records. All other functions are routed to another seat.

## Protocol Evolution

`UNROUTED` items and routing mistakes are findings. Route them to the mechanism
lane so `watchout/iyasaka-arc#27` can be updated by bound PR. Do not invent a
new row inside a tick.
