import { expect, test } from 'bun:test'
import { claimNextTurn, receiveMessage, UnsupportedClaimCapabilityError } from '../../core/eventlog'
import { createK1SqliteFixture } from './helpers/sqlite-fixture'

test('SQLite fails closed before production multi-worker claim mutation', async () => {
  const fixture = await createK1SqliteFixture('capability')
  try {
    await receiveMessage(fixture.db, { messageId: 'sqlite-1', seatId: 'beta' })
    const before = Number((await fixture.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM event_log'))?.n)
    await expect(claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'sqlite-production', executionMode: 'production_multi_worker',
    })).rejects.toBeInstanceOf(UnsupportedClaimCapabilityError)
    const after = Number((await fixture.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM event_log'))?.n)
    expect(after).toBe(before)
    expect(fixture.db.claimCapabilities.productionMultiWorker).toBe(false)

    const unit = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'sqlite-unit', executionMode: 'unit_conformance',
    })
    expect(unit?.turn.message_id).toBe('sqlite-1')
  } finally {
    await fixture.cleanup()
  }
})
