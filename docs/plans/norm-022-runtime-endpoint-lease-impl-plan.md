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
- `docs/SPEC-INDEX.md`

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
5. Add contract fixtures.
   - healthy lease
   - missing lease
   - stale lease
   - conflicting supervisor evidence
   - multiple channels served by one runtime
   - tmux diagnostics only when `supervisor_type='tmux'`

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
4. Are the acceptance fixtures sufficient for the MVP risk?
5. Is any schema change required before implementation, or is metadata on
   existing tables acceptable for the first PR?
6. Is the POST_MERGE evidence list sufficient: migration status if any,
   `bot_status`, strict doctor output, cleanup dry-run, runtime/channel smoke,
   and DB rows?

## Stop Conditions

Do not start implementation if any of these are true:

- The audit rejects metadata-only endpoint lease representation.
- The cleanup/restart gate cannot identify stale holder and fencing evidence.
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
