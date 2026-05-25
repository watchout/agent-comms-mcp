# Agent Registry UI Spec

Date: 2026-05-22

## Purpose

This spec defines how the future UI registers, searches, and binds agents while
the runtime remains local-only. It builds on
[`agent-identity-runtime-foundation.md`](./agent-identity-runtime-foundation.md)
and keeps the critical invariant: paths, processes, endpoints, and LLM engines
are discovery and runtime evidence, not identity.

## Core Rule

Every UI action must resolve to a stable identity before it changes routing:

```text
agent_id  = local canonical identity used by routing and queues
agent_uri = durable address used by UI and future federation
```

The UI may accept a local path or external endpoint as the first input, but it
must not store either as the identity. Local paths create or match
`agent_workspaces`. External endpoints create or match `agent_endpoints`.

## User-Facing Objects

Bot profile:

- `agent_id`
- `agent_uri`
- `display_name`
- `identity_scope`
- `trust_status`
- `auth_method`
- `home_directory`
- provider token source reference
- expected provider identity
- enabled/disabled state
- current channels and routing roles
- active runtime summary

The bot profile is the only normal editable source of truth for local MVP. The
UI must not ask operators to separately edit workspace rows, runtime rows,
connector rows, credential rows, provider identity rows, and provider access
rows for the same bot. Those rows are generated or refreshed from the bot
profile and discovery evidence.

The same rule applies to AI assistants. They may call a typed operation to
change the bot profile, but they must not directly write derived rows as if they
were configuration. Derived rows are recomputed by deterministic projectors,
runtime heartbeat, or provider discovery.

Workspace:

- `workspace_id`
- `name`
- `local_path`
- `repo_url`
- bound agents
- active runtimes that currently use the workspace

Runtime instance:

- `runtime_instance_id`
- `agent_id`
- `workspace_id`
- `runtime_engine`
- `runtime_kind`
- `session_name`
- `checkout_path`
- `commit_sha`
- `port`
- `status`
- `last_seen_at`

Provider identity:

- `provider_identity_id`
- `agent_id`
- `provider`
- `provider_subject_id` (shown as `bot_id` for Discord bot identities)
- `identity_kind`
- `display_name`
- `status`
- `trust_status`
- `connector_instance_id`
- `last_seen_at`

Endpoint:

- `endpoint_id`
- `agent_id`
- `endpoint_uri`
- `transport`
- `auth_method`
- `trust_status`
- `public_key_fingerprint`
- `status`

Channel binding:

- channel membership from `channels.members`
- primary owner from `channel_routing_policy.primary_agent_id`
- effective delivery owner derived from active connector/provider access
- adapter owner from `channel_routing_policy.adapter_owner_agent_id` only as a
  compatibility fallback or explicit override
- outbound allowlist from `channel_routing_policy.outbound_allowlist`

## Search Inputs

The UI must support these search inputs:

- free text
- `agent_id`
- `agent_uri`
- local path
- git repo URL
- tmux/session name
- runtime engine
- endpoint URI
- channel name or id
- Discord user id or channel id, when adapter metadata is available
- provider subject id / bot id

An internal path and an external URI are valid entry points, but they select
different records:

```text
/Users/yuji/Developer/agent-memory
  -> search agent_workspaces.local_path
  -> propose agent_workspace_bindings

https://example.com/aun/agents/research-bot
  -> search agent_endpoints.endpoint_uri
  -> propose disabled/unverified endpoint registration
```

## Candidate Resolution

Candidate results must include evidence and confidence. The UI must not silently
merge identities when conflict evidence exists.

Recommended ranking:

| Rank | Match evidence |
|---:|---|
| 100 | exact `agent_uri` |
| 95 | exact `agent_id` |
| 90 | exact normalized `local_path` |
| 85 | exact `repo_url` |
| 80 | exact endpoint URI |
| 75 | exact tmux/session name with live runtime |
| 70 | exact provider subject id in `agent_provider_identities` |
| 65 | rollout-only Discord user id mirror in `agents.metadata.discord_id` |
| 60 | display name or workspace name |
| 50 | channel membership or routing owner |
| 40 | runtime engine / tag / metadata match |

Candidate shape:

```json
{
  "candidate_type": "agent",
  "agent_id": "agent-mem-dev",
  "agent_uri": "aun://default/agents/agent-mem-dev",
  "confidence": 90,
  "evidence": [
    {"source": "agent_workspaces.local_path", "value": "/Users/yuji/Developer/agent-memory"},
    {"source": "channel_routing_policy.adapter_owner_agent_id", "value": "agent-mem-dev"}
  ],
  "conflicts": [],
  "recommended_actions": ["bind_workspace", "add_runtime_instance"]
}
```

## Local Bot Registration Flow

Input:

- `agent_id`
- `local_path`
- optional `display_name`
- optional `runtime_engine`
- optional `session_name`
- optional provider token source
- optional expected provider identity

Read-only discovery:

- normalize path with realpath when available
- inspect git remote and branch when available
- inspect `.mcp.json` / local config when available
- inspect `scripts/bot-registry.txt` as compatibility evidence
- inspect active tmux sessions and ports when available
- search DB for existing workspace, agent, and runtime candidates

Create/update rules:

1. Create or update one local bot profile rooted in `agents`.
2. Store the canonical local path once as the bot profile home directory or the
   single implementation-owned local workspace reference.
3. If no agent exists, create a new local `agents` row with
   `identity_scope='local'`, `trust_status='local'`, and
   `auth_method='local'`.
4. Create `agent_uri` as `aun://<org_id>/agents/<agent_id>`.
5. Recompute workspace index rows only if the implementation keeps them; do not
   require the operator or AI assistant to edit them.
6. Create an `agent_runtime_instances` row only when an actual runtime is
   launched, imported, or heartbeats.
7. Recompute connector, credential, provider identity, and channel access
   evidence from token/provider discovery through deterministic code.
8. Do not change channel membership or adapter ownership as a side effect of
   bot registration.

## Runtime Swap Flow

Swapping Claude Code to Codex, or Codex to another runner, must keep identity
stable.

Input:

- existing `agent_id`
- target `runtime_engine`
- target `workspace_id`
- optional `session_name`
- optional `checkout_path`

Rules:

- Add a new `agent_runtime_instances` row.
- Keep `channels.members` unchanged.
- Keep `channel_routing_policy` unchanged unless the operator explicitly
  changes routing roles.
- Mark the old runtime `stopped` only after the new runtime passes a canary, or
  when the operator explicitly stops it.
- Flag duplicate active runtimes for the same adapter-owner role unless HA mode
  is explicitly configured.

## External Endpoint Registration Flow

External agents are not enabled in this phase. The UI may record them only as
disabled or unverified.

Input:

- `agent_uri` or endpoint discovery URI
- `endpoint_uri`
- optional public key or fingerprint
- optional display name

Rules:

- Create or match an `agents` row with `identity_scope='external'`.
- Set `trust_status='unverified'` unless a future verification flow succeeds.
- Set `auth_method='none'` or `signed_key` depending on submitted evidence.
- Create an `agent_endpoints` row with `status='disabled'`.
- Do not add channel membership.
- Do not add outbound allowlist entries.
- Do not deliver messages to the endpoint.

## Channel Binding Flow

Channel changes are separate from registration.

Actions:

- add/remove channel member
- set primary agent
- review effective delivery owner
- set adapter owner only as an advanced override
- update outbound allowlist
- assign role routing

Rules:

- Token-bearing connectors should automatically become eligible delivery owners
  for provider surfaces where discovered channel permissions allow them to post.
- The UI must not force users to set an adapter owner for every channel when a
  single eligible connector can be derived from provider identity and channel
  access evidence.
- Adapter owner fields are compatibility/fallback controls, not the primary
  product-facing mental model.
- Explicit adapter owners for Discord projection must have a usable Discord
  identity.
- External agents cannot be adapter owners until verified remote delivery is
  implemented.
- Membership does not imply adapter ownership.
- Adapter ownership does not imply full outbound allowlist access.
- Every routing change must write an audit event.
- The UI must show the effective route before saving.
- If multiple token-bearing connectors can post to the same channel, the UI must
  show the candidates and require an explicit priority or override.

## Conflict Rules

Block:

- same `agent_uri` mapped to different `agent_id`
- same verified external endpoint URI mapped to multiple agents
- same Discord user id mapped to multiple active agents
- setting a disabled or revoked agent as adapter owner
- setting an unverified external agent as adapter owner

Warn and require confirmation:

- same local path bound to multiple agents
- same agent with multiple active local runtimes
- same channel with multiple possible adapter owners
- runtime checkout path differs from the bot profile home directory
- existing `bot-registry.txt` disagrees with DB binding

Allow:

- multiple agents associated with one repository only when the operator
  confirms distinct roles
- one agent with multiple stopped runtime histories
- one agent with multiple endpoints when only one is active

## Trust State Transitions

Local identity:

```text
local -> disabled -> local
```

External identity:

```text
unverified -> verified -> disabled -> verified
unverified -> revoked
verified -> revoked
```

Rules:

- `revoked` means the identity or key must not be trusted again without a new
  identity proof.
- `disabled` is operational suspension and may be reversed by an admin.
- Key revocation must not delete historical audit evidence.
- Trust changes must be audit logged.

## Required Audit Events

The UI must write audit rows for:

- agent create/update
- agent trust/auth change
- bot profile home directory create/update
- generated workspace/index refresh, when the implementation keeps workspace
  indexes
- runtime instance import/start/stop
- connector credential evidence refresh
- provider identity evidence refresh
- provider channel access refresh
- endpoint create/update/disable
- identity key add/revoke
- channel member add/remove
- channel routing policy change
- outbound allowlist change

Audit details must include before/after values for security-sensitive fields.

## API Boundary

Future UI/API handlers should be shaped around deterministic operations:

```text
searchAgentCandidates(input) -> candidates + conflicts + recommended_actions
registerLocalBotProfile(input) -> bot_profile + generated_evidence
refreshBotEvidence(agent_id) -> runtime + connector + credential + provider_access evidence
createRuntimeInstance(agent_id, runtime)
registerExternalEndpoint(agent_uri, endpoint)
setChannelMembership(channel_id, agent_id, action)
setChannelRoutingPolicy(channel_id, policy_patch)
```

These operations must be idempotent where practical. Search must be read-only.
Direct writes to derived tables are not part of the normal UI/API surface.

## Phase 1 Acceptance Criteria

The first UI-backed local registry is acceptable when:

- a local path can be searched and matched to an existing agent
- a local path can create or update one local bot profile
- a runtime engine can be swapped without changing `agent_id`
- channel membership can be edited separately from runtime registration
- effective delivery owner is derived from connector/access evidence, with
  adapter owner override hidden behind an advanced flow
- conflicts are visible before write
- every mutating action writes audit evidence
- external endpoint registration is visible but disabled/unverified only

## Non-Goals

- No remote delivery protocol in Phase 1.
- No automatic trust of external endpoint metadata.
- No identity derived from local path, tmux session, Discord user id, or model
  provider.
- No implicit channel membership from workspace registration.
- No silent merge of duplicate identities.
