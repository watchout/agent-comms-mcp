import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../../core/db/sqlite-adapter'
import { ensureEventLogSchema } from '../../../core/eventlog/schema'

export async function createK1SqliteFixture(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `aun-k1-${label}-`))
  const db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
  return {
    db,
    async cleanup() {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
