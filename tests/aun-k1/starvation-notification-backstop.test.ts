import { expect, test } from 'bun:test'
import { claimNextTurn, receiveMessage } from '../../core/eventlog'
import { createK1PostgresFixture, isK1PostgresFixtureEnabled } from './helpers/postgres-fixture'

test.skipIf(!isK1PostgresFixtureEnabled())('database scan converges after notification loss and historic unrelated work cannot starve a seat', async () => {
  const fixture = await createK1PostgresFixture('starvation_backstop')
  try {
    for (let index = 0; index < 40; index += 1) {
      await receiveMessage(fixture.db, { messageId: `historic-${index}`, seatId: 'other-seat' })
    }
    await receiveMessage(fixture.db, { messageId: 'beta-live', seatId: 'beta', conversationId: 'live-c' })
    const live = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'live-worker', executionMode: 'production_multi_worker', leaseDurationMs: 60_000,
    })
    expect(live?.turn.message_id).toBe('beta-live')

    // No LISTEN/NOTIFY is emitted or consumed. The later durable row is found by the DB backstop scan.
    await receiveMessage(fixture.db, { messageId: 'beta-later', seatId: 'beta', conversationId: 'later-c' })
    const later = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'backstop-worker', executionMode: 'production_multi_worker', leaseDurationMs: 60_000,
    })
    expect(later?.turn.message_id).toBe('beta-later')
    expect(later?.turn.received_seq).toBeGreaterThan(live!.turn.received_seq)

    const committed = await fixture.db.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM event_log_turn_projection WHERE seat_id='beta'`,
    )
    expect(Number(committed?.n)).toBe(2)
  } finally {
    await fixture.cleanup()
  }
})
