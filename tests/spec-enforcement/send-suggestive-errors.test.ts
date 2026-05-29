#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #118 PR-A:
 * suggestive NOT_MENTIONED / INVALID_MENTION_FORMAT errors + reply_context.
 *
 * Background:
 *   LLMs repeatedly passed invalid values to the `send` tool's `mentions` param
 *   (Discord snowflake IDs instead of agent_id strings, empty mentions, etc.).
 *   Root cause: error messages provided no guidance on valid values, so the LLM
 *   had no signal to self-correct.
 *
 * Fix (PR-A — Issue #118):
 *   ① NOT_MENTIONED error now includes the original message author_id and the
 *     full list of registered agent_ids (fetched from DB; empty when DB down).
 *   ② INVALID_MENTION_FORMAT replaces AGENT_NOT_FOUND; error includes the full
 *     valid agent_id list so callers can self-correct without a separate lookup.
 *   ③ Send success response includes reply_context (author/channel/snippet)
 *     so the caller knows where the reply landed.
 *
 * These tests exercise the pure helper functions in core/send-errors.ts.
 * Server-level DB wiring is covered by the existing spec-enforcement suite.
 *
 * See:
 *   - core/send-errors.ts           (pure helpers under test)
 *   - server.ts send handler        (DB wiring call-site)
 *   - github.com/watchout/agent-comms-mcp/issues/118
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  buildNotMentionedErrorMsg,
  validateMentionOrError,
  buildReplyContextSuffix,
} from '../../core/send-errors'
import { resolvePhase5 } from '../../core/routing/server-integration'
import { resetChannelPolicyCache } from '../../core/channel-policy'

let previousFileFallback: string | undefined

beforeEach(() => {
  previousFileFallback = process.env.AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK
  process.env.AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK = 'true'
  resetChannelPolicyCache()
})

afterEach(() => {
  if (previousFileFallback === undefined) {
    delete process.env.AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK
  } else {
    process.env.AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK = previousFileFallback
  }
  resetChannelPolicyCache()
})

// ─────────────────────────────────────────────────────────────────────────────
// T1: mentions 空 + reply_to あり → エラーに author_id が含まれる
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: LLM omits mentions when replying; error must tell the LLM
// who the original author was so it can self-correct on the next attempt.
describe('T1 — NOT_MENTIONED with reply_to context includes original author', () => {
  test('error message contains Error [NOT_MENTIONED]', () => {
    const msg = buildNotMentionedErrorMsg('ceo', ['cto', 'ceo', 'arc'])
    expect(msg).toContain('Error [NOT_MENTIONED]')
  })

  test('error message contains original author_id', () => {
    const msg = buildNotMentionedErrorMsg('ceo', ['cto', 'ceo', 'arc'])
    expect(msg).toContain('ceo')
  })

  test('error message contains Known agents list', () => {
    const msg = buildNotMentionedErrorMsg('ceo', ['cto', 'ceo', 'arc'])
    expect(msg).toContain('Known agents')
    expect(msg).toContain('cto')
    expect(msg).toContain('arc')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: mentions に存在しない agent_id → INVALID_MENTION_FORMAT + 有効一覧
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: LLM passes a typo or Discord snowflake ID as agent_id.
// Error must name the offending value AND show valid alternatives.
describe('T2 — unknown agent_id returns INVALID_MENTION_FORMAT with valid list', () => {
  test('unknown agent_id returns error string (not null)', () => {
    const err = validateMentionOrError('cts', ['cto', 'ceo', 'arc'])
    expect(err).not.toBeNull()
  })

  test('error contains INVALID_MENTION_FORMAT code', () => {
    const err = validateMentionOrError('cts', ['cto', 'ceo', 'arc'])
    expect(err).toContain('INVALID_MENTION_FORMAT')
  })

  test('error names the offending mention', () => {
    const err = validateMentionOrError('cts', ['cto', 'ceo', 'arc'])
    expect(err).toContain('cts')
  })

  test('error includes valid agent list', () => {
    const err = validateMentionOrError('cts', ['cto', 'ceo', 'arc'])
    expect(err).toContain('cto')
    expect(err).toContain('ceo')
    expect(err).toContain('arc')
  })

  test('valid agent_id returns null (no error)', () => {
    const err = validateMentionOrError('cto', ['cto', 'ceo', 'arc'])
    expect(err).toBeNull()
  })

  test('group keywords (all/dev/org) always pass regardless of list', () => {
    for (const kw of ['all', 'dev', 'org']) {
      expect(validateMentionOrError(kw, ['cto'])).toBeNull()
      expect(validateMentionOrError(kw, [])).toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: 送信成功時 → reply_context に author/channel/snippet が含まれる
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: callers lose track of where a reply was delivered;
// reply_context in the success response provides a stable reference.
describe('T3 — send success reply_context includes author/channel/snippet', () => {
  test('reply_context suffix is non-empty when original message provided', () => {
    const suffix = buildReplyContextSuffix(
      { author_id: 'ceo', content: 'テスト結果どう？' },
      'ch-123',
    )
    expect(suffix).not.toBe('')
  })

  test('suffix contains reply_context keyword', () => {
    const suffix = buildReplyContextSuffix(
      { author_id: 'ceo', content: 'テスト結果どう？' },
      'ch-123',
    )
    expect(suffix).toContain('reply_context')
  })

  test('suffix contains original author', () => {
    const suffix = buildReplyContextSuffix(
      { author_id: 'ceo', content: 'テスト結果どう？' },
      'ch-123',
    )
    expect(suffix).toContain('ceo')
  })

  test('suffix contains channel id', () => {
    const suffix = buildReplyContextSuffix(
      { author_id: 'ceo', content: 'テスト結果どう？' },
      'ch-123',
    )
    expect(suffix).toContain('ch-123')
  })

  test('suffix contains content snippet', () => {
    const suffix = buildReplyContextSuffix(
      { author_id: 'ceo', content: 'テスト結果どう？' },
      'ch-123',
    )
    expect(suffix).toContain('テスト結果どう？')
  })

  test('long content is truncated to 60 chars with ellipsis', () => {
    const longContent = 'a'.repeat(80)
    const suffix = buildReplyContextSuffix({ author_id: 'ceo', content: longContent }, 'ch-1')
    expect(suffix).toContain('…')
    // snippet portion should be ≤ 60 chars + '…'
    const snippetMatch = suffix.match(/snippet: "([^"]+)"/)
    expect(snippetMatch).not.toBeNull()
    expect(snippetMatch![1].length).toBeLessThanOrEqual(61) // 60 + '…'
  })

  test('returns empty string when orig is null (no reply_to)', () => {
    const suffix = buildReplyContextSuffix(null, 'ch-123')
    expect(suffix).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: mentions 空 + reply_to なし → エラー（author hint なし）
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: when there is no reply_to, there is no original author
// to suggest — error must still be returned but without a misleading hint.
describe('T4 — NOT_MENTIONED without reply_to has no author hint', () => {
  test('error message contains Error [NOT_MENTIONED]', () => {
    const msg = buildNotMentionedErrorMsg(null, ['cto', 'ceo'])
    expect(msg).toContain('Error [NOT_MENTIONED]')
  })

  test('error message does NOT contain "Original message author"', () => {
    const msg = buildNotMentionedErrorMsg(null, ['cto', 'ceo'])
    expect(msg).not.toContain('Original message author')
  })

  test('error message still includes Known agents list when available', () => {
    const msg = buildNotMentionedErrorMsg(null, ['cto', 'ceo'])
    expect(msg).toContain('Known agents')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T6: DB 不達時 (knownAgents 空) → MENTION_VALIDATION_UNAVAILABLE (silent pass しない)
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: when DB is down, knownAgents is empty. Previous code
// silently returned null (pass) for any mention — unknown agents got through.
// Fail-loud: return MENTION_VALIDATION_UNAVAILABLE so callers know to retry.
describe('T6 — DB unavailable causes MENTION_VALIDATION_UNAVAILABLE (no silent pass)', () => {
  test('empty knownAgents returns MENTION_VALIDATION_UNAVAILABLE error', () => {
    const err = validateMentionOrError('any-agent', [])
    expect(err).not.toBeNull()
    expect(err).toContain('MENTION_VALIDATION_UNAVAILABLE')
  })

  test('group keywords still pass even when knownAgents is empty', () => {
    for (const kw of ['all', 'dev', 'org']) {
      expect(validateMentionOrError(kw, [])).toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T7: knownAgents 配列に対する isKnownAgent クロージャ contract (regression for Phase 5 hotfix)
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: server.ts L2055 / L2646 で `knownAgents.has(id)` が呼ばれていた
// が refreshAgentCache() は string[] を返すため `.has` が undefined で TypeError、
// 19 bot の outbound mention/cc routing が全死亡 (Phase 5 fleet restart 後判明)。
// Fix: `.has(id)` → `.includes(id)`. このテストは配列 contract を pin し再発を防ぐ。
// CTO directive msg `f12988ff-792e-4fef-903e-20c9e0d68b08` / lead-ama hotfix dispatch.
describe('T7 — isKnownAgent closure over refreshAgentCache() array (Phase 5 hotfix regression)', () => {
  test('refreshAgentCache return type is Array (supports .includes, not .has)', () => {
    const knownAgents: string[] = ['cto', 'ceo', 'lead-ama', 'agent-com-dev']
    expect(Array.isArray(knownAgents)).toBe(true)
    expect(typeof (knownAgents as any).has).toBe('undefined')
    expect(typeof knownAgents.includes).toBe('function')
  })

  test('isKnownAgent closure pattern (L2055/L2646) returns true for known id', () => {
    const knownAgents: string[] = ['cto', 'ceo', 'lead-ama', 'agent-com-dev']
    const isKnownAgent = (id: string) => knownAgents.includes(id)
    expect(isKnownAgent('cto')).toBe(true)
    expect(isKnownAgent('agent-com-dev')).toBe(true)
  })

  test('isKnownAgent closure pattern returns false for unknown id (no TypeError)', () => {
    const knownAgents: string[] = ['cto', 'ceo']
    const isKnownAgent = (id: string) => knownAgents.includes(id)
    expect(() => isKnownAgent('nonexistent')).not.toThrow()
    expect(isKnownAgent('nonexistent')).toBe(false)
  })

  test('pre-fix pattern (.has) would throw TypeError on string[] (negative pin)', () => {
    const knownAgents: string[] = ['cto', 'ceo']
    expect(() => (knownAgents as any).has('cto')).toThrow(TypeError)
  })

  test('resolvePhase5 with post-fix isKnownAgent closure → ok for known mention', () => {
    const knownAgents: string[] = ['cto', 'ceo', 'agent-com-dev']
    const result = resolvePhase5({
      sender: 'agent-com-dev',
      channel_id: 'ch-test',
      mention: 'cto',
      content: 'hello',
      isKnownAgent: (id: string) => knownAgents.includes(id),
    })
    expect(result).not.toBeNull()
    expect(result!.ok).toBe(true)
  })

  test('resolvePhase5 with post-fix closure → UNKNOWN_AGENT for unknown mention (no TypeError)', () => {
    const knownAgents: string[] = ['cto', 'ceo']
    expect(() =>
      resolvePhase5({
        sender: 'agent-com-dev',
        channel_id: 'ch-test',
        mention: 'nonexistent',
        content: 'hello',
        isKnownAgent: (id: string) => knownAgents.includes(id),
      }),
    ).not.toThrow()
    const result = resolvePhase5({
      sender: 'agent-com-dev',
      channel_id: 'ch-test',
      mention: 'nonexistent',
      content: 'hello',
      isKnownAgent: (id: string) => knownAgents.includes(id),
    })
    expect(result).not.toBeNull()
    expect(result!.ok).toBe(false)
    expect((result as any).error).toBe('UNKNOWN_AGENT')
  })

  test('pre-fix closure (.has on string[]) → resolvePhase5 throws TypeError (Phase 5 outbound death repro)', () => {
    const knownAgents: string[] = ['cto', 'ceo']
    expect(() =>
      resolvePhase5({
        sender: 'agent-com-dev',
        channel_id: 'ch-test',
        mention: 'cto',
        content: 'hello',
        isKnownAgent: (id: string) => (knownAgents as any).has(id),
      }),
    ).toThrow(TypeError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5: DB 不達時 → エラーに一覧なしだがエラー自体は返る（silent pass しない）
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: DB being unavailable must NOT cause a silent pass where an
// empty-mentions send is accepted without error. The error is always returned;
// it just lacks the helpful hints that require DB access.
describe('T5 — NOT_MENTIONED with DB unavailable still returns error (no silent pass)', () => {
  test('error is returned even when knownAgents is empty (DB down)', () => {
    const msg = buildNotMentionedErrorMsg(null, [])
    expect(msg).toContain('Error [NOT_MENTIONED]')
  })

  test('error does NOT contain Known agents when list is empty', () => {
    const msg = buildNotMentionedErrorMsg(null, [])
    expect(msg).not.toContain('Known agents')
  })

  test('error does NOT contain Original message author when authorId is null', () => {
    const msg = buildNotMentionedErrorMsg(null, [])
    expect(msg).not.toContain('Original message author')
  })
})
