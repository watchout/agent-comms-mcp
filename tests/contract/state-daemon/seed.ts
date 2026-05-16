/**
 * Per-fixture DB seed helpers. Tests target the same `agent_comms` dev DB but
 * scope their data to `agent_id LIKE 'sd-test-%'` and a known set of queue ids
 * inserted within the fixture, so they cannot collide with live fleet rows.
 *
 * For real isolation in CI, swap `DATABASE_URL` to a testcontainers / per-run
 * schema. The contract is: `cleanFixture` removes everything the fixture wrote.
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TEST_PREFIX = 'sd-test-'

export function makeAgentId(suffix: string): string {
  return `${TEST_PREFIX}${suffix}`
}

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const MIGRATION_FILES = [
  'db/migrations/2026-05-08-state-daemon-323.up.sql',
  'db/migrations/2026-05-14-agent-wake-suppression-ssot.up.sql',
]
let migrationApplied = false

/**
 * Apply the state-daemon migration once per test process. The CI workflow
 * runs `bun run db/migrate.ts` which only installs the inline core schema
 * (paired files under `db/migrations/` are operator-driven per the migrate.ts
 * comment, so the workflow never reaches them). The migration is idempotent
 * — every statement is guarded — so re-applying on a dev DB that already
 * has the schema from PR #329 is a no-op.
 */
async function ensureStateDaemonMigration(client: Client): Promise<void> {
  if (migrationApplied) return
  try {
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(join(REPO_ROOT, file), 'utf-8')
      await client.query(sql)
    }
    migrationApplied = true
  } catch (err) {
    // The migration file may not be present on a branch that has rebased
    // past it; keep the seed helper resilient so other branches can still
    // run unrelated DB tests.
    process.stderr.write(
      `[state-daemon test seed] migration apply skipped: ${(err as Error).message}\n`,
    )
  }
}

export async function openClient(): Promise<Client> {
  const url = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
  const c = new Client({ connectionString: url })
  await c.connect()
  // State-daemon contract files share the same fixture prefix on the same
  // Postgres database. Bun may run files in parallel, so serialize the suite
  // at the DB connection level before any file can clean another file's rows.
  await c.query(`SELECT pg_advisory_lock(hashtext('agent-comms-state-daemon-contract-tests'))`)
  await ensureStateDaemonMigration(c)
  return c
}

export async function cleanAll(c: Client): Promise<void> {
  await c.query(`DELETE FROM message_queue WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
  await c.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
}

export interface SeedAgent {
  agent_id: string
  runtime?: 'TUI' | 'SIG'
  tmux_session?: string | null
  status?: 'online' | 'offline' | 'idle' | 'busy' | 'restarting'
  last_seen_at?: Date | string
}

export async function seedAgent(c: Client, a: SeedAgent): Promise<void> {
  // tmux_session lives in metadata JSONB per spec v0.6 §7.1 (既存 column 不要、
  // metadata key で abstract). status / last_seen_at / runtime はそれぞれ既存 column.
  const metadata: Record<string, unknown> = {}
  if (a.tmux_session !== null) {
    metadata.tmux_session = a.tmux_session ?? `${a.agent_id}-session`
  }
  await c.query(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, last_seen_at,
        last_wake_attempt_at, channel_port, metadata)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, 0, $6::jsonb)
     ON CONFLICT (agent_id) DO UPDATE SET
       runtime = EXCLUDED.runtime,
       status = EXCLUDED.status,
       last_seen_at = EXCLUDED.last_seen_at,
       last_wake_attempt_at = NULL,
       metadata = EXCLUDED.metadata`,
    [
      a.agent_id,
      a.agent_id,
      a.runtime ?? 'TUI',
      a.status ?? 'online',
      a.last_seen_at ?? new Date(),
      JSON.stringify(metadata),
    ],
  )
}

export interface SeedQueueRow {
  agent_id: string
  status?: 'pending' | 'received' | 'in_progress' | 'replied' | 'skipped' | 'failed'
  message_id?: string | null
  payload?: string
  claim_expires_at?: Date | null
  claimed_by?: string | null
  claimed_at?: Date | null
  created_at?: Date
  last_wake_attempt_at?: Date | null
  last_heartbeat_at?: Date | null
}

export async function seedQueueRow(c: Client, r: SeedQueueRow): Promise<number> {
  const res = await c.query(
    `INSERT INTO message_queue
       (agent_id, status, message_id, payload, claim_expires_at,
        claimed_by, claimed_at, created_at, last_wake_attempt_at, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10)
     RETURNING id`,
    [
      r.agent_id,
      r.status ?? 'pending',
      r.message_id ?? null,
      r.payload ?? '{}',
      r.claim_expires_at ?? null,
      r.claimed_by ?? null,
      r.claimed_at ?? null,
      r.created_at ?? null,
      r.last_wake_attempt_at ?? null,
      r.last_heartbeat_at ?? null,
    ],
  )
  return Number((res.rows as Array<{ id: number }>)[0].id)
}
