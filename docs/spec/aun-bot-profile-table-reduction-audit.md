# AUN Bot Profile Table Reduction Audit

Date: 2026-05-25
Status: Pre-implementation audit target
Phase: MVP internal normalization

## Implementation Progress

- PR #539 established the editable bot profile root on `agents` and added
  `agent profile get|set|doctor`.
- The next implementation slice adds a profile projector:
  - `agent profile project <agent_id>|--all` is dry-run by default.
  - `--execute` materializes deterministic workspace, workspace binding, and
    connector evidence from the profile.
  - `agent profile doctor --strict` reports missing projected evidence and
    duplicate token source references.
- The runtime heartbeat slice makes `agents.home_directory` the preferred
  workspace source when a profile exists. Runtime `checkout_path` remains
  runtime evidence, but workspace binding no longer treats the server checkout
  as the agent's canonical work directory.
- The status CLI reads `agents.home_directory` for `launch_dir` and no longer
  treats `scripts/bot-registry.txt` as the launch-directory source.
- The MCP lifecycle tools (`restart_bot`, `bot_status`, `watchdog_check`,
  `cleanup_ports`) now build their bot inventory from the DB bot profile first:
  `agents.home_directory`, `agents.channel_port`, and
  `agents.metadata.tmux_session`. `scripts/bot-registry.txt` remains only a
  compatibility fallback for incomplete legacy profile rows.
- The profile CLI now edits the lifecycle fields used by those tools:
  `--home-directory`, `--channel-port`, `--tmux-session`, and
  `--runtime-engine`. `agent profile doctor` treats those as the local complete
  profile criterion, so operators do not have to maintain a second registry file
  to make lifecycle tooling deterministic.
- Credential, provider identity, and provider channel access rows remain
  deferred evidence tables until provider discovery is implemented. They must
  not become manual setup inputs.

## Purpose

This audit checks the bot-related database and scripts against the local MVP
rule:

> Operators and AI assistants edit one bot profile. All other bot/runtime/
> connector rows are generated evidence, indexes, policy, or legacy
> compatibility.

The practical goal is to reduce the normal configuration surface. AUN may keep
materialized tables when they are needed for leases, diagnostics, provider
discovery, or enterprise rollout, but those tables must not become independent
manual setup steps.

## Current Database Shape

The live local database currently has these bot-adjacent tables:

| Table | Current use | MVP classification |
|---|---|---|
| `agents` | logical agent registry plus status, runtime, metadata, cursors, identity columns | editable bot profile root for local MVP |
| `agent_workspaces` | canonical/local workspace index | derived or deferred; not a manual MVP setup table |
| `agent_workspace_bindings` | agent-to-workspace relationship | derived or deferred; not a manual MVP setup table |
| `agent_runtime_instances` | runtime heartbeat evidence | materialized runtime evidence |
| `connector_instances` | connector process/adapter evidence | materialized connector evidence derived from profile token source and runtime discovery |
| `channel_connector_bindings` | materialized channel-to-connector delivery binding | generated delivery index or explicit override only |
| `channel_routing_policy` | channel primary/adapter owner/allowlist/native projection policy | policy table; `adapter_owner_agent_id` is legacy fallback/override, not normal UI model |
| `channels` | logical channel and members | channel membership/policy source |
| `channel_adapters` | provider channel mapping | provider adapter mapping evidence |
| `agent_aliases` | legacy alias mapping | compatibility only; not normal setup |
| `agent_endpoints` | future local/remote endpoint registry | v2/external readiness; not MVP local setup |
| `agent_identity_keys` | future signed identity keys | v2/external readiness; not MVP local setup |
| `role_routing` | governance role target mapping | advanced policy, not bot profile |

Missing but required by the stability plan:

- `agent_provider_identities`
- `connector_credentials`
- `provider_channel_access`

These new tables are also not user-editable configuration. They are generated
or verified evidence from the bot profile, token source, provider API, and
runtime heartbeat.

## Live Local Findings

The local DB confirms that the current model is not yet a single-profile
projection:

| Check | Result |
|---|---:|
| `agents` rows | 36 |
| `agent_workspaces` rows | 0 |
| `agent_workspace_bindings` rows | 0 |
| `agent_runtime_instances` rows | 41 |
| `connector_instances` rows | 13 |
| `channel_connector_bindings` rows | 16 |
| `channel_routing_policy` rows | 16 |
| active connectors without runtime linkage | 11 |
| runtime rows without workspace linkage | 41 |
| policies with adapter owner | 16 |
| policies with outbound allowlist | 16 |

This means runtime and connector evidence exists, but it is not consistently
linked back to one bot profile and one generated projection path.

## Script Audit

The current script and runtime code still writes several low-level tables
directly. That is acceptable only for migration compatibility; it is not the
target product contract.

| File | Current behavior | Required change |
|---|---|---|
| `cli/index.ts` | `agent register` writes `agents`; `agent-com status` reads profile `home_directory` for `launch_dir`; channel policy commands write `channel_routing_policy`; membership commands write `channels.members` | keep typed profile/policy commands, but route bot setup through one bot profile API and prevent direct derived-table authorship |
| `core/runtime-heartbeat.ts` | heartbeat inserts `agent_workspaces`, `agent_workspace_bindings`, `agent_runtime_instances`, and `connector_instances` | keep as projector/evidence writer, but generated rows must include source/profile evidence and be rebuildable |
| `core/channel-connector-sync.ts` | derives connector/binding rows from `channel_routing_policy.adapter_owner_agent_id` | demote to legacy projector; future resolver derives owner from credential plus provider channel access |
| `server.ts` | registration upserts `agents`; heartbeat writes runtime/connector evidence; MCP lifecycle tools read bot inventory from DB profiles first with registry compatibility fallback; Discord token fingerprint is emitted into connector metadata | keep heartbeat path, but move token evidence to credential projector, keep `agents` as profile root, and keep registry fallback visibly temporary |
| `adapters/discord.ts` | self-registers `metadata.discord_id` into `agents` after Discord login | move authority to provider identity evidence; metadata can remain mixed-fleet fallback |
| `db/seed.ts` | seeds `channels`, `channel_adapters`, `agents.metadata.discord_id` from Discord/bootstrap files | keep as discovery/import, not authoritative hand configuration |
| `scripts/bot-registry.txt` | static session/path/agent/port inventory | replace or project into bot profile; normal users should not maintain a parallel registry |
| `scripts/migrate-bot.sh` | reads registry and `.mcp.json`, starts gateway/runbot sessions, copies token env into processes | rework to read the bot profile and secret source reference, then start deterministic runtime |
| `scripts/sync-mcp-config.sh` | rewrites `.mcp.json` with duplicated `AGENT_ID`, port, DB URL, state dir | reduce to bootstrap/export compatibility; DB profile must be the canonical source |
| `scripts/simplify-mcp-json.sh` | removes Discord token/state from `.mcp.json` | aligns with central token source direction, but must become profile-aware |
| `scripts/run-bot.sh` | runner loop consumes queue and heartbeats runtime evidence | keep as runtime worker, but identity must be locked to the DB profile and runtime instance |

## Table Reduction Decision

For MVP, the normal operator-facing surface should be reduced to:

1. bot profile rooted in `agents`
2. `channels` plus channel membership
3. channel policy only for logical policy and explicit overrides

Everything else is generated, discovered, or legacy compatibility:

- `agent_runtime_instances`: keep as runtime heartbeat evidence.
- `connector_instances`: keep as connector evidence, but generated from the
  bot profile and credential/runtime discovery.
- `agent_workspaces` and `agent_workspace_bindings`: do not expose as normal
  setup. Because the live DB has zero rows and the bot profile already needs a
  canonical home directory, these should be deferred, converted to generated
  indexes, or replaced by a profile field for local MVP.
- `channel_connector_bindings`: keep only as generated delivery index or
  explicit override. Do not require one manual row per channel.
- `channel_routing_policy.adapter_owner_agent_id`: keep as mixed-fleet legacy
  fallback until the effective delivery resolver is active.
- `agent_aliases`: keep only for historical aliases and migration guardrails.
- `agent_endpoints` and `agent_identity_keys`: keep for v2 remote/federated
  identity, but do not make them part of local Discord bot setup.
- provider identity, credential, and provider access tables: add as evidence
  tables, not manual configuration tables.

Physical table count may not shrink immediately because runtime, connector,
credential, provider access, lease, and audit evidence are real product data.
The required reduction is that users, UI, and AI assistants no longer edit those
tables independently.

## Required Refactor

Implement NORM-021 before write-mode data cleanup:

1. Add a typed bot profile command/API:
   - create/update `agent_id`
   - display name
   - canonical home directory
   - channel port
   - tmux session name
   - runtime engine preference
   - provider token source reference
   - expected provider identity
   - enabled/disabled state
2. Add a profile projector:
   - `--dry-run` reports generated runtime/workspace/connector/credential/
     provider-identity/provider-access changes
   - `--execute` writes only deterministic evidence with audit
   - deleting generated rows and rerunning the projector recreates equivalent
     state except volatile heartbeat timestamps
3. Mark direct writes to derived tables as internal-only:
   - heartbeat writers
   - provider discovery writers
   - reconcile/projector writers
   - migration compatibility writers
4. Rewrite or deprecate scripts that duplicate bot profile fields:
   - `bot-registry.txt`
   - `.mcp.json` sync scripts
   - migration/restart/watchdog scripts
5. Update strict doctor:
   - fail if an active bot lacks one complete local lifecycle profile:
     `home_directory`, `channel_port`, `metadata.tmux_session`, and
     `runtime_engine_preference`
   - fail if lifecycle identifiers are duplicated across active bots:
     `home_directory`, `channel_port`, or `metadata.tmux_session`
   - fail if active derived rows have no profile/source evidence
   - fail if a token fingerprint maps to more than one active owner
   - fail if a provider token reference and expected provider identity are only
     partially configured
   - fail if connector delivery depends only on a channel owner field
6. Add contract tests:
   - normal bot setup writes one editable profile
   - derived rows are generated by projector/heartbeat, not direct CLI setup
   - derived rows can be deleted and rebuilt from profile plus discovery
   - legacy policy projection remains dry-run-first

## Acceptance Gate

NORM-021 is complete only when:

1. A new local bot can be registered by changing one profile, not multiple
   tables or files.
2. Runtime, connector, credential, provider identity, and provider access rows
   either do not exist yet or carry source evidence linking them to the profile
   revision or discovery run that generated them.
3. No normal CLI/UI path asks the operator to edit workspace, runtime,
   connector, credential, provider identity, or provider access rows directly.
4. Existing low-level scripts are either rewritten to call the bot profile API
   or explicitly labeled migration-only.
5. `aun doctor --strict` reports the current fleet drift without requiring raw
   token output.
