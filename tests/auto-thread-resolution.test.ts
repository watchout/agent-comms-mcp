#!/usr/bin/env bun
/**
 * Tests for auto thread resolution (PR#63)
 *
 * Verifies:
 * 1. routeInbound auto-sets active_thread on thread message delivery
 * 2. reply_to thread_id auto-resolution in send handler
 * 3. getMessageById includes thread_id
 *
 * Usage: bun test tests/auto-thread-resolution.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const SERVER_SOURCE = readFileSync(join(PROJECT_ROOT, 'server.ts'), 'utf-8')

describe('Auto Thread Resolution — routeInbound active_thread auto-set', () => {
  test('routeInbound auto-sets active_thread on thread message', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 5000)
    expect(routeBody).toContain('updateActiveThread(receiverAgentId, messageThreadId)')
  })

  test('auto-focus only when threadId is present', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 5000)
    expect(routeBody).toContain('if (messageThreadId)')
  })

  test('auto-focus logs to stderr', () => {
    expect(SERVER_SOURCE).toContain('agent-comms: auto-focus')
  })

  test('auto-focus happens before push (step ordering)', () => {
    const routeIdx = SERVER_SOURCE.indexOf('async function routeInbound(')
    const routeBody = SERVER_SOURCE.slice(routeIdx, routeIdx + 5000)
    const autoFocusIdx = routeBody.indexOf('auto-focus')
    const pushIdx = routeBody.indexOf('Push to session')
    expect(autoFocusIdx).toBeGreaterThan(-1)
    expect(pushIdx).toBeGreaterThan(-1)
    expect(autoFocusIdx).toBeLessThan(pushIdx)
  })
})

describe('Auto Thread Resolution — reply_to thread_id forcing', () => {
  test('send handler resolves reply_to thread_id before active_thread redirect', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 4000)

    const replyThreadIdx = sendBody.indexOf('reply thread resolve')
    const activeThreadIdx = sendBody.indexOf('active_thread send redirect')
    expect(replyThreadIdx).toBeGreaterThan(-1)
    expect(activeThreadIdx).toBeGreaterThan(-1)
    expect(replyThreadIdx).toBeLessThan(activeThreadIdx)
  })

  test('reply_to thread_id overrides to destination', () => {
    const sendIdx = SERVER_SOURCE.indexOf("if (name === 'send')")
    const sendBody = SERVER_SOURCE.slice(sendIdx, sendIdx + 4000)
    expect(sendBody).toContain('originalMsg?.thread_id')
    expect(sendBody).toContain('to = `thread:${originalMsg.thread_id}`')
  })

  test('logs reply thread resolution', () => {
    expect(SERVER_SOURCE).toContain('reply thread resolve')
  })
})

describe('Auto Thread Resolution — getMessageById', () => {
  test('getMessageById returns thread_id', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function getMessageById(')
    const fnBody = SERVER_SOURCE.slice(fnIdx, fnIdx + 600)
    expect(fnBody).toContain('thread_id')
    expect(fnBody).toContain('SELECT author_id, content, message_type, metadata, thread_id')
  })

  test('getMessageById type includes thread_id', () => {
    const fnIdx = SERVER_SOURCE.indexOf('async function getMessageById(')
    const fnSig = SERVER_SOURCE.slice(fnIdx, fnIdx + 200)
    expect(fnSig).toContain('thread_id: string | null')
  })
})
