import { expect, test } from 'bun:test'
import { claimNextTurn, completeTurn, receiveMessage, recoverSeatClaims, releaseClaim, StaleClaimError } from '../../core/eventlog'
import { createK1PostgresFixture, isK1PostgresFixtureEnabled } from './helpers/postgres-fixture'

test.skipIf(!isK1PostgresFixtureEnabled())('expired reclaim increments the fence and stale holder mutations are rejected', async () => {
  const fixture = await createK1PostgresFixture('lease_fence')
  try {
    await receiveMessage(fixture.db, { messageId: 'lease-1', seatId: 'beta' })
    const first = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'old-worker', executionMode: 'production_multi_worker', leaseDurationMs: 100,
    })
    expect(first).not.toBeNull()
    await fixture.db.query('SELECT pg_sleep(0.15)')

    const expired = await recoverSeatClaims(fixture.db, { seatId: 'beta', activeInstanceId: 'new-worker' })
    expect(expired).toHaveLength(1)
    const releasesBeforeReclaim = await fixture.db.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type='turn.claim_released'`,
    )
    expect(Number(releasesBeforeReclaim?.n)).toBe(0)

    const second = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'new-worker', executionMode: 'production_multi_worker', leaseDurationMs: 10_000,
    })
    expect(second?.claimEpoch).toBe(first!.claimEpoch + 1)
    expect(second?.fencingToken).toBe(first!.fencingToken! + 1)

    let staleRejected = 0
    try {
      await completeTurn(fixture.db, {
        turnId: first!.turn.turn_id, seatId: 'beta', seatInstanceId: 'old-worker',
        claimEventId: first!.claimEventId, fencingToken: first!.fencingToken, outcome: 'no_reply',
      })
    } catch (error) {
      expect(error).toBeInstanceOf(StaleClaimError)
      staleRejected += 1
    }
    try {
      await releaseClaim(fixture.db, {
        turnId: first!.turn.turn_id, claimEpoch: first!.claimEpoch, claimEventId: first!.claimEventId,
        seatId: 'beta', seatInstanceId: 'old-worker', fencingToken: first!.fencingToken, reason: 'stale-release',
      })
    } catch (error) {
      expect(error).toBeInstanceOf(StaleClaimError)
      staleRejected += 1
    }
    expect(staleRejected).toBe(2)

    await completeTurn(fixture.db, {
      turnId: second!.turn.turn_id, seatId: 'beta', seatInstanceId: 'new-worker',
      claimEventId: second!.claimEventId, fencingToken: second!.fencingToken, outcome: 'no_reply',
    })
    const terminal = await fixture.db.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type='turn.completed' AND turn_id=$1`,
      [second!.turn.turn_id],
    )
    expect(Number(terminal?.n)).toBe(1)
  } finally {
    await fixture.cleanup()
  }
})
