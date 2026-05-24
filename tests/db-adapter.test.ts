import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { migrateSqlite } from '../db/migrate-sqlite'
import { unlinkSync } from 'node:fs'

const TEST_DB = '/tmp/agent-com-test-adapter.db'

describe('SqliteAdapter', () => {
  let adapter: SqliteAdapter

  beforeAll(() => {
    try { unlinkSync(TEST_DB) } catch {}
    migrateSqlite(TEST_DB)
    adapter = new SqliteAdapter(TEST_DB)
  })

  afterAll(async () => {
    await adapter.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  it('query returns rows', async () => {
    const rows = await adapter.query('SELECT 1 as val')
    expect(rows).toHaveLength(1)
    expect(rows[0].val).toBe(1)
  })

  it('queryOne returns single row or null', async () => {
    const row = await adapter.queryOne('SELECT 1 as val')
    expect(row?.val).toBe(1)

    const none = await adapter.queryOne("SELECT 1 as val WHERE 1 = 0")
    expect(none).toBeNull()
  })

  it('execute returns rowCount', async () => {
    await adapter.execute(
      "INSERT INTO agents (agent_id, display_name, agent_type) VALUES (?, ?, ?)",
      ['test-bot', 'Test Bot', 'dev']
    )
    const result = await adapter.execute(
      "UPDATE agents SET status = ? WHERE agent_id = ?",
      ['idle', 'test-bot']
    )
    expect(result.rowCount).toBe(1)
  })

  it('transaction commits on success', async () => {
    await adapter.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO channels (id, name) VALUES (?, ?)",
        ['test-ch', 'Test Channel']
      )
    })
    const ch = await adapter.queryOne("SELECT * FROM channels WHERE id = ?", ['test-ch'])
    expect(ch?.name).toBe('Test Channel')
  })

  it('transaction rolls back on error', async () => {
    try {
      await adapter.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO channels (id, name) VALUES (?, ?)",
          ['rollback-ch', 'Rollback']
        )
        throw new Error('test rollback')
      })
    } catch {}
    const ch = await adapter.queryOne("SELECT * FROM channels WHERE id = ?", ['rollback-ch'])
    expect(ch).toBeNull()
  })

  it('$1 param conversion works', async () => {
    const rows = await adapter.query(
      "SELECT * FROM agents WHERE agent_id = $1",
      ['test-bot']
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe('test-bot')
  })

  it('NOW() conversion works', async () => {
    await adapter.execute(
      "INSERT INTO agents (agent_id, display_name, agent_type, created_at) VALUES ($1, $2, $3, NOW())",
      ['now-bot', 'Now Bot', 'dev']
    )
    const row = await adapter.queryOne("SELECT created_at FROM agents WHERE agent_id = $1", ['now-bot'])
    expect(row?.created_at).toBeTruthy()
  })

  it('message_queue INSERT + claim cycle works', async () => {
    await adapter.execute(
      `INSERT INTO message_queue (agent_id, message_id, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      ['test-bot', 'msg-001', '{"content":"hello"}']
    )

    const pending = await adapter.queryOne(
      `SELECT * FROM message_queue WHERE agent_id = $1 AND status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1`,
      ['test-bot']
    )
    expect(pending?.message_id).toBe('msg-001')

    await adapter.execute(
      "UPDATE message_queue SET status = 'read', read_at = datetime('now') WHERE id = $1",
      [pending!.id]
    )
    const read = await adapter.queryOne("SELECT status FROM message_queue WHERE id = $1", [pending!.id])
    expect(read?.status).toBe('read')
  })

  it('->> converts to json_extract', async () => {
    await adapter.execute(
      "INSERT INTO agent_messages (id, author_id, content, metadata) VALUES ($1, $2, $3, $4)",
      ['json-test-msg', 'test-bot', 'hello', '{"to":"cto","priority":"high"}']
    )
    const row = await adapter.queryOne(
      "SELECT * FROM agent_messages WHERE metadata->>'to' = $1",
      ['cto']
    )
    expect(row?.id).toBe('json-test-msg')
  })

  it('out-of-order $n params are correctly reordered', async () => {
    await adapter.execute(
      "INSERT INTO agents (agent_id, display_name, agent_type) VALUES ($1, $2, $3)",
      ['order-bot', 'Order Bot', 'dev']
    )
    const row = await adapter.queryOne(
      "SELECT * FROM agents WHERE agent_type = $2 AND agent_id = $1",
      ['order-bot', 'dev']
    )
    expect(row?.agent_id).toBe('order-bot')
  })

  it('repeated $n params work', async () => {
    const rows = await adapter.query(
      "SELECT * FROM agents WHERE agent_id = $1 OR display_name = $1",
      ['order-bot']
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  it('outbound_queue INSERT + claim works', async () => {
    await adapter.execute(
      `INSERT INTO outbound_queue (message_id, agent_id, channel_external_id, content)
       VALUES ($1, $2, $3, $4)`,
      ['msg-out-001', 'test-bot', '12345', 'hello discord']
    )

    const row = await adapter.queryOne(
      `SELECT * FROM outbound_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    )
    expect(row?.content).toBe('hello discord')
  })

  it('outbound_queue has ADR-060 projection identity evidence columns', async () => {
    const cols = await adapter.query("PRAGMA table_info(outbound_queue)")
    const names = cols.map((c: any) => c.name)
    expect(names).toContain('projection_identity_id')
    expect(names).toContain('intended_projection_identity_id')
    expect(names).toContain('projection_source')
    expect(names).toContain('projection_fallback_reason')
  })
})

describe('migrateSqlite', () => {
  const MIGRATE_DB = '/tmp/agent-com-test-migrate.db'

  afterAll(() => {
    try { unlinkSync(MIGRATE_DB) } catch {}
  })

  it('creates all tables idempotently', () => {
    migrateSqlite(MIGRATE_DB)
    migrateSqlite(MIGRATE_DB) // second run should not throw

    const db = new (require('bun:sqlite').Database)(MIGRATE_DB)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    const names = tables.map((t: any) => t.name)

    expect(names).toContain('agent_messages')
    expect(names).toContain('message_queue')
    expect(names).toContain('outbound_queue')
    expect(names).toContain('agents')
    expect(names).toContain('channels')
    expect(names).toContain('channel_routing_policy')
    expect(names).toContain('role_routing')
    expect(names).toContain('agent_aliases')
    expect(names).toContain('agent_workspaces')
    expect(names).toContain('agent_workspace_bindings')
    expect(names).toContain('agent_runtime_instances')
    expect(names).toContain('agent_endpoints')
    expect(names).toContain('agent_identity_keys')
    expect(names).toContain('connector_instances')
    expect(names).toContain('channel_connector_bindings')
    expect(names).toContain('control_plane_leases')
    expect(names).toContain('audit_log')
    expect(names).toContain('threads')
    db.close()
  })

  it('creates agent identity/runtime foundation columns', () => {
    migrateSqlite(MIGRATE_DB)

    const db = new (require('bun:sqlite').Database)(MIGRATE_DB)
    const cols = db.prepare("PRAGMA table_info(agents)").all()
    const names = cols.map((c: any) => c.name)

    expect(names).toContain('agent_uri')
    expect(names).toContain('identity_scope')
    expect(names).toContain('trust_status')
    expect(names).toContain('auth_method')
    expect(names).toContain('auth_subject')
    expect(names).toContain('disabled_at')
    expect(names).toContain('identity_metadata')

    db.prepare("INSERT INTO agents (agent_id, display_name, agent_type) VALUES (?, ?, ?)").run(
      'identity-foundation-bot',
      'Identity Foundation Bot',
      'dev',
    )
    const row = db.prepare("SELECT agent_uri, identity_scope, trust_status, auth_method FROM agents WHERE agent_id = ?")
      .get('identity-foundation-bot') as any
    expect(row.agent_uri).toBe('aun://default/agents/identity-foundation-bot')
    expect(row.identity_scope).toBe('local')
    expect(row.trust_status).toBe('local')
    expect(row.auth_method).toBe('local')

    db.close()
  })

  it('upgrades legacy agents tables without non-constant ALTER defaults', () => {
    const legacyPath = '/tmp/agent-com-test-legacy-agents.db'
    try { unlinkSync(legacyPath) } catch {}
    const legacy = new (require('bun:sqlite').Database)(legacyPath)
    legacy.exec(`
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        agent_type TEXT NOT NULL DEFAULT 'dev',
        cli_type TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    legacy.prepare(
      "INSERT INTO agents (agent_id, display_name, agent_type, cli_type, status) VALUES (?, ?, ?, ?, ?)",
    ).run('legacy-profile-bot', 'Legacy Profile Bot', 'dev', 'codex', 'idle')
    legacy.close()

    expect(() => migrateSqlite(legacyPath)).not.toThrow()

    const db = new (require('bun:sqlite').Database)(legacyPath)
    const cols = db.prepare("PRAGMA table_info(agents)").all()
    const names = cols.map((c: any) => c.name)
    expect(names).toContain('registered_at')
    expect(names).toContain('runtime')
    expect(names).toContain('home_directory')
    expect(names).toContain('provider_token_source_ref')

    const row = db.prepare(
      "SELECT runtime, registered_at, expected_provider_identity, profile_enabled, profile_source FROM agents WHERE agent_id = ?",
    ).get('legacy-profile-bot') as any
    expect(row.runtime).toBe('codex')
    expect(row.registered_at).not.toBeNull()
    expect(row.expected_provider_identity).toBe('{}')
    expect(row.profile_enabled).toBe(1)
    expect(row.profile_source).toBe('legacy')
    db.close()
    try { unlinkSync(legacyPath) } catch {}
  })

  it('generates SQLite foundation IDs and rejects NULL text primary keys', () => {
    migrateSqlite(MIGRATE_DB)

    const db = new (require('bun:sqlite').Database)(MIGRATE_DB)
    db.prepare("INSERT INTO agents (agent_id, display_name, agent_type) VALUES (?, ?, ?)").run(
      'sqlite-foundation-pk-bot',
      'SQLite Foundation PK Bot',
      'dev',
    )

    db.prepare("INSERT INTO agent_runtime_instances (agent_id) VALUES (?)").run('sqlite-foundation-pk-bot')
    db.prepare("INSERT INTO agent_runtime_instances (agent_id) VALUES (?)").run('sqlite-foundation-pk-bot')
    const runtimeIds = db.prepare("SELECT runtime_instance_id FROM agent_runtime_instances WHERE agent_id = ?")
      .all('sqlite-foundation-pk-bot')
      .map((row: any) => row.runtime_instance_id)
    expect(runtimeIds).toHaveLength(2)
    expect(runtimeIds.every((id: string | null) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(runtimeIds).size).toBe(2)

    db.prepare("INSERT INTO agent_endpoints (agent_id, endpoint_uri) VALUES (?, ?)").run(
      'sqlite-foundation-pk-bot',
      'local://sqlite-foundation-pk-bot/one',
    )
    db.prepare("INSERT INTO agent_endpoints (agent_id, endpoint_uri) VALUES (?, ?)").run(
      'sqlite-foundation-pk-bot',
      'local://sqlite-foundation-pk-bot/two',
    )
    const endpointIds = db.prepare("SELECT endpoint_id FROM agent_endpoints WHERE agent_id = ?")
      .all('sqlite-foundation-pk-bot')
      .map((row: any) => row.endpoint_id)
    expect(endpointIds).toHaveLength(2)
    expect(endpointIds.every((id: string | null) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(endpointIds).size).toBe(2)

    db.prepare("INSERT INTO agent_identity_keys (agent_id, public_key, fingerprint) VALUES (?, ?, ?)").run(
      'sqlite-foundation-pk-bot',
      'public-key-one',
      'fingerprint-one',
    )
    db.prepare("INSERT INTO agent_identity_keys (agent_id, public_key, fingerprint) VALUES (?, ?, ?)").run(
      'sqlite-foundation-pk-bot',
      'public-key-two',
      'fingerprint-two',
    )
    const keyIds = db.prepare("SELECT key_id FROM agent_identity_keys WHERE agent_id = ?")
      .all('sqlite-foundation-pk-bot')
      .map((row: any) => row.key_id)
    expect(keyIds).toHaveLength(2)
    expect(keyIds.every((id: string | null) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(keyIds).size).toBe(2)

    expect(() => db.prepare("INSERT INTO agent_workspaces (workspace_id, name) VALUES (NULL, ?)").run('bad')).toThrow()
    expect(() => db.prepare("INSERT INTO agent_runtime_instances (runtime_instance_id, agent_id) VALUES (NULL, ?)").run('sqlite-foundation-pk-bot')).toThrow()
    expect(() => db.prepare("INSERT INTO agent_endpoints (endpoint_id, agent_id, endpoint_uri) VALUES (NULL, ?, ?)").run('sqlite-foundation-pk-bot', 'local://bad')).toThrow()
    expect(() => db.prepare("INSERT INTO agent_identity_keys (key_id, agent_id, public_key, fingerprint) VALUES (NULL, ?, ?, ?)").run('sqlite-foundation-pk-bot', 'bad-key', 'bad-fingerprint')).toThrow()
    expect(() => db.prepare("INSERT INTO channel_routing_policy (channel_id) VALUES (NULL)").run()).toThrow()
    expect(() => db.prepare("INSERT INTO role_routing (role_key) VALUES (NULL)").run()).toThrow()
    expect(() => db.prepare("INSERT INTO agent_aliases (alias, canonical_agent_id) VALUES (NULL, ?)").run('sqlite-foundation-pk-bot')).toThrow()

    db.close()
  })

  it('creates distributed control plane tables and lease constraints', () => {
    migrateSqlite(MIGRATE_DB)

    const db = new (require('bun:sqlite').Database)(MIGRATE_DB)

    const mqCols = db.prepare("PRAGMA table_info(message_queue)").all()
    const mqNames = mqCols.map((c: any) => c.name)
    expect(mqNames).toContain('assigned_runtime_instance_id')
    expect(mqNames).toContain('claimed_runtime_instance_id')
    expect(mqNames).toContain('channel_binding_id')
    expect(mqNames).toContain('ordering_key')

    const oqCols = db.prepare("PRAGMA table_info(outbound_queue)").all()
    const oqNames = oqCols.map((c: any) => c.name)
    expect(oqNames).toContain('delivery_connector_instance_id')
    expect(oqNames).toContain('channel_binding_id')
    expect(oqNames).toContain('claimed_runtime_instance_id')

    db.prepare("INSERT INTO agents (agent_id, display_name, agent_type) VALUES (?, ?, ?)").run(
      'control-plane-bot',
      'Control Plane Bot',
      'dev',
    )
    db.prepare("INSERT INTO channels (id, name) VALUES (?, ?)").run(
      'control-plane-channel',
      'Control Plane Channel',
    )
    db.prepare("INSERT INTO agent_runtime_instances (agent_id, runtime_engine, status) VALUES (?, ?, ?)").run(
      'control-plane-bot',
      'codex',
      'active',
    )
    const runtime = db.prepare(
      "SELECT runtime_instance_id FROM agent_runtime_instances WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get('control-plane-bot') as any

    db.prepare(
      `INSERT INTO connector_instances
         (agent_id, runtime_instance_id, provider, connector_uri, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'control-plane-bot',
      runtime.runtime_instance_id,
      'discord',
      'discord://control-plane-bot',
      'active',
    )
    const connector = db.prepare(
      "SELECT connector_instance_id FROM connector_instances WHERE connector_uri = ?",
    ).get('discord://control-plane-bot') as any
    expect(typeof connector.connector_instance_id).toBe('string')
    expect(connector.connector_instance_id.length).toBeGreaterThan(0)

    db.prepare(
      `INSERT INTO channel_connector_bindings
         (channel_id, provider, connector_instance_id, binding_role, ordering_scope)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'control-plane-channel',
      'discord',
      connector.connector_instance_id,
      'outbound',
      'thread',
    )
    const binding = db.prepare(
      "SELECT channel_binding_id FROM channel_connector_bindings WHERE channel_id = ?",
    ).get('control-plane-channel') as any
    expect(typeof binding.channel_binding_id).toBe('string')
    expect(binding.channel_binding_id.length).toBeGreaterThan(0)

    db.prepare(
      `INSERT INTO control_plane_leases
         (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id,
          holder_runtime_instance_id, holder_connector_instance_id, fencing_token, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run(
      'channel_binding',
      binding.channel_binding_id,
      'outbound',
      'control-plane-bot',
      runtime.runtime_instance_id,
      connector.connector_instance_id,
      1,
    )
    expect(() => db.prepare(
      `INSERT INTO control_plane_leases
         (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id, fencing_token, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run(
      'channel_binding',
      binding.channel_binding_id,
      'outbound',
      'control-plane-bot',
      2,
    )).toThrow()

    db.prepare(
      "UPDATE control_plane_leases SET status = 'released', released_at = datetime('now') WHERE lease_scope_id = ?",
    ).run(binding.channel_binding_id)
    db.prepare(
      `INSERT INTO control_plane_leases
         (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id, fencing_token, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run(
      'channel_binding',
      binding.channel_binding_id,
      'outbound',
      'control-plane-bot',
      3,
    )

    db.prepare(
      `INSERT INTO message_queue
         (agent_id, message_id, payload, assigned_runtime_instance_id, channel_binding_id, ordering_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'control-plane-bot',
      'control-plane-message',
      '{"content":"hello"}',
      runtime.runtime_instance_id,
      binding.channel_binding_id,
      'thread:alpha',
    )
    db.prepare(
      `INSERT INTO outbound_queue
         (message_id, agent_id, channel_external_id, content, delivery_connector_instance_id,
          channel_binding_id, claimed_runtime_instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'control-plane-message',
      'control-plane-bot',
      '123',
      'hello',
      connector.connector_instance_id,
      binding.channel_binding_id,
      runtime.runtime_instance_id,
    )

    expect(() => db.prepare(
      "INSERT INTO connector_instances (connector_instance_id, agent_id) VALUES (NULL, ?)",
    ).run('control-plane-bot')).toThrow()
    expect(() => db.prepare(
      "INSERT INTO channel_connector_bindings (channel_binding_id, channel_id) VALUES (NULL, ?)",
    ).run('control-plane-channel')).toThrow()
    expect(() => db.prepare(
      `INSERT INTO control_plane_leases
         (lease_id, lease_scope_type, lease_scope_id, fencing_token, expires_at)
       VALUES (NULL, ?, ?, ?, datetime('now', '+30 seconds'))`,
    ).run('channel_binding', binding.channel_binding_id, 4)).toThrow()

    db.close()
  })
})
