# NORM-022 Runtime Endpoint Lease and Supervisor Adapter Impl

Phase: MVP internal normalization
Slice: NORM-022
Status: Spec ready, pre-implementation audit next
Created: 2026-05-27

## Problem

Current local operations still mix three different concepts:

- logical identity: `agent_id`
- runtime supervision: tmux session, local process, launchd, systemd, container,
  or future remote worker
- network reachability: host, bind address, port, Unix socket, or URL

This causes channel-by-channel drift. A channel can have correct routing policy
while the selected connector has stale runtime evidence, disabled credential
evidence, an orphan process on the expected port, or a tmux session name that
does not match the running process.

The defect is not that tmux needs more special handling. The defect is that
tmux is still being treated as an operational authority in some paths. The
authority should be a runtime endpoint lease backed by DB heartbeat evidence.

## Decision

AUN must model reachable local runtimes through endpoint leases and supervisor
adapters.

The canonical chain is:

```text
agent_id
  -> connector_instance
  -> runtime_instance
  -> endpoint lease
  -> health probes
  -> channel binding / delivery eligibility
```

Supervisor-specific state is optional evidence:

```text
tmux session | launchd label | systemd unit | container id | k8s pod | nomad allocation
```

It must not be used as the identity, channel owner, or delivery authority.

## Scope

NORM-022 is the MVP local slice for endpoint leases. It is smaller than the v1
`LEASE-120` work. This slice does not introduce full high availability; it
creates the local control-plane shape required before strict doctor, smoke, and
safe cleanup can be honest.

In scope:

1. Represent endpoint ownership for active local runtimes.
2. Support TCP ports, Unix sockets, stdio-only runtimes, and remote URLs in one
   endpoint model.
3. Record supervisor type without making tmux required.
4. Make `bot_status` and cleanup report through runtime/endpoint evidence first.
5. Prevent cleanup or restart from acting on a port unless DB evidence proves
   the holder is stale or fenced out.
6. Keep channel count independent of session count.

Out of scope:

- full multi-node failover
- remote OAuth/OIDC runtime registration
- external agent delivery
- replacing the existing `control_plane_leases` table if it can be extended
- public network exposure for local bot endpoints

## Data Model

Prefer extending existing tables before adding new ones.

### `agent_runtime_instances`

Keep existing fields:

- `runtime_instance_id`
- `agent_id`
- `runtime_kind`
- `session_name`
- `process_id`
- `port`
- `endpoint_uri`
- `status`
- `last_seen_at`
- `metadata`

Add or standardize metadata keys:

- `supervisor_type`: `tmux`, `launchd`, `systemd`, `docker`, `kubernetes`,
  `nomad`, `process`, `stdio`, `remote`, or `none`
- `supervisor_id`: session name, unit name, container id, pod name, allocation id,
  or null
- `bind_address`: `127.0.0.1` by default for local TCP endpoints
- `endpoint_kind`: `tcp`, `unix_socket`, `stdio`, `http`, `streamable_http`,
  `remote_url`
- `startup_state`: `starting`, `ready`, `degraded`, `stopping`, `stopped`

### `control_plane_leases`

Use `lease_scope_type='runtime_instance'` for runtime holder leases and add a
separate endpoint lease scope in metadata until a dedicated table is justified.

Endpoint lease metadata:

```json
{
  "endpoint_kind": "tcp",
  "host_id": "local-host",
  "bind_address": "127.0.0.1",
  "port": 8811,
  "endpoint_uri": "http://127.0.0.1:8811",
  "supervisor_type": "tmux",
  "supervisor_id": "discord-aun"
}
```

If the existing scope enum must be extended, add:

- `lease_scope_type='runtime_endpoint'`
- `lease_purpose='endpoint'`

Do not store raw tokens or provider credentials in endpoint metadata.

## Runtime Lifecycle

1. Plan startup from DB profile:
   - agent id
   - connector instance
   - supervisor adapter
   - requested endpoint, or dynamic endpoint range
2. Acquire endpoint lease:
   - expire stale active lease atomically
   - assign fencing token
   - reserve endpoint before spawn where possible
3. Start through supervisor adapter:
   - tmux, launchd, systemd, Docker, Kubernetes, Nomad, direct process, or stdio
4. Runtime heartbeat writes:
   - pid/process evidence when available
   - endpoint evidence
   - supervisor evidence
   - commit/check-out evidence
5. Health probes classify:
   - startup: process is still initializing
   - readiness: connector can receive or send work
   - liveness: restart or cleanup is allowed
6. Cleanup/restart may act only when:
   - endpoint lease is expired or revoked
   - heartbeat is stale
   - fencing token does not match the current holder
   - live port owner is not the recorded process

## Supervisor Adapter Contract

Each supervisor adapter must implement the same control surface:

```text
plan(profile, endpoint_request) -> start_plan
start(start_plan) -> runtime_instance evidence
stop(runtime_instance_id, fence) -> terminal evidence
status(runtime_instance_id) -> supervisor evidence
logs(runtime_instance_id) -> optional operator output
attach(runtime_instance_id) -> optional operator handle
```

tmux is only one adapter. A missing tmux session is a blocker only for runtimes
whose `supervisor_type='tmux'`.

## Routing Rule

No channel should require its own session by default.

Channel routing resolves through connector evidence:

```text
channel -> channel_connector_binding -> connector_instance -> runtime_instance
```

Create another runtime/session only when there is a real isolation requirement:

- different provider token or provider identity
- different privilege boundary
- separate rate-limit/failure domain
- separate resource budget
- separate deployment lifecycle

Channel count alone is not a valid reason.

## Diagnostics

`bot_status` should report in this order:

1. agent id and connector status
2. runtime instance and heartbeat freshness
3. endpoint lease holder and fencing token freshness
4. supervisor evidence, if any
5. channel binding/readiness gaps

Examples:

```text
healthy: connector active, runtime heartbeat ok, endpoint lease active,
         readiness probe ok, supervisor tmux discord-aun attached

stale_endpoint: runtime heartbeat stale, endpoint lease expired,
                live port owner differs from recorded holder

supervisor_missing: supervisor_type=tmux, session missing, endpoint free
```

## Acceptance Criteria

1. `aun doctor --strict` detects an active connector without a live runtime
   endpoint lease.
2. `bot_status` can describe a process, tmux session, stdio runtime, or future
   service runtime without assuming tmux.
3. Cleanup refuses to kill a process on a port unless lease/heartbeat/fencing
   evidence proves it is stale.
4. A channel can bind to a connector that serves multiple channels from one
   runtime.
5. A fixture proves channel count does not create session count.
6. A fixture proves tmux-specific diagnostics trigger only for
   `supervisor_type='tmux'`.
7. Local TCP endpoints default to loopback bind unless explicitly configured
   otherwise.

## Frozen Merge-Gate Fixtures

The implementation cannot merge until these executable fixtures pass. This is
the canonical NORM-022 fixture gate and must remain aligned with
`docs/plans/norm-022-runtime-endpoint-lease-impl-plan.md` and
`docs/design/aun-normalization-wbs.md`.

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

Changing this list requires returning to pre-implementation audit.

## Rollout

Use the normal governed lane:

```text
spec -> impl contract/plan -> pre-implementation audit -> implementation
     -> implementation audit -> merge -> POST_MERGE verification
```

Implementation rollout order:

1. Audit this impl contract before merging behavior changes.
2. Add endpoint lease metadata and status reporting without changing restart
   behavior.
3. Change `bot_status` to read runtime/endpoint evidence before tmux details.
4. Change cleanup to dry-run by default when endpoint evidence is missing.
5. Add strict doctor checks and the frozen merge-gate fixtures.
6. Only after clean doctor, allow restart/cleanup to use endpoint lease fencing.
7. After merge, run POST_MERGE verification: migration status if any,
   `bot_status`, strict doctor checks for the targeted fleet, cleanup dry-run
   evidence, and one runtime/channel smoke path with DB rows recorded.

## References

- Kubernetes Service separates client-facing `port` from backend `targetPort`.
- Kubernetes probes separate startup, readiness, and liveness checks.
- systemd socket units supervise sockets via `ListenStream` and related fields.
- Docker port publishing is an explicit security boundary.
- Nomad manages dynamic port allocation and requires collision avoidance with
  OS ephemeral ranges.
