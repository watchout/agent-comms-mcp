import { expect, test } from 'bun:test'
import { receiveMessage } from '../../core/eventlog'
import { createK1PostgresFixture } from './helpers/postgres-fixture'

test('K1 migration up/down/up is reversible and repeated up is idempotent', async () => {
  const fixture = await createK1PostgresFixture('migration_roundtrip')
  try {
    await receiveMessage(fixture.db, { messageId: 'migration-1', seatId: 'beta' })
    expect(Number((await fixture.db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM event_log_turn_projection'))?.n)).toBe(1)

    await fixture.migrate('down')
    const absent = await fixture.db.queryOne<{ present: string | null }>(
      `SELECT to_regclass(current_schema() || '.event_log_turn_projection')::text AS present`,
    )
    expect(absent?.present).toBeNull()

    await fixture.migrate('up')
    expect(Number((await fixture.db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM event_log_turn_projection'))?.n)).toBe(1)
    await fixture.migrate('up')
    expect(Number((await fixture.db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM event_log_turn_projection'))?.n)).toBe(1)

    await fixture.migrate('down')
    await fixture.migrate('up')
    expect(Number((await fixture.db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM event_log_turn_projection'))?.n)).toBe(1)
  } finally {
    await fixture.cleanup()
  }
})
