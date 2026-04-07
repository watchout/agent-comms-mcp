#!/usr/bin/env bun
/**
 * Tests for Webhook Channel architecture (channel-server.ts + pushToChannelServer)
 *
 * Usage: bun test tests/webhook-channel.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')
const CHANNEL_SERVER_PATH = join(PROJECT_ROOT, 'channel-server.ts')

describe('Webhook Channel — channel-server.ts', () => {
  test('channel-server.ts exists', () => {
    expect(existsSync(CHANNEL_SERVER_PATH)).toBe(true)
  })

  const CHANNEL_SOURCE = readFileSync(CHANNEL_SERVER_PATH, 'utf-8')

  test('declares claude/channel capability', () => {
    expect(CHANNEL_SOURCE).toContain("'claude/channel'")
  })

  test('listens on CHANNEL_PORT for POST /push', () => {
    expect(CHANNEL_SOURCE).toContain('CHANNEL_PORT')
    expect(CHANNEL_SOURCE).toContain('/push')
    expect(CHANNEL_SOURCE).toContain("hostname: '127.0.0.1'")
  })

  test('verifies HMAC-SHA256 signature', () => {
    expect(CHANNEL_SOURCE).toContain('verifyPayload')
    expect(CHANNEL_SOURCE).toContain('x-signature')
    expect(CHANNEL_SOURCE).toContain("from './shared/hmac'")
  })

  test('injects via notifications/claude/channel', () => {
    expect(CHANNEL_SOURCE).toContain("method: 'notifications/claude/channel'")
  })

  test('uses StdioServerTransport', () => {
    expect(CHANNEL_SOURCE).toContain('StdioServerTransport')
    expect(CHANNEL_SOURCE).toContain('mcp.connect(transport)')
  })

  test('has graceful shutdown', () => {
    expect(CHANNEL_SOURCE).toContain('SIGINT')
    expect(CHANNEL_SOURCE).toContain('SIGTERM')
    expect(CHANNEL_SOURCE).toContain('httpServer.stop()')
  })

  test('no Discord Client dependency', () => {
    expect(CHANNEL_SOURCE).not.toContain('discord.js')
    expect(CHANNEL_SOURCE).not.toContain('DiscordAdapter')
    expect(CHANNEL_SOURCE).not.toContain('GatewayIntentBits')
  })
})

describe('Webhook Channel — pushToChannelServer', () => {
  test('pushToChannelServer function exists in server.ts', () => {
    expect(SERVER_SOURCE).toContain('async function pushToChannelServer(')
  })

  test('queries channel_port from agents table', () => {
    expect(SERVER_SOURCE).toContain('SELECT channel_port FROM agents WHERE agent_id')
  })

  test('sends HTTP POST to localhost:{port}/push', () => {
    expect(SERVER_SOURCE).toContain('http://127.0.0.1:${port}/push')
  })

  test('includes HMAC signature header', () => {
    expect(SERVER_SOURCE).toContain('X-Signature')
    expect(SERVER_SOURCE).toContain('HMAC_SECRET')
  })

  test('handles missing channel_port gracefully', () => {
    expect(SERVER_SOURCE).toContain('no channel_port for')
  })
})

describe('Webhook Channel — DB migration', () => {
  const MIGRATE_SOURCE = readFileSync(join(PROJECT_ROOT, 'db', 'migrate.ts'), 'utf-8')

  test('agents table has channel_port column', () => {
    expect(MIGRATE_SOURCE).toContain('channel_port INTEGER')
  })
})

describe('Webhook Channel — SSOT', () => {
  const SSOT_SOURCE = readFileSync(join(PROJECT_ROOT, 'docs', 'SSOT.md'), 'utf-8')

  test('SSOT documents Webhook Channel architecture', () => {
    expect(SSOT_SOURCE).toContain('agent-comms-channel')
    expect(SSOT_SOURCE).toContain('channel-server.ts')
  })

  test('SSOT describes HMAC verification', () => {
    expect(SSOT_SOURCE).toContain('HMAC')
  })
})
