# Surface Projection Matrix

## Purpose

AUN needs one provider-neutral model for deciding how an agent message appears on
external surfaces. Discord is the current production surface, but the same
resolution model must support AUN UI, Slack, webhook, GitHub, email, and other
providers without baking Discord-specific roles into core routing.

The UI should expose an agent x surface matrix with presets and diagnostics
preview. It should not expose low-level role toggles as the primary operator
model.

## Model

### `agents`

Canonical AUN actors. An agent can author messages, receive queue work, own
internal state, and optionally have one or more external identities. Being an
AUN agent does not imply a Discord token or any other provider credential.

### `external_surfaces`

Provider-neutral external destinations. Examples:

- Discord channel or thread
- AUN UI room
- Slack channel
- webhook endpoint
- GitHub issue or pull request thread
- email list or inbox

Each surface records provider, external address, capabilities, and ownership
metadata. Surface ownership answers where delivery can happen, not who authored
the AUN message.

### `external_identities`

Provider-facing identities that can display, post, or appear online on a
surface. Examples:

- Discord bot token identity
- Slack app/bot identity
- webhook signing identity
- GitHub app identity
- email sender identity

An external identity may be registered but unhealthy. Native projection can use
it only when the identity is registered and healthy.

### `delivery_connectors`

Runtime processes capable of delivering outbound rows to a provider. A connector
has operational ownership: process health, credentials, supported surfaces, and
claim authority. This is the provider-neutral equivalent of the current
`consumer_agent_id` responsibility.

The first schema foundation for this concept is `connector_instances` plus
`channel_connector_bindings` and `control_plane_leases`; see
[`distributed-control-plane-foundation.md`](./distributed-control-plane-foundation.md).

### `agent_surface_projection`

Matrix table or derived policy that answers how an AUN agent should appear on a
given surface. It links:

- AUN agent
- external surface
- preferred projection identity
- optional presence identity
- fallback connector
- health and fallback policy

The matrix is the UI-facing abstraction. Presets can populate it for common
classes such as channel lead, governance bot, and internal worker.

## Resolution Contract

All outbound paths should observe the same DB-backed resolution result:

1. Resolve the surface from channel/thread metadata.
2. Resolve delivery connector from explicit surface metadata, channel
   `adapterOwner`, then primary fallback.
3. Resolve recipient-facing projection for a single recipient when that
   recipient has a registered healthy provider identity.
4. Resolve sender-native projection when explicitly configured and healthy.
5. If native projection is unavailable, preserve the delivery connector and
   record the fallback reason.

The result should include:

- `surfaceProvider`
- `surfaceExternalId`
- `consumerAgentId` or future `deliveryConnectorId`
- `projectionIdentityId`
- `projectionSource`
- `projectionFallbackReason`
- `presenceIdentityId`
- `diagnosticReason`

Bot send paths, projection, presence, diagnostics, and terminal preview should
read the same result. This prevents the UI from showing one route while
`outbound_queue` stores another.

## Current Slice

The first terminal UI slice is `agent-com diagnose-projection`. The first
distributed-control-plane schema slice adds connector, binding, and lease
records without changing live routing behavior.

It previews the projection decision for:

```bash
agent-com diagnose-projection --channel <surface> --from <agent> --to <agent>[,<agent>]
```

For single-recipient Discord projection, if the recipient has a registered
Discord identity, the preview can choose recipient-facing projection. For
example, `codex-aun -> codex-cto` can resolve to `consumer_agent_id=codex-cto`
when `codex-cto` has Discord identity metadata.

Multiple recipients do not use recipient-facing default projection because
there is no single recipient surface identity to represent the group. They
continue through explicit adapter metadata, `adapterOwner`, or primary fallback.

Explicit adapter metadata remains the highest-precedence operational override.
It is used for cases where a surface or thread has a known connector owner that
must claim delivery regardless of sender or recipient identity.

## UI Direction

The UI should present:

- agent x surface matrix
- presets for channel-facing lead, cross-channel governance, and internal worker
- health status for provider identities and connectors
- diagnostics preview for a selected from/to/surface combination
- explicit fallback reason when native projection is unavailable

The UI should avoid role-specific configuration as the primary model. Roles are
presets over the matrix; the matrix is the durable policy.

## Non-goals For This Slice

- no DB schema migration for the full agent x surface projection matrix yet
- no provider implementation beyond the existing Discord projection path
- no requirement for one adapter process per bot
- no requirement for internal worker bots to own external provider tokens
- no Discord presence as the authoritative AUN status source
