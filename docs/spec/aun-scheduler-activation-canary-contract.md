# AUN Scheduler Activation And Discord Canary Contract

> Status: proposed
> Slice: CP-80 scheduler activation / Discord canary
> Last updated: 2026-06-01

## Purpose

AUN must only return automation and Discord-facing delivery through an explicit,
audited activation gate.

CP-40 through CP-70 define deterministic claim, runtime, turn, completion, and
doctor/preflight contracts. CP-80 defines when those pieces may be activated by
state_daemon or another scheduler, how the first Discord canary is scoped, and
what evidence is required to expand or roll back.

This contract is intentionally a gate. It does not restart state_daemon, enable
Discord traffic, or declare production recovery by itself.

## Terms

| Term | Meaning |
|---|---|
| scheduler activation | Enabling state_daemon or equivalent code to invoke receive/process/completion runners automatically. |
| activation scope | Exact agent/channel/runtime set allowed for scheduler action. |
| canary | Narrow activation scope used to prove DB, runner, outbound, and Discord projection behavior before expansion. |
| activation lease | Durable evidence that one scheduler owns activation for the selected scope. |
| rollback trigger | Stable condition that forces scheduler disablement or scope reduction. |
| expansion gate | Evidence required before adding agents, channels, or runtime paths to activation scope. |

## Product Invariants

1. Scheduler activation requires clean CP-70 preflight for the exact scope.
2. Activation scope must list agent ids, channel ids, runtime kinds, and enabled
   runner phases.
3. Activation must acquire a durable lease or equivalent fencing evidence.
4. One activation scope may have at most one active scheduler lease.
5. Activation starts in canary mode; fleet-wide activation is forbidden as the
   first step.
6. Discord connectivity is a projection canary, not the source of queue truth.
7. A canary must prove inbound, claim, turn, completion, outbound, and audit
   evidence before expansion.
8. Any blocker from CP-70 during canary triggers fail-closed pause or rollback.
9. Rollback must not delete audit evidence or bulk-close active work.
10. Expansion requires a fresh preflight and prior canary evidence.
11. Operators must be able to disable scheduler activation without restarting
    every runtime.
12. No activation command may ask an LLM to call `next`, inspect `inbox`, or
    recover by natural-language prompt injection.

## Required Activation Shape

Implementation may store activation records in a table, config document, or
lease registry, but the durable shape must include:

```ts
type SchedulerActivationRecord = {
  activation_id: string
  scope_name: string
  mode: 'canary' | 'expanded' | 'disabled'
  agents: string[]
  channel_ids: string[]
  runtime_kinds: Array<'codex' | 'claude' | 'openclaw' | 'other'>
  runner_phases: Array<'receive' | 'process' | 'completion'>
  scheduler_owner_id: string
  activation_lease_id: string
  fencing_token: number | string
  preflight_report_id: string
  started_at: string
  disabled_at: string | null
  disable_reason_code: string | null
  rollback_policy_id: string
  expansion_parent_activation_id: string | null
}
```

Rules:

- `mode='disabled'` is terminal for that activation record.
- scope changes require a new activation record.
- `preflight_report_id` must reference a CP-70 clean report for the same scope.
- runner phases may be enabled incrementally; completion must not activate
  before receive/process evidence exists for the same scope.
- Discord channel ids are projection scope evidence only; queue ownership still
  comes from AUN DB state.

## Canary Sequence

The first activation for a scope must proceed in phases:

1. Read-only preflight:
   - CP-70 runtime/projection/scheduler gates return no blockers.
   - target agents, channels, runtime kinds, and runner phases are listed.
2. Receive canary:
   - one targeted or policy-selected pending row is claimed deterministically.
   - no FIFO drain-to-target behavior occurs.
3. Process canary:
   - turn ledger row is created before runtime invocation.
   - runtime adapter receives queue/baton/turn context.
4. Completion canary:
   - typed completion outcome is recorded.
   - reply/no-reply/handoff/retry/quarantine is applied by deterministic code.
5. Projection canary:
   - outbound response is linked to source queue/result evidence.
   - Discord projection success or typed send-failure evidence is recorded.
6. Audit canary:
   - queue, baton, turn, completion, outbound, and scheduler audit events are
     linkable by durable ids.

Expansion may only occur after all enabled phases pass for the prior canary.

## Rollback Triggers

| Code | Action |
|---|---|
| `ACTIVATION_PREFLIGHT_BLOCKED` | Do not activate; retain report evidence. |
| `ACTIVATION_LEASE_CONFLICT` | Abort activation; do not start scheduler work. |
| `ACTIVATION_SCOPE_MISMATCH` | Disable activation record and require new scope. |
| `CANARY_FIFO_DRAIN_DETECTED` | Pause scheduler and quarantine affected work. |
| `CANARY_TURN_LEDGER_MISSING` | Pause process/completion phases. |
| `CANARY_COMPLETION_OUTCOME_MISSING` | Pause completion phase and quarantine work. |
| `CANARY_PROJECTION_FAILED` | Pause expansion; keep DB truth and record typed send failure. |
| `CANARY_AUDIT_GAP` | Pause expansion until audit link is repaired. |
| `CANARY_LOOP_PROMPT_DETECTED` | Disable scheduler for scope and require CP-70 repair. |
| `CANARY_DUPLICATE_ACTIVE_WORK` | Disable scheduler for scope and quarantine affected work. |

Rollback must be a deterministic state change. It must not restart state_daemon
as a repair, delete rows, or bulk-close active work.

## Discord Canary Requirements

Discord canary is allowed only when:

- activation scope is a small allowlist of channels and agents
- outbound projection can be correlated to `source_queue_id` and completion
  `result_id`
- inbound Discord messages are stored as canonical AUN messages before runtime
  claim
- transport chunks do not create multiple claimable runtime rows
- failures can be represented as typed send/projection outcomes
- rollback can disable scheduler activation for the scope without deleting DB
  state

Discord message visibility is not sufficient proof. The required proof is DB
evidence plus connector projection evidence.

## Audit Evidence

Activation, canary, expansion, and rollback must write audit evidence with:

- `activation_id`
- scope name and exact agents/channels/runtime kinds/phases
- scheduler owner id
- lease id and fencing token
- preflight report id
- canary queue/message/turn/result/outbound ids
- previous and next activation mode
- rollback trigger code when present
- Discord projection id or typed send-failure evidence when present
- operator id or automation owner
- timestamp

## Tests Required For Implementation

Implementation PRs must include focused coverage for:

1. activation fails without a clean CP-70 preflight report.
2. activation requires exact agent/channel/runtime/phase scope.
3. duplicate active scheduler lease fails with `ACTIVATION_LEASE_CONFLICT`.
4. first activation cannot start in fleet-wide expanded mode.
5. canary receive does not drain FIFO to reach a target.
6. process phase requires CP-50A turn evidence before runtime invocation.
7. completion phase requires CP-60 typed outcome evidence.
8. Discord projection canary links outbound evidence to source queue/result.
9. rollback trigger disables activation without deleting rows or bulk-closing
   active work.
10. CP-70 blocker during canary pauses or disables scheduler for the scope.
11. expansion requires fresh preflight plus prior canary evidence.
12. activation/rollback commands never invoke `next`, `inbox`, runtime prompt
    injection, or state_daemon restart as repair.

## Non-Goals

- This contract does not implement scheduler activation.
- This contract does not restart state_daemon or connect Discord.
- This contract does not define the final operations rollout calendar.
- This contract does not replace CP-70 doctor/preflight.
- This contract does not allow broad fleet activation as the first step.

## Acceptance Criteria

CP-80 is complete when:

- scheduler activation is exact-scope, leased, preflight-gated, and auditable
- canary mode proves receive/process/completion/projection/audit evidence before
  expansion
- rollback is deterministic and does not rely on LLM prompts or restarts
- Discord is restored as a projection surface only after DB evidence is clean
- expansion requires fresh evidence rather than operator intuition
