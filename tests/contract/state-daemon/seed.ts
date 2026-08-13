/**
 * Per-fixture DB seed helpers. Tests target the same `agent_comms` dev DB but
 * scope their data to `agent_id LIKE 'sd-test-%'` and a known set of queue ids
 * inserted within the fixture, so they cannot collide with live fleet rows.
 *
 * For real isolation in CI, swap `DATABASE_URL` to a testcontainers / per-run
 * schema. The contract is: `cleanFixture` removes everything the fixture wrote.
 */
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
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
  'db/migrations/2026-06-06-runtime-memory-ready-evidence.up.sql',
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
  await c.query(`DELETE FROM agent_messages WHERE channel_id LIKE $1`, [`${TEST_PREFIX}channel-%`])
  await c.query(`DELETE FROM channels WHERE id LIKE $1`, [`${TEST_PREFIX}channel-%`])
  await c.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
}

export interface SeedAgent {
  agent_id: string
  runtime?: 'TUI' | 'SIG' | 'codex' | 'codex-runner'
  runtime_engine_preference?: 'codex' | 'codex-runner' | 'claude-code' | null
  tmux_session?: string | null
  discord_id?: string | null
  port?: number | null
  status?: 'online' | 'offline' | 'idle' | 'busy' | 'restarting'
  last_seen_at?: Date | string
  runtime_instance_id?: string
  memoryReady?: boolean
}

function fixturePort(agentId: string): number {
  let hash = 0
  for (const ch of agentId) hash = (hash * 31 + ch.charCodeAt(0)) % 20_000
  return 20_000 + hash
}

export async function seedAgent(c: Client, a: SeedAgent): Promise<void> {
  // tmux_session lives in metadata JSONB per spec v0.6 §7.1 (既存 column 不要、
  // metadata key で abstract). status / last_seen_at / runtime はそれぞれ既存 column.
  const metadata: Record<string, unknown> = {}
  if (a.tmux_session !== null) {
    metadata.tmux_session = a.tmux_session ?? `${a.agent_id}-session`
  }
  if (a.discord_id) {
    metadata.discord_id = a.discord_id
  }
  const port = a.port === undefined ? fixturePort(a.agent_id) : a.port
  await c.query(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, last_seen_at,
        last_wake_attempt_at, channel_port, metadata, runtime_engine_preference,
        profile_enabled, disabled_at, home_directory)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, 0, $6::jsonb, $7, TRUE, NULL,
             '/tmp/agent-comms-mcp')
     ON CONFLICT (agent_id) DO UPDATE SET
       runtime = EXCLUDED.runtime,
       runtime_engine_preference = EXCLUDED.runtime_engine_preference,
       status = EXCLUDED.status,
       last_seen_at = EXCLUDED.last_seen_at,
       last_wake_attempt_at = NULL,
       metadata = EXCLUDED.metadata,
       profile_enabled = TRUE,
       disabled_at = NULL,
       home_directory = EXCLUDED.home_directory`,
    [
      a.agent_id,
      a.agent_id,
      a.runtime ?? 'TUI',
      a.status ?? 'online',
      a.last_seen_at ?? new Date(),
      JSON.stringify(metadata),
      a.runtime_engine_preference ?? null,
    ],
  )
  await c.query(`UPDATE agents SET channel_port=$2 WHERE agent_id=$1`, [a.agent_id, port])
  if (a.memoryReady === false || port === null) return

  const runtimeInstanceId = a.runtime_instance_id ?? randomUUID()
  const sessionName = a.tmux_session === null ? `${a.agent_id}-codex` : metadata.tmux_session as string
  const runtimeStartedAt = '2026-05-01T00:00:00.000Z'
  const completedAt = '2026-05-01T00:00:01.000Z'
  await c.query(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port,
        checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
     VALUES ($1, $2, $3, 'local_process', $4, $5,
             '/tmp/state-daemon-test-checkout', 'state-daemon-test-head', 'running',
             $6, $7, '{"source":"state-daemon-fixture"}'::jsonb)
     ON CONFLICT (runtime_instance_id) DO UPDATE SET
       agent_id=EXCLUDED.agent_id,
       runtime_engine=EXCLUDED.runtime_engine,
       session_name=EXCLUDED.session_name,
       port=EXCLUDED.port,
       status=EXCLUDED.status,
       last_seen_at=EXCLUDED.last_seen_at`,
    [
      runtimeInstanceId,
      a.agent_id,
      a.runtime_engine_preference ?? a.runtime ?? 'TUI',
      sessionName,
      port,
      runtimeStartedAt,
      a.last_seen_at ?? completedAt,
    ],
  )
  await c.query(
    `INSERT INTO runtime_memory_ready_evidence
       (agent_id, project, runtime_instance_id, profile_revision, profile_source,
        session_name, port, expected_agent_id, checkout_path, checkout_commit_sha,
        recovery_command, result_status, completed_at, evidence_path, evidence_log_id,
        valid_until, source, metadata)
     VALUES
       ($1, 'agent-comms-mcp', $2, 1, 'legacy',
        $3, $4, $1, '/tmp/state-daemon-test-checkout', 'state-daemon-test-head',
        'fixture:mcp__wasurezu__recover_context', 'ready', $5,
        '/tmp/state-daemon-memory-ready-fixture.json', 'fixture-memory-ready-log',
        '2099-01-01T00:00:00.000Z', 'agent_memory_boot_recovery',
        '{"fixture":true}'::jsonb)`,
    [a.agent_id, runtimeInstanceId, sessionName, port, completedAt],
  )
  const fixtureChannelId = `${TEST_PREFIX}channel-${a.agent_id}`
  await c.query(
    `INSERT INTO channels (id, name, type, members)
     VALUES ($1, $1, 'channel', ARRAY[$2]::text[])
     ON CONFLICT (id) DO UPDATE SET members=EXCLUDED.members`,
    [fixtureChannelId, a.agent_id],
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
  const messageIdExplicit = Object.prototype.hasOwnProperty.call(r, 'message_id')
  const messageId = messageIdExplicit ? r.message_id ?? null : randomUUID()
  if (messageId !== null) {
    const fixtureChannelId = `${TEST_PREFIX}channel-${r.agent_id}`
    await c.query(
      `INSERT INTO channels (id, name, type, members)
       VALUES ($1, $1, 'channel', ARRAY[$2]::text[])
       ON CONFLICT (id) DO UPDATE SET members=EXCLUDED.members`,
      [fixtureChannelId, r.agent_id],
    )
    await c.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source)
       VALUES ($1::uuid, $2, 'state-daemon-fixture', $3, 'instruction', 'state-daemon-fixture')
       ON CONFLICT (id) DO UPDATE SET channel_id=EXCLUDED.channel_id`,
      [messageId, fixtureChannelId, r.payload ?? 'state-daemon fixture work'],
    )
  }
  const res = await c.query(
    `INSERT INTO message_queue
       (agent_id, status, message_id, payload, claim_expires_at,
        claimed_by, claimed_at, created_at, last_wake_attempt_at, last_heartbeat_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10)
     RETURNING id`,
    [
      r.agent_id,
      r.status ?? 'pending',
      messageId,
      r.payload ?? JSON.stringify({ message_type: 'instruction', content: 'state-daemon fixture work' }),
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
