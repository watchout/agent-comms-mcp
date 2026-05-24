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
const BOT_PROFILE_UP = join(REPO_ROOT, 'db/migrations/2026-05-25-bot-profile-ssot.up.sql')
const BOT_PROFILE_DOWN = join(REPO_ROOT, 'db/migrations/2026-05-25-bot-profile-ssot.down.sql')

// PR #340 (incident #339): the destructive-migration gate in
// db/migrate.ts rejects DROP COLUMN / TRUNCATE / etc. unless
// AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1 is set. The migrations under
// test in this suite are intentionally destructive (that is the whole point
// of the round-trip), so we opt the suite in to the gate. We restore the
// prior env state on teardown to avoid polluting unrelated tests.
const DESTRUCTIVE_GATE_ENV = 'AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED'

dbDescribe('Issue #278 §G-2 case 16 — paired migrations are reversible + idempotent', () => {
  let client: Client
  let priorDestructiveGate: string | undefined

  beforeAll(async () => {
    priorDestructiveGate = process.env[DESTRUCTIVE_GATE_ENV]
    process.env[DESTRUCTIVE_GATE_ENV] = '1'
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

    // Issue #323 cycle 7 — restore the state-daemon trigger that the
    // routing-v3-stage-b down.sql now drops as a prelude (so the down
    // path could safely remove claim_expires_at without leaving a
    // dangling trigger reference). m4-entry-smoke and any subsequent
    // test that asserts the trigger is installed depends on this. The
    // function and trigger are CREATE OR REPLACE / DROP IF EXISTS +
    // CREATE so re-running on a DB that already has them is a no-op.
    await client.query(`
      CREATE OR REPLACE FUNCTION notify_queue_event() RETURNS trigger AS $func$
      BEGIN
        PERFORM pg_notify('queue_event', json_build_object(
          'op', TG_OP,
          'id', NEW.id,
          'agent_id', NEW.agent_id,
          'status', NEW.status,
          'claim_expires_at', NEW.claim_expires_at
        )::text);
        RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql;
    `)
    await client.query(`DROP TRIGGER IF EXISTS message_queue_notify ON message_queue`)
    await client.query(`
      CREATE TRIGGER message_queue_notify
        AFTER INSERT OR UPDATE OF status, claim_expires_at ON message_queue
        FOR EACH ROW EXECUTE FUNCTION notify_queue_event()
    `)
    try {
      await applyUpMigrationFile(BOT_PROFILE_UP)
    } catch {}

    await client.end()
    if (priorDestructiveGate === undefined) {
      delete process.env[DESTRUCTIVE_GATE_ENV]
    } else {
      process.env[DESTRUCTIVE_GATE_ENV] = priorDestructiveGate
    }
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

  test('bot-profile-ssot — down restores trigger body, up re-adds profile defaults', async () => {
    await applyUpMigrationFile(BOT_PROFILE_UP)
    expect(await columnExists('agents', 'home_directory')).toBe(true)
    expect(await columnExists('agents', 'expected_provider_identity')).toBe(true)

    await client.query(`DELETE FROM agents WHERE agent_id LIKE '__norm021_roundtrip_%'`)
    await client.query(
      `INSERT INTO agents (
         agent_id, display_name, agent_type, runtime,
         expected_provider_identity, profile_enabled, profile_revision, profile_source
       )
       VALUES ($1, $1, 'dev', 'codex', NULL, NULL, NULL, '')`,
      ['__norm021_roundtrip_up__'],
    )
    const upRow = await client.query(
      `SELECT expected_provider_identity, profile_enabled, profile_revision, profile_source
         FROM agents
        WHERE agent_id = $1`,
      ['__norm021_roundtrip_up__'],
    )
    expect(upRow.rows[0].expected_provider_identity).toEqual({})
    expect(upRow.rows[0].profile_enabled).toBe(true)
    expect(upRow.rows[0].profile_revision).toBe(1)
    expect(upRow.rows[0].profile_source).toBe('legacy')

    await applyDownMigration(BOT_PROFILE_DOWN)
    expect(await columnExists('agents', 'home_directory')).toBe(false)
    expect(await columnExists('agents', 'expected_provider_identity')).toBe(false)
    const downFunction = await client.query<{ body: string }>(
      `SELECT pg_get_functiondef('set_agent_identity_defaults()'::regprocedure) AS body`,
    )
    expect(downFunction.rows[0].body).not.toContain('expected_provider_identity')
    expect(downFunction.rows[0].body).not.toContain('profile_enabled')

    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime)
       VALUES ($1, $1, 'dev', 'codex')`,
      ['__norm021_roundtrip_down__'],
    )

    await applyUpMigrationFile(BOT_PROFILE_UP)
    expect(await columnExists('agents', 'home_directory')).toBe(true)
    expect(await columnExists('agents', 'expected_provider_identity')).toBe(true)
    const reUpFunction = await client.query<{ body: string }>(
      `SELECT pg_get_functiondef('set_agent_identity_defaults()'::regprocedure) AS body`,
    )
    expect(reUpFunction.rows[0].body).toContain('expected_provider_identity')
    expect(reUpFunction.rows[0].body).toContain('profile_enabled')

    await client.query(
      `INSERT INTO agents (
         agent_id, display_name, agent_type, runtime,
         expected_provider_identity, profile_enabled, profile_revision, profile_source
       )
       VALUES ($1, $1, 'dev', 'codex', NULL, NULL, 0, '')`,
      ['__norm021_roundtrip_reup__'],
    )
    const reUpRow = await client.query(
      `SELECT expected_provider_identity, profile_enabled, profile_revision, profile_source
         FROM agents
        WHERE agent_id = $1`,
      ['__norm021_roundtrip_reup__'],
    )
    expect(reUpRow.rows[0].expected_provider_identity).toEqual({})
    expect(reUpRow.rows[0].profile_enabled).toBe(true)
    expect(reUpRow.rows[0].profile_revision).toBe(1)
    expect(reUpRow.rows[0].profile_source).toBe('legacy')

    await client.query(`DELETE FROM agents WHERE agent_id LIKE '__norm021_roundtrip_%'`)
  })
})
