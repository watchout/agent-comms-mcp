# NORM-035 Provider Channel Access Discovery Impl

Date: 2026-05-25
Status: Pre-implementation audit target
Phase: MVP internal normalization
Slice: NORM-035

## Purpose

NORM-035 records which provider channels a credentialed connector can actually
read or write.

This closes the gap between "a bot has a token" and "this bot can post to this
Discord channel." Without provider channel access evidence, AUN can only guess
at delivery ownership from channel-level fallback fields.

## Required Model

Add provider channel access records. The table name may be
`provider_channel_access` unless implementation discovers an existing
equivalent.

These records are discovery evidence, not user-editable or AI-authored channel
setup. The normal local MVP input is the bot profile plus token source. AUN
discovers or verifies channel access from the provider and materializes these
rows only as rebuildable evidence so delivery can be derived without per-channel
owner configuration.

Required fields:

| Field | Requirement |
|---|---|
| `access_id` | Stable primary key. UUID is acceptable. |
| `provider` | Provider namespace such as `discord`. |
| `provider_channel_id` | Provider-native channel id. |
| `channel_id` | Optional core `channels.id` if mapped. |
| `connector_instance_id` | Connector whose credential was used to discover access. |
| `agent_id` | Connector owner agent. |
| `can_read` | Provider says connector can view/read channel. |
| `can_write` | Provider says connector can post/send message. |
| `can_mention` | Provider says connector can mention users/roles, if available. |
| `can_manage_threads` | Provider says connector can create/manage threads, if available. |
| `provider_guild_id` | Discord guild/server id when available. |
| `provider_channel_name` | Non-authoritative display name. |
| `source` | `provider_api`, `operator_override`, `bootstrap`, or `unknown`. |
| `status` | `active`, `stale`, `disabled`, or `unknown`. |
| `discovered_at`, `expires_at`, `created_at`, `updated_at` | Freshness timestamps. |
| `metadata` | Non-secret provider metadata. |

Required constraints:

- foreign key to `connector_instances(connector_instance_id)`
- foreign key to `agents(agent_id)`
- optional foreign key to `channels(id)` when mapped
- uniqueness on active `(provider, provider_channel_id, connector_instance_id)`
- no raw token or permission payload containing secrets

## Discovery Contract

For Discord MVP:

1. Use a connector credential from NORM-030.
2. Call provider API to list channels/guilds visible to the bot when supported.
3. Compute read/write capabilities from provider permission data.
4. Map provider channel ids to existing `channel_adapters.external_id` when
   possible.
5. Write or refresh access rows with freshness timestamps.
6. Mark missing or expired rows as stale before relying on them for owner
   resolution.
7. Never print or store the raw token.

If Discord API limitations prevent global discovery for a token, the MVP may
verify a known channel list from `channel_adapters` one channel at a time.

## Relationship To Channels

`channels.members` remains the logical communication membership list.
Provider channel access is not the same thing as channel membership.

Example:

- `auditor` may be a logical member of `agent-com`
- the `auditor` Discord connector may or may not have write access to the
  Discord channel behind `agent-com`
- delivery can use `auditor` directly only if both logical policy and provider
  access allow it

## Acceptance Criteria

1. Discovery records read/write access for each active Discord connector against
   mapped operational Discord channels.
2. Access records include freshness timestamps and can become stale.
3. Access records do not imply logical membership or outbound allowlist access.
4. Effective delivery owner resolver can query access records without provider
   API calls in the hot path.
5. Missing or stale access produces a deterministic diagnosis.
6. Diagnostics can show "connector exists but cannot write this channel" without
   exposing secrets.
7. SQLite tests or fixtures cover access row insertion and resolver input shape.

## Non-Goals

- No OAuth/OIDC provider permissions.
- No Slack or non-Discord provider discovery.
- No UI implementation.
- No automatic channel membership rewrite.
- No direct delivery switch. That belongs to NORM-036.
