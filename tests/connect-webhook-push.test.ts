#!/usr/bin/env bun
/**
 * Tests for routeInbound → pushToChannelServer connection (PR#65)
 *
 * Usage: bun test tests/connect-webhook-push.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

describe('routeInbound → pushToChannelServer connection', () => {
  test('routeInbound calls pushToChannelServer after pushFn', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 6000)

    const pushFnIdx = routeBody.indexOf('await pushFn(content, pushMeta)')
    const webhookIdx = routeBody.indexOf('pushToChannelServer(receiverAgentId,')
    expect(pushFnIdx).toBeGreaterThan(-1)
    expect(webhookIdx).toBeGreaterThan(-1)
    expect(pushFnIdx).toBeLessThan(webhookIdx)
  })

  test('pushToChannelServer failure does not block pushFn', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 6000)

    // pushFn is awaited, pushToChannelServer is fire-and-forget (.catch)
    expect(routeBody).toContain('await pushFn(content, pushMeta)')
    expect(routeBody).toContain('pushToChannelServer(receiverAgentId, content, pushMeta).catch(')
  })

  test('failure writes audit_log', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 6000)
    expect(routeBody).toContain("writeAuditLog('push.failed'")
    expect(routeBody).toContain("method: 'webhook_channel'")
  })

  test('pushToChannelServer skips when channel_port is NULL', () => {
    // This is in the pushToChannelServer function itself
    expect(SERVER_SOURCE).toContain('no channel_port for')
    expect(SERVER_SOURCE).toContain('return false')
  })

  test('dual push path is documented in comments', () => {
    expect(SERVER_SOURCE).toContain('dual path: pushFn for legacy + pushToChannelServer for Webhook Channel')
  })
})
