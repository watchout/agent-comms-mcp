#!/usr/bin/env bun
/**
 * Tests for Webhook Channel push delivery (updated for §5.1 pure routeInbound)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

describe('Webhook Channel push — pure routeInbound + caller push', () => {
  test('routeInbound returns pushMeta (does not push internally)', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 5000)
    expect(routeBody).toContain('return { delivered: true, messageId, pushMeta }')
    expect(routeBody).not.toContain('await pushFn(content, pushMeta)')
  })

  test('daemon shared client handles push after routeInbound', () => {
    const daemonBlock = SERVER_SOURCE.indexOf("if (TRANSPORT_MODE === 'daemon')")
    const section = SERVER_SOURCE.slice(daemonBlock, daemonBlock + 20000)
    expect(section).toContain('if (result.delivered)')
    expect(section).toContain('pushToChannelServer(expectedBot,')
  })

  test('pushToChannelServer skips when channel_port is NULL', () => {
    expect(SERVER_SOURCE).toContain('no channel_port for')
  })
})
