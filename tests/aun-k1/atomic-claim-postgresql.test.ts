import { expect, test } from 'bun:test'
import { claimNextTurn, completeTurn, receiveMessage } from '../../core/eventlog'
import { createK1PostgresFixture } from './helpers/postgres-fixture'

test('PostgreSQL SKIP LOCKED claim commits one winner and one completion', async () => {
  const fixture = await createK1PostgresFixture('atomic_claim')
  const workerA = await fixture.connect()
  const workerB = await fixture.connect()
  try {
    await receiveMessage(fixture.db, { messageId: 'atomic-1', seatId: 'beta', conversationId: 'atomic-c1' })
    const results = await Promise.all([
      claimNextTurn(workerA, {
        seatId: 'beta', seatInstanceId: 'worker-a', executionMode: 'production_multi_worker', leaseDurationMs: 10_000,
      }),
      claimNextTurn(workerB, {
        seatId: 'beta', seatInstanceId: 'worker-b', executionMode: 'production_multi_worker', leaseDurationMs: 10_000,
      }),
    ])
    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    const winner = winners[0]!
    expect(winner.claimEpoch).toBe(0)
    expect(winner.fencingToken).toBe(1)

    const projection = await fixture.db.queryOne<any>(
      `SELECT availability, claim_event_id, claim_epoch, fencing_token, claimed_by_instance
         FROM event_log_turn_projection WHERE turn_id=$1`,
      [winner.turn.turn_id],
    )
    expect(projection).toMatchObject({
      availability: 'claimed',
      claim_event_id: winner.claimEventId,
      claimed_by_instance: winner.claimEventId === results[0]?.claimEventId ? 'worker-a' : 'worker-b',
    })
    expect(Number(projection.claim_epoch)).toBe(0)
    expect(Number(projection.fencing_token)).toBe(1)

    const owner = winner.claimEventId === results[0]?.claimEventId ? 'worker-a' : 'worker-b'
    const ownerDb = owner === 'worker-a' ? workerA : workerB
    await completeTurn(ownerDb, {
      turnId: winner.turn.turn_id,
      seatId: 'beta',
      seatInstanceId: owner,
      claimEventId: winner.claimEventId,
      fencingToken: winner.fencingToken,
      outcome: 'no_reply',
    })
    const counts = await fixture.db.queryOne<{ claims: string; completions: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE event_type='turn.claimed') AS claims,
         COUNT(*) FILTER (WHERE event_type='turn.completed') AS completions
       FROM event_log WHERE turn_id=$1`,
      [winner.turn.turn_id],
    )
    expect(Number(counts?.claims)).toBe(1)
    expect(Number(counts?.completions)).toBe(1)
  } finally {
    await workerA.close()
    await workerB.close()
    await fixture.cleanup()
  }
})
