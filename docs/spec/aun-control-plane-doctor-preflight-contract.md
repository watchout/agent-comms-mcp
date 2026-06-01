# AUN Control-Plane Doctor And Preflight Contract

> Status: proposed
> Slice: CP-70 doctor/preflight/repair
> Last updated: 2026-06-01

## Purpose

AUN must not restart or activate scheduler/runtime paths while known
control-plane defects remain in the durable queue, baton, turn, completion, or
projection state.

Earlier slices define how work is claimed, presented, turned, and completed.
CP-70 defines the deterministic doctor and preflight contract that decides
whether it is safe to activate automation, and which exact repair action is
allowed when it is not safe.

The doctor is a read-only diagnostic surface. Repair commands are explicit,
queue-id scoped, dry-run first, and audited. No LLM should be asked to repair a
loop by calling `next`, draining FIFO rows, or interpreting Discord text.

## Terms

| Term | Meaning |
|---|---|
| doctor finding | Stable, machine-readable diagnostic result with code, severity, subject, evidence, and repair hint. |
| preflight gate | Deterministic pass/fail check for a subsystem before activation or restart. |
| activation blocker | Finding that must be resolved before state_daemon, scheduler, or runtime runner activation. |
| repair action | Explicit deterministic command that mutates state to resolve one finding. |
| dry-run repair | Repair planning mode that returns the exact mutation/audit that would happen without changing state. |
| scoped repair | Repair requiring an exact durable identifier such as `queue_id`, `turn_id`, `baton_id`, or `conversation_id`. |

`queue doctor` may remain the existing CLI surface. This contract defines the
control-plane evidence and gates that implementation must cover before CP-80
scheduler activation.

## Product Invariants

1. Doctor checks are read-only.
2. Preflight fails closed when blocker findings exist.
3. Every blocker has a stable code and exact subject identifier.
4. Repair commands default to dry-run.
5. Mutating repair requires an exact identifier; bulk active-row repair is
   forbidden.
6. Active-row repair requires an explicit active-state flag and exact
   `queue_id` / `turn_id` / `baton_id` evidence.
7. Repair writes audit evidence with the original finding code.
8. A repair cannot ask an LLM to call `next`, inspect an inbox, or drain FIFO.
9. Split/chunked requests are grouped by canonical message/presentation
   evidence, not by provider prose.
10. Quarantine findings block scheduler activation until repaired or explicitly
    acknowledged by an operator policy.
11. Doctor/preflight must work without Discord connectivity.
12. Passing preflight is necessary but not sufficient for production activation;
    CP-80 owns the final activation step.

## Required Finding Shape

Implementation may use JSON, SQL rows, or another structured representation,
but each finding must expose this shape:

```ts
type ControlPlaneDoctorFinding = {
  code: ControlPlaneDoctorCode
  severity: 'info' | 'warning' | 'blocker'
  gate: 'runtime' | 'projection' | 'scheduler_activation' | 'repair'
  subject_type:
    | 'queue'
    | 'message'
    | 'conversation'
    | 'baton'
    | 'turn'
    | 'completion'
    | 'outbound'
    | 'agent'
    | 'channel'
  subject_id: string
  agent_id: string | null
  channel_id: string | null
  conversation_id: string | null
  baton_id: string | null
  queue_id: string | null
  message_id: string | null
  turn_id: string | null
  result_id: string | null
  evidence: Record<string, unknown>
  recommended_repair: ControlPlaneRepairHint | null
}

type ControlPlaneRepairHint = {
  command: string
  requires_execute_flag: boolean
  requires_exact_subject: true
  requires_active_override: boolean
  mutates_active_work: boolean
}
```

## Required Finding Codes

| Code | Severity | Meaning |
|---|---|---|
| `LOOP_PROMPT_BACKLOG` | blocker | Natural-language `next` / processing / wake-loop prompt remains queued or active. |
| `DRAIN_TO_TARGET_RISK` | blocker | Requested operation would require consuming unrelated FIFO rows to reach a target. |
| `SPLIT_REQUEST_GROUP_INCOMPLETE` | blocker | Transport/presentation fragments are incomplete for one canonical message. |
| `SPLIT_REQUEST_MULTIPLE_CLAIMABLE` | blocker | One logical instruction produced multiple claimable runtime work rows. |
| `STUCK_ACTIVE_QUEUE_ROW` | blocker | Queue row is active beyond policy with no valid turn/completion evidence. |
| `STALE_ACTIVE_TURN` | blocker | Active turn heartbeat/deadline is stale and recovery is required. |
| `DUPLICATE_ACTIVE_TURN` | blocker | More than one active turn exists for one queue row or baton. |
| `DUPLICATE_ACTIVE_BATON` | blocker | One open conversation has multiple active batons. |
| `COMPLETION_OUTCOME_MISSING` | blocker | Completed/active turn lacks a durable typed outcome. |
| `QUARANTINED_WORK` | blocker | Work is explicitly quarantined and must not be scheduled. |
| `OUTBOUND_PROJECTION_STUCK` | warning/blocker | Reply projection is pending/failed beyond policy after a reply outcome. |
| `CONTROL_PLANE_AUDIT_GAP` | warning/blocker | Required audit evidence is missing for a state transition. |
| `AGENT_IDENTITY_MISMATCH` | blocker | Queue/turn/runtime identity does not match expected agent ownership. |
| `CHANNEL_SCOPE_MISMATCH` | blocker | Queue/message/thread/channel identifiers do not belong to the same canonical channel scope. |

Implementations may add non-blocking informational codes, but must not rename or
overload the codes above.

## Preflight Gates

### Runtime Gate

`runtime` preflight must fail closed when:

- loop prompt backlog exists for the target agent
- active queue row has no valid turn or completion path
- stale or duplicate active turns exist
- active baton ownership conflicts exist
- agent/runtime identity evidence does not match
- quarantined work would be scheduled

### Projection Gate

`projection` preflight must fail closed or warn according to policy when:

- reply outcome exists but outbound projection is stuck
- split transport fragments would become multiple claimable rows
- canonical message/presentation evidence is incomplete
- channel/thread scope does not match the selected queue/message

### Scheduler Activation Gate

`scheduler_activation` preflight must fail closed when any blocker exists in the
runtime or projection gates for the activation scope. A clean scheduler
activation preflight must include:

- target agent set or fleet scope
- finding counts by code/severity
- exact blocker subjects
- timestamp and database identity
- operator-visible summary
- machine-readable JSON output

## Repair Contract

Repair commands must obey these rules:

- default to dry-run
- require an explicit `--execute` or equivalent for mutation
- require exact durable subject id
- reject active-row mutation unless the exact active subject and active override
  are supplied
- write audit evidence before or in the same transaction as mutation
- never repair by invoking a runtime or LLM prompt

Allowed repair families:

| Repair | Scope |
|---|---|
| close obsolete loop prompt | exact `queue_id`; active rows require active override |
| mark stale turn reclaimed | exact `turn_id`; requires stale heartbeat/deadline evidence |
| quarantine inconsistent work | exact `queue_id` or `turn_id`; blocks scheduler activation |
| relink canonical fragments | exact `message_id` or presentation group; only if deterministic evidence is complete |
| acknowledge missing projection | exact outbound/result id; records typed send-failure policy |

Bulk repair of active rows remains forbidden. Batch repair may only operate on a
set of inactive findings that were returned by the same doctor report and must
include the report id in audit evidence.

## Audit Evidence

Every mutating repair must write audit evidence with:

- finding code
- pre-repair doctor report id or generated diagnostic id
- subject type and subject id
- agent/channel/conversation/baton/queue/message/turn/result ids when present
- previous state and next state
- command name and dry-run/execute mode
- operator/runtime identity that executed repair
- timestamp
- reason
- failure code/detail when repair fails

Preflight itself should be auditable when it gates activation. A failed
activation preflight must include blocker codes and exact subjects.

## Tests Required For Implementation

Implementation PRs must include focused coverage for:

1. doctor emits stable structured findings with exact subject ids.
2. preflight exits non-zero while blocker findings exist.
3. loop prompt backlog blocks runtime and scheduler activation.
4. drain-to-target behavior is reported as `DRAIN_TO_TARGET_RISK`.
5. split/chunked request groups are diagnosed as incomplete or multiple
   claimable work.
6. stale active turn blocks runtime activation until reclaimed/quarantined.
7. duplicate active baton blocks scheduler activation.
8. missing completion outcome blocks completion/scheduler activation.
9. quarantined work blocks scheduling.
10. repair commands are dry-run by default and show exact intended mutation.
11. mutating repair requires exact subject id and writes audit evidence.
12. active-row repair is rejected without an active override and exact id.
13. repair never invokes `next`, `inbox`, state_daemon restart, or runtime prompt
    injection.
14. clean fixture returns zero blocker findings and preflight success.

## Non-Goals

- This contract does not implement CP-80 scheduler activation.
- This contract does not start or restart state_daemon.
- This contract does not define provider-specific Discord smoke tests.
- This contract does not replace CP-40C, CP-50A, or CP-60 data contracts.
- This contract does not allow bulk closure of active queue rows.

## Acceptance Criteria

CP-70 is complete when:

- doctor/preflight can deterministically block unsafe runtime or scheduler
  activation
- findings are structured, stable, and repairable by exact durable id
- repair is dry-run first, audited, and never LLM-driven
- split requests, loop prompts, stale turns, duplicate batons, missing outcomes,
  quarantine, and projection stalls are covered
- Discord or state_daemon activation can be delayed by machine-readable evidence
  instead of operator intuition
