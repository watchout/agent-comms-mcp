#!/usr/bin/env bun
/**
 * Unit test for `core/send-fanout.ts` — per-recipient message_queue INSERT.
 *
 * The integration behaviour against SQLite is covered by
 * `tests/cli-sqlite-backend.test.ts` describe F3b. This file pins the helper
 * itself using mocks so failure modes (recipient throws, partial success)
 * are exercised deterministically.
 *
 * ADR-050 (2026-05-05): UnixSignalBus removed — wake-daemon
 * (bin/wake-daemon.ts) is the de jure primary delivery mechanism. Fanout
 * no longer signals recipients.
 */
import { describe, test, expect } from 'bun:test'
import { fanoutToRecipients, type FanoutDb } from '../core/send-fanout'

function makeDb(behavior: (sql: string, params: any[]) => Promise<{ rows: any[] }>): FanoutDb {
  return {
    query: async <T = any>(sql: string, params: any[] = []) => behavior(sql, params) as Promise<{ rows: T[] }>,
  }
}

describe('fanoutToRecipients — happy path', () => {
  test('INSERTs one row per recipient', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = makeDb(async (sql, params) => {
      calls.push({ sql, params })
      // Simulate RETURNING id — first insert returns row, repeat returns empty
      return { rows: [{ id: calls.length }] }
    })
    const res = await fanoutToRecipients(db, {
      messageId: 'msg-1',
      channelId: 'ch-1',
      threadId: null,
      authorId: 'probe-sender',
      content: 'hello',
      recipients: ['probe-a', 'probe-b', 'probe-c'],
    })
    expect(res.inserted).toEqual(['probe-a', 'probe-b', 'probe-c'])
    expect(res.deduped).toEqual([])
    expect(res.failed).toEqual([])
    expect(calls.length).toBe(3)
    // Payload shape sanity
    const payload = JSON.parse(calls[0].params[2])
    expect(payload.channel_id).toBe('ch-1')
    expect(payload.author_id).toBe('probe-sender')
    expect(payload.message_id).toBe('msg-1')
    expect(payload.content).toBe('hello')
    expect(payload.message_type).toBe('chat')
  })

  test('respects custom messageType + source + threadId + authorName', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = makeDb(async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [{ id: 1 }] }
    })
    await fanoutToRecipients(db, {
      messageId: 'msg-2',
      channelId: 'ch-2',
      threadId: 'thr-1',
      authorId: 'cto',
      authorName: 'CTO',
      content: 'custom',
      recipients: ['probe-a'],
      messageType: 'approval',
      source: 'cli-notify',
    })
    const payload = JSON.parse(calls[0].params[2])
    expect(payload.thread_id).toBe('thr-1')
    expect(payload.author_name).toBe('CTO')
    expect(payload.message_type).toBe('approval')
    expect(payload.source).toBe('cli-notify')
  })

  test('auto-skips terminal no-op continuation instead of enqueuing actionable work', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = makeDb(async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [{ id: 1 }] }
    })
    const content = [
      'Processed queue 86535.',
      '',
      'Acknowledged: the implementation re-audit PASS residual note is covered. No further audit or implementation action is required for this continuation.',
      '',
      'Residual gates remain unchanged: intentional stage/commit before merge preparation and separate POST_MERGE evidence after merge.',
    ].join('\n')
    const res = await fanoutToRecipients(db, {
      messageId: 'msg-terminal-noop',
      channelId: 'ch-1',
      authorId: 'review-bot',
      content,
      recipients: ['implementation-bot'],
      messageType: 'report',
    })
    expect(res.inserted).toEqual(['implementation-bot'])
    expect(calls[0].sql).toContain('status, failed_reason, done_at')
    expect(calls[0].sql).toContain("'skipped'")
    expect(calls[0].params[3]).toBe('AUTO_SKIP_PATTERN:terminal_noop_continuation')
  })
})

describe('fanoutToRecipients — dedup via RETURNING empty', () => {
  test('recipients whose RETURNING is [] count as deduped', async () => {
    const db = makeDb(async (_sql, params) => {
      // probe-dup returns [] (conflict); probe-new returns {id:1}
      if (params[0] === 'probe-dup') return { rows: [] }
      return { rows: [{ id: 1 }] }
    })
    const res = await fanoutToRecipients(db, {
      messageId: 'msg-3',
      channelId: 'ch-3',
      authorId: 'probe-sender',
      content: 'x',
      recipients: ['probe-dup', 'probe-new'],
    })
    expect(res.inserted).toEqual(['probe-new'])
    expect(res.deduped).toEqual(['probe-dup'])
    expect(res.failed).toEqual([])
  })
})

describe('fanoutToRecipients — partial failure', () => {
  test('per-recipient INSERT throw is logged and recorded in `failed`, others proceed', async () => {
    const db = makeDb(async (_sql, params) => {
      if (params[0] === 'probe-broken') throw new Error('db down for this one')
      return { rows: [{ id: 1 }] }
    })
    const res = await fanoutToRecipients(db, {
      messageId: 'msg-4',
      channelId: 'ch-4',
      authorId: 'probe-sender',
      content: 'y',
      recipients: ['probe-ok-1', 'probe-broken', 'probe-ok-2'],
    })
    expect(res.inserted).toEqual(['probe-ok-1', 'probe-ok-2'])
    expect(res.failed).toEqual(['probe-broken'])
  })
})
