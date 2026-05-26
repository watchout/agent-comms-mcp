# AUN Token And Worker Visibility Fast-Slice Spec

Status: recovery backfill for issue #568, not production-ready.

Recovery issue: https://github.com/watchout/agent-comms-mcp/issues/568

This document backfills the spec for the CEO-directed fast slices implemented on
`codex/token-backed-discord-channel-bots` on 2026-05-26. It is not an approval
artifact by itself. The branch remains a working/stabilization branch until
issue #568, the implementation plan, L1, L2, and L3 evidence are complete.

## Source

- CEO token management prompt: `da44a583-26e8-4e5c-b931-21dfd2ce25fa`
- CEO worker visibility prompt: `2a540e48-04a6-4ccb-9bf1-7dcde17d5188`
- CEO progress/liveness prompt: `534487a6-0481-4073-8bec-fa45c6dc809a`
- CEO governance correction: `fd9dc559-90e8-42a5-93b3-4425d2d3f1a4`
- CEO stabilization question: `3a425abf-f3f9-423c-8c9f-4bffe4323c28`
- CEO bot-to-bot and duplicate message question:
  `41aafe83-a1d6-4d03-a337-b43601a123da`
- CEO audit sequencing question: `480208e6-1f9a-416f-883e-9b09fd06209b`
- CEO process correction: `0861c06f-5ec9-4ec1-bf82-b1255f7806f9`

## Problem

AUN needs two near-term control-plane capabilities without waiting for a full UI:

1. Operators must manage Discord-visible bot token ownership from DB evidence
   without storing plaintext token values in normal hot-path tables.
2. Internal DB/TUI workers must be observable even when they have no Discord bot
   token. Long Xhigh Codex runs need liveness and progress evidence so operators
   can tell whether work is still moving.

## Concept Alignment

The core subject is the linkage between external UI/chat-surface bots and AUN
internal agents.

- AUN identity remains `agent_id`.
- A UI/chat surface identity is evidence that a specific external UI account,
  bot, app, or token reference belongs to an AUN `agent_id`.
- Discord is the first provider implementation.
- The same contract should also cover custom chat UIs, web UIs, Slack-like
  providers, local operator consoles, or future surfaces.
- The UI-facing entry point should be one table: `agent_ui_bindings`.

`agent_ui_bindings` is intentionally provider-neutral:

- `ui_type`: provider/surface type, such as `discord`, `custom_chat`,
  `operator_ui`, `slack`, or `web`.
- `ui_id`: provider-specific subject, bot id, app id, account id, or local UI id.
- `ui_handle`: human-readable provider handle when available.
- `ui_token_ref`: non-secret token source reference when that UI surface posts
  externally.
- `surface_role`: role on that UI surface, such as `primary`, `projection`,
  `worker`, or `presence`.
- Optional links to connector, credential, and provider identity evidence.

Supporting tables remain normalized because they answer different questions:

- `connector_credentials`: which non-secret credential reference backs posting?
- `agent_provider_identities`: what provider subject has been expected or
  verified?
- `provider_channel_access`: where can this connector post?

Operators and UI clients should normally read `agent_ui_bindings` first. They
only need the supporting tables when they need credential, identity, or channel
access evidence details.

## Non-Goals

- Do not store plaintext Discord bot tokens in the DB.
- Do not treat a DB-only internal worker as a Discord-visible channel bot.
- Do not mark this fast slice production-ready before issue/spec/impl/L1/L2/L3
  evidence exists.
- Do not replace the full provider discovery or operator UI work in this slice.
- Do not implement encrypted DB secret storage in this slice.
- Do not implement Discord permission discovery in this slice beyond reserving
  the `provider_channel_access` table.
- Do not change queue ownership or mutate historical message ownership as part
  of provider identity normalization.
- Do not force every UI into Discord-specific column names.
- Do not collapse credential, provider identity, and channel access evidence
  into `agent_ui_bindings` if doing so would require duplicating security or
  verification state.

## Slice Boundaries

### Slice A: Token Inventory Backfill

Goal: create DB inventory rows that let operators see which agents have token
source evidence, provider identity evidence, and UI/provider bindings.

In scope:

- Add token inventory tables.
- Materialize inventory from existing bot profile rows.
- Preserve `secret_ref` only; no plaintext secret values.
- Use `agent_ui_bindings` as the single UI-facing binding table across providers.
- Leave `provider_channel_access` empty until provider discovery is implemented.

Out of scope:

- Token rotation UI.
- Encrypted secret-value storage.
- Provider API validation of every token.

### Slice B: Token-Backed Discord Delivery Guard

Goal: prevent a tokenless logical owner from being selected as the Discord
delivery consumer.

In scope:

- Share token evidence collection through a helper.
- Reject tokenless Discord adapter owners during channel connector sync.
- Reject tokenless Discord delivery consumers during outbound projection.
- Keep projection identity distinct from delivery consumer identity.

Out of scope:

- Rewriting the full projection decision model.
- Mutating `agent_id`, channel membership, queue ownership, or message history.

### Slice C: Internal Worker Visibility

Goal: expose DB evidence for internal workers that do not own Discord tokens.

In scope:

- Add `worker_activity`.
- Add `agent-com worker report`, `worker ping`, and `worker list`.
- Add `worker_activity` to `status --format json`.
- Expose liveness through heartbeat age, stale threshold, and derived state.

Out of scope:

- Building a full operator UI.
- Automatically posting worker summaries to Discord.
- Restarting or cancelling workers based on stale state.

### Slice D: Recovery Governance

Goal: make the fast slice auditable without pretending it followed the normal
flow from the start.

In scope:

- Backfill this spec.
- Backfill the implementation plan.
- Open or attach a recovery issue before requesting L1/L2/L3.
- Mark current work as first-slice/verified-locally only.

Out of scope:

- Claiming production readiness before audit.
- Sending audit requests that require reviewers to reconstruct context from
  Discord conversation.

## Requirements

### Token Management Inventory

- Store token management evidence in DB rows, not plaintext secrets.
- Each Discord-visible bot must have token-backed evidence before it can become
  a delivery consumer.
- Preserve `agent_id` as the canonical AUN identity. Provider identities such as
  Discord IDs are evidence, not replacements for `agent_id`.
- Materialize inventory from bot profiles through `agent profile project`.

Required tables:

- `connector_credentials`: `provider`, `agent_id`, connector reference,
  `credential_kind`, `secret_ref`, optional non-secret fingerprint, status,
  trust status, evidence revision, metadata, timestamps.
- `agent_provider_identities`: expected/verified provider subject ID and handle
  evidence for an agent.
- `agent_ui_bindings`: UI/provider binding that ties `agent_id` to provider
  subject, token reference, connector, credential, and provider identity.
- `provider_channel_access`: provider discovery evidence for channel-level
  access. This may remain empty until the provider discovery slice lands.

### UI Surface Binding

`agent_ui_bindings` is the canonical UI binding surface. It must be generic
enough to support Discord first and later custom UIs without schema rewrites.

Minimum fields:

- `agent_id`
- `ui_type`
- `ui_id`
- `ui_handle`
- `ui_token_ref`
- `connector_instance_id`
- `credential_id`
- `provider_identity_id`
- `surface_role`
- `status`
- `trust_status`
- `evidence_revision`
- `metadata`

Uniqueness:

- Active UI identities are unique by `(ui_type, ui_id)`.
- Active primary/projection roles are unique by `(agent_id, ui_type,
  surface_role)`.

Provider-neutral examples:

| UI surface | `ui_type` | `ui_id` example | Token need |
| --- | --- | --- | --- |
| Discord bot | `discord` | Discord bot snowflake | required for Discord-visible posting |
| Custom chat bot | `custom_chat` | custom bot/account id | depends on custom adapter |
| Operator web UI | `operator_ui` | local user/session id | usually no posting token |
| Internal worker pane | `worker_ui` | runtime/session id | no Discord token |

Token inventory status model:

- `connector_credentials.status`: `registered`, `active`, `disabled`,
  `rotated`, or `revoked`.
- `connector_credentials.trust_status`: `local`, `unverified`, `verified`,
  `revoked`, or `disabled`.
- `agent_provider_identities.status`: `expected`, `verified`, `disabled`, or
  `revoked`.
- `agent_ui_bindings.status`: `registered`, `active`, `disabled`, or `revoked`.

### Discord Bot-To-Bot Display Path

The path to Discord showing bot-to-bot conversation is an identity binding and
delivery-consumer selection path. It must not change AUN queue ownership or make
Discord IDs replace `agent_id`.

Concrete implementation steps:

1. Keep `agents.agent_id` as the canonical AUN identity and keep bot profile
   metadata as the editable source for local profile projection.
2. Project each Discord-capable profile into `agent_ui_bindings` with
   `ui_type='discord'`, `ui_id` equal to the Discord bot/user/app subject ID,
   and `ui_token_ref` set to the non-secret token source reference.
3. Link the binding to normalized evidence in `connector_credentials` and
   `agent_provider_identities`; do not copy plaintext tokens into the binding.
4. Resolve inbound Discord mentions by normalizing provider mentions or
   snowflakes through `agent_ui_bindings` and provider identity evidence into
   exactly one canonical `agent_id`.
5. Resolve outbound delivery by mapping target `agent_id` to an active Discord
   `agent_ui_bindings` row, then to a token-backed connector credential and
   delivery consumer.
6. Have Discord posting use that delivery consumer's token-backed bot identity.
   When both sender and receiver have Discord bot bindings, Discord displays the
   exchange as bot-to-bot conversation instead of as a generic router bot thread.
7. Make UI and operator surfaces read `agent_ui_bindings` first; inspect
   connector credential or provider identity tables only for evidence,
   diagnostics, or security review.

The required invariant is that a Discord-visible bot is selected only after the
canonical AUN target has been resolved. The provider identity chooses how to
post on the external surface; it does not choose which AUN agent owns the work.

### Binding Versus Send-Adapter Capability

UI-bot/internal-bot consistency and Discord send capability are adjacent but
separate responsibilities.

The UI-bot/internal-bot consistency layer answers:

- Which AUN `agent_id` does this UI/provider bot represent?
- Which provider subject ID, handle, or UI ID is bound to that agent?
- Which inbound provider mentions normalize to that `agent_id`?
- Which DB rows make the mapping visible to operators and UI clients?

The Discord send adapter answers:

- Which credential or token reference can currently post?
- Which connector instance is active for that token reference?
- Whether the token has write/access capability for the target channel or
  thread.
- Which provider message ID, delivery attempt, error, or fallback decision was
  produced by the send operation.

The binding layer should not call Discord or prove channel permissions on every
message. The send adapter should not invent identity mappings or silently choose
a different logical agent. The contract between them is DB evidence:
`agent_ui_bindings` names the intended UI/provider bot for `agent_id`, while
connector credential and channel access evidence let the Discord adapter decide
whether that intended bot can actually send.

If the binding exists but send capability is missing, AUN should record a
diagnosable delivery failure instead of falling back to another bot identity.

### Duplicate Two-Message Risk

The observed "two messages at the same timing" problem is likely in the same
area as mention recognition and delivery fanout, but it must be proven by
tests before being marked fixed.

Likely causes to inspect:

- An explicit AUN mention and a Discord `<@snowflake>` mention both resolve to
  the same `agent_id` and both paths enqueue work.
- A legacy fanout or CC path adds the same recipient after the primary mention
  already selected it.
- Reply target inference and explicit mention parsing both add the same target.
- A direct `send` path and a notify/fallback path both deliver after only one
  should have been accepted.

Required invariant:

- Build the normalized recipient set after all mention sources are parsed.
- Deduplicate by canonical `agent_id`, not by raw mention text or provider
  subject ID.
- If an explicit AUN `agent_id` and a provider mention resolve to the same
  active binding, create one queue row.
- If two provider/UI IDs are aliases for the same active `agent_id`, create one
  queue row.
- If two distinct active agents are mentioned, create one row per distinct
  `agent_id`.
- If a binding is unknown, disabled, or tokenless for Discord delivery, do not
  create an extra fallback recipient silently.

Acceptance tests for this risk:

- Discord content containing both `@agent_id` and `<@discord_id>` for the same
  active binding produces exactly one `message_queue` row.
- Two active UI bindings that point to the same `agent_id` produce one row when
  both are mentioned.
- Two different active agents still produce two queue rows.
- Disabled or unknown UI bindings do not create an extra queue row.
- A direct `send` success or queued delivery prevents notify/fallback from
  creating a duplicate message for the same logical reply.

### Token-Backed Delivery Guard

- Discord delivery-consumer selection must reject tokenless owners.
- Token evidence may come from profile token source ref, legacy token evidence,
  or connector metadata token evidence.
- Projection identity may remain identity-based, but delivery ownership must be
  token-backed for Discord.

Token evidence sources:

- `agents.provider_token_source_ref`
- legacy `agents.discord_token` where a local SQLite legacy schema still has it
- `agents.metadata` token reference or non-secret fingerprint
- `connector_instances.metadata` token reference or non-secret fingerprint

If no token evidence is present for a Discord owner, the implementation must
skip connector/binding creation or delivery-consumer selection with diagnostic
evidence instead of silently falling back.

### Internal Worker Visibility

- Internal workers may run without Discord tokens.
- A worker must expose DB evidence for current assignment, queue row, runtime,
  progress summary, repo/branch/PR/artifact context, blocked reason, and handoff
  target when known.
- `worker_activity` is the operator-facing activity row.
- `agent-com worker report` creates or replaces an activity row.
- `agent-com worker ping` updates heartbeat/progress for long-running work.
- `agent-com worker list` and `agent-com status --format json` expose activity
  rows for operators and UI.

Required liveness semantics:

- `heartbeat_at` records the last activity heartbeat.
- `stale_after_sec` defines when the row becomes stale.
- `progress_percent` is optional 0-100 progress evidence.
- `progress_label` is an optional phase label such as `analysis`,
  `implementation`, `verification`, or `reply`.
- Derived visibility state:
  - `moving`: non-terminal row with heartbeat age <= stale threshold.
  - `stale`: non-terminal row with heartbeat age > stale threshold.
  - `unknown`: no heartbeat evidence.
  - `closed`: terminal row (`completed`, `failed`, or `handoff`).

Timestamp rule:

- Postgres timestamptz and SQLite `datetime('now')` must both parse as UTC for
  worker liveness. A fresh SQLite row must not appear stale because the process
  local timezone differs from UTC.

## Rollback And Compatibility

- Migrations are additive and should be idempotent.
- Rollback SQL may drop the new fast-slice tables and indexes, but must not
  mutate existing `agents`, `message_queue`, `agent_messages`, or
  `outbound_queue` history.
- Hot-path code must tolerate missing new tables/columns during mixed-version
  local runs where possible.
- Live DB rows created by the fast slice are evidence rows. If L2/L3 rejects the
  slice, disable or drop only the new evidence surfaces through an explicit
  rollback plan.

## Acceptance Criteria

- SQLite and Postgres migrations create the token inventory and worker activity
  tables idempotently.
- `agent profile project` materializes token inventory rows without plaintext
  token storage.
- Discord channel connector sync and outbound projection reject tokenless
  Discord delivery owners.
- Inbound mention normalization deduplicates recipients by canonical
  `agent_id`, so one logical target cannot receive two queue rows from explicit
  and provider mentions in the same message.
- Direct send and notify/fallback behavior cannot create two logical deliveries
  for the same reply once the direct path has queued or sent successfully.
- `worker report`, `worker ping`, `worker list`, and `status --format json`
  work in SQLite and Postgres paths.
- Fresh SQLite `datetime('now')` rows are parsed as UTC so fresh heartbeat does
  not incorrectly appear stale.
- Targeted tests cover schema creation, profile projection, token-backed owner
  rejection, worker reporting, worker ping, and status exposure.

## Definition Of Done

This work is not done when the code compiles. It reaches each state as follows:

- `first-slice`: code exists and can run locally.
- `verified-locally`: targeted tests, migration check, and live smoke have
  passed.
- `recovery-packet-ready`: issue, this spec, implementation plan, local test
  evidence, and live smoke evidence are attached.
- `audit-ready`: L1/L2/L3 reviewers can evaluate without reading Discord
  history.
- `production-ready`: all L1/L2/L3 findings are resolved and merge/rollback
  decision is recorded.

## Audit Status

This spec is a backfill draft for stabilization. It must be paired with an
implementation plan and issue before L1/L2/L3. Auditors should review this as a
recovery packet, not as evidence that the branch is already production-ready.
