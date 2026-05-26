# AUN Token And Worker Visibility Fast-Slice Implementation Plan

Status: stabilization recovery plan, not production-ready.

Branch: `codex/token-backed-discord-channel-bots`

Recovery issue: https://github.com/watchout/agent-comms-mcp/issues/568

## Decision

Do not send the current branch to audit as "done." The correct path is:

1. Freeze feature scope.
2. Backfill issue/spec/implementation evidence.
3. Run local and live smoke verification.
4. Send the recovery packet to L1/L2/L3.
5. Fix audit findings.
6. Only then treat the work as merge/production-ready.

Scope is frozen to the recovery of the already-implemented fast slices. New
feature work must move to follow-up issues unless it is required to make the
current recovery packet auditable.

## PR And Audit Sequencing

Recommended path:

1. Open or update a recovery issue and, if useful, a draft PR now so reviewers
   can see the direction and evidence trail.
2. Do not ask L1/L2/L3 to pass the branch as merge-ready until the
   binding-native implementation and evidence are attached to the audit packet.
3. Keep the binding-native changes in this slice scoped to
   `agent_ui_bindings`-first mention resolution, outbound projection, and
   send-path diagnostics.
4. Add targeted tests for binding lookup precedence, member-scoped dedup,
   token-backed delivery consumer selection, and direct-send versus fallback
   duplicate prevention.
5. Submit the final audit packet as docs plus implementation plus test/live
   evidence.

A docs-only or plan-only PR is acceptable only as an early design/recovery
review artifact. It must be labeled draft/recovery and must not be represented
as "audit-passed" or "production-ready." The full audit should evaluate the
spec and implementation together because the risk is in whether DB evidence,
mention normalization, and Discord delivery behavior actually line up.

If the diff becomes too large, split by behavior rather than by docs/code:

- PR 1: token inventory, worker visibility, and already-implemented
  token-backed delivery guard, with clear caveat that bot-to-bot binding-native
  send is follow-up.
- PR 2: binding-native Discord mention/send path and duplicate-message guard.

Do not split into "spec first" and "implementation later" for final approval;
that would force audit to approve intent without executable evidence.

Forward rule for future work:

- Write or update the spec before implementation starts.
- Implement only the approved/specified scope.
- Run targeted tests and collect live evidence where the behavior touches live
  DB, Discord, queue, token, or worker visibility paths.
- Request audit after spec, implementation, and evidence are aligned.
- Do not treat retrospective spec backfill as the normal process. This branch is
  a recovery exception caused by a CEO-directed fast slice, not the default
  delivery model.

## Product Framing

The work is a UI/chat-surface binding recovery, not merely a Discord token
patch.

- AUN internal identity remains `agent_id`.
- External UI/chat bots bind to `agent_id` through `agent_ui_bindings`.
- Discord is the first concrete provider.
- The same table should cover custom chat UIs, operator UIs, web UIs, or future
  provider surfaces by varying `ui_type`, `ui_id`, and `surface_role`.
- Credential/provider/channel tables are supporting evidence, not separate UI
  entry points.

Audit should check whether `agent_ui_bindings` is generic enough to be the one
UI-facing table while still keeping token/security evidence normalized.

## Bot-To-Bot Delivery Phase Plan

The Discord bot-to-bot outcome is reached by separating canonical AUN identity
from provider UI identity, then using the provider identity only at the
inbound/outbound surface edges.

Internal naming:

- Product-level "send adapter" maps to the existing outbound path made of
  `outbound_queue`, `adapters/outbound-consumer.ts`,
  `adapters/discord-client.ts`, and `adapters/discord.ts`.
- `core/outbound-projection.ts` decides which `agent_id` should be the
  delivery consumer and which identity is being projected.
- `DiscordAdapter.sendAdapterMessage()` is the provider call boundary.
- `core/send-fanout.ts` is separate internal fanout to recipient
  `message_queue` rows; it is not the Discord send adapter.

Current send-adapter status:

- The async outbound send path already exists and is not a from-scratch build.
- Queue claiming is already keyed by `COALESCE(consumer_agent_id, agent_id) =
  AGENT_ID`, so the consumer side is largely `agent_id` based.
- The per-bot Discord client registry already avoids shared-client fallback
  (`discordClients.get(AGENT_ID)` must exist or delivery fails).
- This branch now makes the core Discord identity evidence binding-native:
  mention conversion, inbound sender/mention resolution, outbound projection,
  token-evidence checks, and diagnostics prefer `agent_ui_bindings` and
  normalized credential evidence before legacy compatibility metadata.
- Remaining deferred work is provider-side channel write/access discovery and
  live smoke evidence that proves the selected Discord bot identity is visible
  on the provider surface.

### Phase 0. Recovery Evidence

- Freeze the current fast-slice scope and record this recovery path in the
  issue/spec/plan.
- Attach the CEO prompts, local tests, live DB migration evidence, and live
  projection counts.
- Keep the branch labeled `first-slice` and `verified-locally` only until
  L1/L2/L3 have reviewed it.

### Phase 1. Canonical Binding Table

- Use `agent_ui_bindings` as the single UI-facing lookup for external surface
  identities.
- Keep `agent_id` canonical and treat Discord IDs, app IDs, handles, and token
  references as provider evidence.
- Keep plaintext tokens out of DB hot-path tables.

### Phase 2. Discord Registry Projection

- Project existing bot profiles into `connector_credentials`,
  `agent_provider_identities`, and `agent_ui_bindings`.
- Store `ui_type='discord'`, the Discord subject ID as `ui_id`, and the
  non-secret token source as `ui_token_ref`.
- Link credentials and provider identities from the binding so operator and UI
  surfaces can explain why a bot can or cannot post.

### Phase 3. Mention Resolver And Dedup

- Parse explicit AUN mentions, Discord provider mentions, reply target hints,
  and any legacy fanout inputs into one candidate recipient set.
- Normalize every candidate through `agent_ui_bindings` or existing identity
  evidence to canonical `agent_id`.
- Deduplicate by canonical `agent_id` before creating `message_queue` rows.
- Treat the two-message-at-once issue as unresolved until tests prove one
  logical target creates exactly one queue row.

### Phase 4. Send-Adapter Capability Check

- Treat token evidence, active connector state, and channel write/access checks
  as Discord send-adapter responsibilities.
- Feed the adapter the intended `agent_id` and active Discord
  `agent_ui_bindings` row; do not ask it to invent identity mappings.
- Let the adapter produce delivery evidence: selected connector, provider
  message ID, failure reason, fallback decision, and diagnostics.
- Replace remaining legacy identity lookups in the send path with binding-native
  lookups where needed:
  - mention conversion should prefer `agent_ui_bindings(ui_type='discord')`
    before `agents.metadata.discord_id`
  - token/client selection should be explainable through credential or binding
    evidence before falling back to compatibility paths
  - channel write/access evidence should be checked by the adapter or marked as
    deferred provider-discovery work

### Phase 5. Outbound Bot-To-Bot Projection

- Resolve target `agent_id` to the active Discord `agent_ui_bindings` row.
- Ask the Discord adapter to verify token-backed connector capability before
  selecting a delivery consumer.
- Send through the selected agent bot token so Discord displays the message
  under that bot identity.
- Preserve queue owner, projection identity, and historical message ownership.

### Phase 6. Live Smoke And Audit

- Run local SQLite/Postgres tests for projection, token guard, mention dedup,
  and fallback dedup.
- Run live smoke that proves profile projection creates bindings and direct
  delivery does not need a router bot as the visible product identity.
- Attach evidence to the recovery issue before asking L1/L2/L3.

## Current Fast-Slice Contents

Token inventory and token-backed Discord delivery guard:

- `core/token-evidence.ts`
- `core/channel-connector-sync.ts`
- `core/outbound-projection.ts`
- `db/migrate.ts`
- `db/migrate-sqlite.ts`
- `db/migrations/2026-05-26-token-management-inventory.*.sql`
- `tests/channel-connector-sync.test.ts`
- `tests/contract/test_outbound_projection_owner.test.ts`

Worker visibility and liveness:

- `cli/index.ts`
- `db/migrate.ts`
- `db/migrate-sqlite.ts`
- `db/migrations/2026-05-26-worker-activity-visibility.*.sql`
- `tests/cli-sqlite-backend.test.ts`
- `docs/spec/aun-communication-stability-mvp-impl.md`
- `docs/design/agent-registry-ui-spec.md`

Recovery documents:

- `docs/spec/aun-token-worker-visibility-fast-slice-spec.md`
- `docs/plans/aun-token-worker-visibility-fast-slice-impl-plan.md`

## Work Breakdown

### A. Token Inventory

Already implemented:

- Add `connector_credentials`.
- Add `agent_provider_identities`.
- Add `provider_channel_access`.
- Add `agent_ui_bindings`.
- Extend profile projection so existing bot profiles can materialize inventory
  rows.
- Verify live DB counts after projection.

Still needed before audit:

- Attach the exact projection command and count output to the recovery issue.
- Confirm whether synthetic roundtrip agents should be excluded by policy or
  repaired separately.
- Confirm whether the `agent_ui_bindings` fields are enough for non-Discord UI
  surfaces before calling the schema audit-ready.

Deferred follow-up:

- Provider discovery that fills `provider_channel_access`.
- Token rotation UI/API.
- Encrypted secret-value storage.
- Surface-specific adapters for custom chat/web UI.

### B. Token-Backed Discord Delivery Guard

Already implemented:

- Add shared token evidence collection.
- Make channel connector sync skip tokenless Discord owners.
- Make outbound projection avoid tokenless Discord delivery consumers.
- Add regression tests.

Still needed before audit:

- Attach tests that show tokenless owners are rejected.
- Ask L2 to inspect the distinction between delivery consumer and projection
  identity.

Deferred follow-up:

- Full effective delivery owner resolver based on provider channel access.

### B2. Mention Resolver And Duplicate Delivery Guard

Already implemented:

- `core/ui-bindings.ts` provides `agent_ui_bindings`-first Discord identity
  lookups with legacy `agents.metadata.discord_id` fallback.
- Discord provider mentions and explicit AUN mentions normalize through the
  shared route helpers before queue fanout.
- Member-scoped Discord lookup deduplicates by canonical `agent_id` and fails
  closed on ambiguous bindings.
- Discord adapter mention conversion now uses the binding-first helpers.

Still needed before audit:

- Add tests that combine explicit `agent_id` mentions and Discord
  `<@snowflake>` mentions for the same binding and assert one queue row.
- Keep the existing tests for two UI bindings that map to the same `agent_id`.
- Add tests proving two distinct agents still receive two distinct queue rows.
- Keep the existing tests for unknown or disabled UI bindings.
- Verify direct `send` and notify/fallback cannot create duplicate logical
  deliveries once direct delivery has queued or sent successfully.

Deferred follow-up:

- Provider-specific parser cleanup if the current mention parser cannot cleanly
  express canonical recipient normalization.
- UI affordances that show which raw mention was normalized to which
  `agent_id`.

### C. Worker Visibility And Liveness

Already implemented:

- Add `worker_activity`.
- Add `agent-com worker report`.
- Add `agent-com worker ping`.
- Add `agent-com worker list`.
- Add `worker_activity` to `status --format json`.
- Add `progress_percent`, `progress_label`, `stale_after_sec`, and derived
  `visibility_state`.
- Fix SQLite UTC timestamp parsing for heartbeat freshness.

Still needed before audit:

- Attach live smoke showing `moving` and `closed`.
- Add or capture a stale-state example. This can be a controlled SQLite/fixture
  test or a live DB row with a deliberately old heartbeat in a throwaway DB.

Deferred follow-up:

- Operator UI.
- Discord progress summary projection through lead/channel-facing bots.
- Automated restart/cancel policy for stale workers.

### D. Governance Recovery

Already implemented:

- Add draft backfill spec.
- Add this implementation/recovery plan.

Still needed before audit:

- Open or attach the recovery issue.
- Paste CEO source messages and branch status.
- Paste local test evidence and live smoke evidence.
- Decide whether this remains one recovery PR or splits into two PRs.

Deferred follow-up:

- A reusable "fast slice recovery" checklist or CLI helper.

## Recovery Steps

### 1. Issue Backfill

Create or attach one recovery issue that states:

- CEO explicitly requested a fast first slice.
- The branch was implemented before full gate evidence.
- The branch is not production-ready.
- Audit must verify both the implementation and the recovery packet.

If the review load is high, split into two issues:

- Token registry and token-backed Discord delivery guard.
- Internal worker visibility and liveness/progress reporting.

Issue must explicitly include:

- Current gate state: `first-slice` and `verified-locally` only.
- Live DB tables already created.
- Recovery risk: implementation came before formal spec and audit.
- Proposed audit question: whether to keep, split, revise, or roll back.

### 2. Spec Backfill

Use `docs/spec/aun-token-worker-visibility-fast-slice-spec.md` as the initial
spec. Before audit, confirm it covers:

- DB schema and indexes.
- Secret handling and no-plaintext-token rule.
- Bot-to-bot delivery path from `agent_id` through `agent_ui_bindings` to
  token-backed Discord connector.
- Mention/fanout dedup invariant for the two-message-at-once problem.
- Delivery-consumer eligibility.
- Worker activity status and liveness semantics.
- Migration/rollback behavior.
- Deferred provider discovery and UI projection work.

### 3. Implementation Evidence

Attach these commands and outputs to the issue/PR:

```bash
bun test tests/cli-sqlite-backend.test.ts \
  tests/channel-connector-sync.test.ts \
  tests/contract/test_outbound_projection_owner.test.ts \
  tests/spec-enforcement/outbound-queue-phase3.test.ts \
  tests/db-adapter.test.ts \
  tests/runtime-heartbeat.test.ts \
  tests/control-plane-leases.test.ts \
  tests/unit/discord-ui-bindings.test.ts \
  tests/unit/member-scoped-discord-resolver.test.ts \
  tests/spec-enforcement/send-mention-union.test.ts \
  tests/contract/test_delivery_diagnostics.test.ts
git diff --check
DATABASE_URL=postgresql://localhost/agent_comms AGENT_COM_DB=postgres bun db/migrate.ts
```

Live smoke evidence to capture:

- `agent profile project` dry-run and selected execute results.
- Counts for `connector_credentials`, `agent_provider_identities`,
  `agent_ui_bindings`, and `provider_channel_access`.
- `worker report`, `worker ping`, `worker list`, and `status --format json`
  evidence showing `moving`, `stale`/threshold behavior, and `closed`.

Minimum current evidence to paste:

- Binding/projection/worker targeted suite: `122 pass`, `0 fail`.
- Inbound/router surrounding suite: `107 pass`, `0 fail`.
- Binding-focused suite: `36 pass`, `0 fail`.
- `git diff --check`: pass.
- Live Postgres migration: pass.
- Live worker activity row for queue `84250` reached `completed`, 100%, `done`.

### 4. L1 Request

Ask L1 to review:

- Scope recovery honesty: is this correctly labeled as fast slice?
- Data model safety: are DB rows additive and bounded?
- Basic behavioral tests: do tests cover the acceptance criteria?
- Live DB impact: are already-applied migrations acceptable and reversible?

### 5. L2 Request

Ask L2 to review:

- Security: token secret handling and no plaintext leakage.
- UI binding model: `agent_ui_bindings` as one provider-neutral UI entry point
  rather than Discord-only schema.
- Mention normalization: explicit AUN mentions and provider mentions resolve to
  one canonical recipient set deduplicated by `agent_id`.
- Duplicate delivery safety: direct send and notify/fallback cannot both create
  deliveries for one logical reply.
- Routing correctness: tokenless Discord owners cannot deliver.
- SQLite/Postgres parity.
- Liveness correctness, especially timestamp handling and stale detection.
- Migration idempotency and rollback files.

### 6. L3 Request

Ask L3 to decide:

- Whether the fast-slice recovery is acceptable.
- Whether to split into two PRs before merge.
- Whether live DB changes need an explicit rollback/reapply plan.
- Whether deferred provider discovery/UI projection work blocks merge or can be
  tracked separately.

## Stop Conditions

Stop and do not request audit if any of these are true:

- The recovery issue is missing.
- The spec or implementation plan still says the branch is production-ready.
- A migration command fails.
- `git diff --check` fails.
- Targeted tests fail.
- Live DB evidence cannot be explained.
- Scope keeps expanding beyond the current token/worker visibility slices.

## Ready-To-Audit Checklist

- [ ] Recovery issue exists.
- [ ] Spec is attached or linked.
- [ ] Implementation plan is attached or linked.
- [ ] Diff summary is attached.
- [ ] Targeted test output is attached.
- [ ] Live migration evidence is attached.
- [ ] Live token inventory counts are attached.
- [ ] Live worker visibility evidence is attached.
- [ ] Deferred work list is attached.
- [ ] L1/L2/L3 review prompts are written.

## Gate Labels

- `first-slice`: working implementation exists.
- `verified-locally`: targeted tests and local checks pass.
- `recovery-packet-ready`: issue, spec, implementation plan, and evidence are
  attached.
- `audit-ready`: L1/L2/L3 requests can be sent.
- `production-ready`: all gate findings are resolved.

Current status: `first-slice` and `verified-locally`; recovery issue #568 is
open; not yet `audit-ready` or `production-ready`.

## Immediate Next Step

Attach the draft PR and latest test/live evidence to issue #568. Do not request
production approval until L1/L2/L3 findings are resolved.
