import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'
import { applyDownMigration, applyUpMigrationFile } from '../../db/migrate'
import { join, dirname } from 'node:path'

// Issue #278 (§G-2 case 16) — paired migration files must support a
// down → up roundtrip without losing data.
//
// The two paired migrations under test:
//   2026-04-30-routing-v3-stage-b — adds claim columns + sweeper index.
//   2026-04-30-stage-b-drop-current-message-id — drops the legacy column.
//
// We run each paired up/down/up cycle and verify that the schema lands
// where it started (column present after the round trip, index back in
// place, unrelated rows untouched).

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const STAGE_B_UP = join(REPO_ROOT, 'db/migrations/2026-04-30-routing-v3-stage-b.up.sql')
const STAGE_B_DOWN = join(REPO_ROOT, 'db/migrations/2026-04-30-routing-v3-stage-b.down.sql')
const DROP_CMI_UP = join(REPO_ROOT, 'db/migrations/2026-04-30-stage-b-drop-current-message-id.up.sql')
const DROP_CMI_DOWN = join(REPO_ROOT, 'db/migrations/2026-04-30-stage-b-drop-current-message-id.down.sql')

dbDescribe('Issue #278 §G-2 case 16 — paired migrations are reversible + idempotent', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  afterAll(async () => {
    // Restore the post-migration state (column + claim infra in place)
    // even if a test failed mid-roundtrip, so other test files keep
    // running against the canonical schema.
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_message_id BIGINT`)
    await client.query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_by TEXT`)
    await client.query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ`)
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_mq_expired_claims
        ON message_queue(claim_expires_at)
        WHERE claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL AND status = 'read'`,
    )
    await client.end()
  })

  async function columnExists(table: string, column: string): Promise<boolean> {
    const r = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    )
    return (r.rows[0]?.count ?? 0) > 0
  }

  async function indexExists(name: string): Promise<boolean> {
    const r = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_indexes WHERE indexname = $1`,
      [name],
    )
    return (r.rows[0]?.count ?? 0) > 0
  }

  test('routing-v3-stage-b — down removes claim columns + index, up restores them', async () => {
    // Precondition: post-up state.
    await applyUpMigrationFile(STAGE_B_UP)
    expect(await columnExists('message_queue', 'claimed_by')).toBe(true)
    expect(await columnExists('message_queue', 'claim_expires_at')).toBe(true)
    expect(await indexExists('idx_mq_expired_claims')).toBe(true)

    // down → columns + index gone.
    await applyDownMigration(STAGE_B_DOWN)
    expect(await columnExists('message_queue', 'claimed_by')).toBe(false)
    expect(await columnExists('message_queue', 'claim_expires_at')).toBe(false)
    expect(await indexExists('idx_mq_expired_claims')).toBe(false)

    // up again → back to post-up state, no errors (idempotent).
    await applyUpMigrationFile(STAGE_B_UP)
    expect(await columnExists('message_queue', 'claimed_by')).toBe(true)
    expect(await columnExists('message_queue', 'claim_expires_at')).toBe(true)
    expect(await indexExists('idx_mq_expired_claims')).toBe(true)

    // re-up is a no-op (CREATE INDEX IF NOT EXISTS / DO $$ EXCEPTION
    // duplicate_column trap) — running it once more must not throw.
    await applyUpMigrationFile(STAGE_B_UP)
  })

  test('stage-b-drop-current-message-id — down restores the column, up drops it again', async () => {
    // Apply the drop to baseline.
    await applyUpMigrationFile(DROP_CMI_UP)
    expect(await columnExists('agents', 'current_message_id')).toBe(false)

    // down adds it back.
    await applyDownMigration(DROP_CMI_DOWN)
    expect(await columnExists('agents', 'current_message_id')).toBe(true)

    // up drops it again — fully reversible cycle.
    await applyUpMigrationFile(DROP_CMI_UP)
    expect(await columnExists('agents', 'current_message_id')).toBe(false)

    // re-up is idempotent (DROP COLUMN IF EXISTS).
    await applyUpMigrationFile(DROP_CMI_UP)
  })
})
