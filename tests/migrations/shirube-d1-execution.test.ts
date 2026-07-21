import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../../db/migrate-sqlite'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('Shirube D1 execution migration', () => {
  test('SQLite up is repeat-safe and creates the immutable authority and receipt columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shirube-d1-migration-'))
    dirs.push(dir)
    const path = join(dir, 'agent-com.db')
    migrateSqlite(path)
    migrateSqlite(path)
    const db = new SqliteAdapter(path)
    try {
      const claims = await db.query<{ name: string }>('PRAGMA table_info(shirube_d1_claims)')
      const invocations = await db.query<{ name: string }>('PRAGMA table_info(shirube_d1_invocations)')
      expect(claims.map((column) => column.name)).toEqual(expect.arrayContaining([
        'control_source', 'exact_base_sha', 'allowed_paths_digest', 'created_at', 'updated_at',
      ]))
      expect(invocations.map((column) => column.name)).toEqual(expect.arrayContaining([
        'reserved_at', 'completed_at', 'internal_reply_receipt', 'github_writeback_receipt', 'external_send_receipt',
      ]))
    } finally {
      await db.close()
    }
  })

  test('PostgreSQL down migration refuses to erase nonempty durable receipts', () => {
    const sql = readFileSync(join(import.meta.dir, '../../db/migrations/2026-07-21-shirube-d1-execution.down.sql'), 'utf8')
    expect(sql).toContain('IF EXISTS (SELECT 1 FROM shirube_d1_effect_deliveries LIMIT 1)')
    expect(sql).toContain('RAISE EXCEPTION')
    expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(sql.indexOf('DROP TABLE'))
  })
})
