# Bot / Channel Directory

## Decision

Use the database as the runtime source of truth for bot identities, channel
membership, and user-editable routing state. JSON files remain useful for
bootstrap, seed data, export/import, tests, and emergency GitOps review, but
they should not be the long-term UI editing surface.

Agent identity is distinct from workspaces and running LLM processes. The
identity/runtime split is defined in
[`agent-identity-runtime-foundation.md`](./agent-identity-runtime-foundation.md).
The UI registration and search behavior is defined in
[`agent-registry-ui-spec.md`](./agent-registry-ui-spec.md).
The distributed worker/connector lease model is defined in
[`distributed-control-plane-foundation.md`](./distributed-control-plane-foundation.md).
The default development stance is defined in
[`aun-development-principles.md`](./aun-development-principles.md).
Channel membership and routing policy continue to reference stable `agent_id`
values; UI and future external agent registration should additionally expose
`agent_uri`, workspace bindings, runtime instances, endpoints, and identity
keys.

## Stable IDs

`agent_id` is a stable logical slug.

Good examples:

- `codex-aun`
- `codex-cto`
- `codex-audit`
- `agent-com-dev`
- `wbs-dev`
- `xmarketing-dev`

Do not derive the identity from:

- `display_name`
- project directory
- tmux session name
- Discord user id
- Discord bot token owner

Those values are mutable runtime or adapter metadata. Keep them in `agents`
columns or `agents.metadata`, not as the canonical identity.

## Channel IDs

The current `channels.id` rows often use Discord snowflakes. That works as a
compatibility bridge, but the preferred model is:

| Concept | Target location |
|---|---|
| Internal stable channel slug | `channels.id` or future `channels.slug` |
| Human label | `channels.name` |
| Discord channel id | `channel_adapters.external_id` |
| Discord-specific metadata | `channel_adapters.metadata` |

Before exposing channel management in a UI, add or migrate to a stable internal
channel key so platform ids do not become product-facing identifiers.

## Current Tables

Already DB-backed:

- `agents`: bot/human identity, status, runtime, metadata
- `channels`: channel rows and member lists
- `channel_adapters`: platform mapping such as Discord channel id
- `thread_adapters`: platform mapping for threads
- `connector_instances`: provider-facing connector workers and credentials
- `channel_connector_bindings`: channel-to-connector roles and ordering policy
- `control_plane_leases`: short-lived worker claims over connectors, bindings,
  partitions, and runtimes
- `channel_routing_policy`: runtime channel primary, Discord adapter owner,
  outbound allowlist, and native projection maps
- `role_routing`: DB target table for governance role routing
- `agent_aliases`: DB target table for legacy-to-canonical identity aliases

Compatibility JSON:

- `config/bot-routing.json`
- `config/agent-role-routing.json`

`config/bot-routing.json` remains a seed/fallback source. Runtime routing reads
prefer `channel_routing_policy` when rows exist and fall back to JSON by channel
while rollout is incomplete.

## Target Directory Tables

The first policy tables now exist. Additional UI-facing directory tables can be
added later without changing routing semantics.

Candidate tables:

```text
agent_directory
  agent_id primary key references agents(agent_id)
  stable_slug text unique not null
  display_label text not null
  purpose text
  owner_team text
  project_dir text
  lifecycle_status text
  ui_visible boolean

channel_directory
  channel_id primary key references channels(id)
  stable_slug text unique not null
  display_label text not null
  purpose text
  ui_visible boolean
```

The important split is stable identity, display labels, platform adapters, and
routing policy.

## JSON Policy

- JSON may seed default rows.
- JSON may export a snapshot for review.
- JSON may be used in tests.
- JSON should not be the active UI-editable runtime source.

## Immediate Operator View

`agent-com directory` is the read-only bridge for the current mixed state. It
combines:

- live `agents`
- live `channels`
- live `channel_adapters`
- DB channel policy from `channel_routing_policy`, with JSON fallback by channel
- current role routing from `config/agent-role-routing.json`

Use:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts directory --format text
```

The report marks:

- ready recipients
- blocked recipients
- duplicate display names
- channel ids that look like platform ids
- governance roles and unusable role targets

## Policy Commands

List active DB policy:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts channel policy list --format json
```

Seed DB policy from the compatibility JSON:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts channel policy import-json --dry-run
```

Bootstrap policy candidates from live channel membership and Discord adapter
rows:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts channel policy bootstrap --dry-run \
  --extra-allowlist codex-aun,codex-cto,codex-audit
```

The bootstrap command is intentionally dry-run by default. Executing it broadens
runtime send permissions and should go through PR/audit approval before
production use:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts channel policy bootstrap --execute \
  --extra-allowlist codex-aun,codex-cto,codex-audit
```

## Effective Delivery Ownership

The long-term UI should not expose one required "owner" field for every
channel. Users should register agents, connectors, tokens, and channel access;
the system then derives the effective delivery owner.

For provider-backed surfaces such as Discord:

1. A token-bearing connector owns its own provider UI identity.
2. Provider discovery records which channels that connector can read or write.
3. If exactly one active connector can write to a channel for a role, it becomes
   the effective delivery owner for that surface/role.
4. If multiple connectors are eligible, the UI asks for an explicit preference
   or priority.
5. `channel_routing_policy.adapter_owner_agent_id` remains a compatibility
   fallback and explicit override, not the normal operator-facing setup step.

This keeps MCP/UI setup small enough for users to operate. Channel membership,
logical primary agent, outbound allowlist, and effective delivery connector are
separate concepts; only conflicts or special routing should require per-channel
owner editing.

## Other-Channel AUN Readiness

For AUN to function in a non-`agent-com` Discord channel, that channel needs:

- a `channels` row and a Discord `channel_adapters` row
- a `channel_routing_policy` row with `primary_agent_id`
- an effective delivery owner, derived from an active connector with provider
  access evidence or, during mixed rollout, from
  `channel_routing_policy.adapter_owner_agent_id`
- an `outbound_allowlist` containing the sender and intended recipients, for
  example `codex-aun` plus the channel's local bot
- the effective delivery connector process running so it can claim outbound
  rows

If bootstrap reports `no_ready_discord_bot_member`, routing policy alone is not
enough; a channel-local bot must be registered, given a Discord identity, and
started before AUN can post through that channel.

## Migration Path

1. Keep existing `agents`, `channels`, and adapter tables.
2. Add read-only directory reporting.
3. Add DB policy tables with backfill from JSON. Done for
   `channel_routing_policy`, `role_routing`, and `agent_aliases`.
4. Teach routing reads to prefer DB policy and fall back to JSON. Done for
   channel policy.
5. Add UI writes to DB only.
6. Keep JSON export/import for backup and review.
7. Remove JSON runtime dependency after one full release cycle.
