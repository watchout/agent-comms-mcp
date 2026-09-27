import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { notifySenderOfDeliveryStatus } from '../core/sender-feedback'

let directory: string
let adapter: SqliteAdapter
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'sender-feedback-'))
  const path = join(directory, 'fixture.db')
  migrateSqlite(path)
  adapter = new SqliteAdapter(path)
  for (const id of ['sender', 'recipient']) {
    await adapter.execute("INSERT INTO agents(agent_id,display_name,agent_type) VALUES($1,$1,'dev')", [id])
  }
})
afterEach(async () => {
  await adapter.close()
  rmSync(directory, { recursive: true, force: true })
})

for (const expired of [false, true]) {
  test(`SQLite ${expired ? 'expired' : 'active'} ISO claim uses the database clock`, async () => {
    await adapter.execute(`INSERT INTO message_queue(agent_id,payload,status,claimed_by,claim_expires_at)
      VALUES('recipient','{}','in_progress','recipient',$1)`,
    [new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString()])
    const result = await notifySenderOfDeliveryStatus({
      async query<T>(sql: string, params?: any[]) { return { rows: await adapter.query<T>(sql, params) } },
    }, {
      senderId: 'sender', targetId: 'recipient',
      inspect: () => ({ observations: [], reasonCode: 'NO_LIVE_RUNTIME' }),
    })
    expect(result).toEqual(expired ? { emitted: 'system_error' } : { emitted: 'system_info', reason: 'queue-skip' })
    expect(await adapter.query("SELECT id FROM message_queue WHERE agent_id='sender'")).toHaveLength(expired ? 1 : 0)
    expect((await adapter.queryOne("SELECT status FROM agents WHERE agent_id='recipient'"))?.status).toBeNull()
  })
}
