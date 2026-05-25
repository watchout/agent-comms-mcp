# AUN Enterprise Control Plane Direction

Date: 2026-05-26
Status: Directional design constraint for AUN roadmap and implementation PRs

## Purpose

This document records the product and architecture direction AUN must preserve
while internal Discord operation is stabilized.

AUN is not just a Discord bridge, a queue helper, or a bot launcher. AUN is a
durable control plane for LLM agents. The short-term local fleet must be built
on concepts that can become a secure, standard, observable, multi-runtime agent
control plane without a later rewrite of identity, routing, queue ownership, or
audit evidence.

This document constrains:

- database shape and ownership boundaries
- connector and runtime abstractions
- queue claim and lease semantics
- audit and observability requirements
- near-term Discord stabilization tradeoffs
- public positioning for large technology organization adoption

## Market Position

The public category should be:

```text
durable agent control plane / agent operations mesh
```

Do not position AUN primarily as:

- a Discord bot collection
- a chat sync tool
- an MCP wrapper
- a tmux session manager
- a Claude Code-only plugin

Discord, Slack, Teams, web UI, MCP transports, local CLIs, Codex, Claude Code,
and remote workers are surfaces, connectors, runtimes, or projections. The
product value is the durable coordination layer beneath them.

## Differentiation To Preserve

### Evidence-native agent communication

Every meaningful action should leave durable evidence:

- inbound provider event
- normalized message
- queue row
- claim holder and lease
- runtime heartbeat
- outbound delivery result
- audit event
- review or merge evidence when relevant

This is a sharper position than ordinary chat-based agent orchestration. AUN
should be able to answer "what happened, who owned it, why did it run, and what
proof allows us to close it?" without relying on chat transcript prose.

### Runtime-independent identity

`agent_id` is the logical identity. Runtime engine, model, CLI, tmux session,
workspace path, Discord identity, and provider token are replaceable evidence
or bindings. They must not become the canonical identity.

The design must support:

- the same `agent_id` moving from Claude Code to Codex or another runtime
- multiple runtime instances for one logical agent
- one runtime handling many eligible queue items
- runtime replacement without breaking audit history
- remote runtimes later proving identity through authenticated endpoints or
  keys

### Connector-neutral routing

Provider-specific details stay behind connector boundaries. A Discord token can
make a connector eligible for Discord delivery, but the core routing decision is
provider-neutral:

```text
message intent -> agent identity -> eligible connector/runtime -> claim/lease
```

Near-term Discord operation may use Discord ids, names, and tokens, but those
values must be recorded as provider identities or connector credential evidence,
not as core AUN identity.

### Distributed control without a post office

AUN should not depend on a single universal process that receives and forwards
all work. AUN should also not require one dedicated session per channel.

The durable database is the coordination point. Runtime and connector workers
advertise capability, claim eligible work, heartbeat ownership, and commit only
when the claim or lease is still valid.

### Standards-aligned external surface

Internal local operation can remain pragmatic, but public and enterprise paths
must align with standards:

- MCP Streamable HTTP as the primary remote MCP transport direction:
  https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- OAuth/OIDC-style authorization for remote protected resources:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- A2A-style agent interoperability where cross-agent tasks require a standard
  agent protocol surface:
  https://a2a-protocol.org/v0.3.0/specification/
- OpenTelemetry-compatible traces, metrics, and logs for operations:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/
- OpAMP-style fleet management direction for remote agents and collectors:
  https://opentelemetry.io/docs/specs/opamp/
- CloudEvents-compatible event export for audit and integration:
  https://www.cncf.io/projects/cloudevents/
- zero-trust posture for identity, policy, and runtime access:
  https://csrc.nist.gov/pubs/sp/800/207/final

These links are direction anchors. They do not mean every local MVP slice must
implement the full standard before internal stabilization.

## Design Rules

### 1. One editable source, derived evidence elsewhere

Operators and UIs should edit the smallest stable source of truth possible.
Derived tables may exist for queryability, audit, constraints, and performance,
but they must be generated or discovered from the editable source plus runtime
or provider evidence.

For a local bot profile, the editable source should cover stable facts such as:

- logical `agent_id`
- canonical local workspace or home directory
- runtime launch policy reference
- connector token secret reference
- intended enabled/disabled state

Derived evidence can include:

- provider identity rows
- token fingerprint rows
- connector instances
- runtime instances
- provider channel access
- channel bindings
- search indexes
- status projections

The system must not require a user, operator, or AI assistant to manually enter
the same fact in multiple tables.

### 2. Secrets are references, not row content

Raw tokens and secrets must not be stored in diagnostics or ordinary registry
rows. The database may store:

- secret reference
- provider
- non-secret fingerprint
- last verified identity
- last verified access
- rotation metadata
- revocation status

This allows local-only token operation now while preserving the path to managed
secret stores, key rotation, and enterprise audit later.

### 3. Liveness is evidence, not identity

`agent_runtime_instances` answers "what is running now?" It does not define who
the agent is. Runtime rows must be heartbeat-based and expire naturally.

Do not hard-block on offline state until the fleet has heartbeat coverage. Once
coverage exists, policy can decide whether a missing runtime is a warning or a
hard block for a given recipient, connector, or action.

### 4. Claims need leases and fencing

Queue status alone is not enough for enterprise-grade recovery. The final claim
model needs:

- owner runtime or connector
- claim timestamp
- claim expiration
- heartbeat
- monotonic fencing token or equivalent stale-holder protection
- terminal close evidence

The local MVP can keep lease data in existing queue columns where practical,
but the semantics must stay compatible with explicit lease/fencing primitives.

### 5. Provider output is a projection

Discord messages, provider message ids, mentions, and bot display names are
projection evidence. They can confirm delivery, but they are not the authority
for identity, authorization, or completion.

Provider names can change. Provider ids and token-derived identities are more
stable, but still provider-scoped.

### 6. Every operational mutation is script-controlled

State changes must be performed by deterministic code:

- CLI command
- daemon action
- migration
- typed runner
- audited reconcile command

LLMs can propose, summarize, and inspect. They must not be the untyped authority
that mutates routing, credentials, channel ownership, or queue completion.

### 7. Design public surfaces before expanding local shortcuts

If a local shortcut would make the future public surface awkward, prefer the
slightly longer local implementation that matches the final model.

Acceptable MVP shortcuts:

- local PostgreSQL as the coordination database
- Discord as the first connector
- local launchd/tmux/process evidence
- nullable future columns
- compatibility fallback to legacy routing

Unacceptable shortcuts:

- duplicated per-channel scripts
- path or tmux name as canonical identity
- one token controlling multiple logical connector owners
- raw secrets in registry tables or diagnostics
- chat-only completion evidence
- manual data entry in several tables for one stable fact

## Target Concept Model

```text
agent_profile
  -> agent_id / agent_uri
  -> workspace reference
  -> runtime launch policy
  -> connector secret reference

runtime discovery
  -> agent_runtime_instances
  -> heartbeat / process evidence / commit evidence

provider discovery
  -> provider identities
  -> credential fingerprints
  -> provider channel access
  -> connector instances

policy
  -> channel routing policy
  -> eligible delivery owner resolver
  -> deny / allow / role rules

work
  -> agent_messages
  -> message_queue / outbound_queue
  -> claim / lease / fencing
  -> terminal state
  -> audit event
```

Names may differ in implementation. The dependency direction should not.

## Near-term Internal Stabilization Mapping

The current normalization MVP remains the right near-term path. The direction
above changes how we judge each slice:

- NORM-020 and NORM-021 must reduce operator-edited bot data to one stable
  profile and generated evidence.
- NORM-025 and NORM-030 must make provider identity and token ownership
  unambiguous without storing raw tokens.
- NORM-035 and NORM-036 must make Discord delivery owner selection a
  deterministic resolver, not a per-channel manual owner field.
- NORM-040 must become the first machine-enforced proof that local data is
  internally consistent.
- NORM-060 must prove "Discord visible" plus DB evidence for inbound, claim,
  close, outbound, and audit.
- NORM-080 must make state-daemon coverage DB-policy driven, with deny policy
  for exceptions rather than hard-coded allow lists for every adopted bot.

## Enterprise Readiness Gate

AUN should not claim enterprise readiness until these are true:

- remote transport: Streamable HTTP or successor MCP transport is supported
- authorization: OAuth/OIDC-compatible protected-resource access exists
- identity: logical agent identity is separate from runtime and provider
  identity
- runtime security: external runtimes can prove identity and be revoked
- secrets: raw tokens are never stored or printed in ordinary operation
- policy: tenant, RBAC, service account, deny, and revocation semantics exist
- audit: every state transition has durable, queryable evidence
- observability: OTel-compatible telemetry exists for queue, runtime,
  connector, auth, and delivery flows
- events: CloudEvents-compatible export exists for external integration
- availability: takeover uses leases/fencing, not a single router process
- operations: doctor/smoke/reconcile commands provide deterministic proof

## Current Decision

Proceed with internal stabilization, but treat AUN as a future enterprise
agent control plane. Schema, scripts, and daemon work must keep this model
intact. If a local fix conflicts with this direction, update the design first
or classify the fix as a temporary compatibility path with explicit removal
criteria.
