import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { PgAdapter } from '../../core/db/pg-adapter'
import {
  claimNextTurn,
  EventLog,
  failTurnAttempt,
  receiveMessage,
  scheduleTurnRetry,
} from '../../core/eventlog'

const ROOT = resolve(import.meta.dir, '../..')
const K1_UP = readFileSync(resolve(ROOT, 'db/migrations/2026-07-16-aun-k1-event-projection-claim.up.sql'), 'utf8')
const K2_UP = readFileSync(resolve(ROOT, 'db/migrations/2026-07-16-aun-k2-runtime-supervision.up.sql'), 'utf8')
const K2_DOWN = readFileSync(resolve(ROOT, 'db/migrations/2026-07-16-aun-k2-runtime-supervision.down.sql'), 'utf8')
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

function fixtureUrl(): { url: string; name: string } {
  if (!fixtureEnabled()) throw new Error('AUN_K2_DB_SCOPE must equal isolated_disposable_fixture')
  const url = process.env.AUN_K2_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K2_TEST_DATABASE_URL is required')
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name.startsWith('aun_k2_fixture_')) throw new Error(`unsafe K2 fixture database ${name}`)
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== url) {
    throw new Error('DATABASE_URL must be absent or equal AUN_K2_TEST_DATABASE_URL')
  }
  return { url, name }
}

function quoted(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) throw new Error(`unsafe identifier ${identifier}`)
  return `"${identifier}"`
}

async function createFixture(label: string) {
  const { url, name } = fixtureUrl()
  const schema = `k2_${label}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const db = new PgAdapter(url)
  await db.execute(`CREATE SCHEMA ${quoted(schema)}`)
  await db.execute(`SET search_path TO ${quoted(schema)}, public`)
  await db.execute(EVENT_LOG_DDL)
  await db.execute(K1_UP)
  return {
    db, name, schema,
    migrate: async (direction: 'up' | 'down') => db.execute(direction === 'up' ? K2_UP : K2_DOWN),
    async cleanup() {
      await db.execute(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`)
      await db.close()
    },
  }
}

async function canonicalProjection(db: PgAdapter): Promise<string> {
  const row = await db.queryOne<{ canonical: string }>(`
    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.turn_id)::text, '[]') AS canonical
      FROM event_log_turn_projection p
  `)
  return row?.canonical ?? '[]'
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe.if(fixtureEnabled())('K2 migration roundtrip', () => {
  test('K2-TC-012 guarded up/down/up is lossless, replay-equal and downgrade fails closed', async () => {
    const fixture = await createFixture('migration_roundtrip')
    try {
      const available = await receiveMessage(fixture.db, { messageId: 'available-1', seatId: 'alpha' })
      const claimedReceive = await receiveMessage(fixture.db, { messageId: 'claimed-1', seatId: 'beta' })
      const clock = await fixture.db.queryOne<{ claimed_at: Date; lease_expires_at: Date }>(`
        SELECT clock_timestamp() AS claimed_at, clock_timestamp() + interval '60 seconds' AS lease_expires_at
      `)
      const log = new EventLog(fixture.db)
      const claimed = await log.append({
        eventId: randomUUID(), eventType: 'turn.claimed', seatId: 'beta',
        seatInstanceId: 'runtime-beta-claimed', causationId: claimedReceive.event.event_id,
        turnId: claimedReceive.event.turn_id, claimEpoch: 0,
        payload: {
          claim_profile: 'postgres_multi_worker_v1', fencing_token: 1,
          claimed_at: new Date(clock!.claimed_at).toISOString(),
          lease_expires_at: new Date(clock!.lease_expires_at).toISOString(),
        },
      })
      const completedReceive = await receiveMessage(fixture.db, { messageId: 'completed-1', seatId: 'gamma' })
      const completedClaim = await log.append({
        eventId: randomUUID(), eventType: 'turn.claimed', seatId: 'gamma',
        seatInstanceId: 'runtime-gamma-completed', causationId: completedReceive.event.event_id,
        turnId: completedReceive.event.turn_id, claimEpoch: 0,
        payload: {
          claim_profile: 'postgres_multi_worker_v1', fencing_token: 1,
          claimed_at: new Date(clock!.claimed_at).toISOString(),
          lease_expires_at: new Date(clock!.lease_expires_at).toISOString(),
        },
      })
      await log.append({
        eventId: `done:${completedReceive.event.turn_id}`, eventType: 'turn.completed', seatId: 'gamma',
        seatInstanceId: 'runtime-gamma-completed', causationId: completedClaim.event.event_id,
        turnId: completedReceive.event.turn_id, claimEpoch: 0,
        payload: { outcome: 'no_reply', fencing_token: 1 },
      })
      expect(available.event.turn_id).not.toBe(claimedReceive.event.turn_id)
      expect(claimed.event.claim_epoch).toBe(0)

      await fixture.migrate('up')
      const incremental = await canonicalProjection(fixture.db)
      await fixture.db.execute('SELECT aun_k1_rebuild_turn_projection()')
      const replay = await canonicalProjection(fixture.db)
      expect(replay).toBe(incremental)

      const beforeRows = Number((await fixture.db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM event_log_turn_projection'))?.n)
      await fixture.migrate('down')
      const columnsAfterDown = await fixture.db.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='event_log_turn_projection'
           AND column_name IN ('available_at','attempt_count','terminal_reason','last_failure_code')
      `)
      expect(columnsAfterDown).toHaveLength(0)
      await fixture.migrate('up')
      const afterRoundtrip = await canonicalProjection(fixture.db)
      expect(digest(afterRoundtrip)).toBe(digest(incremental))
      await fixture.migrate('up')
      expect(await canonicalProjection(fixture.db)).toBe(afterRoundtrip)
      expect(Number((await fixture.db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM event_log_turn_projection'))?.n)).toBe(beforeRows)

      const retryReceive = await receiveMessage(fixture.db, { messageId: 'retry-1', seatId: 'delta' })
      const retryClaim = await claimNextTurn(fixture.db, {
        seatId: 'delta', seatInstanceId: 'runtime-delta-retry',
        executionMode: 'production_multi_worker', leaseDurationMs: 60_000,
      })
      const failure = await failTurnAttempt(fixture.db, {
        turnId: retryReceive.event.turn_id!, seatId: 'delta', seatInstanceId: 'runtime-delta-retry',
        claimEventId: retryClaim!.claimEventId, claimEpoch: retryClaim!.claimEpoch,
        fencingToken: retryClaim!.fencingToken!, failureCode: 'RUNTIME_TIMEOUT',
        failureSummary: 'fixture timeout', retryable: true,
      })
      await scheduleTurnRetry(fixture.db, {
        turnId: retryReceive.event.turn_id!, seatId: 'delta', seatInstanceId: 'runtime-delta-retry',
        claimEventId: retryClaim!.claimEventId, claimEpoch: retryClaim!.claimEpoch,
        fencingToken: retryClaim!.fencingToken!, failureEventId: failure.event.event_id,
        availableAt: new Date(Date.now() + 60_000).toISOString(), backoffMs: 60_000,
      })
      let downgradeError: unknown
      try {
        await fixture.migrate('down')
      } catch (error) {
        downgradeError = error
        await fixture.db.execute('ROLLBACK')
      }
      expect(String(downgradeError)).toContain('K2_DOWNGRADE_UNREPRESENTABLE')
      const retained = await fixture.db.queryOne<{ availability: string; attempt_count: number }>(
        'SELECT availability, attempt_count FROM event_log_turn_projection WHERE turn_id=$1',
        [retryReceive.event.turn_id],
      )
      expect(retained?.availability).toBe('retry_wait')
      expect(Number(retained?.attempt_count)).toBe(1)
      expect(fixture.name.startsWith('aun_k2_fixture_')).toBeTrue()
    } finally {
      await fixture.cleanup()
    }
  })
})
