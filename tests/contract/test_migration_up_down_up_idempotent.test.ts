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
const UI_IDENTITY_UP = join(REPO_ROOT, 'db/migrations/2026-05-26-agent-ui-identity-binding.up.sql')
const UI_IDENTITY_DOWN = join(REPO_ROOT, 'db/migrations/2026-05-26-agent-ui-identity-binding.down.sql')
const AUDIT_IDENTITY_UP = join(REPO_ROOT, 'db/migrations/2026-07-14-audit-identity-canonicalization.up.sql')
const AUDIT_IDENTITY_DOWN = join(REPO_ROOT, 'db/migrations/2026-07-14-audit-identity-canonicalization.down.sql')

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
      await applyUpMigrationFile(UI_IDENTITY_UP)
      await applyUpMigrationFile(AUDIT_IDENTITY_UP)
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

  async function triggerExists(name: string): Promise<boolean> {
    const r = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = $1`,
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

    // The audit-identity migration is later in the stack and its triggers
    // depend on profile_enabled, so roll it back before exercising the older
    // bot-profile down migration.
    await applyDownMigration(AUDIT_IDENTITY_DOWN)
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
    await applyUpMigrationFile(AUDIT_IDENTITY_UP)
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

  test('agent-ui-identity-binding — down removes UI identity columns, up restores trigger defaults', async () => {
    await applyUpMigrationFile(BOT_PROFILE_UP)
    await applyUpMigrationFile(UI_IDENTITY_UP)
    expect(await columnExists('agents', 'ui_id')).toBe(true)
    expect(await columnExists('agents', 'ui_handle')).toBe(true)
    expect(await indexExists('uq_agents_ui_id_active')).toBe(true)
    expect(await indexExists('uq_agents_ui_handle_active')).toBe(true)

    await client.query(`DELETE FROM agents WHERE agent_id LIKE '__ui_identity_roundtrip_%'`)
    await client.query(
      `INSERT INTO agents (
         agent_id, display_name, agent_type, runtime,
         metadata, ui_id, ui_handle, profile_enabled
       )
       VALUES ($1, $1, 'dev', 'codex', $2::jsonb, NULL, '', true)`,
      ['__ui_identity_roundtrip_up__', JSON.stringify({ replaces: 'lead-ui-roundtrip' })],
    )
    const upRow = await client.query(
      `SELECT ui_id, ui_handle
         FROM agents
        WHERE agent_id = $1`,
      ['__ui_identity_roundtrip_up__'],
    )
    expect(Number(upRow.rows[0].ui_id)).toBeGreaterThan(0)
    expect(upRow.rows[0].ui_handle).toBe('lead-ui-roundtrip')

    await applyDownMigration(UI_IDENTITY_DOWN)
    expect(await columnExists('agents', 'ui_id')).toBe(false)
    expect(await columnExists('agents', 'ui_handle')).toBe(false)
    const downFunction = await client.query<{ body: string }>(
      `SELECT pg_get_functiondef('set_agent_identity_defaults()'::regprocedure) AS body`,
    )
    expect(downFunction.rows[0].body).not.toContain('ui_handle')

    await applyUpMigrationFile(UI_IDENTITY_UP)
    expect(await columnExists('agents', 'ui_id')).toBe(true)
    expect(await columnExists('agents', 'ui_handle')).toBe(true)
    const reUpFunction = await client.query<{ body: string }>(
      `SELECT pg_get_functiondef('set_agent_identity_defaults()'::regprocedure) AS body`,
    )
    expect(reUpFunction.rows[0].body).toContain('ui_handle')

    await client.query(`DELETE FROM agents WHERE agent_id LIKE '__ui_identity_roundtrip_%'`)
  })

  test('audit-identity-canonicalization — down removes fail-closed guards, up restores them', async () => {
    await applyUpMigrationFile(AUDIT_IDENTITY_UP)
    expect(await columnExists('agents', 'historical_only')).toBe(true)
    expect(await columnExists('agents', 'new_work_allowed')).toBe(true)
    expect(await columnExists('role_routing', 'active_function')).toBe(true)
    expect(await columnExists('role_routing', 'canonical_seat')).toBe(true)
    expect(await columnExists('role_routing', 'historical_only')).toBe(true)
    expect(await indexExists('idx_agents_routable')).toBe(true)
    expect(await indexExists('idx_role_routing_active_function')).toBe(true)
    expect(await triggerExists('trg_connector_instances_routable')).toBe(true)
    expect(await triggerExists('trg_agents_no_disable_with_active_dependencies')).toBe(true)

    const connectorId = '00000000-0000-4000-8000-000000127159'
    const bindingId = '00000000-0000-4000-8000-000000127160'
    const accessConnectorId = '00000000-0000-4000-8000-000000127178'
    const accessId = '00000000-0000-4000-8000-000000127179'
    const directAccessConnectorId = '00000000-0000-4000-8000-000000127180'
    const directAccessId = '00000000-0000-4000-8000-000000127181'
    await client.query(`DELETE FROM provider_channel_access WHERE provider_channel_access_id IN ($1::uuid, $2::uuid)`, [accessId, directAccessId])
    await client.query(`DELETE FROM channel_connector_bindings WHERE channel_binding_id = $1::uuid`, [bindingId])
    await client.query(`DELETE FROM connector_instances WHERE connector_instance_id IN ($1::uuid, $2::uuid, $3::uuid)`, [connectorId, accessConnectorId, directAccessConnectorId])
    await client.query(`DELETE FROM channels WHERE id = $1`, ['__audit_identity_binding_reassign__'])
    await client.query(`DELETE FROM agents WHERE agent_id IN ($1, $2, $3, $4, $5)`, [
      '__audit_identity_binding_owner__',
      '__audit_identity_disabled_owner__',
      '__audit_identity_access_owner__',
      '__audit_identity_direct_owner__',
      '__audit_identity_direct_access_agent__',
    ])
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, historical_only, new_work_allowed, profile_enabled)
       VALUES
         ($1, $1, 'dev', 'codex', 'idle', false, true, true),
         ($2, $2, 'dev', 'codex', 'disabled', true, false, false),
         ($3, $3, 'dev', 'codex', 'idle', false, true, true),
         ($4, $4, 'dev', 'codex', 'idle', false, true, true),
         ($5, $5, 'dev', 'codex', 'idle', false, true, true)`,
      [
        '__audit_identity_binding_owner__',
        '__audit_identity_disabled_owner__',
        '__audit_identity_access_owner__',
        '__audit_identity_direct_owner__',
        '__audit_identity_direct_access_agent__',
      ],
    )
    await client.query(
      `INSERT INTO channels (id, name, type, members)
       VALUES ($1, $1, 'channel', ARRAY[]::text[])`,
      ['__audit_identity_binding_reassign__'],
    )
    await client.query(
      `INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
       VALUES ($1::uuid, $2, 'discord', 'discord://agents/__audit_identity_binding_owner__', 'disabled')`,
      [connectorId, '__audit_identity_binding_owner__'],
    )
    await client.query(
      `INSERT INTO channel_connector_bindings (channel_binding_id, channel_id, provider, connector_instance_id, status)
       VALUES ($1::uuid, $2, 'discord', $3::uuid, 'active')`,
      [bindingId, '__audit_identity_binding_reassign__', connectorId],
    )
    await expect(client.query(
      `UPDATE connector_instances
          SET agent_id = $1
        WHERE connector_instance_id = $2::uuid`,
      ['__audit_identity_disabled_owner__', connectorId],
    )).rejects.toThrow('DISABLED_OR_HISTORICAL_AGENT_ACTIVE_CONNECTOR')
    await client.query(
      `INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
       VALUES ($1::uuid, $2, 'discord', 'discord://agents/__audit_identity_access_owner__', 'disabled')`,
      [accessConnectorId, '__audit_identity_access_owner__'],
    )
    await client.query(
      `INSERT INTO provider_channel_access (provider_channel_access_id, provider, provider_channel_id, connector_instance_id, agent_id, status)
       VALUES ($1::uuid, 'discord', 'access-channel-127178', $2::uuid, NULL, 'active')`,
      [accessId, accessConnectorId],
    )
    await expect(client.query(
      `UPDATE connector_instances
          SET agent_id = $1
        WHERE connector_instance_id = $2::uuid`,
      ['__audit_identity_disabled_owner__', accessConnectorId],
    )).rejects.toThrow('DISABLED_OR_HISTORICAL_AGENT_ACTIVE_CONNECTOR')
    expect((await client.query(
      `SELECT agent_id, status
         FROM connector_instances
        WHERE connector_instance_id = $1::uuid`,
      [accessConnectorId],
    )).rows[0]).toEqual({
      agent_id: '__audit_identity_access_owner__',
      status: 'disabled',
    })
    expect((await client.query(
      `SELECT agent_id, status
         FROM provider_channel_access
        WHERE provider_channel_access_id = $1::uuid`,
      [accessId],
    )).rows[0]).toEqual({
      agent_id: null,
      status: 'active',
    })
    await expect(client.query(
      `UPDATE agents
          SET historical_only = true,
              new_work_allowed = false,
              status = 'disabled'
        WHERE agent_id = $1`,
      ['__audit_identity_access_owner__'],
    )).rejects.toThrow('DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES')
    expect((await client.query(
      `SELECT status, historical_only, new_work_allowed
         FROM agents
        WHERE agent_id = $1`,
      ['__audit_identity_access_owner__'],
    )).rows[0]).toEqual({
      status: 'idle',
      historical_only: false,
      new_work_allowed: true,
    })
    await client.query(
      `INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
       VALUES ($1::uuid, $2, 'discord', 'discord://agents/__audit_identity_direct_owner__', 'disabled')`,
      [directAccessConnectorId, '__audit_identity_direct_owner__'],
    )
    await client.query(
      `INSERT INTO provider_channel_access (provider_channel_access_id, provider, provider_channel_id, connector_instance_id, agent_id, status)
       VALUES ($1::uuid, 'discord', 'direct-access-channel-127178', $2::uuid, $3, 'active')`,
      [directAccessId, directAccessConnectorId, '__audit_identity_direct_access_agent__'],
    )
    await client.query(
      `UPDATE agents
          SET historical_only = true,
              new_work_allowed = false,
              status = 'disabled'
        WHERE agent_id = $1`,
      ['__audit_identity_direct_owner__'],
    )
    expect((await client.query(
      `SELECT status, historical_only, new_work_allowed
         FROM agents
        WHERE agent_id = $1`,
      ['__audit_identity_direct_owner__'],
    )).rows[0]).toEqual({
      status: 'disabled',
      historical_only: true,
      new_work_allowed: false,
    })
    await expect(client.query(
      `UPDATE agents
          SET historical_only = true,
              new_work_allowed = false,
              status = 'disabled'
        WHERE agent_id = $1`,
      ['__audit_identity_direct_access_agent__'],
    )).rejects.toThrow('DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES')
    await client.query(`DELETE FROM provider_channel_access WHERE provider_channel_access_id IN ($1::uuid, $2::uuid)`, [accessId, directAccessId])
    await client.query(`DELETE FROM channel_connector_bindings WHERE channel_binding_id = $1::uuid`, [bindingId])
    await client.query(`DELETE FROM connector_instances WHERE connector_instance_id IN ($1::uuid, $2::uuid, $3::uuid)`, [connectorId, accessConnectorId, directAccessConnectorId])
    await client.query(`DELETE FROM channels WHERE id = $1`, ['__audit_identity_binding_reassign__'])
    await client.query(`DELETE FROM agents WHERE agent_id IN ($1, $2, $3, $4, $5)`, [
      '__audit_identity_binding_owner__',
      '__audit_identity_disabled_owner__',
      '__audit_identity_access_owner__',
      '__audit_identity_direct_owner__',
      '__audit_identity_direct_access_agent__',
    ])

    await applyDownMigration(AUDIT_IDENTITY_DOWN)
    expect(await columnExists('agents', 'historical_only')).toBe(false)
    expect(await columnExists('agents', 'new_work_allowed')).toBe(false)
    expect(await columnExists('role_routing', 'active_function')).toBe(false)
    expect(await columnExists('role_routing', 'canonical_seat')).toBe(false)
    expect(await columnExists('role_routing', 'historical_only')).toBe(false)
    expect(await indexExists('idx_agents_routable')).toBe(false)
    expect(await indexExists('idx_role_routing_active_function')).toBe(false)
    expect(await triggerExists('trg_connector_instances_routable')).toBe(false)
    expect(await triggerExists('trg_agents_no_disable_with_active_dependencies')).toBe(false)

    await applyUpMigrationFile(AUDIT_IDENTITY_UP)
    expect(await columnExists('agents', 'historical_only')).toBe(true)
    expect(await columnExists('agents', 'new_work_allowed')).toBe(true)
    expect(await columnExists('role_routing', 'active_function')).toBe(true)
    expect(await columnExists('role_routing', 'canonical_seat')).toBe(true)
    expect(await columnExists('role_routing', 'historical_only')).toBe(true)
    expect(await triggerExists('trg_connector_instances_routable')).toBe(true)
    expect(await triggerExists('trg_agents_no_disable_with_active_dependencies')).toBe(true)

    await applyUpMigrationFile(AUDIT_IDENTITY_UP)
  })
})
