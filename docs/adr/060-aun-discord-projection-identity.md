# ADR-060: Separate AUN Agent Identity From Discord Projection Identity

> **Status**: Proposed
> **Date**: 2026-05-20
> **Issue**: #470
> **Related PRs / issues**: #411, #456, #469
> **Scope of this ADR PR**: documentation only; no runtime behavior, schema, config, bot-registry, or daemon changes.

## Context

The #456/#469 runtime probes showed that direct AUN bot-to-bot delivery can work while
Discord projection can still remain pending. The root design problem is that
`consumer_agent_id` currently mixes two separate meanings:

- the runtime adapter owner that claims and posts an `outbound_queue` row
- the Discord-facing native identity that should appear as the sender

This coupling makes projection brittle. For example, `codex-cto -> codex-aun`
can pass AUN routing and ACL checks, but if native Discord projection for
`codex-cto` is configured while no healthy `codex-cto` delivery runtime exists,
the outbound row can be left under the wrong consumer identity instead of being
sent by the channel `adapterOwner`.

The system needs separate names for logical AUN authorship, delivery ownership,
Discord display identity, and future presence identity.

## Decision

AUN outbound projection uses four distinct identity roles.

| Role | Storage / field | Meaning | Runtime authority |
|---|---|---|---|
| Canonical AUN author | `agent_messages.author_id`, `outbound_queue.agent_id` | Agent that authored the durable AUN message or owns the work result | AUN routing and audit model |
| Delivery adapter runtime owner | `outbound_queue.consumer_agent_id` | Adapter process allowed to claim and post the outbound row | Channel metadata / routing policy |
| Discord projection identity | `outbound_queue.projection_identity_id` | Resolved Discord-facing display/post identity after fallback | Projection resolver |
| Presence identity | `presence_identity_id` | Optional Discord online/presence identity | Model only at first; not authoritative AUN status |

`consumer_agent_id` must never carry Discord display semantics. It answers
"which runtime consumes this outbound row?", not "which bot should this look like
in Discord?".

## Bot Classes

### Channel-facing lead bot

Examples: repo lead or project lead bots that own a human-facing Discord channel.
They are usually token-bearing and can be the `adapterOwner` for that channel.
They may also have native projection identity when explicitly registered and
healthy.

### Cross-channel governance bot

Examples: CTO, ARC, auditor, or CEO-style governance agents. They may participate
in multiple channels and may be token-bearing, but their governance identity does
not imply that each channel must have a dedicated runtime adapter process for
that identity.

### Internal worker bot

Examples: narrowly scoped implementation, audit, or verification agents. They are
AUN-internal by default. They do not require Discord tokens, and their Discord
projection should normally go through the channel `adapterOwner` unless they are
explicitly promoted to a registered, healthy native projection identity.

## Token Ownership Guidance

Discord token ownership is explicit operational state, not a consequence of
being an AUN agent.

- A bot with a Discord token may act as a delivery adapter runtime owner only for
  channels where policy assigns that role.
- A bot may have a native projection identity only when that identity is
  registered and health-checked.
- Internal worker bots must not be required to carry Discord tokens.
- One adapter process per bot is not required.
- A native projection identity that is configured but unhealthy must degrade to
  the channel adapter owner rather than blocking Discord delivery.

## Routing Policy Semantics

The default projection policy is:

1. Resolve the delivery consumer from channel/thread metadata, then channel
   metadata, then a single-recipient direct delivery connector when exactly one
   active recipient Discord connector has an active credential and write-capable
   channel binding or provider access, then `adapterOwner`, then the existing
   primary fallback.
2. Resolve native projection only when a projection identity is both registered
   and healthy.
3. If native projection is unavailable, preserve `consumer_agent_id` as the
   channel adapter owner and record fallback evidence.

Recipient-facing projection by itself must not change `consumer_agent_id`.
Direct recipient delivery is selected only from connector-scoped delivery
evidence: the active credential and write-capable channel binding/access must
belong to the same active connector instance. Read-only access, mismatched
connector evidence, or ambiguous connector evidence fails closed to the normal
channel owner fallback. For thread-targeted outbound, provider access evidence
must match the actual outbound target external id for the thread, not only the
parent channel external id.

`nativeRoleOutboundOwners` is deprecated compatibility input only. It may be
read during migration to infer legacy intent, but it must not become a consumer
owner override in the new design. The new model separates:

- consumer owner selection: delivery runtime ownership
- projection identity selection: Discord-facing display/post identity

The expected replacement is a native projection mapping such as
`nativeProjectionIdentities[senderAgentId]`, interpreted only as intended
projection identity and never as `consumer_agent_id`.

## Implementation Split

This ADR is PR 1 and changes documentation only.

### PR 2: Schema + pure resolver

Add `outbound_queue.projection_identity_id` for Postgres and SQLite.

Introduce a pure resolver that returns:

- `channelExternalId`
- `consumerAgentId`
- `projectionIdentityId`
- `intendedProjectionIdentityId`
- `projectionSource`
- `projectionFallbackReason`

Resolver contract:

- `consumerAgentId` comes from thread/channel metadata owner, then eligible
  single-recipient connector evidence, then `adapterOwner`, then `primary`
  fallback.
- native projection mapping controls only `projectionIdentityId`.
- native projection is selected only when registered and healthy.
- if native projection is configured but unavailable,
  `consumerAgentId=adapterOwner` is preserved and fallback reason is recorded.

### PR 3: Server and CLI outbound write paths

Update MCP `send` / `notify` and CLI `send` / `notify` inserts to write both
delivery and projection identity fields:

- `agent_id`
- `consumer_agent_id`
- `projection_identity_id`
- `channel_external_id`
- `content`

### PR 4: Projection evidence and diagnostics

Add persisted projection evidence so operators can distinguish a healthy native
projection from a fallback to the channel adapter owner without reverse-
engineering the row after the fact:

- `intended_projection_identity_id`
- `projection_source`
- `projection_fallback_reason`

Extend MCP `send` / `notify`, CLI `send` / `notify`, and legacy infra producers
to write these evidence fields alongside `projection_identity_id`.

For the #456/#469 follow-up, `codex-cto -> codex-aun` must keep passing ACL. If
`codex-cto` native projection is not healthy, Discord projection must be sent by
the channel adapter owner (`agent-com-dev` in the current channel), not left
pending under `consumer_agent_id=codex-cto`.

Keep outbound claiming keyed by `consumer_agent_id`, with legacy fallback to
`agent_id` for older rows.

Diagnostics must show:

- `author_id`
- `consumer_agent_id`
- `projection_identity_id`
- `intended_projection_identity_id`
- `projection_source`
- `projection_health`
- `projection_fallback_reason`
- machine-readable pending/failure reason

The consumer may initially send through its own Discord client when no usable
native projection client exists. That fallback must be visible in diagnostics
and logs.

## Acceptance Criteria

- Direct AUN probe: `codex-cto -> codex-aun` notify succeeds without
  `OUTBOUND_ACL_VIOLATION`.
- Queue evidence: `message_queue.agent_id=codex-aun` direct row exists; no
  `lead-ama` relay row is required.
- Native unavailable projection:
  - `outbound_queue.agent_id=codex-cto`
  - `outbound_queue.consumer_agent_id=agent-com-dev`
  - `outbound_queue.projection_identity_id` records intended native projection
    or fallback identity according to resolver contract
  - the persisted `intended_projection_identity_id` field preserves the
    pre-fallback target when fallback occurs
  - row reaches `status=sent`
  - `discord_message_id` is populated
- Native healthy projection:
  - row still uses the correct delivery consumer per resolver contract
  - native projection identity is recorded and used
- Diagnostics explain both successful native projection and fallback to adapter
  owner.

## Non-goals

- Do not change runtime behavior in this ADR PR.
- Do not require one adapter process per bot.
- Do not require internal worker bots to have Discord tokens.
- Do not move routing policy to DB in the first implementation.
- Do not make Discord presence the authoritative AUN status source.
- Do not mutate `.mcp.json`, bot registry, production routing config, or restart
  Discord/state-daemon runtime as part of this ADR PR.

## Rollback

The ADR PR is documentation-only. Rollback is a normal revert of this file.

Later implementation PRs must each include their own rollback plan. In
particular, schema PRs must keep old `consumer_agent_id` fallback behavior until
all outbound writers and diagnostics understand `projection_identity_id`.

## Consequences

Positive:

- AUN audit identity stays stable even when Discord projection degrades.
- Delivery ownership remains operationally grounded in the adapter runtime that
  can actually post.
- Internal workers can participate in AUN without Discord tokens.
- The #411 adapter owner fallback remains the safe default.

Trade-offs:

- The design adds one more identity field to outbound rows.
- Projection diagnostics become mandatory for debuggability.
- Legacy `nativeRoleOutboundOwners` behavior must be migrated carefully because
  it previously conflated projection intent with consumer ownership.
