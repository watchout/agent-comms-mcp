# NORM-025 Provider Identity Registry Impl

Date: 2026-05-24
Status: Pre-implementation audit target
Phase: MVP internal normalization
Slice: NORM-025
Related design:

- `docs/design/aun-normalization-roadmap.md`
- `docs/design/agent-identity-runtime-foundation.md`
- `docs/design/agent-registry-ui-spec.md`
- `docs/adr/060-aun-discord-projection-identity.md`

## Purpose

NORM-025 closes the gap between the abstract AUN identity model and concrete
provider-facing bot identities.

For Discord operations, operators often say `bot_id`. In the control-plane data
model this must be represented as a provider-neutral `provider_subject_id`, not
as loose JSON metadata, local path convention, tmux session name, token value,
or model name.

This document is the implementation contract. A code PR that changes provider
identity behavior must not merge until this impl contract has been audited or
the PR explicitly records an approved exception.

NORM-025 is necessary but not sufficient for stable communication. A provider
subject id can be mentioned or displayed, but it cannot post to Discord without
a credentialed connector, provider channel access evidence, and an effective
delivery owner resolver. Those requirements are defined in
`docs/spec/aun-communication-stability-mvp-impl.md`.

## Problem

Before this slice, Discord identity exists mostly as
`agents.metadata.discord_id`. That is useful rollout metadata, but it is not a
complete source of truth:

- it cannot express disabled or revoked provider identities cleanly
- it cannot attach trust state to the provider subject
- it does not prevent one provider subject from being bound to multiple agents
- it hides whether code is using legacy metadata or a normalized identity row
- it makes UI registration/search ambiguous when runtime, workspace, connector,
  and provider identity differ

This creates operational ambiguity for cases such as:

- `lead-tuk` channel should be driven by a Codex runtime for `codex-mem`
- `adf-lead` channel should be driven by a Codex runtime for `codex-adf`
- `codex-cto` and `discord-cto` naming drift must not decide identity
- one Discord token or provider subject must not silently operate as multiple
  active agents

## Required Model

Add an `agent_provider_identities` table. It is the DB authority for
provider-facing bot/user/app ids.

This table is internal evidence derived from bot profile token/provider
verification or provider discovery. Operators or AI assistants must not manually
enter the same Discord id in both the bot profile and this table. The bot
profile may carry an expected provider identity for verification; the normalized
row is the verified result and should be rebuildable from provider discovery.

Required fields:

| Field | Requirement |
|---|---|
| `provider_identity_id` | Stable primary key. UUID is acceptable. |
| `agent_id` | References the owning AUN agent. |
| `provider` | Provider namespace such as `discord`. |
| `provider_subject_id` | Provider-native stable subject id. For Discord, this is the operator-facing bot/user id. |
| `identity_kind` | At least `bot`, `user`, `app`, `webhook`, or `unknown`. |
| `surface_role` | Optional role label such as `primary`, `projection`, `worker`, or `presence`; defaults to `primary` when omitted. |
| `is_default` | Whether this identity is the default for its `(agent_id, provider, identity_kind, surface_role)` scope. |
| `display_name` | Optional operator display label. Not authoritative. |
| `status` | At least `active`, `disabled`, `revoked`. |
| `trust_status` | At least `local`, `unverified`, `verified`, `revoked`, `disabled`. |
| `connector_instance_id` | Optional reference to the connector instance that most recently registered or owns this identity. |
| `metadata` | Provider-specific non-secret metadata. |
| `created_at`, `updated_at` | Audit-friendly timestamps. |

Required constraints:

- `UNIQUE(provider, provider_subject_id)`
- at most one active default identity for each
  `(agent_id, provider, identity_kind, surface_role)`
- `provider_subject_id` must not be empty
- `status` and `trust_status` must be checked enums or equivalent constraints
- foreign key to `agents(agent_id)`
- foreign key to `connector_instances(connector_instance_id)` when the table is
  already available in that database engine

Raw Discord tokens, OAuth tokens, API keys, or session secrets must never be
stored in this table or printed by diagnostics.

## Identity Boundaries

NORM-025 does not change the meaning of `agent_id`.

| Concept | Authority | Meaning |
|---|---|---|
| `agent_id` | `agents` and routing tables | Who is responsible for AUN work and audit. |
| `workspace_id` | `agent_workspaces` | Where local code or data lives. |
| `runtime_instance_id` | `agent_runtime_instances` | What process/model/session is running now. |
| `connector_instance_id` | `connector_instances` | Which connector process can speak to a provider. |
| `provider_identity_id` | `agent_provider_identities` | Which provider subject belongs to an agent. |
| `agent_ui_binding_id` | `agent_ui_bindings` | Product-facing binding from `agent_id` to provider UI, credential evidence, and connector. |
| `projection_identity_id` | outbound projection model | Which identity is intended or used for human-facing projection. |

`provider_identity_id` and `projection_identity_id` are related but not the
same. Provider identity proves the Discord subject-to-agent binding. Projection
identity decides how an outbound message appears or falls back on a surface.
`agent_ui_bindings` is the indexed operator and delivery entry point that joins
provider identity with credential evidence and connector status for a specific
`agent_id`.

Discord UIs may expose "switch bot" controls. That control selects an eligible
`agent_ui_binding_id`, `provider_identity_id`, or `connector_instance_id` for a
channel role; it must not rewrite `agent_id`, `agent_uri`, queue ownership, or
channel membership. If the schema implementation does not yet include
`surface_role` / `is_default`, the MVP must still preserve the same behavior
through connector binding priority or explicit delivery-owner override rows.

## Migration Contract

The first implementation must be additive and mixed-fleet safe.

Required migration behavior:

1. Create `agent_provider_identities` after `connector_instances` exists.
2. Backfill Discord rows from `agents.metadata.discord_id`.
3. Preserve existing disabled or revoked provider identity rows on rerun.
4. Do not reactivate a disabled or revoked row just because legacy metadata
   still exists.
5. Keep `agents.metadata.discord_id` as a rollout compatibility mirror until a
   later cleanup slice removes it.
6. Provide Postgres and SQLite migration parity.
7. Provide a rollback migration that drops only the new table and does not
   mutate `agents` or erase legacy metadata.

Preflight before applying to a live DB:

- report the count of `agents.metadata.discord_id` rows
- report duplicate `(provider, provider_subject_id)` candidates
- abort or require explicit operator handling if duplicates exist

## Runtime Contract

Discord self-registration:

1. When a Discord adapter starts, read its own provider subject id from the
   provider API.
2. Check `agent_provider_identities` before trusting local environment state.
3. Fail closed when the subject is disabled or revoked for this agent.
4. Fail closed when the same `(provider, provider_subject_id)` is active for a
   different agent.
5. Upsert the provider identity for the current `agent_id` only after the
   duplicate and disabled/revoked checks pass.
6. Optionally mirror the id into `agents.metadata.discord_id` for compatibility.

Routing and directory reads:

- Prefer `agent_ui_bindings` when the caller needs the complete
  agent-to-provider-UI binding, credential status, connector status, or hot-path
  delivery answer.
- Prefer `agent_provider_identities` for Discord id lookup and mention
  rendering.
- Fall back to `agents.metadata.discord_id` only when the normalized table is
  absent or no usable provider identity row exists.
- Directory output must make the normalized source visible enough for
  diagnostics.
- Sender/recipient policy must continue to use `agent_id`, channel membership,
  and routing policy. Provider subject ids are not routing authority.

Effective delivery ownership:

- A token-bearing connector is the owner of its own provider UI identity. For
  Discord, a connector that controls a Discord bot token should be eligible to
  post as that bot wherever provider/channel access evidence says the bot can
  write.
- The UI must not require operators to hand-configure an adapter owner for every
  channel when provider access can be discovered.
- Channel-level `adapter_owner_agent_id` is a compatibility fallback and an
  explicit override for ambiguous cases, not the normal user-facing ownership
  model.
- Direct connector delivery is allowed when all of these are true:
  - the target agent has an active, non-revoked provider identity
  - a connector instance for that agent/provider is active
  - the connector has provider-discovered access to the target channel or an
    approved DB capability row for that channel
  - channel membership and outbound policy allow the logical sender/recipient
- If exactly one connector is eligible for a provider/channel/role, the system
  may derive the effective delivery owner automatically.
- If multiple connectors are eligible, the UI must show the conflict and require
  an explicit preference or priority. It must not silently pick a token holder
  when that would change which external identity posts.
- If no eligible connector exists, delivery may fall back to the legacy channel
  adapter owner only when policy allows fallback and the fallback is recorded in
  projection evidence.

Preflight behavior:

- Disabled provider identity: hard block.
- Revoked provider identity: hard block.
- Non-member recipient: hard block by existing channel policy.
- Offline provider identity: do not hard block until runtime heartbeat coverage
  exists for the target fleet. This is handled by the runtime slice, not
  NORM-025.

## UI And Operator Contract

The registry UI may label a Discord `provider_subject_id` as `bot_id`, but the
stored column must stay provider-neutral.

Provider token registration should be a high-level action:

```text
register Discord connector for <agent_id>
  -> record connector instance
  -> record provider identity
  -> discover accessible Discord channels
  -> propose effective delivery ownership for those channels
```

The operator should normally choose agents and channels, not edit low-level
owner rows for each channel. Per-channel owner selection is an advanced
override used for conflicts, HA, migration, or fallback routing.

Search should eventually support:

- `agent_id`
- `agent_uri`
- provider display name
- Discord bot/user id
- workspace path
- runtime session name
- channel membership

NORM-025 only requires that the provider identity row exists and can be used by
future UI/CLI registration flows without schema rewrite.

## Acceptance Criteria

A NORM-025 implementation PR must prove:

1. Schema exists in Postgres and SQLite with the constraints above.
2. Backfill from `agents.metadata.discord_id` is idempotent.
3. Disabled and revoked rows are not reactivated by backfill or adapter start.
4. Duplicate provider subject assignment is rejected or fails closed.
5. Discord mention rendering prefers normalized provider identities.
6. Discord inbound identity resolution prefers normalized provider identities.
7. Directory/projection diagnostics prefer normalized provider identities while
   keeping metadata fallback for pre-migration DBs.
8. Existing metadata-only fixtures still pass before fleet migration.
9. No raw token or secret is stored or emitted.
10. The PR records live DB preflight output without exposing secrets.

Minimum targeted tests:

- provider identity migration/backfill/idempotency
- duplicate provider subject guard
- disabled/revoked guard
- Discord adapter self-registration
- inbound Discord id resolution
- mention rendering
- directory output
- outbound projection fallback compatibility
- SQLite migration parity

## Rollout Plan

1. Audit this impl contract.
2. Merge the doc-only impl PR.
3. Rebase or update the code PR to reference this slice.
4. Run targeted tests and `git diff --check`.
5. Run live DB preflight read-only checks.
6. Request auditor and ARC review through AUN.
7. Merge only after CI, audit evidence, and breaking-change verification are
   recorded.
8. After merge, run migration and compare normalized provider identity rows
   against legacy metadata counts.

## Rollback Plan

Rollback of the implementation PR must be safe while mixed fleet runtimes still
use metadata fallback:

- revert code to metadata-only reads if necessary
- run the down migration to drop `agent_provider_identities`
- keep `agents.metadata.discord_id` intact
- do not rotate or print tokens as part of rollback
- record rollback evidence in PR or audit log

## Non-Goals

- No token fingerprint uniqueness enforcement. That belongs to NORM-030.
- No full runtime/workspace registration. That belongs to NORM-020.
- No UI registration flow. That belongs to REG-100.
- No external or federated agents.
- No OAuth/OIDC or Streamable HTTP transport changes.
- No requirement that every internal worker has a Discord token.

## PR Sequencing Rule

If an implementation PR already exists when this impl doc is introduced, it must
be treated as blocked on this impl audit. The implementation PR may remain open
for review, but it must not merge until the impl doc is audited and any required
changes are applied to the implementation.
