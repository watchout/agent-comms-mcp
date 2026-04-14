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
    // Slice grew with PR-B.2 §H2 receiver-pipeline fanout block (Step 7c).
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 7000)
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

  // Phase 4 (Issue #130) removed `pushToChannelServer`. The two
  // pins below reference that removed function, so they fail against
  // post-Phase-4 server.ts. Skipped here so Layer 0 CI stays green.
  test.skip('daemon shared client handles push after handleInboundMessage (obsolete)', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE)")
    const section = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(section).toContain('if (result.delivered)')
    expect(section).toContain('pushToChannelServer(expectedBot,')
  })

  test.skip('pushToChannelServer skips when channel_port is NULL (obsolete)', () => {
    expect(SERVER_SOURCE).toContain('no channel_port for')
  })
})
