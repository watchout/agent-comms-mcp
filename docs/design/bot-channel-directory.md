# Bot / Channel Directory

## Decision

Use the database as the runtime source of truth for bot identities, channel
membership, and user-editable routing state. JSON files remain useful for
bootstrap, seed data, export/import, tests, and emergency GitOps review, but
they should not be the long-term UI editing surface.

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

Still JSON-backed:

- `config/bot-routing.json`
- `config/agent-role-routing.json`

## Target Tables

Move user-editable policy out of JSON into DB tables in a later migration.

Proposed tables:

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

channel_routing_policy
  channel_id references channels(id)
  primary_agent_id references agents(agent_id)
  adapter_owner_agent_id references agents(agent_id)
  outbound_allowlist text[]
  policy_source text

role_routing
  role_key text primary key
  channel_id references channels(id)
  agent_id references agents(agent_id)
  description text
  new_work_allowed boolean

agent_aliases
  alias text primary key
  canonical_agent_id references agents(agent_id)
  new_work_allowed boolean
  reason text
```

The exact schema can be refined, but the important split is stable identity,
display labels, platform adapters, and routing policy.

## JSON Policy

After the DB tables exist:

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
- current channel policy from `config/bot-routing.json`
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

## Migration Path

1. Keep existing `agents`, `channels`, and adapter tables.
2. Add read-only directory reporting.
3. Add DB policy tables with backfill from JSON.
4. Teach routing reads to prefer DB policy and fall back to JSON.
5. Add UI writes to DB only.
6. Keep JSON export/import for backup and review.
7. Remove JSON runtime dependency after one full release cycle.
