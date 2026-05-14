#!/usr/bin/env bun
/**
 * Guardrail 4 (FEAT-005 CP-6): db/migrate.ts is safe to re-run.
 *
 * Re-running the migration after a successful first run must be a
 * no-op (no errors, no row changes, no CHECK violations). This
 * matters because:
 *   - CI runs `bun run db/migrate.ts` on every PR even when no
 *     schema changes landed.
 *   - Post-merge runbook re-applies the CP-3 vocabulary rename
 *     block; the UPDATE must match zero rows because the state is
 *     already 'claimed'.
 *   - Future hotfix migrations appended to the same file will run
 *     alongside the CP-3 block on every invocation.
 *
 * The test shells out to `bun run db/migrate.ts` twice and asserts
 * both runs exit 0. A schema-shape snapshot around the invocations
 * proves nothing silently drifted.
 *
 * Skipped automatically when no DATABASE_URL is reachable (CI / dev
 * without Postgres). Never seeds rows, so it does not pollute the
 * outbound_queue fixture space.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'

let client: Client | null = null
let available = false

beforeAll(async () => {
  try {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await client.query('SELECT 1')
    available = true
  } catch {
    available = false
  }
})

afterAll(async () => {
  if (client) await client.end().catch(() => {})
})

function runMigrate(): { exitCode: number; stderr: string } {
  const r = spawnSync('bun', ['run', 'db/migrate.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf-8',
  })
  return { exitCode: r.status ?? -1, stderr: r.stderr ?? '' }
}

async function snapshotOutboundQueueCheck(): Promise<string> {
  const { rows } = await client!.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'outbound_queue'::regclass
        AND conname  = 'outbound_queue_status_check'`,
  )
  return rows[0]?.def ?? ''
}

async function snapshotIndexes(): Promise<string[]> {
  const { rows } = await client!.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'outbound_queue'
      ORDER BY indexname`,
  )
  return rows.map((r: any) => r.indexname)
}

// Pre-existing latent fail (predates this PR's v0.9 vocab-follow
// scope, schema drift origin not in 8-file Interface contract).
// Deferred to Issue #338 sub-PR 9 (latent fail investigation).
describe('migration idempotency (guardrail 4)', () => {
  test('second run of db/migrate.ts exits 0 with no schema drift', async () => {
    if (!available) {
      console.log('skip: no DATABASE_URL reachable')
      return
    }

    // First run (may be a no-op if CI already ran migrate earlier in
    // the job; either way it should exit 0).
    const first = runMigrate()
    expect(first.exitCode).toBe(0)

    const checkBefore = await snapshotOutboundQueueCheck()
    const indexesBefore = await snapshotIndexes()

    // Second run — must be a pure no-op.
    const second = runMigrate()
    expect(second.exitCode).toBe(0)

    const checkAfter = await snapshotOutboundQueueCheck()
    const indexesAfter = await snapshotIndexes()

    // CHECK definition stable.
    expect(checkAfter).toBe(checkBefore)
    // Index set stable (no DROP + CREATE changing the oid is fine,
    // we only care that the name set matches).
    expect(indexesAfter).toEqual(indexesBefore)

    // The post-CP-3 state must actually be present (sanity — if it
    // weren't, idempotency above would still hold but the migration
    // is silently broken).
    expect(checkAfter).toContain("'claimed'")
    expect(indexesAfter).toContain('idx_outbound_queue_claimed_claimed_at')
  })
})
