# AUN runtime-health monitoring (M1)

Monitoring M1 is an observe-and-plan boundary. `bin/aun-watchdog.ts` reads
database/runtime evidence, evaluates seven independent health dimensions, and
writes machine-readable reports and local alert plans to stderr. It cannot
restart a runtime, request approval, change a queue, write the database, notify
a provider, or mutate tmux, launchd, systemd, an endpoint, or a host.

Control handoff: `CH-AUN-MONITORING-M1-20260721-001` in Issue #794.

## Health projection

Every report contains `agent_id`, the current `runtime_instance_id` when
available, `generated_at`, `aggregate_state`, and all seven dimensions:

1. `agent_runtime`: agent heartbeat plus runtime-instance state and heartbeat.
2. `supervisor_session`: tmux/supervisor session observation.
3. `endpoint_identity`: expected port owner and exact `AGENT_ID` identity.
4. `queue_actionable_receive`: queue placement and the matching runtime's
   memory-ready evidence.
5. `runtime_presentation_claim`: active presentation/claim evidence, kept
   separate from queue placement.
6. `ui_runner_reachability`: TUI pane or runner-surface reachability, kept
   separate from supervisor existence.
7. `provider_projection`: Discord connector projection when Discord is the
   configured surface.

Each dimension carries `applicable`, `state`, `reason_code`, `observed_at`,
`freshness_limit_seconds`, and exact `evidence_refs`. The only state vocabulary
is `HEALTHY`, `DEGRADED`, `DOWN`, and `UNKNOWN`. Aggregate precedence is:

```text
DOWN > UNKNOWN > DEGRADED > HEALTHY
```

A fresh heartbeat never overrides another dimension. A dimension is excluded
only when fresh positive profile/binding evidence proves it is not applicable.
Missing applicability evidence remains `UNKNOWN`.

Runtime-labelled observations are bound to the selected
`agent_runtime_instances.runtime_instance_id`. Supervisor and UI probes use
that row's `session_name`; endpoint probes use that row's `port`, or the port
from its `endpoint_uri` when `port` is absent. An agent profile is comparison
evidence only: a different profile session or port fails closed and the profile
target is never probed as though it belonged to the selected runtime. A claim
is healthy presentation evidence only when
`message_queue.claimed_runtime_instance_id` equals the selected runtime ID.

## Fail-closed reason table

| Condition | State | Canonical reason |
| --- | --- | --- |
| Missing observation or evidence ref | `UNKNOWN` | `EVIDENCE_ABSENT` |
| Invalid timestamp | `UNKNOWN` | `EVIDENCE_INVALID_TIMESTAMP` |
| Future timestamp | `UNKNOWN` | `EVIDENCE_FUTURE_TIMESTAMP` |
| Older than the freshness limit | `UNKNOWN` | `EVIDENCE_STALE` |
| Probe timeout | `UNKNOWN` | `PROBE_TIMEOUT` |
| Probe exception | `UNKNOWN` | `PROBE_EXCEPTION` |
| Probe completed and the target is absent | `DOWN` | domain reason such as `ENDPOINT_PORT_UNBOUND` |
| Expected and observed agent identities differ | `DOWN` | `IDENTITY_MISMATCH` |
| Non-applicability lacks positive evidence | `UNKNOWN` | `APPLICABILITY_EVIDENCE_MISSING` |
| Runtime and profile session differ | `UNKNOWN` | `RUNTIME_PROFILE_SESSION_MISMATCH` |
| Runtime and profile port differ | `UNKNOWN` | `RUNTIME_PROFILE_PORT_MISMATCH` |
| Runtime port and endpoint URI port differ | `UNKNOWN` | `RUNTIME_PORT_ENDPOINT_URI_MISMATCH` |
| Agent claim is not bound to the selected runtime | `UNKNOWN` | `CLAIM_RUNTIME_OWNERSHIP_UNPROVEN` |

The default freshness limit is 300 seconds and is configurable with
`AUN_WATCHDOG_CRASH_THRESHOLD_SEC`. Invalid or non-positive limits fail closed.

## Local alert plan

Alerts are plans printed locally; they are not deliveries. The canonical
dedupe key is the SHA-256 of `agent_id`, `runtime_instance_id`, and sorted
applicable `dimension:state:reason_code` tuples.

- A healthy aggregate is suppressed.
- The same dedupe key is suppressed for 300 seconds and becomes eligible again
  at the 300-second boundary.
- Each agent is capped at six emitted plans per rolling hour.
- History is process-local memory only. It is not persisted or written to the
  database.
- A plan includes all evidence refs and every non-healthy dimension.

## Running the observer

The process requires `DATABASE_URL`; all SQL in the observer is `SELECT`-only.

```bash
DATABASE_URL=<database> bun bin/aun-watchdog.ts
```

Each poll emits `runtime-health` and `runtime-health-alert-plan` JSON records to
stderr. Treat `UNKNOWN` as an evidence gap, not as authorization to recover.

## Explicitly out of scope

M1 does not execute recovery. Approval requests are M2, and owner-approved
restart execution is M3. Both require separate handoffs and owner decisions.
No M1 report, alert plan, test result, or PR state grants Ready, merge,
activation, canary, distribution, or rollout authority.
