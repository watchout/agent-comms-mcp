#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #118 PR-B:
 * agent_id cache (TTL 60s) + mentions auto-fill.
 *
 * Background:
 *   PR-A introduced direct DB queries to fetch valid agent_ids on every send
 *   call. PR-B replaces those with a TTL-60s in-process cache so the DB is
 *   only hit when the cache is cold or stale (once per minute at most).
 *
 *   Additionally, PR-B adds a mentions auto-fill: if the LLM omits `mentions`
 *   but provides `reply_to`, the server automatically fills in the original
 *   message's author_id, avoiding a NOT_MENTIONED error for the common
 *   "reply to this message" use case.
 *
 * These tests exercise the pure helpers in core/agent-cache.ts.
 * Server-level wiring (module-level cache variable, DB adapter) is covered by
 * the existing spec-enforcement + integration suites.
 *
 * See:
 *   - core/agent-cache.ts            (pure helpers under test)
 *   - server.ts send handler         (DB wiring call-site)
 *   - github.com/watchout/agent-comms-mcp/issues/118
 */
import { describe, test, expect } from 'bun:test'
import { refreshAgentCacheWith, applyMentionsAutoFill } from '../../core/agent-cache'

// ─────────────────────────────────────────────────────────────────────────────
// T1: cache hit (TTL 内) → DB query なし
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: every send call was hitting the DB to validate agent_ids.
// With TTL cache, DB is queried at most once per minute.
describe('T1 — cache hit within TTL skips DB query', () => {
  test('returns cached ids without calling queryFn', async () => {
    let queryCalled = 0
    const freshCache = { ids: ['cto', 'ceo', 'arc'], ts: Date.now() }
    const queryFn = async () => { queryCalled++; return ['new-list'] }

    const { ids, updated } = await refreshAgentCacheWith(freshCache, 60_000, queryFn)

    expect(queryCalled).toBe(0)
    expect(ids).toEqual(['cto', 'ceo', 'arc'])
    expect(updated).toBeNull() // cache unchanged
  })

  test('returns same ids when TTL is nearly expired but not yet', async () => {
    const almostExpired = { ids: ['cto'], ts: Date.now() - 59_999 }
    const { ids } = await refreshAgentCacheWith(almostExpired, 60_000, async () => ['new'])
    expect(ids).toEqual(['cto'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: cache miss / expired → DB query で更新
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: after TTL expires, the cache must refresh from DB so
// newly registered agents are picked up within 60 seconds.
describe('T2 — cache miss or expired triggers DB query and updates cache', () => {
  test('null cache → queryFn called, cache updated', async () => {
    let queryCalled = 0
    const queryFn = async () => { queryCalled++; return ['cto', 'ceo'] }

    const { ids, updated } = await refreshAgentCacheWith(null, 60_000, queryFn)

    expect(queryCalled).toBe(1)
    expect(ids).toEqual(['cto', 'ceo'])
    expect(updated).not.toBeNull()
    expect(updated!.ids).toEqual(['cto', 'ceo'])
  })

  test('expired cache (ts in the past) → queryFn called', async () => {
    let queryCalled = 0
    const expired = { ids: ['old'], ts: Date.now() - 120_000 } // 2 minutes ago
    const queryFn = async () => { queryCalled++; return ['new'] }

    const { ids, updated } = await refreshAgentCacheWith(expired, 60_000, queryFn)

    expect(queryCalled).toBe(1)
    expect(ids).toEqual(['new'])
    expect(updated!.ids).toEqual(['new'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: DB 不達 + cache なし → fail-loud (empty ids)
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: when DB is unavailable and no cache exists, returning an
// empty list causes validateMentionOrError (PR-A T6) to return
// MENTION_VALIDATION_UNAVAILABLE — fail-loud rather than silently passing
// unknown agents.
describe('T3 — DB unavailable + no cache → returns empty list (fail-loud via validateMentionOrError)', () => {
  test('null cache + null queryFn → empty ids', async () => {
    const { ids, updated } = await refreshAgentCacheWith(null, 60_000, null)
    expect(ids).toEqual([])
    expect(updated).toBeNull()
  })

  test('expired cache + null queryFn → returns stale ids (not []) to avoid unnecessary disruption', async () => {
    const stale = { ids: ['cto', 'ceo'], ts: Date.now() - 120_000 }
    const { ids } = await refreshAgentCacheWith(stale, 60_000, null)
    expect(ids).toEqual(['cto', 'ceo']) // stale but better than nothing
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: mentions 空 + reply_to あり → auto-fill で author_id が mentions に入る
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: LLM frequently omits mentions when replying. Auto-fill
// from original message author avoids the NOT_MENTIONED error for the common
// "reply to this message" pattern.
describe('T4 — empty mentions + reply_to → auto-filled with original author', () => {
  test('empty mentions + reply_to + origAuthorId → returns [origAuthorId]', () => {
    const result = applyMentionsAutoFill([], 'msg-uuid-123', 'ceo')
    expect(result).toEqual(['ceo'])
  })

  test('null mentions + reply_to + origAuthorId → returns [origAuthorId]', () => {
    const result = applyMentionsAutoFill(null, 'msg-uuid-123', 'cto')
    expect(result).toEqual(['cto'])
  })

  test('undefined mentions + reply_to + origAuthorId → returns [origAuthorId]', () => {
    const result = applyMentionsAutoFill(undefined, 'msg-uuid-123', 'arc')
    expect(result).toEqual(['arc'])
  })

  test('empty mentions + reply_to + no author → returns null (cannot auto-fill)', () => {
    const result = applyMentionsAutoFill([], 'msg-uuid-123', null)
    expect(result).toBeNull()
  })

  test('empty mentions + no reply_to → returns null (cannot auto-fill)', () => {
    const result = applyMentionsAutoFill([], null, 'ceo')
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5: mentions 明示 + reply_to あり → 明示値を尊重
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: when the LLM provides explicit mentions, auto-fill must
// NOT override them even when reply_to context is present.
describe('T5 — explicit mentions are respected, not overridden by auto-fill', () => {
  test('non-empty mentions → returns null (no change needed)', () => {
    const result = applyMentionsAutoFill(['cto'], 'msg-uuid-123', 'ceo')
    expect(result).toBeNull()
  })

  test('multiple explicit mentions → returns null', () => {
    const result = applyMentionsAutoFill(['cto', 'ceo'], 'msg-uuid-123', 'arc')
    expect(result).toBeNull()
  })
})
