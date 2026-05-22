# Distributed Control Plane Foundation

Date: 2026-05-22

Development principles: [`aun-development-principles.md`](./aun-development-principles.md).

## Decision

AUN should not use a single central router process for all channels, and it
should not require one dedicated tmux/session per channel. The durable
coordination point is the database; execution is handled by a pool of runtime
and connector workers that directly claim eligible work.

This is closer to a controller/lease model than to a blockchain or P2P ledger:

- no consensus protocol
- no replicated append-only chain
- no node-to-node routing dependency
- no single "post office" process that must inspect and forward everything

The database stores intent, queue state, leases, and audit evidence. Workers
run the same code with different registered capabilities and claim work through
bounded leases and row-level queue claims.

## Control Plane Objects

### `agents`

Stable logical identity. This answers "who is responsible?" and remains the
canonical queue and audit identity for compatibility.

### `agent_runtime_instances`

Concrete execution. This answers "what is running now?" Examples include a
Codex tmux session, Claude Code tmux session, local script runner, or future
API worker.

One `agent_id` can have multiple runtime instances. This avoids the OpenClaw
failure mode where one ingress/session becomes the bottleneck for all work.

### `connector_instances`

Provider-facing connector process or credential boundary. This answers "which
worker can speak to the external provider?" Examples:

- Discord gateway connector
- Slack connector
- webhook connector
- future AUN-native connector

A connector is not the same as an agent identity. It is an operational delivery
and receive capability that can be leased, drained, disabled, and failed over.

### `channel_connector_bindings`

The binding between a channel/surface and a connector role. This answers "which
connector role is allowed to handle this channel?"

Bindings carry:

- provider
- role: inbound, outbound, bidirectional, projection, presence, or worker
- priority
- max concurrency
- ordering scope: none, channel, thread, or custom
- status

This lets a small number of connector workers cover many channels without
making one worker the universal bottleneck.

### `control_plane_leases`

Short-lived claims over connector instances, channel bindings, queue partitions,
or runtime instances. This answers "who is currently allowed to act for this
scope?"

Leases must have:

- scope type and scope id
- purpose
- holder agent/runtime/connector
- fencing token
- heartbeat
- expiration
- terminal status

Only one active lease exists per `(scope_type, scope_id, purpose)`. Lease
acquisition must assign a fresh fencing token and must atomically mark expired
active leases as expired before takeover. Expired or released leases allow
another worker to take over.

## Queue Compatibility

Existing routing remains compatible:

- `message_queue.agent_id` remains the logical recipient.
- `outbound_queue.consumer_agent_id` remains the legacy delivery consumer.
- `channel_routing_policy.adapter_owner_agent_id` remains the legacy channel
  owner.

The distributed control plane adds nullable references that future workers can
use without breaking existing bots:

- `message_queue.assigned_runtime_instance_id`
- `message_queue.claimed_runtime_instance_id`
- `message_queue.channel_binding_id`
- `message_queue.ordering_key`
- `outbound_queue.delivery_connector_instance_id`
- `outbound_queue.channel_binding_id`
- `outbound_queue.claimed_runtime_instance_id`

Current code may leave these columns null. New workers can opt in gradually.

## Claim Model

Workers claim work directly from the queue. There is no central process that
must receive all messages and re-route them.

Target model:

```text
channel_connector_bindings
  -> control_plane_leases
  -> message_queue / outbound_queue claim
  -> runtime worker processes work
  -> audit and heartbeat update durable state
```

The queue claim operation should use atomic row locking semantics where the
database supports it. Work that requires order uses `ordering_key` and
`ordering_scope`; unrelated work can proceed in parallel.

## Failure Model

- A worker crash leaves queue rows and leases in durable state.
- Lease expiration makes the scope claimable by another worker.
- Fencing tokens prevent stale workers from committing after a newer lease.
- Connector disablement stops new claims without deleting history.
- Runtime instance replacement does not change `agent_id` or audit history.

## Security Baseline

The model is designed for a zero-trust enterprise deployment path:

- no implicit trust from local path, tmux name, or Discord identity
- connector and runtime scopes are explicit records
- connector status and trust status are revocable
- leases are auditable
- external endpoints remain disabled until authenticated and verified
- channel membership, connector binding, and projection identity are separate
  policy layers

## Implementation Status

The first slice added the schema and design foundation:

- `connector_instances`
- `channel_connector_bindings`
- `control_plane_leases`
- queue reference columns for future runtime/connector claims

The next implementation slice adds script-controlled lease primitives:

- acquire an active lease for a scope and purpose
- atomically expire stale active leases before takeover
- assign monotonic fencing tokens per scope and purpose
- heartbeat active leases only when the fence and optional holder still match
- verify a fence before worker-side commits
- release active leases without allowing expired stale holders to mutate state

These primitives do not change live routing behavior by themselves. Existing
`consumer_agent_id` and `channel_routing_policy` behavior remains the active
path until a channel or connector explicitly opts into lease-backed workers.

## Acceptance Criteria

- Multiple runtime instances can be represented for the same `agent_id`.
- Multiple connectors can cover different channel bindings without duplicating
  code.
- A channel can point at connector capability rather than a hard-coded tmux
  session.
- The schema can represent a worker-pool lease without a central router.
- Existing send/receive behavior remains compatible when new columns are null.
- Future implementation can move one channel or connector at a time from
  `consumer_agent_id` to connector/runtime leases.
