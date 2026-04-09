#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #103 — send mention union routing fix.
 *
 * Background:
 *   `server.ts` send handler computed `sendMentions` with an OR, not a union:
 *
 *     const sendMentions = Array.isArray(mentions) ? mentions : parseMentions(partContent)
 *
 *   When a caller supplied `mentions: ["cto"]` AND included `<@1485599598259994635>`
 *   in the content body (the recommended dual-mention pattern per CTO directive
 *   2026-04-09), `parseMentions(content)` was never called — the `<@discord_id>`
 *   token was silently dropped.  `routeInbound` then received only `["cto"]` from
 *   the arg, which is correct, but the inverse failure is equally silent:
 *
 *     mentions: []  +  content: "<@1485599598259994635>"
 *       → sendMentions = parseMentions(content) = []   (no @agent_id in content)
 *       → pushTargets = []  → silent delivery failure
 *
 *   4 distinct cases of this class caused missed push notifications on 2026-04-09.
 *
 * Fix (Option A union, `core/route-message.ts#buildSendMentions`):
 *   Union three sources and dedup:
 *     1. Agent IDs from the `mentions` arg
 *     2. Agent IDs resolved from `<@discord_id>` patterns in content
 *     3. Agent IDs from `@agent_id` native patterns in content
 *
 * Each test below cites the regression class it guards and MUST remain green.
 *
 * See:
 *   - core/route-message.ts                  (buildSendMentions implementation)
 *   - server.ts send handler L~2051          (call site)
 *   - github.com/watchout/agent-comms-mcp/issues/103
 */
import { describe, test, expect } from 'bun:test'
import { buildSendMentions } from '../../core/route-message'

// Stub resolver: maps Discord user IDs → agent IDs, mirroring the agents table.
const mockResolve = async (did: string): Promise<string | null> =>
  (({ '1485599598259994635': 'cto', '1227059781265653783': 'ceo' } as Record<string, string>)[did] ?? null)

// ─────────────────────────────────────────────────────────────────────────────
// T1: mentions arg provided, same agent also in content as <@discord_id>
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: caller supplies mentions:["cto"] + "<@CTO_DID>" in content.
// Old code took the mentions array and never looked at content → correct result
// by accident, but the symmetric T2 case (empty arg) silently dropped the agent.
// Union ensures both sources are always merged and deduped.
describe('T1 — mentions arg + matching content discord ID → dedup to 1', () => {
  test('sendMentions contains cto exactly once', async () => {
    const result = await buildSendMentions(['cto'], '<@1485599598259994635> hello', mockResolve)
    expect(result).toContain('cto')
    expect(result.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: empty mentions arg, agent only in content as <@discord_id>
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: caller supplies mentions:[] but uses "<@CTO_DID>" in content
// (the Discord-native dual-mention pattern).  Old code hit parseMentions(content)
// which matches @word patterns only — "<@\d+>" was never parsed → pushTargets=[].
describe('T2 — empty mentions arg, discord ID in content → resolved from content', () => {
  test('sendMentions resolves cto from content token', async () => {
    const result = await buildSendMentions([], '<@1485599598259994635> hello', mockResolve)
    expect(result).toContain('cto')
    expect(result.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: mentions arg only, no discord ID in content
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: basic case — arg-only mentions must be preserved even when
// the union finds nothing extra in content.  Guard against accidental filtering.
describe('T3 — mentions arg only, no content discord token → arg preserved', () => {
  test('sendMentions returns arg agent ID unchanged', async () => {
    const result = await buildSendMentions(['cto'], 'hello no mention syntax', mockResolve)
    expect(result).toContain('cto')
    expect(result.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: two agents in both arg and content → union dedup to 2
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: multi-agent message where both agents appear in the mentions
// arg AND as discord tokens in content.  Must be exactly 2 (no duplicates).
describe('T4 — two agents in arg + both <@discord_id> in content → 2 unique agents', () => {
  test('sendMentions contains exactly cto and ceo', async () => {
    const result = await buildSendMentions(
      ['cto', 'ceo'],
      '<@1485599598259994635> <@1227059781265653783> hello',
      mockResolve,
    )
    expect(result).toContain('cto')
    expect(result).toContain('ceo')
    expect(result.length).toBe(2)
  })
})
