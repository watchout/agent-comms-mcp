#!/usr/bin/env bun
/**
 * Tests for Webhook Channel push delivery (updated for §5.1 pure routeInbound + handleInboundMessage)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
// FEAT-005 (adapter rewrite): handleInboundMessage lives in
// adapters/inbound-receiver.ts. Concat keeps pin semantics.
const SERVER_SOURCE =
  readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')
  + '\n'
  + readFileSync(join(PROJECT_ROOT, 'adapters/inbound-receiver.ts'), 'utf-8')

describe('Webhook Channel push — handleInboundMessage + caller push', () => {
  test('handleInboundMessage returns pushMeta when delivered', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function handleInboundMessage(')
    // Slice widened to cover spec §8.2 sender-feedback block (Behavioral FAIL
    // B5) that sits between persistInboundDelivery and Step 7c.
    // PR-β (Issue #230): window widened from 9000 to 12000 chars after the
    // reply_to UUID resolution + mentions auto-fill blocks were added at the
    // top of handleInboundMessage.
    // PR-β cycle 3 (Issue #230): bumped 12000 → 14000 to cover the new
    // early-capture + 2-step lookup commentary added at the top.
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 14000)
    expect(fnBody).toContain('delivered: true, messageId, pushMeta')
  })

  test('routeInbound is pure (no pushFn, no DB calls)', () => {
    const routeIdx = SERVER_SOURCE.indexOf('function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 2000)
    expect(routeBody).not.toContain('await ')
    expect(routeBody).not.toContain('pushFn')
    expect(routeBody).not.toContain('saveMessage')
    expect(routeBody).not.toContain('updateLastReceivedContext')
  })

  // Phase 4 (Issue #130) removed `pushToChannelServer`. Phase C I5 removed TRANSPORT_MODE.
  // These tests are obsolete — kept as skip for historical reference.
  test.skip('shared client handles push after handleInboundMessage (obsolete)', () => {
    const sharedStartup = SERVER_SOURCE.indexOf('// --- 2. Shared startup (unconditional) ---')
    const section = SERVER_SOURCE.slice(sharedStartup)
    expect(section).toContain('if (result.delivered)')
    expect(section).toContain('pushToChannelServer(expectedBot,')
  })

  test.skip('pushToChannelServer skips when channel_port is NULL (obsolete)', () => {
    expect(SERVER_SOURCE).toContain('no channel_port for')
  })
})
