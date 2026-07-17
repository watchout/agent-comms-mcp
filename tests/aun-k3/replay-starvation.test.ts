import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { PgAdapter } from '../../core/db/pg-adapter'
import { EventLog, canonicalJson, deliveryTruthView, ensureEventLogSchema, rebuildDeliveryTruthView } from '../../core/eventlog'
import { appendUnit, makeDeliveryFixture } from './delivery-truth.test'

const PG_EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), seat_id TEXT, seat_instance_id TEXT,
    conversation_id TEXT, causation_id TEXT, correlation_id TEXT, turn_id TEXT, reply_id TEXT,
    claim_epoch INTEGER, payload JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX uq_el_delivery_claim ON event_log(reply_id, claim_epoch) WHERE event_type='reply.delivery_claimed';
  CREATE UNIQUE INDEX uq_el_reply_delivered ON event_log(reply_id) WHERE event_type='reply.delivered';
  CREATE INDEX idx_el_type_reply ON event_log(event_type, reply_id);
`

const pgEnabled = () => process.env.AUN_K3_DB_SCOPE === 'isolated_disposable_fixture'

async function pgFixture() {
  const url = process.env.AUN_K3_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K3_TEST_DATABASE_URL is required')
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name.startsWith('aun_k3_fixture_')) throw new Error(`unsafe K3 fixture database ${name}`)
  const schema = `k3_replay_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const db = new PgAdapter(url)
  await db.execute(`CREATE SCHEMA "${schema}"`)
  await db.execute(`SET search_path TO "${schema}", public`)
  await db.execute(PG_EVENT_LOG_DDL)
  return { db, async cleanup() { await db.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.close() } }
}

describe('K3 replay and pending selection', () => {
  test('TC013 a terminal prefix larger than one page cannot starve a later pending V2 unit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-k3-replay-'))
    const db = new SqliteAdapter(join(dir, 'eventlog.db'))
    await ensureEventLogSchema(db)
    try {
      const log = new EventLog(db)
      for (let index = 0; index < 1100; index += 1) {
        await log.append({
          eventId: `legacy-enqueued-${index}`, eventType: 'reply.enqueued', replyId: `legacy-${index}`,
          payload: { content: 'legacy-prefix' },
        })
        await log.append({
          eventId: `legacy-delivered-${index}`, eventType: 'reply.delivered', replyId: `legacy-${index}`,
          payload: { transport_message_id: `legacy-message-${index}` },
        })
      }
      const fixture = makeDeliveryFixture('provider_ack', 'after-terminal-prefix')
      await appendUnit(db, fixture)
      const started = performance.now()
      const view = await deliveryTruthView(db)
      const elapsed = performance.now() - started
      expect(view.map(row => row.reply_id)).toContain(fixture.unit.reply_id)
      expect(view.find(row => row.reply_id === fixture.unit.reply_id)?.state).toBe('pending')
      expect(elapsed).toBeLessThan(2000)
      expect(canonicalJson(await rebuildDeliveryTruthView(db))).toBe(canonicalJson(view))
    } finally {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.if(pgEnabled())('K3 PostgreSQL replay and pending selection', () => {
  test('TC013-PG terminal prefix cannot starve a later pending V2 unit', async () => {
    const pg = await pgFixture()
    try {
      const log = new EventLog(pg.db)
      for (let index = 0; index < 1050; index += 1) {
        await log.append({ eventId: `pg-legacy-enqueued-${index}`, eventType: 'reply.enqueued', replyId: `pg-legacy-${index}`, payload: { content: 'legacy' } })
        await log.append({ eventId: `pg-legacy-delivered-${index}`, eventType: 'reply.delivered', replyId: `pg-legacy-${index}`, payload: { transport_message_id: `message-${index}` } })
      }
      const fixture = makeDeliveryFixture('provider_ack', 'pg-after-prefix')
      await appendUnit(pg.db, fixture)
      const started = performance.now()
      const view = await deliveryTruthView(pg.db)
      expect(view.find(row => row.reply_id === fixture.unit.reply_id)?.state).toBe('pending')
      expect(performance.now() - started).toBeLessThan(2000)
      expect(canonicalJson(await rebuildDeliveryTruthView(pg.db))).toBe(canonicalJson(view))
    } finally { await pg.cleanup() }
  }, 20_000)
})
