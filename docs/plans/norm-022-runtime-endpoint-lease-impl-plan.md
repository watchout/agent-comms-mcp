# NORM-022 Runtime Endpoint Lease Implementation Plan

Date: 2026-05-27
Phase: MVP internal normalization
Slice: NORM-022
Status: Pre-implementation audit request packet

## Goal

Move runtime readiness, status, cleanup, and restart decisions away from tmux
or raw port observations and onto DB-backed runtime endpoint lease evidence.

The implementation must preserve the current internal fleet while changing the
authority model:

```text
agent_id -> connector_instance -> runtime_instance -> endpoint lease -> health
```

tmux, launchd, systemd, containers, direct processes, and future remote workers
are supervisor adapters. They are diagnostics and control handles, not identity
or channel ownership.

## Source Artifacts

- `docs/design/aun-normalization-roadmap.md`
- `docs/design/aun-normalization-wbs.md`
- `docs/spec/norm-022-runtime-endpoint-lease-supervisor-adapter-impl.md`
- `docs/operations/agent-role-routing-map.md`
- `docs/SPEC-INDEX.md`

## Governance Route

CEO directive on 2026-05-27 sets the NORM-022 review chain:

| Gate | Agent |
|---|---|
| L1 pre-implementation audit | `devauditor` |
| L2 implementation audit | `l2auditor` |
| L3 approval | `cto` |

The current action is L1 pre-implementation audit. L2 and L3 are recorded here
so the later implementation and approval gates do not drift back to the default
role map.

## Implementation Order

1. Add read-only endpoint lease evidence projection.
   - Prefer existing `agent_runtime_instances` and `control_plane_leases`.
   - Store endpoint kind, bind address, endpoint URI, supervisor type, and
     supervisor id as metadata where a dedicated table is not yet justified.
   - Do not store raw tokens or provider secrets.
2. Update status/read model.
   - `bot_status` reports connector, runtime heartbeat, endpoint lease, health,
     and supervisor evidence in that order.
   - tmux/session/port details are shown as diagnostic evidence only.
3. Add safe cleanup/restart gates.
   - Missing endpoint lease means dry-run/refuse by default.
   - Destructive cleanup requires stale heartbeat, endpoint lease ownership,
     fencing evidence, and process mismatch evidence.
4. Add strict-doctor coverage.
   - Active connector without runtime endpoint lease fails strict doctor.
   - Stale/conflicting runtime or supervisor evidence fails with row ids.
5. Add the frozen merge-gate contract fixtures named below. These fixtures are
   executable and must all pass before the implementation PR can merge.

## Frozen Merge-Gate Fixture Contract

NORM-022 uses one canonical fixture list across this implementation plan, the
impl contract, and WBS. The list intentionally subsumes the L1 audit shorthand
(`healthy`, TTL expiry, supervisor down, duplicate lease, restart, disable)
plus the acceptance-critical cases already present in the original plan.

Implementation must provide executable fixtures for:

1. `healthy_endpoint_lease`: connector active, runtime heartbeat fresh,
   endpoint lease active, readiness probe ok.
2. `missing_lease_refusal`: an active connector without endpoint lease evidence
   fails strict doctor and cleanup/restart dry-run refuses action.
3. `stale_ttl_expiry`: stale heartbeat or expired endpoint lease is detected,
   reported with row ids, and does not become destructive without fencing proof.
4. `duplicate_active_lease_fenced`: duplicate active endpoint holders fail
   closed until one holder is expired, revoked, or fenced out.
5. `supervisor_down_fail_closed`: supervisor evidence down or missing cannot be
   treated as authority by itself; readiness/liveness fails closed.
6. `restart_gated_by_lease_heartbeat_fencing`: restart/cleanup can proceed only
   when endpoint lease ownership, stale heartbeat, fencing token, and process
   mismatch evidence all agree.
7. `disabled_or_revoked_fail_closed`: disabled agent, connector, credential,
   binding, or revoked lease prevents delivery/restart eligibility.
8. `multi_channel_single_runtime`: one runtime can serve multiple channel
   bindings without creating one session per channel.
9. `tmux_diagnostics_only_for_tmux_supervisor`: tmux diagnostics are emitted
   only when `supervisor_type='tmux'`; missing tmux is not a blocker for
   launchd, systemd, direct process, stdio, or remote runtimes.

Any implementation PR that changes the fixture names, drops a fixture, or moves
coverage out of the merge gate must return to pre-implementation audit.

## Out Of Scope

- Full orchestration.
- Complete tmux removal.
- Raw token storage in DB.
- Public OAuth/OIDC.
- Remote agent delivery.
- Multi-region or HA scheduling.
- Vault migration.
- Enterprise UI.

## Pre-Implementation Audit Request

Please audit whether this slice is safe to move from spec/plan to
implementation.

Review questions:

1. Does the plan keep the authority boundary correct: DB endpoint lease and
   heartbeat evidence first, supervisor/port observations second?
2. Is the rollout mixed-fleet safe, especially while some runtimes still lack
   endpoint lease evidence?
3. Are the cleanup/restart gates strict enough to prevent killing a live holder
   from `lsof`, port, or tmux evidence alone?
4. Is the frozen merge-gate fixture contract sufficient for the MVP risk, and
   does it cover every destructive cleanup/restart path?
5. Is any schema change required before implementation, or is metadata on
   existing tables acceptable for the first PR?
6. Is the POST_MERGE evidence list sufficient: migration status if any,
   `bot_status`, strict doctor output, cleanup dry-run, runtime/channel smoke,
   and DB rows?

## Stop Conditions

Do not start implementation if any of these are true:

- The audit rejects metadata-only endpoint lease representation.
- The cleanup/restart gate cannot identify stale holder and fencing evidence.
- The frozen fixture list drifts between the plan, impl contract, and WBS.
- The plan requires raw token reads in status, doctor, or cleanup paths.
- `git diff --check` fails on the spec/plan docs.
- The reviewer cannot determine which DB rows prove readiness.

## POST_MERGE Evidence To Capture

- Migration status or explicit "no migration" statement.
- `bot_status` output for at least one active Discord-capable runtime.
- Strict doctor output for the target runtime/connector checks.
- Cleanup dry-run showing refusal when endpoint lease evidence is missing or
  insufficient.
- Runtime/channel smoke evidence showing one runtime can serve more than one
  channel without one-session-per-channel behavior.
- Relevant DB row ids for runtime instance, lease, connector, and channel
  binding.
