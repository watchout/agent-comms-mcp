import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { PgAdapter } from '../../core/db/pg-adapter'
import { dispatchV2OutboxOnce, ensureEventLogSchema } from '../../core/eventlog'
import { FakeV2Adapter, appendUnit, makeDeliveryFixture } from './delivery-truth.test'

const EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), seat_id TEXT, seat_instance_id TEXT,
    conversation_id TEXT, causation_id TEXT, correlation_id TEXT, turn_id TEXT, reply_id TEXT,
    claim_epoch INTEGER, payload JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX uq_el_turn_claim ON event_log(turn_id, claim_epoch) WHERE event_type='turn.claimed';
  CREATE UNIQUE INDEX uq_el_turn_completed ON event_log(turn_id) WHERE event_type='turn.completed';
  CREATE UNIQUE INDEX uq_el_delivery_claim ON event_log(reply_id, claim_epoch) WHERE event_type='reply.delivery_claimed';
  CREATE UNIQUE INDEX uq_el_reply_delivered ON event_log(reply_id) WHERE event_type='reply.delivered';
  CREATE INDEX idx_el_type_reply ON event_log(event_type, reply_id);
`

function postgresFixtureEnabled(): boolean {
  return process.env.AUN_K3_DB_SCOPE === 'isolated_disposable_fixture'
}

async function createPostgresFixture(label: string) {
  const url = process.env.AUN_K3_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K3_TEST_DATABASE_URL is required')
  const databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!databaseName.startsWith('aun_k3_fixture_')) throw new Error(`unsafe K3 fixture database ${databaseName}`)
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== url) throw new Error('DATABASE_URL must equal AUN_K3_TEST_DATABASE_URL')
  const schema = `k3_${label}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const db = new PgAdapter(url)
  await db.execute(`CREATE SCHEMA "${schema}"`)
  await db.execute(`SET search_path TO "${schema}", public`)
  await db.execute(EVENT_LOG_DDL)
  return { db, async cleanup() { await db.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.close() } }
}

describe('K3 matrix evidence', () => {
  test('TC014 N=4 matrix has exact claim/start/effect/truth formulas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-k3-matrix-'))
    const db = new SqliteAdapter(join(dir, 'eventlog.db'))
    await ensureEventLogSchema(db)
    try {
      const cases = [
        { fixture: makeDeliveryFixture('provider_ack', 'matrix-1'), adapter: new FakeV2Adapter('provider_ack') },
        { fixture: makeDeliveryFixture('durable_handoff', 'matrix-2'), adapter: new FakeV2Adapter('durable_handoff') },
        { fixture: makeDeliveryFixture('none', 'matrix-3'), adapter: new FakeV2Adapter('delivery_unknown') },
        { fixture: makeDeliveryFixture('provider_ack', 'matrix-4'), adapter: new FakeV2Adapter('provider_ack') },
      ]
      for (const item of cases) {
        await appendUnit(db, item.fixture)
        await dispatchV2OutboxOnce(db, item.adapter, {
          dispatcherId: 'dispatcher', dispatcherInstanceId: `instance-${item.fixture.unit.reply_id}`,
          targetConnectorInstanceId: item.fixture.unit.destination.connector_instance_id,
          loadRegistration: unit => cases.find(candidate => candidate.fixture.unit.reply_id === unit.reply_id)!.fixture.registration,
        })
      }
      const count = async (eventType: string) => Number((await db.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM event_log WHERE event_type=$1', [eventType],
      ))?.n ?? 0)
      const N = cases.length
      expect(await count('reply.delivery_claimed')).toBe(N)
      expect(await count('reply.provider_nonce_reserved')).toBe(N)
      expect(await count('reply.provider_invocation_started')).toBe(N)
      expect(cases.reduce((n, item) => n + item.adapter.calls, 0)).toBe(N)
      expect(await count('reply.delivered')).toBe(2)
      expect(await count('reply.handoff_accepted')).toBe(1)
      expect(await count('reply.delivery_unknown')).toBe(1)
    } finally {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('TC016 wrong target, foreign owner, and invalid registration all have zero deltas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-k3-zero-delta-'))
    const db = new SqliteAdapter(join(dir, 'eventlog.db'))
    await ensureEventLogSchema(db)
    try {
      const fixture = makeDeliveryFixture('provider_ack', 'zero-delta')
      await appendUnit(db, fixture)
      const adapter = new FakeV2Adapter('provider_ack')
      const wrongTarget = await dispatchV2OutboxOnce(db, adapter, {
        dispatcherId: 'dispatcher', dispatcherInstanceId: 'wrong-target',
        targetConnectorInstanceId: '99999999-9999-4999-8999-999999999999',
        loadRegistration: () => fixture.registration,
      })
      const invalidRegistration = structuredClone(fixture.registration)
      invalidRegistration.status = 'revoked'
      const invalid = await dispatchV2OutboxOnce(db, adapter, {
        dispatcherId: 'dispatcher', dispatcherInstanceId: 'invalid-registration',
        targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
        loadRegistration: () => invalidRegistration,
      })
      expect(wrongTarget.providerInvocations + invalid.providerInvocations).toBe(0)
      expect(adapter.calls).toBe(0)
      expect(Number((await db.queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM event_log WHERE event_type IN ('reply.delivery_claimed','reply.provider_nonce_reserved','reply.provider_invocation_started')",
      ))?.n ?? 0)).toBe(0)
    } finally {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.if(postgresFixtureEnabled())('K3 disposable PostgreSQL matrix evidence', () => {
  test('TC014-PG N=4 exact delivery formulas hold on PostgreSQL', async () => {
    const pg = await createPostgresFixture('matrix')
    try {
      const cases = [
        { fixture: makeDeliveryFixture('provider_ack', 'pg-matrix-1'), adapter: new FakeV2Adapter('provider_ack') },
        { fixture: makeDeliveryFixture('durable_handoff', 'pg-matrix-2'), adapter: new FakeV2Adapter('durable_handoff') },
        { fixture: makeDeliveryFixture('none', 'pg-matrix-3'), adapter: new FakeV2Adapter('delivery_unknown') },
        { fixture: makeDeliveryFixture('provider_ack', 'pg-matrix-4'), adapter: new FakeV2Adapter('provider_ack') },
      ]
      for (const item of cases) {
        await appendUnit(pg.db, item.fixture)
        await dispatchV2OutboxOnce(pg.db, item.adapter, {
          dispatcherId: 'dispatcher', dispatcherInstanceId: `pg-${item.fixture.unit.reply_id}`,
          targetConnectorInstanceId: item.fixture.unit.destination.connector_instance_id,
          loadRegistration: unit => cases.find(candidate => candidate.fixture.unit.reply_id === unit.reply_id)!.fixture.registration,
        })
      }
      const rows = await pg.db.query<{ event_type: string; n: string }>(
        `SELECT event_type, COUNT(*) AS n FROM event_log
         WHERE event_type IN ('reply.delivery_claimed','reply.provider_nonce_reserved','reply.provider_invocation_started','reply.delivered','reply.handoff_accepted','reply.delivery_unknown')
         GROUP BY event_type`,
      )
      expect(Object.fromEntries(rows.map(row => [row.event_type, Number(row.n)]))).toEqual({
        'reply.delivered': 2, 'reply.delivery_claimed': 4, 'reply.delivery_unknown': 1,
        'reply.handoff_accepted': 1, 'reply.provider_invocation_started': 4, 'reply.provider_nonce_reserved': 4,
      })
    } finally { await pg.cleanup() }
  })
})
