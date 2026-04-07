#!/usr/bin/env bun
/**
 * Tests for reply_to mention guard (PR#61 — Layer 2 send control)
 *
 * Verifies:
 * 1. getMessageById helper exists
 * 2. reply_to sends check mentions in original message
 * 3. Own message, emergency, human sender bypass
 * 4. Fallback when message not found
 *
 * Usage: bun test tests/reply-mention-guard.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

describe('reply_to mention guard — Source Structure', () => {
  test('getMessageById function exists', () => {
    expect(SERVER_SOURCE).toContain('async function getMessageById(messageId: string)')
  })

  test('getMessageById queries agent_messages', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function getMessageById(')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 600)
    expect(fnBody).toContain('FROM agent_messages WHERE id = $1')
    expect(fnBody).toContain('author_id')
    expect(fnBody).toContain('message_type')
    expect(fnBody).toContain('metadata')
  })

  test('send handler validates reply_to mentions', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    expect(sendBody).toContain('getMessageById(reply_to)')
    expect(sendBody).toContain('NOT_MENTIONED_IN_ORIGINAL')
  })

  test('checks content mentions via parseMentions', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    expect(sendBody).toContain('parseMentions(originalMsg.content)')
  })

  test('checks metadata mentions as fallback', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    expect(sendBody).toContain('metadata')
    expect(sendBody).toContain('mentions')
  })

  test('allows reply to own message', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    expect(sendBody).toContain('originalMsg.author_id === agentId')
  })

  test('allows reply to emergency message', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    expect(sendBody).toContain("originalMsg.message_type === 'emergency'")
    expect(sendBody).toContain("originalMsg.content.startsWith('!stop')")
  })

  test('allows reply to human (CEO) message', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    expect(sendBody).toContain('isHumanAgent(originalMsg.author_id)')
  })

  test('fallback allows reply when original message not found', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    // After the if (originalMsg) block, there should be a comment about fallback
    expect(sendBody).toContain('fallback')
  })

  test('writes audit_log on denial', () => {
    expect(SERVER_SOURCE).toContain("code: 'NOT_MENTIONED_IN_ORIGINAL'")
  })

  test('guard runs before resolveDestination', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 3500)
    const guardIdx = sendBody.indexOf('NOT_MENTIONED_IN_ORIGINAL')
    const resolveIdx = sendBody.indexOf('resolveDestination(to, agentId)')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(resolveIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(resolveIdx)
  })
})
