# Agent Identity / Runtime Foundation

Date: 2026-05-22

## Decision

`agent_id` remains the local canonical identity used by existing message,
channel, queue, and audit tables. AUN also introduces `agent_uri` as the stable
address used by UI, federation, and future external agents.

The identity is not the same thing as the workspace, LLM runtime, process, or
Discord adapter. Those concepts are separate records:

- `agents`: who the agent is, its local `agent_id`, global `agent_uri`, trust
  state, and authentication subject.
- `agent_workspaces`: where the agent works, such as a local repository path.
- `agent_workspace_bindings`: which identities are allowed to operate in a
  workspace.
- `agent_runtime_instances`: what is currently running for an identity, such
  as Codex, Claude Code, a local tmux process, or a future remote worker.
- `connector_instances`: provider-facing connector processes that can speak to
  Discord, Slack, webhook, or future AUN-native surfaces.
- `channel_connector_bindings`: which connector roles are allowed to handle a
  channel without requiring one session per channel.
- `control_plane_leases`: short-lived worker claims for connector, channel
  binding, queue partition, or runtime scopes.
- `agent_endpoints`: how the identity can be reached.
- `agent_identity_keys`: public keys and fingerprints for future signed
  external identity.

Local-only operation remains the only enabled runtime mode for this phase.
External/federated agents are a schema and security design target, not enabled
behavior.

## Identity Model

Local identity:

```text
agent_id:  agent-mem-dev
agent_uri: aun://default/agents/agent-mem-dev
```

`agent_id` is still used in:

- `channels.members`
- `channel_routing_policy.primary_agent_id`
- `channel_routing_policy.adapter_owner_agent_id`
- `message_queue.agent_id`
- `outbound_queue.consumer_agent_id`
- `audit_log.agent_id`

`agent_uri` is the durable address that can survive UI, remote endpoints, and
cross-environment registration. It must not encode a local path, tmux session,
or model provider.

## Runtime Model

An identity can have zero or more runtime instances. Only one runtime should be
active for a given adapter ownership role unless the channel policy explicitly
allows an HA setup.

Example:

```text
agents.agent_id: agent-mem-dev
agent_workspaces.local_path: /Users/yuji/Developer/agent-memory

agent_runtime_instances:
  runtime_engine: claude-code
  runtime_kind: local_tmux
  session_name: discord-agent-mem
  status: stopped

agent_runtime_instances:
  runtime_engine: codex
  runtime_kind: local_tmux
  session_name: discord-agent-mem-codex
  status: active
```

This allows Claude Code, Codex, and future API workers to be swapped without
changing channel membership, audit history, or routing ownership.

## Security Baseline

The target bar is large-enterprise adoption. The foundation must support:

- Stable addresses: every non-human agent has an `agent_uri` that is treated as
  immutable once verified.
- Explicit trust state: `local`, `unverified`, `verified`, `revoked`,
  `disabled`.
- Explicit authentication method: `local`, `signed_key`, `mcp_token`, `oauth`,
  or `none`.
- Key rotation: public keys live in `agent_identity_keys`, not in channel
  policy.
- Revocation: `disabled_at`, endpoint `status`, and key `revoked_at` must be
  auditable.
- Least privilege: channel membership and outbound allowlists stay independent
  of runtime location.
- Runtime separation: a process restart, worktree change, or LLM swap must not
  change the identity.
- Endpoint evidence: remote or local endpoints are records, not implicit
  process environment assumptions.
- Auditability: registration, trust changes, endpoint changes, key changes,
  and routing changes must be audit events before UI-driven self-service.

## Phasing

Phase 0: local-only foundation.

- Add identity/runtime/workspace/endpoint/key schema.
- Keep existing CLI and relay behavior unchanged.
- Backfill `agent_uri` as `aun://<org_id>/agents/<agent_id>`.
- Keep external endpoints disabled by policy.

Phase 1: UI local registration.

- UI can create `agents`, `agent_workspaces`, and local runtime definitions.
- UI can bind identities to channels and set adapter owner roles.
- UI can show active runtime instances and stale/duplicate runtimes.

Phase 2: controlled external endpoint records.

- UI can register external endpoints as disabled/unverified.
- No message delivery to external endpoints until signature verification and
  allowlist policy are implemented.

Phase 3: signed remote agents.

- Remote agents prove control of `agent_uri` through registered public keys.
- Delivery requires channel allowlist, endpoint trust, key validity, and audit
  evidence.
- Revocation must stop new work immediately while preserving historical audit.

## Non-Goals For This Slice

- No remote delivery protocol is enabled.
- No UI is implemented.
- No automatic migration of existing tmux sessions into
  `agent_runtime_instances`.
- No change to current `agent_id` routing behavior.

## Operational Rule

`agent_id` answers "who is responsible?". `workspace_id` answers "where do they
work?". `runtime_instance_id` answers "what is running now?". `endpoint_uri`
answers "where can this identity be reached?". `agent_uri` answers "what is
this identity's stable address?".

The UI registration, search, and binding behavior is specified in
[`agent-registry-ui-spec.md`](./agent-registry-ui-spec.md).
The distributed worker/connector lease behavior is specified in
[`distributed-control-plane-foundation.md`](./distributed-control-plane-foundation.md).
