#!/usr/bin/env bun
/**
 * Tests for active_thread send redirect (PR#60)
 *
 * Verifies:
 * 1. Send tool redirects channel → thread when active_thread is set
 * 2. Thread/agent/DM destinations are not redirected
 * 3. Audit log records send_redirect events
 *
 * Usage: bun test tests/active-thread-redirect.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

describe('active_thread send redirect — Source Structure', () => {
  test('send handler checks active_thread before resolveDestination', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    expect(sendIdx).toBeGreaterThan(-1)
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 2000)

    // getActiveThread must appear before resolveDestination
    const activeThreadIdx = sendBody.indexOf('getActiveThread(agentId)')
    const resolveIdx = sendBody.indexOf('resolveDestination(to, agentId)')
    expect(activeThreadIdx).toBeGreaterThan(-1)
    expect(resolveIdx).toBeGreaterThan(-1)
    expect(activeThreadIdx).toBeLessThan(resolveIdx)
  })

  test('redirects channel: destinations to thread: when active_thread set', () => {
    expect(SERVER_SOURCE).toContain("to?.startsWith('channel:')")
    expect(SERVER_SOURCE).toContain('to = `thread:${senderActiveThread}`')
  })

  test('does not redirect thread: destinations', () => {
    // The condition only matches channel: prefix
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 1500)
    const redirectBlock = sendBody.slice(
      sendBody.indexOf('senderActiveThread && to?.startsWith'),
      sendBody.indexOf('active_thread_override') + 30
    )
    // Should only match channel:, not thread: or agent:
    expect(redirectBlock).toContain("to?.startsWith('channel:')")
    expect(redirectBlock).not.toContain("to?.startsWith('thread:')")
    expect(redirectBlock).not.toContain("to?.startsWith('agent:')")
  })

  test('logs redirect to stderr', () => {
    expect(SERVER_SOURCE).toContain('agent-comms: send redirect')
    expect(SERVER_SOURCE).toContain('active_thread=')
  })

  test('writes audit_log with send_redirect event', () => {
    expect(SERVER_SOURCE).toContain("writeAuditLog('send_redirect'")
    expect(SERVER_SOURCE).toContain("reason: 'active_thread_override'")
    expect(SERVER_SOURCE).toContain('original_to: originalTo')
  })

  test('uses let for to variable (mutable for redirect)', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 200)
    expect(sendBody).toContain('let { to,')
  })

  test('active_thread=NULL does not redirect (no getActiveThread guard needed)', () => {
    // When getActiveThread returns null, senderActiveThread is falsy → no redirect
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 1500)
    expect(sendBody).toContain('if (senderActiveThread && to')
  })
})
