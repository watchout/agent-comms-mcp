#!/usr/bin/env bun
/**
 * Unit test for `core/send-fanout.ts` — per-recipient message_queue INSERT
 * + MessageBus signal (Phase 2 F cycle 2, CTO option (a)).
 *
 * The integration behaviour against SQLite is covered by
 * `tests/cli-sqlite-backend.test.ts` describe F3b. This file pins the helper
 * itself using mocks so failure modes (recipient throws, partial success)
 * are exercised deterministically.
 */
import { describe, test, expect } from 'bun:test'
import { fanoutToRecipients, type FanoutDb } from '../core/send-fanout'
import type { MessageBus } from '../core/message-bus'

function makeDb(behavior: (sql: string, params: any[]) => Promise<{ rows: any[] }>): FanoutDb {
  return {
    query: async <T = any>(sql: string, params: any[] = []) => behavior(sql, params) as Promise<{ rows: T[] }>,
  }
}

function makeBus(signalImpl?: (channel: string) => Promise<void>): { bus: MessageBus; signals: string[] } {
  const signals: string[] = []
  const bus: MessageBus = {
    async signal(channel: string) {
      signals.push(channel)
      if (signalImpl) await signalImpl(channel)
    },
    async waitForSignal() { return false },
    async close() {},
  }
  return { bus, signals }
}

describe('fanoutToRecipients — happy path', () => {
  test('INSERTs one row per recipient and signals each', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = makeDb(async (sql, params) => {
      calls.push({ sql, params })
      // Simulate RETURNING id — first insert returns row, repeat returns empty
      return { rows: [{ id: calls.length }] }
    })
    const { bus, signals } = makeBus()
    const res = await fanoutToRecipients(db, bus, {
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
    expect(signals).toEqual(['bot_probe-a', 'bot_probe-b', 'bot_probe-c'])
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
    await fanoutToRecipients(db, null, {
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
})

describe('fanoutToRecipients — dedup via RETURNING empty', () => {
  test('recipients whose RETURNING is [] count as deduped and are NOT signaled', async () => {
    const { bus, signals } = makeBus()
    const db = makeDb(async (_sql, params) => {
      // probe-dup returns [] (conflict); probe-new returns {id:1}
      if (params[0] === 'probe-dup') return { rows: [] }
      return { rows: [{ id: 1 }] }
    })
    const res = await fanoutToRecipients(db, bus, {
      messageId: 'msg-3',
      channelId: 'ch-3',
      authorId: 'probe-sender',
      content: 'x',
      recipients: ['probe-dup', 'probe-new'],
    })
    expect(res.inserted).toEqual(['probe-new'])
    expect(res.deduped).toEqual(['probe-dup'])
    expect(res.failed).toEqual([])
    // Only probe-new gets a signal — deduped recipient was already signaled
    // by the original sender.
    expect(signals).toEqual(['bot_probe-new'])
  })
})

describe('fanoutToRecipients — partial failure', () => {
  test('per-recipient INSERT throw is logged and recorded in `failed`, others proceed', async () => {
    const { bus, signals } = makeBus()
    const db = makeDb(async (_sql, params) => {
      if (params[0] === 'probe-broken') throw new Error('db down for this one')
      return { rows: [{ id: 1 }] }
    })
    const res = await fanoutToRecipients(db, bus, {
      messageId: 'msg-4',
      channelId: 'ch-4',
      authorId: 'probe-sender',
      content: 'y',
      recipients: ['probe-ok-1', 'probe-broken', 'probe-ok-2'],
    })
    expect(res.inserted).toEqual(['probe-ok-1', 'probe-ok-2'])
    expect(res.failed).toEqual(['probe-broken'])
    expect(signals).toEqual(['bot_probe-ok-1', 'bot_probe-ok-2'])
  })

  test('bus.signal throw is logged but does NOT unrecord the inserted row', async () => {
    const db = makeDb(async () => ({ rows: [{ id: 1 }] }))
    const { bus, signals } = makeBus(async (channel) => {
      if (channel === 'bot_probe-b') throw new Error('signal failed')
    })
    const res = await fanoutToRecipients(db, bus, {
      messageId: 'msg-5',
      channelId: 'ch-5',
      authorId: 'probe-sender',
      content: 'z',
      recipients: ['probe-a', 'probe-b', 'probe-c'],
    })
    // All three rows count as inserted even though probe-b's signal threw —
    // the row is already in message_queue, polling fallback covers the wake.
    expect(res.inserted).toEqual(['probe-a', 'probe-b', 'probe-c'])
    expect(res.failed).toEqual([])
    expect(signals).toEqual(['bot_probe-a', 'bot_probe-b', 'bot_probe-c'])
  })
})

describe('fanoutToRecipients — bus optional', () => {
  test('null bus skips signaling entirely', async () => {
    const db = makeDb(async () => ({ rows: [{ id: 1 }] }))
    const res = await fanoutToRecipients(db, null, {
      messageId: 'msg-6',
      channelId: 'ch-6',
      authorId: 'probe-sender',
      content: 'n',
      recipients: ['probe-a'],
    })
    expect(res.inserted).toEqual(['probe-a'])
    // No throw, no signal — callers in isolated tests or daemons that own
    // their own bus can pass null without incident.
  })
})
