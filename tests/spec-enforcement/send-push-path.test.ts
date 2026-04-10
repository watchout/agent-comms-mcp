#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #127 — send tool push path completeness.
 *
 * Background:
 *   `server.ts` send handler iterated over `delivery.pushTargets` and only
 *   wrote inbox signal files via `sendInboxSignal()`. Recipients connected
 *   to the agent-comms-channel server (Webhook Channel method) or attached
 *   over SSE never received the push, so bot→bot messages sent via the MCP
 *   `send` tool sat in the queue until the recipient polled.
 *
 *   The Discord inbound path (`server.ts` ~L3002-3010) already had the
 *   correct two-tier push: `pushToChannelServer()` first, then in-process
 *   SSE `notifications/claude/channel` fallback. The send path was missing
 *   this entirely — Issue #127 P0.
 *
 * Fix (server.ts pushTargets loop):
 *   For each recipient in `delivery.pushTargets`:
 *     1. `sendInboxSignal()` — file-based signal (existing)
 *     2. `pushToChannelServer()` — HTTP push to bot's channel-server
 *     3. SSE fallback via `botContexts.get(recipient).server.notification`
 *        when (2) returns false
 *
 * These tests are source-level: we read server.ts and assert that the
 * pushTargets loop body references `pushToChannelServer` and the SSE
 * fallback shape. A regression that drops either branch will fail loudly.
 *
 * See:
 *   - server.ts send handler pushTargets loop (~L2057)
 *   - server.ts Discord inbound onMessage handler (~L3002) — reference pattern
 *   - github.com/watchout/agent-comms-mcp/issues/127
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_SRC = readFileSync(
  join(import.meta.dir, '..', '..', 'server.ts'),
  'utf-8',
)

/**
 * Extract the body of the `for (const recipient of delivery.pushTargets)`
 * loop in the send handler. We anchor on the loop header and grab everything
 * up to the matching close brace at the same indent level.
 */
function extractSendPushLoopBody(): string {
  const header = 'for (const recipient of delivery.pushTargets) {'
  const start = SERVER_SRC.indexOf(header)
  if (start === -1) {
    throw new Error(
      'send-push-path test: pushTargets loop header not found in server.ts ' +
      '(refactor likely renamed it — update this test or restore the loop)',
    )
  }
  // Walk forward counting braces until we close the loop body.
  let depth = 0
  let i = start + header.length - 1 // points at the opening `{`
  for (; i < SERVER_SRC.length; i++) {
    const ch = SERVER_SRC[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return SERVER_SRC.slice(start, i + 1)
    }
  }
  throw new Error('send-push-path test: unterminated pushTargets loop body')
}

// ─────────────────────────────────────────────────────────────────────────────
// T1: pushTargets loop must call pushToChannelServer for each recipient
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: send tool used to call only sendInboxSignal() inside the
// pushTargets loop. Without pushToChannelServer(), recipients running with
// channel-server (Webhook Channel) never receive bot→bot messages until poll.
describe('T1 — send pushTargets loop invokes pushToChannelServer per recipient', () => {
  test('loop body contains pushToChannelServer call on the recipient', () => {
    const body = extractSendPushLoopBody()
    expect(body).toContain('pushToChannelServer(recipient,')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: SSE fallback fires when pushToChannelServer returns false
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: Discord inbound path uses a two-tier push — channel-server
// first, then in-process SSE notification via botContexts. The send path must
// mirror this so recipients attached over SSE (no channel-server) still
// receive the push synchronously.
describe('T2 — send pushTargets loop falls back to SSE notification on push failure', () => {
  test('loop body contains the !pushed → botContexts → server.notification fallback', () => {
    const body = extractSendPushLoopBody()
    // The fallback must (a) be gated on the pushed result being false,
    // (b) look up the recipient's BotContext, and (c) emit the
    // notifications/claude/channel notification on its server handle.
    expect(body).toContain('if (!pushed)')
    expect(body).toContain('botContexts.get(recipient)')
    expect(body).toContain("'notifications/claude/channel'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: pushMeta on the send path matches the inbound contract
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: lead-ama follow-up after PR#131 first cut. The send path
// originally built `{ from, channel_id, message_id, thread_id }` only, which
// diverged from the inbound contract (handleInboundMessage L~1363) and forced
// SSE consumers to special-case the source. The send pushMeta MUST now carry
// the same field names as inbound (`chat_id / message_id / user / user_id /
// ts / source`) so consumers can read both push sources uniformly. The legacy
// from / channel_id / thread_id fields are kept for backward compatibility
// during the cutover.
describe('T3 — send pushMeta matches the inbound pushMeta contract', () => {
  test('send-path pushMeta literal contains all inbound contract fields', () => {
    // sendPushMeta is hoisted just above the recipient loop so it can be reused
    // across the SSE fallback. Locate the literal by its variable declaration
    // and assert each contract field is present.
    const declMatch = SERVER_SRC.match(/const sendPushMeta\s*=\s*\{[\s\S]*?\n\s*\}/)
    expect(declMatch).not.toBeNull()
    const decl = declMatch![0]
    // Inbound contract fields
    expect(decl).toMatch(/chat_id:\s*dest\.channelId/)
    expect(decl).toMatch(/message_id:\s*id/)
    expect(decl).toMatch(/user:\s*agentId/)
    expect(decl).toMatch(/user_id:\s*agentId/)
    expect(decl).toMatch(/ts:\s*new Date\(\)\.toISOString\(\)/)
    // ARC codex audit (2026-04-10): the source MUST be 'agent-comms', not
    // 'discord' — these are internal MCP-originated pushes, not platform-relayed.
    expect(decl).toMatch(/source:\s*'agent-comms'/)
    expect(decl).not.toMatch(/source:\s*'discord'/)
    // Legacy fields preserved for backward compat during cutover
    expect(decl).toMatch(/from:\s*agentId/)
    expect(decl).toMatch(/channel_id:\s*dest\.channelId/)
    expect(decl).toMatch(/thread_id:\s*dest\.threadId/)
  })

  test('the recipient loop and SSE fallback both reference sendPushMeta', () => {
    const body = extractSendPushLoopBody()
    expect(body).toContain('pushToChannelServer(recipient, partContent, sendPushMeta)')
    expect(body).toContain('meta: sendPushMeta')
  })
})
