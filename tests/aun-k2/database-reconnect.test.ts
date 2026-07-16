import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { DbAdapter } from '../../core/db/adapter'
import { PgAdapter } from '../../core/db/pg-adapter'
import { receiveMessage } from '../../core/eventlog'
import { runWithReconnect } from '../../core/eventlog/seat-supervisor'
import { runSeatWorkerOnce } from '../../core/eventlog/worker'

const ROOT = resolve(import.meta.dir, '../..')
const K1_UP = resolve(ROOT, 'db/migrations/2026-07-16-aun-k1-event-projection-claim.up.sql')
const K2_UP = resolve(ROOT, 'db/migrations/2026-07-16-aun-k2-runtime-supervision.up.sql')
const EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), seat_id TEXT,
    seat_instance_id TEXT, conversation_id TEXT, causation_id TEXT, correlation_id TEXT,
    turn_id TEXT, reply_id TEXT, claim_epoch INTEGER, payload JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX uq_el_turn_claim ON event_log(turn_id, claim_epoch) WHERE event_type='turn.claimed';
  CREATE UNIQUE INDEX uq_el_turn_completed ON event_log(turn_id) WHERE event_type='turn.completed';
  CREATE UNIQUE INDEX uq_el_delivery_claim ON event_log(reply_id, claim_epoch) WHERE event_type='reply.delivery_claimed';
  CREATE UNIQUE INDEX uq_el_reply_delivered ON event_log(reply_id) WHERE event_type='reply.delivered';
  CREATE INDEX idx_el_type_turn ON event_log(event_type, turn_id);
  CREATE INDEX idx_el_type_reply ON event_log(event_type, reply_id);
  CREATE INDEX idx_el_conversation ON event_log(conversation_id, seq);
  CREATE INDEX idx_el_seat_type ON event_log(seat_id, event_type);
  CREATE INDEX idx_el_causation ON event_log(causation_id);
`

function fixtureEnabled(): boolean {
  return process.env.AUN_K2_DB_SCOPE === 'isolated_disposable_fixture'
}

function fixtureUrl(): string {
  if (!fixtureEnabled()) throw new Error('AUN_K2_DB_SCOPE must equal isolated_disposable_fixture')
  const url = process.env.AUN_K2_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K2_TEST_DATABASE_URL is required')
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name.startsWith('aun_k2_fixture_')) throw new Error(`unsafe K2 fixture database ${name}`)
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== url) {
    throw new Error('DATABASE_URL must be absent or equal AUN_K2_TEST_DATABASE_URL')
  }
  return url
}

function quoted(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) throw new Error(`unsafe identifier ${identifier}`)
  return `"${identifier}"`
}

async function createFixture(label: string) {
  const url = fixtureUrl()
  const schema = `k2_${label}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const bootstrap = new PgAdapter(url)
  await bootstrap.execute(`CREATE SCHEMA ${quoted(schema)}`)
  await bootstrap.execute(`SET search_path TO ${quoted(schema)}, public`)
  await bootstrap.execute(EVENT_LOG_DDL)
  await bootstrap.execute(readFileSync(K1_UP, 'utf8'))
  await bootstrap.execute(readFileSync(K2_UP, 'utf8'))
  const connect = async () => {
    const db = new PgAdapter(url)
    await db.execute(`SET search_path TO ${quoted(schema)}, public`)
    return db
  }
  return {
    bootstrap,
    connect,
    async cleanup() {
      await bootstrap.execute(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`)
      await bootstrap.close()
    },
  }
}

class TrackedAdapter implements DbAdapter {
  readonly dialect = 'postgres' as const
  readonly claimCapabilities = {
    productionMultiWorker: true, skipLocked: true, transactionLeaseClock: true,
  } as const
  closed = false

  constructor(readonly id: string, private readonly db: PgAdapter) {}

  query<T = unknown>(sql: string, params?: unknown[]) { return this.db.query<T>(sql, params) }
  queryOne<T = unknown>(sql: string, params?: unknown[]) { return this.db.queryOne<T>(sql, params) }
  execute(sql: string, params?: unknown[]) { return this.db.execute(sql, params) }
  transaction<T>(fn: (tx: DbAdapter) => Promise<T>) {
    return this.db.transaction(() => fn(this))
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.db.close()
  }
}

describe.skipIf(!fixtureEnabled())('K2 database reconnect and poll backstop', () => {
  test('K2-TC-011 committed input survives one connection loss and a fresh adapter finishes it', async () => {
    const fixture = await createFixture('reconnect')
    const adapters: TrackedAdapter[] = []
    try {
      const received = await receiveMessage(fixture.bootstrap, {
        messageId: 'reconnect-1', seatId: 'kodama', conversationId: 'conversation-reconnect-1',
      })
      let runs = 0
      let modelCalls = 0
      const started = performance.now()
      const report = await runWithReconnect({
        unit: {
          unitId: 'seat:kodama', kind: 'seat', seatId: 'kodama',
          adapterFactory: async () => {
            const tracked = new TrackedAdapter(`connection-${adapters.length + 1}`, await fixture.connect())
            adapters.push(tracked)
            return tracked
          },
          run: async db => {
            runs += 1
            if (runs === 1) {
              await db.close()
              const error = new Error('simulated ECONNRESET after committed receive')
              ;(error as Error & { code: string }).code = 'ECONNRESET'
              throw error
            }
            return runSeatWorkerOnce(db, {
              seatId: 'kodama', seatInstanceId: 'runtime-kodama-reconnect',
              runtime: { async runTurn() { modelCalls += 1; return { outcome: 'no_reply' } } },
              maxTurns: 1, claimExecutionMode: 'production_multi_worker', claimLeaseDurationMs: 5_000,
            })
          },
          retryable: error => (error as { code?: string }).code === 'ECONNRESET',
        },
        timeoutMs: 30_000,
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 10,
        jitterSeed: 20260716,
        sleep: async () => {},
      })
      const elapsedSeconds = (performance.now() - started) / 1000
      expect(report.status).toBe('completed')
      expect(report.adapter_instances).toBe(2)
      expect(report.closed_adapters).toBe(2)
      expect(adapters).toHaveLength(2)
      expect(adapters[0].closed).toBeTrue()
      expect(adapters[0].id).not.toBe(adapters[1].id)
      expect(elapsedSeconds).toBeLessThanOrEqual(30)
      expect(modelCalls).toBe(1)
      expect((report.value as { claimed: number; completed: number })).toMatchObject({ claimed: 1, completed: 1 })
      expect(Number((await fixture.bootstrap.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_id=$1`, [received.event.event_id],
      ))?.n)).toBe(1)
      expect(Number((await fixture.bootstrap.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE turn_id=$1 AND event_type='turn.completed'`,
        [received.event.turn_id],
      ))?.n)).toBe(1)
    } finally {
      for (const db of adapters) await db.close()
      await fixture.cleanup()
    }
  })

  test('K2-TC-013 polling claims a later eligible turn when notification is lost', async () => {
    const fixture = await createFixture('poll_backstop')
    let worker: PgAdapter | null = null
    try {
      for (let index = 0; index < 75; index++) {
        await receiveMessage(fixture.bootstrap, {
          messageId: `historic-${index}`, seatId: 'unrelated', conversationId: `history-${index}`,
        })
      }
      const intended = await receiveMessage(fixture.bootstrap, {
        messageId: 'later-eligible', seatId: 'beta', conversationId: 'conversation-later-eligible',
      })
      const notifyConsumed = false
      const started = performance.now()
      worker = await fixture.connect()
      const result = await runSeatWorkerOnce(worker, {
        seatId: 'beta', seatInstanceId: 'runtime-beta-poll-backstop',
        runtime: { async runTurn() { return { outcome: 'no_reply' } } },
        maxTurns: 1, claimExecutionMode: 'production_multi_worker', claimLeaseDurationMs: 5_000,
      })
      const pollBackstopMs = performance.now() - started
      expect(notifyConsumed).toBeFalse()
      expect(result).toMatchObject({ claimed: 1, completed: 1 })
      expect(pollBackstopMs).toBeLessThanOrEqual(2_000)
      const claim = await fixture.bootstrap.queryOne<{ turn_id: string }>(
        `SELECT turn_id FROM event_log WHERE event_type='turn.claimed' AND seat_id='beta' ORDER BY seq DESC LIMIT 1`,
      )
      expect(claim?.turn_id).toBe(intended.event.turn_id)
      expect(Number((await fixture.bootstrap.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE turn_id=$1 AND event_type='turn.completed'`,
        [intended.event.turn_id],
      ))?.n)).toBe(1)
    } finally {
      if (worker) await worker.close()
      await fixture.cleanup()
    }
  })
})
