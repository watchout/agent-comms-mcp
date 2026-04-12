# SSOT-1: Feature Catalog — agent-comms-mcp

> Source extracted from codebase on 2026-04-13 JST by lead-ama.
> Format: `| ID | Feature Name | Priority | Type | Size | Dependencies |` — parsed by `framework plan` (`plan-engine.js::parseFeaturesFromMarkdown`).

---

## Feature List

| ID | Feature Name | Priority | Type | Size | Dependencies |
|----|--------------|----------|------|------|--------------|
| FEAT-001 | Discord inbound receiver (stdio onMessage → handleInboundMessage) | P0 | proprietary | L | None |
| FEAT-002 | agent_messages universal log (all direction/role, partial UNIQUE) | P0 | proprietary | M | None |
| FEAT-003 | message_queue per-agent push queue with dedup UNIQUE | P0 | proprietary | L | FEAT-002 |
| FEAT-004 | outbound_queue Discord send queue (pending→processing→sent/failed) | P0 | proprietary | L | FEAT-002 |
| FEAT-005 | Outbound forwarder unification (daemon-owns-outbound, S2-A/S3) | P0 | proprietary | L | FEAT-004 |
| FEAT-006 | Per-bot Discord adapter (token-scoped client, outbound REST) | P0 | proprietary | M | None |
| FEAT-007 | Shared Discord adapter (Pattern A human-warning only onMessage) | P1 | proprietary | S | FEAT-001 |
| FEAT-008 | PollingDriver buffer (1s tick, pg_notify hybrid) | P0 | proprietary | M | FEAT-003 |
| FEAT-009 | Agent registration + heartbeat (agents table, last_seen_at) | P0 | proprietary | S | None |
| FEAT-010 | pg_notify agent_events channel (online/offline broadcast) | P1 | proprietary | S | FEAT-009 |
| FEAT-011 | Inbound mentions filter + route (core/route-message, pushTargets) | P0 | proprietary | M | FEAT-001 |
| FEAT-012 | Message split for platform limits (core/message-split, Discord 2000) | P1 | proprietary | S | None |
| FEAT-013 | Platform-friendly send safety layer (burst/dup/backoff/mention sanitize) | P1 | proprietary | M | FEAT-004 |
| FEAT-014 | MCP tool: next (pop oldest queued message) | P0 | proprietary | S | FEAT-003 |
| FEAT-015 | MCP tool: send (enqueue to outbound_queue) | P0 | proprietary | S | FEAT-004 |
| FEAT-016 | MCP tool: unfocus (clear active_project focus) | P2 | proprietary | S | FEAT-009 |
| FEAT-017 | MCP tool: quote (fetch message by id) | P2 | proprietary | S | FEAT-002 |
| FEAT-018 | MCP tool: history (channel history via DB) | P1 | proprietary | S | FEAT-002 |
| FEAT-019 | MCP tool: inbox (pending messages for current agent) | P1 | proprietary | S | FEAT-003 |
| FEAT-020 | MCP tool: fetch_discord_history (direct Discord API) | P2 | proprietary | S | FEAT-006 |
| FEAT-021 | MCP tool: agents (list registered agents + status) | P1 | proprietary | S | FEAT-009 |
| FEAT-022 | MCP tool: restart_bot (tmux session restart with auto-confirm) | P1 | proprietary | M | None |
| FEAT-023 | MCP tool: bot_status (health of all registered bots) | P1 | proprietary | S | None |
| FEAT-024 | MCP tool: watchdog_check (liveness probe) | P2 | proprietary | S | FEAT-023 |
| FEAT-025 | MCP tool: cleanup_ports (kill orphan port holders) | P2 | proprietary | S | None |
| FEAT-026 | CLI: daemon (long-running polling + outbound consumer) | P0 | proprietary | M | FEAT-008 FEAT-005 |
| FEAT-027 | CLI: next / send / agents / status / heartbeat | P0 | proprietary | M | FEAT-014 FEAT-015 |
| FEAT-028 | CLI: channel create / add-member / remove-member / members | P1 | proprietary | S | None |
| FEAT-029 | CLI: agent register (with runtime / display-name / type) | P1 | proprietary | S | FEAT-009 |
| FEAT-030 | Webhook inbound adapter (connect-webhook-push) | P1 | proprietary | M | FEAT-011 |
| FEAT-031 | SSE transport (push delivery over Server-Sent Events) | P2 | proprietary | L | FEAT-003 |
| FEAT-032 | LLM adapter abstraction (anthropic / openai / google) | P2 | proprietary | M | None |
| FEAT-033 | HMAC signing for bridge webhooks (shared/hmac) | P1 | proprietary | S | None |
| FEAT-034 | Audit log (audit_log table, agent lifecycle events) | P1 | proprietary | S | FEAT-009 |
| FEAT-035 | Rate limiting (rate_limits table, per agent/channel) | P1 | proprietary | S | FEAT-002 |
| FEAT-036 | Duplicate detection window (duplicate_hashes, 10s) | P1 | proprietary | S | None |
| FEAT-037 | Channel adapter registry (channel_adapters / channel_settings) | P1 | proprietary | M | None |
| FEAT-038 | Thread adapter + threads mapping (Discord thread → channel) | P1 | proprietary | M | FEAT-037 |
| FEAT-039 | Decisions / knowledge / task_states persistence (memory tags) | P2 | proprietary | M | FEAT-002 |
| FEAT-040 | Recovery config + quality log (session recover_context) | P2 | proprietary | M | FEAT-002 |
| FEAT-041 | Shadow messages (dark-launch / canary staging) | P2 | proprietary | S | FEAT-002 |
| FEAT-042 | Catch-up log (session start context restore) | P2 | proprietary | S | FEAT-039 |
| FEAT-043 | Loop counters (cron-style recurring task state) | P2 | proprietary | S | None |
| FEAT-044 | DB migrations runner (db/migrate.ts, ADR-041/PR#140 schema) | P0 | proprietary | M | None |
| FEAT-045 | DB seed (db/seed.ts, fixture bootstrap for tests) | P1 | proprietary | S | FEAT-044 |
| FEAT-046 | DB cleanup (db/cleanup.ts, prune old queue rows) | P1 | proprietary | S | FEAT-003 FEAT-004 |
| FEAT-047 | Agent cache (core/agent-cache, in-memory agents lookup) | P1 | proprietary | S | FEAT-009 |
| FEAT-048 | Send error classification (core/send-errors) | P1 | proprietary | S | FEAT-004 |
| FEAT-049 | Orphan reclaim (outbound_queue processing-stuck recovery) | P1 | proprietary | S | FEAT-005 |
| FEAT-050 | Spec-enforcement tests (s2b-receiver-unify, s2a-daemon-owns-outbound) | P0 | proprietary | M | FEAT-001 FEAT-005 |

---

## Legend

- **Priority**: P0 (core / release-blocking), P1 (important), P2 (nice-to-have)
- **Type**: `common` (from ADF common-features catalog) / `proprietary` (project-specific)
- **Size**: S (≤1 day) / M (2-3 days) / L (1 week) / XL (>1 week)
- **Dependencies**: space-separated FEAT IDs; `None` if independent

All features here are **`proprietary`** because agent-comms-mcp is an infrastructure / messaging layer, not a generic SaaS app. The ADF `common-features` catalog (auth / account / role / CRUD / nav / notif) does not map onto this codebase.

---

## Status annotations (operational context, not parsed by `framework plan`)

| ID | Status | Notes |
|----|--------|-------|
| FEAT-001 | Existing (refactored by PR#157) | stdio-only inbound enforced; spec-enforcement test pins source-level invariant |
| FEAT-002 | Existing | PR#142 added `uq_mq_agent_message` partial UNIQUE (v1.0.3) |
| FEAT-003 | Existing | PR#140 prevents duplicate INSERT; PR#142 `ON CONFLICT DO NOTHING` |
| FEAT-004 | Existing | claim SQL race + identity misattribution (→ FEAT-005) |
| FEAT-005 | Refactoring | outbound_forwarder_unification plan v2 drafting in-flight (route:ceo-approval) |
| FEAT-006 | Existing | per-bot token map; `DISCORD_BOT_TOKEN` + per-agent overrides |
| FEAT-007 | Existing | Pattern A = unmention human warning (restored in PR#157 commit 4) |
| FEAT-008 | Existing | v1.0.2 §6.5 PR#139 |
| FEAT-014-025 | Existing | MCP tool surface stable |
| FEAT-031 | Existing | SSE_TRANSPORT_SPEC.md; low-traffic bridge path |
| FEAT-049 | Refactoring | to be added in outbound_forwarder_unification v2 |
| FEAT-050 | Existing | growing — s2a spec-enforcement test pending FEAT-005 |

---

## Cross-references

- **SSOT head**: `docs/SSOT.md` (v1 design principles, §1.4 seven invariants)
- **Detail spec**: `docs/agent-com-message-queue-spec.md` (§1 line 39: daemon owns PollingDriver + outbound_queue consumption)
- **SSE transport**: `docs/SSE_TRANSPORT_SPEC.md`
- **Related ADRs**: ADR-041 (Receiver-MessageBus), ADR-045 (Dev-Lead Pool)
- **Related merged PRs**: #139 (PollingDriver), #140 (mq dedup), #142 (UNIQUE + ON CONFLICT), #156 (D3 fallback), #157 (S2-B inbound unify), #160 (ADF retrofit)
- **Related in-flight**: outbound_forwarder_unification v2 (branch `plan/outbound-forwarder-unification`)

---

## Priority definition

| Priority | Definition | Target |
|----------|------------|--------|
| **P0** | Core / release-blocking — pipeline breaks without this | Already shipped or imminent |
| **P1** | Important — significant UX / operational degradation without this | Shipped or near-term |
| **P2** | Nice-to-have / supporting — observable only in specific flows | Shipped but low change velocity |

---

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-12 | Stub created by framework retrofit | agent-com-dev (PR #160) |
| 2026-04-13 | Initial catalog populated (50 features) from codebase survey | lead-ama |
