# AUN Communication Stability MVP Impl

Date: 2026-05-25
Status: Pre-implementation audit target
Phase: MVP internal normalization

## Purpose

This document defines the minimum structural foundation required before AUN can
be treated as stable for internal Discord-backed communication.

The target is still a communication MCP, not a heavy workflow engine. Normal
messages must work without requiring users to configure low-level routing rows.
At the same time, a message cannot be considered deliverable just because an
agent has a Discord id. Posting requires a credentialed connector, runtime
ownership, provider channel access, queue evidence, and fallback rules.

This document exists because data reconciliation alone cannot make the current
fleet stable. Data cleanup must be delayed until the structural prerequisites
below are present or the cleanup will only create another inconsistent snapshot.

## Stability Definition

AUN internal communication is stable when, for every target operational bot and
channel, the system can answer these questions from DB rows and deterministic
commands:

1. Who is the logical AUN agent?
2. What is the single editable bot profile for that agent?
3. What runtime is currently alive for that agent?
4. What provider identity belongs to that agent?
5. What connector can post to the provider?
6. What non-secret credential reference backs that connector?
7. Which provider channels can that connector read or write?
8. Which effective delivery owner will be used for this message?
9. Did the queue row get claimed and closed by the intended agent?
10. Did outbound projection reach `sent` or a diagnosed terminal failure?

If any answer depends on a path name, tmux session name, `.mcp.json` folklore,
raw token inspection, or a human remembering which bot is which, the fleet is
not stable.

## Product Model

The operator-facing product model is one editable bot profile, not a collection
of low-level tables.

For local MVP, the bot profile is rooted in `agents` and has one editable source
of truth for these values:

```text
agent_id
display_name
home_directory
runtime_engine preference
provider token source reference
expected provider identity
enabled/disabled state
```

All other rows are internal projections, caches, evidence, or indexes derived
from that profile and runtime/provider discovery. They must not become separate
manual setup steps in the UI or normal CLI.

They also must not become AI-written configuration. An AI assistant may propose
or request a bot profile change, but it must not write independent derived
state as authority. Derived state is produced only by deterministic code:

- DB constraints/triggers
- typed CLI/API commands
- runtime heartbeat
- provider discovery jobs
- dry-run-first reconcile/projector commands

The implementation should prefer views or computed reports when persistence is
not needed. If derived state is materialized for performance, indexing, or
audit, it must be rebuildable from the bot profile plus provider/runtime
discovery and carry enough source evidence, such as profile revision, source
hash, discovery timestamp, or projector name, to prove what generated it.

Examples:

- runtime instance rows are heartbeat evidence
- connector rows are derived from a token-bearing bot profile
- credential rows are non-secret evidence derived from the token source
- provider identity rows are verified provider subjects
- provider channel access rows are discovery results
- workspace rows are optional indexing for advanced multi-workspace cases

If the same editable value must be entered in two places, the design is wrong.
If a derived row cannot be deleted and rebuilt from the single editable profile
plus discovery evidence, it is not derived state and must be redesigned.

## Non-Negotiable Boundaries

- `discord_id` or future `provider_subject_id` identifies a provider subject.
  It does not prove posting capability.
- A Discord token proves potential posting capability only through a connector
  credential record, not by being present in a local file.
- Raw tokens must never be stored in DB or printed by diagnostics.
- Channel-level owner fields are fallback or override state. They are not the
  primary UI model.
- Data reconciliation must be dry-run-first and must not execute until the
  structural prerequisites are in place.

## Required Structural Prerequisites

### 1. Bot Profile And Runtime Evidence

Every active local bot must have:

- `agents` row
- one canonical home directory recorded on the bot profile or a single
  bot-profile-owned local workspace field
- `agent_runtime_instances` row with heartbeat evidence

`agent_workspaces` and `agent_workspace_bindings` are not required manual
configuration for the local MVP. They may be generated as indexes for future
multi-workspace UI and enterprise features, but the editable source remains the
bot profile.

Runtime evidence must include enough local evidence to diagnose the process,
such as runtime engine, runtime kind, session name when available, process id,
checkout path, commit sha when available, and freshness time.

### 2. Provider Identity Registry

Every Discord-capable bot must have:

- `agent_provider_identities` row
- provider `discord`
- provider subject id
- identity kind
- status and trust status

This is NORM-025. It allows mention resolution and identity conflict checks, but
it is not sufficient for posting.

### 3. Connector Credential Registry

Every token-bearing connector must have a non-secret credential record.

The operator must not create this record by hand. It is derived from the bot
profile's token source and connector startup/discovery.

Required data:

- credential id
- provider
- owner `agent_id`
- connector instance id
- token fingerprint or equivalent stable non-secret hash
- secret reference or local secret source descriptor
- status: active, disabled, revoked, rotated
- trust status
- created/updated/last verified timestamps

Required invariants:

- one active token fingerprint maps to one active owner
- duplicate active fingerprints hard fail or make doctor fail
- raw token values are never stored or printed
- revocation prevents new outbound claims

### 4. Provider Channel Access Discovery

Every active provider connector must be able to report the provider channels it
can read and write.

Required data:

- provider
- provider channel id
- connector instance id
- capabilities such as read, write, mention, manage thread
- discovered display name
- discovered at / expires at
- source: provider_api, operator_override, or bootstrap

This is the data that lets AUN derive "this token can post to this Discord
channel" without forcing the operator to hand-edit every channel owner.

### 5. Effective Delivery Owner Resolver

Outbound delivery must resolve through this order:

1. explicit high-priority connector binding or override, if present and healthy
2. exactly one active connector with provider write access for the channel
3. legacy `channel_routing_policy.adapter_owner_agent_id`, only as mixed-fleet
   fallback
4. diagnosed terminal failure when no eligible connector exists

If multiple eligible connectors exist, the resolver must not silently choose.
It must return an ambiguity diagnosis that UI/CLI can resolve with priority or
override.

### 6. Queue And Reply Evidence

Normal communication remains simple:

- message is inserted
- intended recipient queue row is inserted
- recipient claims with `next`
- recipient replies or marks done
- outbound reaches `sent` or diagnosed terminal failure when a provider surface
  is involved

Approval/audit messages may add a policy that requires a PR review, PR comment,
or AUN reply before completion. That policy is message-type specific and must
not turn AUN into a general workflow engine.

### 7. Doctor And Reconcile Gate

`aun doctor --strict` or equivalent must block data execution when:

- an active bot has no bot profile home directory or runtime evidence
- a Discord-capable bot has provider identity but no connector credential
- a connector credential has no connector instance
- a connector has no provider channel access evidence
- a channel has no effective delivery owner
- an allowlist references a non-member or disabled agent
- active duplicate token fingerprints exist
- queue rows are stale outside an approved reconcile plan

## Required Implementation Order

Do not execute data cleanup before the structural slices below exist.

| Order | Slice | Required before data execution |
|---:|---|---|
| 1 | NORM-020 bot profile and runtime heartbeat | active bot profile and runtime evidence are visible |
| 2 | NORM-025 provider identity registry | provider subjects are DB authority |
| 3 | NORM-030 connector credential registry | token ownership is non-secret and unique |
| 4 | NORM-035 provider channel access discovery | connector read/write access is known |
| 5 | NORM-036 effective delivery owner resolver | posting owner is derived or diagnosed |
| 6 | NORM-040 strict doctor | structural gaps fail deterministically |
| 7 | NORM-050 data reconcile | execute only after dry-run plan and audit |
| 8 | NORM-060 fleet smoke | prove inbound, queue, claim, reply, outbound |

Read-only inventory can happen at any time. Write-mode data reconciliation
cannot.

Slice contracts:

- [`aun-bot-profile-table-reduction-audit.md`](./aun-bot-profile-table-reduction-audit.md)
- [`norm-025-provider-identity-registry-impl.md`](./norm-025-provider-identity-registry-impl.md)
- [`norm-030-connector-credential-registry-impl.md`](./norm-030-connector-credential-registry-impl.md)
- [`norm-035-provider-channel-access-impl.md`](./norm-035-provider-channel-access-impl.md)
- [`norm-036-effective-delivery-owner-resolver-impl.md`](./norm-036-effective-delivery-owner-resolver-impl.md)

## Data Reconciliation Scope

After the structural gate is ready, data reconciliation may update:

- `agents`
- `agent_workspaces`
- `agent_workspace_bindings`
- `agent_runtime_instances`
- `agent_provider_identities`
- connector credential records
- provider channel access records
- `connector_instances`
- `channel_connector_bindings`
- `channels.members`
- `channel_routing_policy`
- stale queue rows covered by an approved plan

However, only the bot profile is user-editable in the normal local MVP. The
other rows are recomputed or repaired from the bot profile and discovery
evidence by deterministic commands. They are listed here because reconcile may
need to repair materialized derived state, not because users or AI assistants
should configure them directly.

Each execution must have:

- dry-run diff
- plan hash
- affected row count
- secret-free output
- audit evidence
- rollback or reverse plan

## Acceptance Criteria

The stability MVP is not complete until:

1. The active internal bot list has one editable bot profile per bot and
   generated evidence rows for runtime, provider identity, connector,
   credential, and provider access where applicable.
2. A message from `codex-aun` to every target active bot can be delivered or
   fail with a deterministic reason.
3. A reply from every target active bot can be delivered or fail with a
   deterministic reason.
4. Discord projection uses direct connector delivery when exactly one eligible
   connector exists.
5. Legacy adapter-owner fallback is visibly recorded when used.
6. Duplicate token fingerprints fail strict doctor.
7. Non-member, disabled, revoked, or missing-credential recipients fail closed.
8. All target operational channels pass smoke with DB evidence.

## Current Known Gap

NORM-025 / PR #536 is necessary but not sufficient. It normalizes provider
identity. It does not create connector credentials, discover provider channel
access, or prove that an agent can post to Discord.

Therefore, merging provider identity alone must not be represented as
"communication stability complete." It is one prerequisite in the stability
sequence.
