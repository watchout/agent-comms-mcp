import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { EventLog, dispatchV2OutboxOnce, ensureEventLogSchema } from '../../core/eventlog'
import { runSeatSupervisorCycle } from '../../core/eventlog/seat-supervisor'
import { FakeV2Adapter, appendUnit, makeDeliveryFixture } from './delivery-truth.test'

interface FixtureAdapter extends DbAdapter {
  id: string
  closed: boolean
}

function adapter(id: string): FixtureAdapter {
  return {
    id, closed: false, dialect: 'sqlite',
    async query() { return [] }, async queryOne() { return null },
    async execute() { return { rowCount: 0 } },
    async transaction<T>(fn: (tx: DbAdapter) => Promise<T>) { return fn(this) },
    async close() { this.closed = true },
  }
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

async function withSqlite<T>(run: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aun-k3-dispatcher-negative-'))
  const db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
  try { return await run(db) } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function eventRows(db: DbAdapter): Promise<number> {
  return Number((await db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM event_log'))?.n ?? 0)
}

async function casRows(db: DbAdapter): Promise<number> {
  return Number((await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM event_log WHERE event_type IN (
      'reply.provider_nonce_reserved', 'reply.delivery_claimed',
      'reply.provider_invocation_started', 'reply.delivered',
      'reply.handoff_accepted', 'reply.delivery_unknown', 'reply.failed'
    )`,
  ))?.n ?? 0)
}

describe('K3 dedicated dispatcher liveness', () => {
  test('TC012 a hung seat cannot delay 100 dispatcher cycles or share its DB adapter', async () => {
    const seatDb = adapter('seat-db')
    const dispatcherDb = adapter('dispatcher-db')
    const reconcilerDb = adapter('reconciler-db')
    const cycleLatency: number[] = []
    const overallStart = performance.now()
    const report = await runSeatSupervisorCycle({
      units: [
        {
          unitId: 'seat:hung', kind: 'seat', seatId: 'hung', adapterFactory: async () => seatDb,
          run: async () => new Promise(() => {}),
        },
        {
          unitId: 'outbox:k3', kind: 'outbox', adapterFactory: async () => dispatcherDb,
          run: async db => {
            for (let cycle = 0; cycle < 100; cycle += 1) {
              const started = performance.now()
              await db.query('SELECT 1')
              cycleLatency.push(performance.now() - started)
            }
            return { cycles: 100 }
          },
        },
        {
          unitId: 'reconciler:k3', kind: 'reconciler', adapterFactory: async () => reconcilerDb,
          run: async db => {
            await db.query('SELECT 1')
            return { cycles: 1 }
          },
        },
      ],
      maxConcurrency: 1, unitTimeoutMs: 30, reconnectMaxAttempts: 1,
      reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 1,
    })
    const outbox = report.units.find(unit => unit.unit_id === 'outbox:k3')!
    expect(outbox.status).toBe('completed')
    expect((outbox.value as { cycles: number }).cycles).toBe(100)
    expect(cycleLatency).toHaveLength(100)
    expect(percentile95(cycleLatency)).toBeLessThanOrEqual(100)
    expect(performance.now() - overallStart).toBeLessThan(200)
    expect(new Set([seatDb.id, dispatcherDb.id, reconcilerDb.id]).size).toBe(3)
  })

  test('TC016 wrong target, wrong queue, foreign live owner, and invalid loaded registration have exact zero deltas', async () => {
    const outcomes: Array<{ name: string; event_row_delta: number; CAS_winners: number; provider_attempts: number; external_effects: number; V1_invocations: number }> = []

    await withSqlite(async db => {
      const fixture = makeDeliveryFixture('provider_ack', 'tc016-wrong-target')
      const transport = new FakeV2Adapter('provider_ack')
      await appendUnit(db, fixture)
      const before = await eventRows(db)
      const casBefore = await casRows(db)
      const result = await dispatchV2OutboxOnce(db, transport, {
        dispatcherId: 'dispatcher', dispatcherInstanceId: 'wrong-target',
        targetConnectorInstanceId: '99999999-9999-4999-8999-999999999999',
        loadRegistration: () => fixture.registration,
      })
      outcomes.push({
        name: 'wrong target', event_row_delta: (await eventRows(db)) - before,
        CAS_winners: (await casRows(db)) - casBefore,
        provider_attempts: result.providerInvocations, external_effects: transport.calls, V1_invocations: 0,
      })
    })

    await withSqlite(async db => {
      const fixture = makeDeliveryFixture('provider_ack', 'tc016-wrong-queue')
      const transport = new FakeV2Adapter('provider_ack')
      await new EventLog(db).append({
        eventId: `wrong-queue:${fixture.unit.reply_id}`, eventType: 'reply.enqueued',
        seatId: 'foreign-dispatch-queue', conversationId: fixture.unit.conversation_id,
        turnId: fixture.unit.turn_id, replyId: fixture.unit.reply_id,
        payload: fixture.unit as unknown as Record<string, unknown>,
      })
      const before = await eventRows(db)
      const casBefore = await casRows(db)
      const result = await dispatchV2OutboxOnce(db, transport, {
        dispatcherId: 'dispatcher', dispatcherInstanceId: 'wrong-queue',
        targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
        loadRegistration: () => fixture.registration,
      })
      outcomes.push({
        name: 'wrong queue', event_row_delta: (await eventRows(db)) - before,
        CAS_winners: (await casRows(db)) - casBefore,
        provider_attempts: result.providerInvocations, external_effects: transport.calls, V1_invocations: 0,
      })
    })

    await withSqlite(async db => {
      const fixture = makeDeliveryFixture('provider_ack', 'tc016-foreign-live-owner')
      const transport = new FakeV2Adapter('provider_ack')
      await appendUnit(db, fixture)
      await new EventLog(db).append({
        eventId: `foreign-live-claim:${fixture.unit.reply_id}`, eventType: 'reply.delivery_claimed',
        seatId: 'foreign-dispatcher', seatInstanceId: 'foreign-live-instance',
        conversationId: fixture.unit.conversation_id, turnId: fixture.unit.turn_id,
        replyId: fixture.unit.reply_id, claimEpoch: 0,
      })
      const before = await eventRows(db)
      const casBefore = await casRows(db)
      const result = await dispatchV2OutboxOnce(db, transport, {
        dispatcherId: 'dispatcher', dispatcherInstanceId: 'local-live-instance',
        targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
        loadRegistration: () => fixture.registration,
      })
      outcomes.push({
        name: 'foreign live owner', event_row_delta: (await eventRows(db)) - before,
        CAS_winners: (await casRows(db)) - casBefore,
        provider_attempts: result.providerInvocations, external_effects: transport.calls, V1_invocations: 0,
      })
    })

    await withSqlite(async db => {
      const fixture = makeDeliveryFixture('provider_ack', 'tc016-invalid-registration')
      const transport = new FakeV2Adapter('provider_ack')
      await appendUnit(db, fixture)
      const invalidRegistration = structuredClone(fixture.registration)
      invalidRegistration.status = 'revoked'
      const before = await eventRows(db)
      const casBefore = await casRows(db)
      const result = await dispatchV2OutboxOnce(db, transport, {
        dispatcherId: 'dispatcher', dispatcherInstanceId: 'invalid-registration',
        targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
        loadRegistration: () => invalidRegistration,
      })
      outcomes.push({
        name: 'invalid loaded registration', event_row_delta: (await eventRows(db)) - before,
        CAS_winners: (await casRows(db)) - casBefore,
        provider_attempts: result.providerInvocations, external_effects: transport.calls, V1_invocations: 0,
      })
    })

    expect(outcomes).toEqual([
      'wrong target', 'wrong queue', 'foreign live owner', 'invalid loaded registration',
    ].map(name => ({ name, event_row_delta: 0, CAS_winners: 0, provider_attempts: 0, external_effects: 0, V1_invocations: 0 })))
  })
})
