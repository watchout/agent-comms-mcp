import { expect, test } from 'bun:test'
import { activeTurnProjection, claimNextTurn, receiveMessage, recoverSeatClaims } from '../../core/eventlog'
import { createK1PostgresFixture, isK1PostgresFixtureEnabled } from './helpers/postgres-fixture'

test.skipIf(!isK1PostgresFixtureEnabled())('generic recovery never releases a live foreign instance by identity alone', async () => {
  const fixture = await createK1PostgresFixture('recovery_provenance')
  try {
    await receiveMessage(fixture.db, { messageId: 'recovery-1', seatId: 'beta' })
    const live = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'live-predecessor', executionMode: 'production_multi_worker', leaseDurationMs: 60_000,
    })
    expect(live).not.toBeNull()

    const recovered = await recoverSeatClaims(fixture.db, { seatId: 'beta', activeInstanceId: 'new-instance' })
    expect(recovered).toEqual([])
    const row = (await activeTurnProjection(fixture.db, { seatId: 'beta' }))[0]
    expect(row).toMatchObject({
      availability: 'claimed',
      claim_event_id: live!.claimEventId,
      claimed_by_instance: 'live-predecessor',
      fencing_token: live!.fencingToken,
    })
    const releaseCount = await fixture.db.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type='turn.claim_released'`,
    )
    expect(Number(releaseCount?.n)).toBe(0)
  } finally {
    await fixture.cleanup()
  }
})
