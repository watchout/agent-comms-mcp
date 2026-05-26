# AUN Normalization Roadmap

Date: 2026-05-24
Status: Normative for AUN normalization planning

## Purpose

This document fixes the development contract for AUN normalization. Work must
start from the target operating model, split into MVP / v1 / v2 gates, then
break down into implementation PRs. A discovered inconsistency is not a new
open-ended scope item by itself; it must be classified against one of these
gates before implementation.

AUN normalization is complete only when the MVP gate can be proven by
deterministic evidence. Chat messages, tmux output, local path names, and LLM
claims are operator hints, not completion evidence.

Per-slice progress, dependencies, expected PR count, and open decisions are
tracked in [`aun-normalization-wbs.md`](./aun-normalization-wbs.md). The WBS is
working state; this roadmap remains the contract.

This roadmap applies together with:

- [`aun-development-principles.md`](./aun-development-principles.md)
- [`aun-enterprise-control-plane-direction.md`](./aun-enterprise-control-plane-direction.md)
- [`agent-identity-runtime-foundation.md`](./agent-identity-runtime-foundation.md)
- [`bot-channel-directory.md`](./bot-channel-directory.md)
- [`distributed-control-plane-foundation.md`](./distributed-control-plane-foundation.md)
- [`agent-registry-ui-spec.md`](./agent-registry-ui-spec.md)
- [`../spec/aun-bot-profile-table-reduction-audit.md`](../spec/aun-bot-profile-table-reduction-audit.md)
- [`../spec/aun-communication-stability-mvp-impl.md`](../spec/aun-communication-stability-mvp-impl.md)
- [`../spec/norm-030-connector-credential-registry-impl.md`](../spec/norm-030-connector-credential-registry-impl.md)
- [`../spec/norm-035-provider-channel-access-impl.md`](../spec/norm-035-provider-channel-access-impl.md)
- [`../spec/norm-036-effective-delivery-owner-resolver-impl.md`](../spec/norm-036-effective-delivery-owner-resolver-impl.md)

## North Star

AUN is a durable control plane for LLM agents. Discord, tmux, Codex, Claude
Code, local paths, and future remote workers are runtimes, connectors, or
projections. They are not the product identity.

The public and enterprise direction is fixed in
[`aun-enterprise-control-plane-direction.md`](./aun-enterprise-control-plane-direction.md):
AUN should be designed as a durable agent control plane / agent operations
mesh, with internal Discord stabilization implemented as the first local
deployment of that model rather than as a Discord-specific product branch.

The final architecture has these properties:

- stable `agent_id` and `agent_uri`
- one editable bot profile per local bot, with DB-backed derived evidence for
  runtimes, connectors, provider identities, channel bindings, routing policy,
  queue state, leases, and audit
- one product-facing `agent_ui_bindings` record per active provider UI binding,
  linking `agent_id` to provider subject, credential evidence, connector, and
  verification status for low-latency UI and delivery lookup
- one authoritative secret location per connector, which may be an external
  local source such as env, Keychain, or `.mcp.json`; DB stores only the
  reference, non-secret fingerprint, verification status, and derived evidence
- derived evidence is created by deterministic code from the bot profile and
  discovery, not by user or AI duplication of the same setting
- hot-path routing and UI reads use indexed materialized evidence, not raw secret
  reads or provider API calls
- deterministic CLI or daemon actions for every state transition
- provider-neutral routing with Discord as one connector
- Discord-specific UI can switch between eligible Discord bot connectors, but
  that switch changes the selected connector/projection owner for a surface; it
  must not mutate `agent_id` or copy a Discord id into routing authority
- no one-channel-one-script duplication
- no single post-office runtime that becomes the universal bottleneck
- local-only operation first, without blocking later enterprise auth,
  federation, RBAC, or standard transport support

## Phase Gates

### MVP: Internal Normalization

Goal: the active internal AUN fleet can send, receive, recover, and be audited
without relying on implicit tmux/path/token knowledge.

MVP is complete only when all of the following are true:

1. DB registry is authoritative for active local operation:
   - every active local bot has an `agents` row
   - every active local bot has one editable bot profile containing its
     canonical home directory or local workspace reference
   - workspace/index tables, when present, are generated from the bot profile
     and not separate manual configuration
   - derived rows are rebuildable from the bot profile plus runtime/provider
     discovery evidence
   - every active local process emits an `agent_runtime_instances` heartbeat
   - every active Discord-capable process has a `connector_instances` row
     derived from the bot profile token source and linked to runtime evidence
     without storing raw tokens
2. Token identity is unambiguous:
   - every active Discord-capable bot has an `agent_ui_bindings` row linking
     `agent_id`, `ui_type='discord'`, verified Discord `ui_id`, credential
     evidence, connector instance, and trust status
   - a live Discord token fingerprint maps to only one active connector owner
   - duplicate token fingerprints are blocked or reported before routing use
   - connector credentials are represented by non-secret fingerprint and
     secret reference records, not raw token storage in the MVP hot path
   - if encrypted DB secret storage is later used, the UI/API remains
     write-only for plaintext token input and never returns decrypted token
     values; connector/runtime-only secret resolution remains outside normal
     UI reads
   - provider channel read/write access is discovered or explicitly overridden
     before a connector is treated as a delivery owner
   - delivery resolution reads credential, provider identity, and channel access
     evidence from DB in the hot path; slow secret resolution and provider API
     verification happen at startup, refresh, or explicit reconcile time
   - raw token values are never stored or printed in diagnostics
3. Queue state is mechanically safe:
   - `next -> processing -> send/done` is a valid happy path
   - stale claims are recoverable by deterministic logic
   - `message_queue` and `outbound_queue` terminal states are auditable
   - fallback paths do not leave valid in-progress work open
4. Channel and bot assignment is explicit:
   - every operational Discord channel has a `channels` row
   - every operational Discord channel has a `channel_adapters` row
   - every operational channel has `channel_routing_policy`
   - channel-level bot selection references `agent_ui_bindings`; it does not
     duplicate token material or make the channel the credential owner
   - effective delivery owner can be derived from connector credentials and
     provider access, or falls back to an explicit legacy override with evidence
   - primary agent is clear where a channel has a local project owner
   - outbound allowlist contains the intended sender/recipient set
   - disabled or non-member recipients fail closed
5. Runtime liveness is observable:
   - active runtimes heartbeat with `runtime_instance_id`, `agent_id`,
     `workspace_id`, process evidence, runtime engine, and last seen time
   - offline hard-block policy is not enabled until heartbeat coverage exists
   - duplicate active runtimes for the same effective connector role are
     reported
6. State daemon behavior is policy-driven:
   - default bot coverage is DB-driven
   - exclusions use deny policy rather than per-bot hard-coded startup lists
   - state-daemon actions leave DB evidence
7. All target internal channels pass smoke with DB evidence:
   - Discord inbound is recorded as `agent_messages.source='discord'`
   - channel id resolves correctly
   - mention/recipient resolution is correct
   - bot-authored duplicate input is ignored
   - target queue row is inserted
   - target bot claims and closes the row
   - outbound projection reaches terminal `sent` or expected `failed`
   - audit evidence references the run
8. `aun doctor --strict` or equivalent exits cleanly:
   - no missing registry rows for active bots
   - no duplicate active token fingerprints
   - no active process without DB runtime evidence
   - no active connector without owner/runtime linkage
   - no operational channel without policy/binding
   - no stale queue rows outside approved reconcile plans
   - no stale runtime rows outside freshness thresholds

MVP non-goals:

- no external agent delivery
- no public OAuth/OIDC enforcement
- no full UI
- no Streamable HTTP transport requirement
- no tenant/RBAC enforcement beyond schema-compatible design

### v1: Local Control Plane

Goal: a local operator can register, bind, inspect, and run many agents and
channels without manual DB surgery or session folklore.

v1 is complete when:

- CLI and/or UI can register one local bot profile and let AUN derive
  workspaces, runtimes, connectors, credentials, provider identities, and
  channel access evidence
- AI assistants and operators mutate the bot profile through typed commands;
  they do not directly author the derived evidence tables
- channel policy updates are DB writes with audit events
- agent search works by `agent_id`, `agent_uri`, local path, repo URL, session
  name, connector metadata, and channel membership evidence
- runtime swaps keep identity stable
- connector projection from legacy channel policy is dry-run-first and audited
- state daemon can supervise the eligible local fleet using DB policy
- smoke runner supports all local operational channels
- operator reports can explain "who owns this channel?", "what runtime is
  alive?", "which connector can send?", and "what is stuck?"

v1 non-goals:

- no verified remote agents
- no enterprise SSO requirement
- no multi-tenant hosted deployment requirement

### v2: Enterprise Control Plane

Goal: AUN can be evaluated as a standard, secure agent control plane by large
technology organizations.

v2 is complete when:

- Streamable HTTP is the primary MCP transport for remote deployments
- OAuth 2.1 / OIDC and protected-resource metadata are implemented for remote
  access
- tenants, RBAC, service accounts, key rotation, and revocation are enforced
- external agent endpoints are registered, verified, and auditable
- signed identity keys or equivalent proof bind remote runtimes to `agent_uri`
- OpenTelemetry-compatible traces/metrics/logs exist for queue, runtime,
  connector, lease, and auth events
- CloudEvents-compatible event export exists for audit and integration
- high availability uses control-plane leases and fencing tokens, not a single
  central router
- secrets are managed by provider-backed secret stores or equivalent policy,
  never by raw token diagnostics

## Required Implementation Slices

Every implementation PR must declare which slice and phase gate it advances.

| Slice | Phase | Scope | Completion evidence |
|---|---|---|---|
| NORM-000 | MVP | This roadmap and SSOT references | docs updated, PR review/audit |
| NORM-010 | MVP | Queue claim/send consistency | tests proving `processing` claims can close via `send` |
| NORM-020 | MVP | Bot profile and runtime heartbeat registration | one editable bot profile exists; runtime/connector evidence is generated from discovery |
| NORM-021 | MVP | Bot table reduction and script rewrite | normal setup edits one profile; workspace/runtime/connector/credential/provider evidence is generated or migration-only |
| NORM-025 | MVP | Provider identity registry for Discord bot/user/app ids | provider subject rows are DB authority, duplicates fail closed, metadata fallback remains mixed-fleet safe |
| NORM-030 | MVP | Connector credential registry and token uniqueness | non-secret credential records exist, duplicate active token fingerprint is blocked or strict-doctor failed |
| NORM-035 | MVP | Provider channel access discovery | connector read/write access per provider channel is recorded without raw token output |
| NORM-036 | MVP | Effective delivery owner resolver | delivery owner derives from connector/access evidence or returns deterministic ambiguity/failure |
| NORM-040 | MVP | `aun doctor --strict` registry/queue/channel checks | deterministic nonzero exit on drift, zero exit on clean fixture |
| NORM-050 | MVP | Channel/bot assignment reconcile | dry-run plan, audited execute path, no raw token output |
| NORM-060 | MVP | Full-channel smoke runner | DB evidence for inbound, queue, processing, outbound, audit |
| NORM-070 | MVP | Legacy queue/runtime cleanup | dry-run plan hash, audited execute path, terminal states preserved |
| NORM-080 | MVP | State-daemon DB policy coverage and deny policy | no per-bot allow hard-code required for normal adoption |
| REG-100 | v1 | Local registry CLI/UI operations | audited create/update flows and conflict checks |
| CONN-110 | v1 | Connector projection and readiness | dry-run-first projection from policy to bindings |
| LEASE-120 | v1 | Active lease acquisition, heartbeat, release, fencing | contract tests for takeover and stale holder rejection |
| SMOKE-130 | v1 | Repeatable local fleet smoke | operator command creates reproducible evidence bundle |
| AUTH-200 | v2 | OAuth/OIDC remote access baseline | protected resource metadata and auth tests |
| TRAN-210 | v2 | Streamable HTTP transport | conformance tests against MCP transport requirements |
| EXT-220 | v2 | Verified external agent endpoints | signed proof, key rotation, revocation tests |
| OBS-230 | v2 | Enterprise observability/export | OTel and CloudEvents-compatible evidence |

## PR Gate

A PR that changes AUN identity, routing, queue, connector, runtime, or
state-daemon behavior must include:

1. phase and slice id
2. the exact invariant it changes
3. DB rows, constraints, scripts, or tests that prove the invariant
4. rollout and rollback notes for mixed old/new fleet operation
5. audit evidence or an explicit reason audit is not applicable
6. confirmation that raw secrets are neither stored nor printed

For identity, routing, runtime, connector, queue, or state-daemon behavior that
bridges abstract design to code, create a doc-only impl contract PR first and
audit that PR before merging the implementation PR. Emergency stabilization may
open the implementation PR in parallel, but merge remains blocked until the impl
contract is audited and referenced.

Do not merge implementation that only says "works in Discord" or "tmux output
looks right". Provider output can support the claim, but the gate is DB,
deterministic command output, CI, and audit evidence.

## Scope Classification Rule

When a new defect or request appears:

1. classify it into MVP, v1, v2, or out-of-scope
2. if it is MVP, attach it to an existing NORM slice or add a new slice before
   coding
3. if it is v1/v2, do not let it block MVP unless it would force a future
   rewrite of schema, identity, authorization, or state ownership
4. if it reveals an unsafe MVP assumption, update this roadmap before the
   implementation PR

This keeps short-term Discord/internal stabilization aligned with the final
enterprise control-plane design without allowing every future feature to delay
normalization.
