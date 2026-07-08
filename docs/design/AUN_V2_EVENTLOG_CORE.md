# AUN V2 Durable Core — EventLogCore/v1

- Status: built in branch `aun-v2-eventlog-core`; NOT wired into the running daemon
- Design authority: #794 (Reboot Architecture) + EventLogCore/v1 Option B owner
  decision (approved 2026-07-05, #794 comment 4884040411) +
  `SPEC-AUN-002-durable-core-build-target`
- Build handoff: #794 comment 4911246042 (owner → implementation, 2026-07-08)
- Cutover to the running daemon is a **protected surface: owner GO required**

## What this is

A NEW core, decoupled from V1's mutable-status machine. State is never
overwritten: everything that happens is one appended row in `event_log`, and
queue / inbox / thread / outbox are queries over that log. If any process —
or the whole fleet — dies, nothing is recovered *from* memory or status
columns, because nothing authoritative ever lived there.

```
core/eventlog/
├── types.ts    event vocabulary + SuiteEvent/v1-compatible envelope
├── schema.ts   append-only table, triggers, claim-arbiter unique indexes
├── store.ts    the only write path (INSERT-only, event_id idempotent)
├── views.ts    queue_view / inbox_view / thread_view / outbox_view + stall query
├── turns.ts    receive → pull-claim → present → complete (+outbox, fenced)
├── outbox.ts   delivery dispatcher (claimed attempts, nonce idempotency)
└── index.ts    public surface
```

## The five pieces (SPEC-AUN-002) and where they live

| Piece | Implementation |
|---|---|
| 1. Append-only event log | `event_log` table; `event_log_no_update` / `event_log_no_delete` triggers abort any UPDATE/DELETE; `event_id` UNIQUE = idempotency key (duplicate append is a no-op, never a second row) |
| 2. State = rebuildable projections | `views.ts` — every view is a pure query over the log; there is no materialized state to corrupt, so replay-rebuild is structural, not procedural |
| 3. Pull-claim | `claimNextTurn` appends `turn.claimed`; the partial unique index `uq_el_turn_claim(turn_id, claim_epoch)` arbitrates races — conditional insert wins, losers back off. No push delivery anywhere |
| 4. Transactional outbox | `completeTurn` writes `turn.completed` + `reply.enqueued*` in ONE transaction; `dispatchOutboxOnce` claims attempts by epoch and records `reply.delivered` (transport message id) / `reply.failed(retryable\|permanent)`; every attempt for a reply carries the same nonce `out-<reply_id>` (V1 Discord 40062-as-success pattern made a contract) |
| 5. Timer-free stall detection | `openTurns` / `openTurnCount` — "stuck" is the query *open turns (optionally older than T)*; no elapsed-time timer is ever the truth |

## Event vocabulary (EventLogCore/v1, additive-within-version)

`message.received` → `turn.claimed` → `turn.claim_released`? →
`turn.presented` → `turn.completed{outcome: replied|no_reply|skipped|failed}`
→ `reply.enqueued` → `reply.delivery_claimed` → `reply.delivered` |
`reply.failed{kind: retryable|permanent}`, plus `conversation.linked`.

Every event carries `conversation_id`, `causation_id` (parent event),
`correlation_id`, and seat identity (`seat_id` + `seat_instance_id`) —
field-compatible with SuiteEvent/v1 (iyasaka-arc D2-2).

## Recovery model (no timers)

Restart is the evidence. A starting seat instance calls `recoverSeatClaims`,
which releases claims held by *its own seat's dead predecessor instances*
(never another live seat's). Fencing: a released or superseded claim cannot
complete its turn (`StaleClaimError`; `uq_el_turn_completed` is the
mechanical backstop). The outbox dispatcher mirrors this with
`recoverDispatcherClaims`.

Ordering: within a `conversation_id`, only the earliest open turn is
claimable (strict per-conversation serialization). Turns without a
conversation are independent work orders claimable by seat pools.

## "It works" evidence (all green, `bun test tests/eventlog/`)

| SPEC-AUN-002 criterion | Fixture |
|---|---|
| Fleet-kill → restart → full rebuild, zero lost work | `eventlog-fleet-kill.test.ts` — real subprocess workers SIGKILLed mid-work twice, restarted, drained; every turn completed exactly once, replay into a virgin DB reproduces identical views |
| p95 within budget, fail-closed | `eventlog-p95.test.ts` — enqueue p95 < 10ms, claim p95 < 50ms, queue_view < 250ms budgets as hard assertions (observed baseline ~0.1–0.4ms) |
| Zero double-processing / zero double-send | `eventlog-turns.test.ts`, `eventlog-outbox.test.ts` — negative fixtures incl. ambiguous-send crash window + nonce-dedup retry, concurrent dispatchers, forged completion |
| Thread traceable from the log | `eventlog-thread.test.ts` — causation-chain tree, Discord-agnostic |
| One real end-to-end on live infra | **PENDING — belongs to the dual-run/cutover step (owner GO), see below** |

## Reuse and deliberate non-reuse

Reused: the `DbAdapter` (SQLite/PG interface), V1's atomic-claim discipline
and nonce-idempotency contract, migration idempotency conventions, bun test
patterns. Not dragged in: `message_queue`/`outbound_queue` status columns,
claim-TTL timers, push delivery — V1's mutable-status model stays out of the
new core by construction (branch adds files only; no existing file modified).

## Cutover plan (strangler, per Option B M1–M6 — each step behind owner GO)

1. **M1 dual-write**: V1 writers also append EventLogCore events in the same
   transaction (`ensureEventLogSchema` is idempotent and additive).
2. **M2 verify**: projections compared against live V1 tables (drift check).
3. **M3 pull-claim**: consumers switch to `claimNextTurn` over projections.
4. **M4 doctor**: chase timers replaced by `openTurns` queries.
5. **M5 outbox**: sends go through `dispatchOutboxOnce` with the Discord
   adapter implementing `OutboxTransport` (nonce-idempotent); legacy send
   path retired.
6. **M6**: status columns demoted to projection-only; V1 kept as fallback.

## Open items (documented, not hidden)

- PostgreSQL DDL for the append-only triggers (SQLite DDL is production
  today; the store/views/turns/outbox code is adapter-neutral).
- Discord `OutboxTransport` adapter (thin wrapper over the existing
  outbound send + enforced nonce) — cutover-step work.
- Live end-to-end evidence — requires touching live infra: gated on owner GO.
