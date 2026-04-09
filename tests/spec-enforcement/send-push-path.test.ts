#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #123:
 * send tool path must call pushToChannelServer + SSE fallback.
 *
 * Background:
 *   The Discord inbound path (server.ts L~3004) calls pushToChannelServer after
 *   routing so bot-to-bot messages are delivered directly to the recipient's
 *   Claude Code session. The send tool path previously only called
 *   sendInboxSignal (file-based), which wakes the polling loop but does NOT
 *   deliver push notifications — so bot-to-bot messages via `send` were never
 *   pushed to the recipient.
 *
 *   Impact: governance chain bot-to-bot communication (dev→lead, lead→auditor,
 *   auditor→lead, lead→CTO, etc.) relied on send tool and was silently undelivered.
 *
 * Fix (Issue #123):
 *   After sendInboxSignal, also call pushToChannelServer(recipient, content, meta).
 *   If pushToChannelServer fails, fall back to SSE notification via botContexts.
 *
 * These are source-level regression guards. They read server.ts and assert the
 * required patterns are present, so a well-intentioned refactor that removes the
 * fix will break CI immediately.
 *
 * See:
 *   - server.ts pushTargets loop (~L2057)
 *   - server.ts Discord inbound path (~L3004) — reference implementation
 *   - github.com/watchout/agent-comms-mcp/issues/123
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SOURCE = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

// Extract the pushTargets loop body for targeted assertions.
// We look for the region between "for (const recipient of delivery.pushTargets)" and
// the next "// Forward to platform adapters" comment, which marks the end of the loop.
const PUSH_TARGETS_REGION = (() => {
  const start = SERVER_SOURCE.indexOf('for (const recipient of delivery.pushTargets)')
  const end = SERVER_SOURCE.indexOf('// Forward to platform adapters', start)
  if (start === -1 || end === -1) return ''
  return SERVER_SOURCE.slice(start, end)
})()

describe('Issue #123 — send tool pushTargets loop calls pushToChannelServer', () => {
  // REGRESSION CLASS: pushToChannelServer was absent from the send tool path.
  // All bot-to-bot governance chain messages (dev→lead, lead→auditor, etc.) were
  // silently undelivered via push — only file signals were written.
  test('pushTargets loop contains pushToChannelServer call', () => {
    expect(PUSH_TARGETS_REGION).toContain('pushToChannelServer')
  })

  test('pushToChannelServer is called with recipient as first argument', () => {
    expect(PUSH_TARGETS_REGION).toMatch(/pushToChannelServer\s*\(\s*recipient/)
  })

  test('pushToChannelServer is called with message content', () => {
    // partContent is the message body for this push
    expect(PUSH_TARGETS_REGION).toMatch(/pushToChannelServer\s*\(\s*recipient\s*,\s*partContent/)
  })
})

describe('Issue #123 — send tool pushTargets loop has SSE fallback', () => {
  // REGRESSION CLASS: if the recipient's channel-server is unreachable (e.g. bot
  // restarting), the SSE fallback must kick in to notify via the active MCP transport.
  test('SSE fallback checks botContexts when push fails', () => {
    expect(PUSH_TARGETS_REGION).toContain('botContexts.get(recipient)')
  })

  test('SSE fallback sends notifications/claude/channel notification', () => {
    expect(PUSH_TARGETS_REGION).toContain('notifications/claude/channel')
  })

  test('SSE fallback is guarded by transport check', () => {
    expect(PUSH_TARGETS_REGION).toMatch(/recipCtx\?\.transport/)
  })
})

describe('Issue #123 — symmetry with Discord inbound path', () => {
  // REGRESSION CLASS: the Discord inbound path is the reference implementation.
  // Both paths must follow the same pushToChannelServer + SSE fallback pattern.
  test('Discord inbound path also calls pushToChannelServer (reference guard)', () => {
    // Verify the reference implementation is still there so we can compare
    expect(SERVER_SOURCE).toMatch(/pushToChannelServer\s*\(\s*botId/)
  })
})
