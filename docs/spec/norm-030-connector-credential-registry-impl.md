# NORM-030 Connector Credential Registry Impl

Date: 2026-05-25
Status: Pre-implementation audit target
Phase: MVP internal normalization
Slice: NORM-030

## Purpose

NORM-030 makes provider credentials first-class control-plane records without
storing raw secrets in the database.

`agent_provider_identities` can say which Discord bot/user/app an agent owns,
but posting requires a credentialed connector. The current mixed local state
keeps Discord tokens in `.mcp.json` or process environment and only partially
represents the connector in DB. That is not enough for stable delivery,
duplicate-token detection, revocation, or UI registration.

## Required Model

Add a connector credential registry as internal evidence derived from a bot
profile token source. The table name may be `connector_credentials` unless
implementation discovers an existing equivalent.

This is not a second user-editable token setting. The normal local MVP input is
the bot profile's token source reference. Credential rows are recomputed or
refreshed by deterministic scripts/runtime startup so AUN can enforce ownership,
revocation, and duplicate detection without printing raw tokens. AI assistants
must not author credential rows directly.

Required fields:

| Field | Requirement |
|---|---|
| `credential_id` | Stable primary key. UUID is acceptable. |
| `connector_instance_id` | References `connector_instances`. |
| `agent_id` | Owner agent. Duplicates connector owner for query and constraints. |
| `provider` | Provider namespace such as `discord`. |
| `credential_kind` | `bot_token`, `oauth_token`, `webhook_secret`, `api_key`, or `unknown`. |
| `secret_ref` | Non-secret reference to where the raw secret lives. |
| `token_fingerprint` | Stable non-secret hash/fingerprint of the live token. |
| `fingerprint_algorithm` | Algorithm/version used to compute the fingerprint. |
| `status` | `active`, `disabled`, `revoked`, `rotated`, or `unknown`. |
| `trust_status` | `local`, `unverified`, `verified`, `revoked`, or `disabled`. |
| `last_verified_at` | Last time the credential was successfully checked. |
| `metadata` | Non-secret provider metadata. |
| `created_at`, `updated_at`, `disabled_at`, `revoked_at` | Audit-friendly timestamps. |

Required constraints:

- foreign key to `connector_instances(connector_instance_id)`
- foreign key to `agents(agent_id)`
- `UNIQUE(provider, token_fingerprint)` for active credentials, where the DB
  engine supports partial uniqueness
- `token_fingerprint` must not be empty for active token credentials
- `secret_ref` must not contain raw token material
- checked enums or equivalent for status/trust/kind

## Secret Handling

Raw token values must never be stored in DB or printed by diagnostics.

Allowed `secret_ref` examples:

- `env:DISCORD_BOT_TOKEN_AGENT_COM_DEV`
- `mcp-json:/Users/yuji/Developer/agent-comms-mcp/.mcp.json#mcpServers.agent-comms.env.DISCORD_BOT_TOKEN`
- `keychain:aun/default/discord/agent-com-dev`
- `vault:path/to/secret`

The `mcp-json:` form is allowed only for local MVP inventory. It is not a
future enterprise secret backend.

Fingerprinting must be deterministic for duplicate detection but non-reversible.
Implementation may use HMAC or hash with local salt. If a salt is used, the salt
must not be logged with fingerprints in a way that enables offline token
guessing.

## Runtime Contract

When a Discord connector starts or refreshes:

1. Locate its raw token from the bot profile's allowed local secret source.
2. Compute a non-secret fingerprint.
3. Identify its provider subject through Discord API, when possible.
4. Upsert or verify the matching `connector_instances` row.
5. Upsert or verify the matching credential row.
6. Fail closed if the same active fingerprint belongs to another active owner.
7. Fail closed if the credential is disabled or revoked.
8. Do not emit the raw token in stdout, logs, DB, PR comments, audit logs, or
   Discord messages.

The command must be idempotent. Re-running it with the same bot profile and
token source should converge to the same credential evidence, not create a
second independent configuration.

## Relationship To NORM-025

NORM-025 provider identity and NORM-030 connector credential must agree:

- one active Discord bot token should resolve to one provider subject
- that provider subject must map to the same owner agent unless an explicit
  migration override is active
- mismatch between credential owner and provider identity owner is a strict
  doctor failure

## Acceptance Criteria

1. Schema exists in Postgres and SQLite or a documented MVP SQLite-safe subset.
2. Active duplicate token fingerprints are blocked or detected by strict doctor.
3. Disabled/revoked credentials prevent new connector claims.
4. Connector startup records or verifies credential fingerprint and owner from
   the bot profile token source.
5. Raw token values are never stored or printed in test fixtures, diagnostics,
   PR output, or audit evidence.
6. Credential owner and provider identity owner mismatch is diagnosed.
7. Existing local `.mcp.json` token sources can be inventoried without printing
   token values.
8. Rollback drops only new credential records and leaves existing `.mcp.json`
   local operation usable through legacy fallback.

## Non-Goals

- No enterprise secret store integration.
- No OAuth/OIDC implementation.
- No remote connector registration.
- No automatic token rotation.
- No channel access discovery. That belongs to NORM-035.
