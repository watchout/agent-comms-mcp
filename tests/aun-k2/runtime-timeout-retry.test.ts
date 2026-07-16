import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { PgAdapter } from '../../core/db/pg-adapter'
import {
  blockTurn,
  claimNextTurn,
  completeTurn,
  deadLetterTurn,
  failTurnAttempt,
  receiveMessage,
  StaleClaimError,
} from '../../core/eventlog'
import { RuntimeTimeoutError } from '../../core/eventlog/runtimes'
import { runSeatWorkerOnce } from '../../core/eventlog/worker'

const ROOT = resolve(import.meta.dir, '../..')
const K1_UP = resolve(ROOT, 'db/migrations/2026-07-16-aun-k1-event-projection-claim.up.sql')
const K2_UP = resolve(ROOT, 'db/migrations/2026-07-16-aun-k2-runtime-supervision.up.sql')

const EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    seat_id TEXT,
    seat_instance_id TEXT,
    conversation_id TEXT,
    causation_id TEXT,
    correlation_id TEXT,
    turn_id TEXT,
    reply_id TEXT,
    claim_epoch INTEGER,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
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
  const db = new PgAdapter(url)
  await db.execute(`CREATE SCHEMA ${quoted(schema)}`)
  await db.execute(`SET search_path TO ${quoted(schema)}, public`)
  await db.execute(EVENT_LOG_DDL)
  await db.execute(readFileSync(K1_UP, 'utf8'))
  await db.execute(readFileSync(K2_UP, 'utf8'))
  return {
    db,
    async cleanup() {
      await db.execute(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`)
      await db.close()
    },
  }
}

describe.skipIf(!fixtureEnabled())('K2 timeout, retry and stale-fence truth', () => {
  test('K2-TC-007 timeout records failure/retry/release and increments the next claim fence', async () => {
    const fixture = await createFixture('timeout_retry')
    try {
      const received = await receiveMessage(fixture.db, {
        messageId: 'timeout-1',
        seatId: 'arc',
        conversationId: 'conversation-timeout-1',
      })
      const clock = await fixture.db.queryOne<{ now: Date }>('SELECT clock_timestamp() AS now')
      const fixedNow = new Date(clock!.now)
      let modelCalls = 0
      const result = await runSeatWorkerOnce(fixture.db, {
        seatId: 'arc',
        seatInstanceId: 'runtime-arc-timeout-1',
        runtime: {
          async runTurn() {
            modelCalls += 1
            throw new RuntimeTimeoutError('fake child exceeded 50ms and was killed')
          },
        },
        maxTurns: 1,
        claimExecutionMode: 'production_multi_worker',
        claimLeaseDurationMs: 5_000,
        retryBackoffMs: 100,
        now: () => fixedNow,
      })

      expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, staleLost: 0 })
      expect(modelCalls).toBe(1)
      const lifecycle = await fixture.db.query<{ event_type: string; event_id: string; claim_epoch: number }>(
        `SELECT event_type, event_id, claim_epoch FROM event_log
          WHERE turn_id=$1 AND event_type <> 'message.received' ORDER BY seq`,
        [received.event.turn_id],
      )
      expect(lifecycle.map(row => row.event_type)).toEqual([
        'turn.claimed',
        'turn.presented',
        'turn.attempt_failed',
        'turn.retry_scheduled',
        'turn.claim_released',
      ])
      const projection = await fixture.db.queryOne<{
        availability: string
        attempt_count: number
        available_at: Date
        claim_epoch: number
        fencing_token: string
      }>('SELECT * FROM event_log_turn_projection WHERE turn_id=$1', [received.event.turn_id])
      expect(projection?.availability).toBe('retry_wait')
      expect(Number(projection?.attempt_count)).toBe(1)
      expect(new Date(projection!.available_at).toISOString()).toBe(
        new Date(fixedNow.getTime() + 100).toISOString(),
      )
      expect(Number(projection?.claim_epoch)).toBe(0)
      expect(Number(projection?.fencing_token)).toBe(1)
      expect(Number((await fixture.db.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE turn_id=$1 AND event_type='turn.completed'`,
        [received.event.turn_id],
      ))?.n)).toBe(0)
      expect(Number((await fixture.db.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE turn_id=$1 AND event_type='reply.enqueued'`,
        [received.event.turn_id],
      ))?.n)).toBe(0)

      const early = await claimNextTurn(fixture.db, {
        seatId: 'arc', seatInstanceId: 'runtime-arc-early',
        executionMode: 'production_multi_worker', leaseDurationMs: 5_000,
      })
      expect(early).toBeNull()
      const waitMs = Math.max(0, new Date(projection!.available_at).getTime() - Date.now() + 25)
      await Bun.sleep(waitMs)
      const retryClaim = await claimNextTurn(fixture.db, {
        seatId: 'arc', seatInstanceId: 'runtime-arc-retry-1',
        executionMode: 'production_multi_worker', leaseDurationMs: 5_000,
      })
      expect(retryClaim?.claimEpoch).toBe(1)
      expect(retryClaim?.fencingToken).toBe(2)
    } finally {
      await fixture.cleanup()
    }
  })

  test('K2-TC-008 stale attempt mutations lose after a newer fence and one terminal wins', async () => {
    const fixture = await createFixture('stale_fence')
    try {
      const received = await receiveMessage(fixture.db, {
        messageId: 'stale-1', seatId: 'beta', conversationId: 'conversation-stale-1',
      })
      const stale = await claimNextTurn(fixture.db, {
        seatId: 'beta', seatInstanceId: 'runtime-beta-stale',
        executionMode: 'production_multi_worker', leaseDurationMs: 60,
      })
      expect(stale).not.toBeNull()
      await Bun.sleep(90)
      const current = await claimNextTurn(fixture.db, {
        seatId: 'beta', seatInstanceId: 'runtime-beta-current',
        executionMode: 'production_multi_worker', leaseDurationMs: 5_000,
      })
      expect(current?.claimEpoch).toBe(1)
      expect(current?.fencingToken).toBe(2)

      const staleAttempts = await Promise.allSettled([
        failTurnAttempt(fixture.db, {
          turnId: received.event.turn_id!, seatId: 'beta', seatInstanceId: 'runtime-beta-stale',
          claimEventId: stale!.claimEventId, claimEpoch: stale!.claimEpoch,
          fencingToken: stale!.fencingToken!, conversationId: 'conversation-stale-1',
          failureCode: 'RUNTIME_TIMEOUT', failureSummary: 'late stale timeout', retryable: true,
        }),
        failTurnAttempt(fixture.db, {
          turnId: received.event.turn_id!, seatId: 'beta', seatInstanceId: 'runtime-beta-foreign-stale',
          claimEventId: stale!.claimEventId, claimEpoch: stale!.claimEpoch,
          fencingToken: stale!.fencingToken!, conversationId: 'conversation-stale-1',
          failureCode: 'RUNTIME_EXIT_NONZERO', failureSummary: 'late foreign stale exit', retryable: true,
        }),
      ])
      expect(staleAttempts.filter(result => result.status === 'fulfilled')).toHaveLength(0)
      for (const result of staleAttempts) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StaleClaimError)
      }

      await completeTurn(fixture.db, {
        turnId: received.event.turn_id!, seatId: 'beta', seatInstanceId: 'runtime-beta-current',
        claimEventId: current!.claimEventId, fencingToken: current!.fencingToken,
        conversationId: 'conversation-stale-1', outcome: 'no_reply', replies: [],
      })
      expect(Number((await fixture.db.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE turn_id=$1 AND event_type='turn.attempt_failed'`,
        [received.event.turn_id],
      ))?.n)).toBe(0)
      expect(Number((await fixture.db.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE turn_id=$1 AND event_type='turn.completed'`,
        [received.event.turn_id],
      ))?.n)).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test('blocked and dead-lettered turns are terminal projection truth without turn.completed', async () => {
    const fixture = await createFixture('terminal_truth')
    try {
      const blockedReceive = await receiveMessage(fixture.db, { messageId: 'blocked-1', seatId: 'alpha' })
      const blockedClaim = await claimNextTurn(fixture.db, {
        seatId: 'alpha', seatInstanceId: 'runtime-alpha-blocked',
        executionMode: 'production_multi_worker', leaseDurationMs: 5_000,
      })
      await blockTurn(fixture.db, {
        turnId: blockedReceive.event.turn_id!, seatId: 'alpha', seatInstanceId: 'runtime-alpha-blocked',
        claimEventId: blockedClaim!.claimEventId, claimEpoch: blockedClaim!.claimEpoch,
        fencingToken: blockedClaim!.fencingToken!, reasonCode: 'OWNER_ACTION_REQUIRED',
        reasonSummary: 'deterministic fixture block',
      })

      const deadReceive = await receiveMessage(fixture.db, { messageId: 'dead-1', seatId: 'beta' })
      const deadClaim = await claimNextTurn(fixture.db, {
        seatId: 'beta', seatInstanceId: 'runtime-beta-dead',
        executionMode: 'production_multi_worker', leaseDurationMs: 5_000,
      })
      await deadLetterTurn(fixture.db, {
        turnId: deadReceive.event.turn_id!, seatId: 'beta', seatInstanceId: 'runtime-beta-dead',
        claimEventId: deadClaim!.claimEventId, claimEpoch: deadClaim!.claimEpoch,
        fencingToken: deadClaim!.fencingToken!, reasonCode: 'RETRY_BUDGET_EXHAUSTED',
        reasonSummary: 'deterministic fixture dead letter', attemptCount: 5,
      })
      const states = await fixture.db.query<{ turn_id: string; availability: string; terminal_reason: string; attempt_count: number }>(
        `SELECT turn_id, availability, terminal_reason, attempt_count
           FROM event_log_turn_projection WHERE turn_id IN ($1,$2) ORDER BY turn_id`,
        [blockedReceive.event.turn_id, deadReceive.event.turn_id],
      )
      expect(states.map(state => state.availability).sort()).toEqual(['blocked', 'dead_lettered'])
      expect(states.find(state => state.availability === 'blocked')?.terminal_reason).toBe('OWNER_ACTION_REQUIRED')
      expect(Number(states.find(state => state.availability === 'dead_lettered')?.attempt_count)).toBe(5)
      expect(Number((await fixture.db.queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM event_log
          WHERE turn_id IN ($1,$2) AND event_type='turn.completed'`,
        [blockedReceive.event.turn_id, deadReceive.event.turn_id],
      ))?.n)).toBe(0)
      expect(await claimNextTurn(fixture.db, {
        seatId: 'alpha', seatInstanceId: 'runtime-alpha-late',
        executionMode: 'production_multi_worker', leaseDurationMs: 5_000,
      })).toBeNull()
      expect(await claimNextTurn(fixture.db, {
        seatId: 'beta', seatInstanceId: 'runtime-beta-late',
        executionMode: 'production_multi_worker', leaseDurationMs: 5_000,
      })).toBeNull()
    } finally {
      await fixture.cleanup()
    }
  })
})
