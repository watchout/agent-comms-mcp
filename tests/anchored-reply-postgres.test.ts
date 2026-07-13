import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

import {
  QUEUE_WORK_RESULT_VERSION,
  finalizeDoneQueueWork,
  type QueueWorkDb,
} from '../core/queue-work'

const DATABASE_URL = process.env.DATABASE_URL

if (DATABASE_URL) describe('transaction-native anchored reply finalizer — PostgreSQL', () => {
  let client: Client
  const suffix = randomUUID().slice(0, 8)
  const sender = `test-finalizer-sender-${suffix}`
  const owner = `test-finalizer-owner-${suffix}`
  const channel = `test-finalizer-channel-${suffix}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    for (const agentId of [sender, owner]) {
      await client.query(
        `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status)
         VALUES ($1, $1, 'dev', 'test', 'idle')`,
        [agentId],
      )
    }
    await client.query(
      `INSERT INTO channels (id, name, members, created_by)
       VALUES ($1, $1, $2, $3)`,
      [channel, [sender, owner], sender],
    )
  })

  afterAll(async () => {
    await client.query(
      `DELETE FROM outbound_queue
        WHERE message_id IN (SELECT id::text FROM agent_messages WHERE channel_id = $1)`,
      [channel],
    )
    await client.query(
      `DELETE FROM message_queue
        WHERE agent_id = ANY($1::text[])
           OR message_id IN (SELECT id::text FROM agent_messages WHERE channel_id = $2)`,
      [[sender, owner], channel],
    )
    await client.query('DELETE FROM audit_log WHERE target = $1 OR agent_id = ANY($2::text[])', [channel, [sender, owner]])
    await client.query('DELETE FROM agent_messages WHERE channel_id = $1', [channel])
    await client.query('DELETE FROM channels WHERE id = $1', [channel])
    await client.query('DELETE FROM agents WHERE agent_id = ANY($1::text[])', [[sender, owner]])
    await client.end()
  })

  async function seedDoneQueue(reply = 'transaction-native reply'): Promise<{ queueId: string; originalId: string }> {
    const originalId = randomUUID()
    await client.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, content, message_type, source, direction, role)
       VALUES ($1, $2, $3, 'handoff', 'instruction', 'test', 'inbound', 'agent')`,
      [originalId, channel, owner],
    )
    const payload = JSON.stringify({
      channel_id: channel,
      thread_id: null,
      author_id: owner,
      content: 'handoff',
      message_id: originalId,
      message_type: 'instruction',
      runner_result: {
        schema_version: QUEUE_WORK_RESULT_VERSION,
        ok: true,
        summary: 'complete',
        reply,
        evidence: [],
        next_action: 'reply',
      },
    })
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, done_at)
       VALUES ($1, $2, $3, 'done', now())
       RETURNING id::text AS id`,
      [sender, originalId, payload],
    )
    return { queueId: inserted.rows[0].id, originalId }
  }

  async function readEvidence(queueId: string, originalId: string) {
    const result = await client.query(
      `SELECT
         (SELECT count(*)::int FROM agent_messages WHERE reply_to = $1::uuid) AS reply_count,
         (SELECT count(*)::int
            FROM message_queue mq
            JOIN agent_messages am ON am.id::text = mq.message_id
           WHERE am.reply_to = $1::uuid AND mq.agent_id = $2) AS owner_receipt_count,
         (SELECT count(*)::int
            FROM outbound_queue oq
            JOIN agent_messages am ON am.id::text = oq.message_id
           WHERE am.id = $1::uuid OR am.reply_to = $1::uuid) AS request_reply_outbound_count,
         (SELECT status FROM message_queue WHERE id = $3) AS source_status,
         (SELECT replied_with FROM message_queue WHERE id = $3) AS source_replied_with`,
      [originalId, owner, queueId],
    )
    return result.rows[0]
  }

  test('done → replied is one atomic reply/receipt with connector-free zero outbound and idempotent replay', async () => {
    const seeded = await seedDoneQueue()
    const priorPath = process.env.PATH
    process.env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    const started = performance.now()
    const outcome = await finalizeDoneQueueWork(client, { queueId: seeded.queueId })
    const elapsedMs = performance.now() - started
    process.env.PATH = priorPath

    expect(outcome).toMatchObject({ ok: true, code: 'REPLIED', queue_id: seeded.queueId })
    expect(elapsedMs).toBeLessThanOrEqual(1000)
    const repliedWith = outcome.ok ? outcome.replied_with : null
    expect(repliedWith).toBeTruthy()
    expect(await readEvidence(seeded.queueId, seeded.originalId)).toEqual({
      reply_count: 1,
      owner_receipt_count: 1,
      request_reply_outbound_count: 0,
      source_status: 'replied',
      source_replied_with: repliedWith,
    })

    const replay = await finalizeDoneQueueWork(client, { queueId: seeded.queueId })
    expect(replay).toMatchObject({ ok: true, code: 'ALREADY_REPLIED', replied_with: repliedWith })
    expect(await readEvidence(seeded.queueId, seeded.originalId)).toEqual({
      reply_count: 1,
      owner_receipt_count: 1,
      request_reply_outbound_count: 0,
      source_status: 'replied',
      source_replied_with: repliedWith,
    })
  })

  for (const failureStage of ['fanout', 'projection', 'source_close'] as const) {
    test(`injected ${failureStage} failure rolls back reply, receipt, and source transition`, async () => {
      const seeded = await seedDoneQueue(`rollback-${failureStage}`)
      let receiptInserted = false
      const failingDb: QueueWorkDb = {
        async query<T = any>(sql: string, params?: unknown[]) {
          if (failureStage === 'fanout' && sql.includes('INSERT INTO message_queue')) {
            throw new Error('injected fanout failure')
          }
          if (failureStage === 'projection' && receiptInserted) {
            receiptInserted = false
            throw new Error('injected projection failure')
          }
          if (failureStage === 'source_close' && sql.includes("SET status = 'replied'")) {
            throw new Error('injected source-close failure')
          }
          const result = await client.query(sql, params as any[])
          if (sql.includes('INSERT INTO message_queue')) receiptInserted = true
          return { rows: result.rows as T[], rowCount: result.rowCount }
        },
      }

      const outcome = await finalizeDoneQueueWork(failingDb, { queueId: seeded.queueId })
      expect(outcome).toMatchObject({ ok: false, code: 'RETRYABLE_FINALIZER_FAILURE' })
      expect(await readEvidence(seeded.queueId, seeded.originalId)).toEqual({
        reply_count: 0,
        owner_receipt_count: 0,
        request_reply_outbound_count: 0,
        source_status: 'done',
        source_replied_with: null,
      })
    })
  }

  test('minimal PATH has no child process or nested lock, and PostgreSQL latency stays bounded', async () => {
    const runnerSource = readFileSync(join(import.meta.dir, '../bin/aun/run-queue-work.ts'), 'utf8')
    const coreSource = readFileSync(join(import.meta.dir, '../core/anchored-reply.ts'), 'utf8')
    expect(runnerSource).not.toContain('AgentComCliReplySender')
    expect(runnerSource).not.toMatch(/execFileAsync\(['"]bun['"]\)/)
    expect(coreSource).not.toMatch(/from ['"]node:child_process['"]|execFile|spawn/)
    expect(coreSource).not.toContain('FOR UPDATE')

    const priorPath = process.env.PATH
    process.env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    const samples: number[] = []
    try {
      for (let index = 0; index < 20; index += 1) {
        const seeded = await seedDoneQueue(`latency-${index}`)
        const started = performance.now()
        const outcome = await finalizeDoneQueueWork(client, { queueId: seeded.queueId })
        samples.push(performance.now() - started)
        expect(outcome.ok).toBe(true)
      }
    } finally {
      process.env.PATH = priorPath
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
    const max = sorted[sorted.length - 1]
    process.stdout.write(`finalizer_latency_raw_ms=${JSON.stringify(samples.map((value) => Number(value.toFixed(2))))}\n`)
    process.stdout.write(`finalizer_latency_ms p95=${p95.toFixed(2)} max=${max.toFixed(2)} samples=${samples.length}\n`)
    expect(p95).toBeLessThanOrEqual(250)
    expect(max).toBeLessThanOrEqual(1000)
  })
})
else describe('transaction-native anchored reply finalizer — PostgreSQL', () => {
  test('requires DATABASE_URL for the PostgreSQL fixture', () => {
    expect(DATABASE_URL).toBeUndefined()
  })
})
