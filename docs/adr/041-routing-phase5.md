# ADR-041: Phase 5 Routing — `mention` / `mentions[]` + `cc[]` (4-port abstraction)

> **Status**: Accepted (initial Phase 5 landing) → **Amended 2026-05-05** (mentions[] removed) → **Amended 2026-05-27** (mentions[] restored with canonical normalization)
> **Issues**: #305 / #306 / #308 / #250
> **PRs**: PR-Phase5 series (4-port abstraction), PR #309 (ACL via 4-port), PR-mention-required-mentions-array-removed (this amendment)

## Context

Phase 5 introduced the 4-port routing abstraction (`InboundResolver` /
`PrimaryFallback` / `OutboundPolicyValidator` / `MessageBodyDecorator`,
`core/routing/ports/`) sourced from `config/bot-routing.json`. The new
canonical send/notify shape is:

- `mention?: AgentId` — **1 primary recipient** (queue 投入)
- `mentions?: AgentId[]` — explicit multi-recipient fanout (deduped, queue 投入 per recipient)
- `cc?: AgentId[]` — reference recipients (queue **非投入**, body 末尾に `[CC: <@id>]` 注入)

Initially, the legacy `mentions: AgentId[]` argument was retained with
auto-convert (`mentions[0]` → `mention`, rest → `cc`) and a deprecation
warning so existing callers could migrate without breakage.

## Decision (initial)

Land 4-port abstraction; auto-convert `mentions[]` → `mention + cc[]` with
warning; plan removal in 1-2 sprints.

## Amendment 2026-05-27 (CEO directive `66e18dc3`)

The 2026-05-05 removal is superseded for explicit fanout: `mentions[]` is
restored as a supported send/notify input for true multi-recipient delivery.
`mention` and `mentions[]` are both normalized through
`core/mention-normalization.ts` into canonical `agent_id[]`.

### Rationale

- Multiple bot recipients are a real use case and should not require repeated
  sends when the same content targets several agents.
- Agent identity must be normalized in one source of truth. Native aliases
  such as `@cto` normalize to the canonical runtime owner (`codex-cto`) before
  queue routing.
- Missing mention targets must not silently fall through to `channel.primary`
  or human fanout. No-mention inbound messages now produce an explicit
  missing-target route result so the router/adapter can reply with a human
  alert.

### Current contract

- `mention` and `mentions[]` may be supplied independently or together; the
  normalized queue list is deduped.
- `cc[]` remains reference-only and is never enqueued.
- Missing or empty `mention`/`mentions[]` → `INVALID_MENTION`.
- Unknown non-group agent IDs → `UNKNOWN_AGENT`.
- Intentional broadcast remains explicit via `@all` / `@everyone` / `@here`.

## Amendment 2026-05-05 (CEO directive `5e2d9235`)

The legacy `mentions[]` argument is **completely removed**. `mention`
(1 primary) is required; `cc[]` (queue 非投入、body suffix 注入) remains.
This amendment is historical as of the 2026-05-27 restoration above; its
anti-pattern target was silent auto-conversion, not explicit fanout.

### Rationale

- Auto-convert deprecation alone did not drive caller migration: ADR-041
  issued the deprecation notice but `mentions[]`-shape callers persisted
  (per `bot-registry.txt` snapshot 2026-05-04).
- 2026-05-04 CTO #agent-com queue plateaued at 60+ (msg `30ff2632`).
  Breakdown: stall-checker α 14 / **mention 重複 20** / factored 9 /
  unique actionable 13. Multi-mention `send` calls (avg 2-4 mentions ×
  5-6 senders) drove the linear `agent_messages` INSERT amplification —
  the structural cause of the plateau, not warning cardinality.
- Continued auto-convert blocked the `cc[]` queue 非投入 invariant from
  being observable: `mentions[a,b,c]` enqueued all 3, even when the
  caller's intent was `a primary + b/c CC`.

### Historical Scope of Removal

- **MCP schema**: `send` / `notify` `inputSchema` no longer declared
  `mentions`; `mention` is in `required: [...]`.
- **Server runtime**: `args.mentions !== undefined` produced an
  `INVALID_MENTION` reject with literal phrase
  `mentions[] is removed in Phase 5 cleanup, use { mention: 'primary',
  cc: ['observers'] } instead` (no silent conversion).
- **Routing port**: `InboundResolveInput.mentions` field was deleted;
  auto-convert branch deleted.
- **Adapter symmetry**: `send` AND `notify` share the same schema /
  validator / reject semantics (per the 4-port invariant).

### Migration

Callers update from
```
{ mentions: ['cto', 'ceo', 'agent-com-dev'] }
```
to
```
{ mention: 'cto', cc: ['ceo', 'agent-com-dev'] }
```

Bot-script migration in external repos (`~/Developer/{lead-*,*-dev}`) is
each per-bot dev's responsibility (separate PRs); this PR scope is the
agent-comms-mcp core only.

### Failure modes preserved

- `mention` empty / missing → `INVALID_MENTION`
- `mention` unknown agent → `UNKNOWN_AGENT`
- sender or recipient violates `outboundAllowlist` → `OUTBOUND_ACL_VIOLATION`
- `cc[]` unknown agents → strip + warning (degradation safe, unchanged)

### Test gates

- `tests/routing/ports.test.ts` — port-level dedup / validation / cc[] body
  injection; auto-convert tests removed (the `mentions` field no longer
  exists at type level).
- `tests/contract/test_no_mentions_array_remnant.test.ts` — 6 fixtures
  (a-f) covering reject symmetry, `INVALID_MENTION` / `UNKNOWN_AGENT`
  error class pinning, cc[] queue 非投入 SQL invariant, repo-wide grep
  for legacy shape, and this ADR amendment hash pin.
- `tests/contract/test_input_mentions_trace.test.ts` — snapshot semantics
  updated to reflect the singular `args.mention` shape.

## Consequences

- Breaking change: pre-amendment callers (`mentions: [...]`) fail with a
  clear migration error instead of silent conversion. Marked with
  `breaking-change-verified` PR label per
  `~/.claude/rules/governance-flow.md`.
- CTO queue #agent-com plateau is expected to drop because each `send`
  enqueues only 1 row (mention) instead of N (one per mention entry).
- Lead-bot / dev-bot scripts in external repos must migrate before they
  can `send` again; the reject error message includes the new shape so
  the caller can self-correct.

## References

- CEO directive: `c40b8dc9` / `5e2d9235`
- ARC Option (b) approval: `f411e1da`
- 1 PR 1 concern exception: `0abf16e9`
- Pre-impl gate auditor PASS 6/6: `70efc425`
- lead-ama dispatch (3-split): `fb9fd718` / `d3025da7` / `5f1de02f`
- CTO L3 alignment: `4ea436e4`
- CTO queue plateau diagnosis: `30ff2632` (2026-05-04)
