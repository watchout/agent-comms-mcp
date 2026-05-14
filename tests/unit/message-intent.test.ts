import { describe, expect, test } from 'bun:test'
import {
  hasExplicitMessageDisposition,
  normalizeMessageDisposition,
  readMessageQueueDisposition,
} from '../../core/message-intent'

describe('normalizeMessageDisposition', () => {
  test('defaults delivered messages to request + expect_response=true', () => {
    expect(normalizeMessageDisposition({})).toEqual({
      intent: 'request',
      expectResponse: true,
      context: {},
    })
  })

  test('treats inform as no-response by default without hard-coding a domain task kind', () => {
    expect(normalizeMessageDisposition({ intent: 'inform' })).toEqual({
      intent: 'inform',
      expectResponse: false,
      context: {},
    })
  })

  test('top-level fields override metadata hints and context stays opaque', () => {
    expect(normalizeMessageDisposition({
      intent: 'request',
      expect_response: true,
      context: { repo: 'watchout/agent-comms-mcp', pr: 370 },
      metadata: {
        intent: 'inform',
        expect_response: false,
        context: { ignored: true },
      },
    })).toEqual({
      intent: 'request',
      expectResponse: true,
      context: { repo: 'watchout/agent-comms-mcp', pr: 370 },
    })
  })

  test('metadata can carry disposition for older callers that only pass metadata', () => {
    expect(normalizeMessageDisposition({
      metadata: {
        intent: 'ack',
        expect_response: false,
        context: { ticket: 'abc' },
      },
    })).toEqual({
      intent: 'ack',
      expectResponse: false,
      context: { ticket: 'abc' },
    })
  })

  test('explicit detection allows default callers to keep using old queue schemas', () => {
    expect(hasExplicitMessageDisposition({})).toBe(false)
    expect(hasExplicitMessageDisposition({ intent: 'inform' })).toBe(true)
    expect(hasExplicitMessageDisposition({ metadata: { context: { pr: 371 } } })).toBe(true)
  })

  test('readMessageQueueDisposition falls back to defaults when old DBs lack columns', async () => {
    const db = {
      async query() {
        throw new Error('no such column: intent')
      },
    }
    expect(await readMessageQueueDisposition(db, 1)).toEqual({
      intent: 'request',
      expectResponse: true,
      context: {},
    })
  })
})
