import { expect, test } from 'bun:test'
import { activeTurnProjection, claimNextTurn, completeTurn, receiveMessage, rebuildActiveTurnProjection } from '../../core/eventlog'
import { canonicalJson } from '../../core/eventlog/transport-contract'
import { createK1PostgresFixture } from './helpers/postgres-fixture'

test('incremental active projection is indexed and byte-identical after replay rebuild', async () => {
  const fixture = await createK1PostgresFixture('projection_replay')
  try {
    await receiveMessage(fixture.db, { messageId: 'p1', seatId: 'beta', conversationId: 'c1', payload: { priority: 7 } })
    await receiveMessage(fixture.db, { messageId: 'p2', seatId: 'beta', conversationId: 'c2', payload: { priority: 2 } })
    await receiveMessage(fixture.db, { messageId: 'p3', seatId: 'gamma', conversationId: 'c3' })
    const claimed = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'projection-worker', executionMode: 'production_multi_worker', leaseDurationMs: 10_000,
    })
    expect(claimed?.turn.message_id).toBe('p1')
    await completeTurn(fixture.db, {
      turnId: claimed!.turn.turn_id, seatId: 'beta', seatInstanceId: 'projection-worker',
      claimEventId: claimed!.claimEventId, fencingToken: claimed!.fencingToken, outcome: 'no_reply',
    })

    const incremental = canonicalJson(await activeTurnProjection(fixture.db))
    const rebuilt = canonicalJson(await rebuildActiveTurnProjection(fixture.db))
    expect(rebuilt).toBe(incremental)

    const indexes = await fixture.db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname=current_schema() AND tablename='event_log_turn_projection'
        ORDER BY indexname`,
    )
    expect(indexes.map(row => row.indexname)).toEqual(expect.arrayContaining([
      'idx_el_turn_projection_claimable',
      'idx_el_turn_projection_expired',
      'idx_el_turn_projection_conversation',
    ]))
    expect(fixture.db.claimCapabilities).toEqual({
      productionMultiWorker: true,
      skipLocked: true,
      transactionLeaseClock: true,
    })
  } finally {
    await fixture.cleanup()
  }
})
