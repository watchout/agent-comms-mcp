import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { syncChannelPolicyConnectors } from '../core/channel-connector-sync'

async function withSyncDb<T>(fn: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-sync-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.prepare(
      `INSERT INTO agents (
         agent_id, display_name, agent_type, cli_type, status,
         provider_token_source_ref, expected_provider_identity, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'hotel-dev',
      'Hotel Dev',
      'dev',
      'TUI',
      'idle',
      'local-env:DISCORD_TOKEN_HOTEL_DEV',
      JSON.stringify({ provider: 'discord', subject_id: '123456789012345678' }),
      JSON.stringify({ discord_id: '123456789012345678' }),
    )
    seed.prepare("INSERT INTO agents (agent_id, display_name, agent_type, cli_type, status) VALUES (?, ?, ?, ?, ?)").run(
      'other-dev',
      'Other Dev',
      'dev',
      'TUI',
      'idle',
    )
    seed.prepare("INSERT INTO channels (id, name, members) VALUES (?, ?, ?)").run(
      'hotel-channel',
      'hotel-kanri',
      JSON.stringify(['hotel-dev', 'other-dev']),
    )
    seed.prepare("INSERT INTO channels (id, name, members) VALUES (?, ?, ?)").run(
      'empty-channel',
      'empty',
      JSON.stringify(['hotel-dev']),
    )
    seed.prepare("INSERT INTO channels (id, name, members) VALUES (?, ?, ?)").run(
      'hotel-secondary-channel',
      'hotel-secondary',
      JSON.stringify(['hotel-dev']),
    )
    seed.prepare(
      `INSERT INTO channel_routing_policy
         (channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist)
       VALUES (?, ?, ?, ?)`,
    ).run(
      'hotel-channel',
      'hotel-dev',
      'hotel-dev',
      JSON.stringify(['hotel-dev']),
    )
    seed.prepare(
      `INSERT INTO channel_routing_policy
         (channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist)
       VALUES (?, ?, ?, ?)`,
    ).run(
      'empty-channel',
      'hotel-dev',
      null,
      JSON.stringify(['hotel-dev']),
    )
    seed.prepare(
      `INSERT INTO channel_routing_policy
         (channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist)
       VALUES (?, ?, ?, ?)`,
    ).run(
      'hotel-secondary-channel',
      'hotel-dev',
      'hotel-dev',
      JSON.stringify(['hotel-dev']),
    )
    seed.close()

    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('channel connector sync', () => {
  test('dry-run plans connector and binding rows without mutating the DB', async () => {
    await withSyncDb(async (db) => {
      const report = await syncChannelPolicyConnectors(db, {
        dryRun: true,
        channel: 'hotel-kanri',
      })

      expect(report.dry_run).toBe(true)
      expect(report.planned).toHaveLength(1)
      expect(report.planned[0].connector_action).toBe('create')
      expect(report.planned[0].binding_action).toBe('create')

      const connectors = await db.query('SELECT * FROM connector_instances')
      const bindings = await db.query('SELECT * FROM channel_connector_bindings')
      expect(connectors).toHaveLength(0)
      expect(bindings).toHaveLength(0)
    })
  })

  test('execute creates connector and binding rows, then rerun reuses them', async () => {
    await withSyncDb(async (db) => {
      const first = await syncChannelPolicyConnectors(db, { dryRun: false })
      expect(first.created_connectors).toBe(1)
      expect(first.created_bindings).toBe(2)
      expect(first.skipped).toEqual([
        {
          channel_id: 'empty-channel',
          channel_name: 'empty',
          adapter_owner_agent_id: null,
          reason: 'no_adapter_owner',
        },
      ])

      const connector = await db.queryOne<any>(
        "SELECT * FROM connector_instances WHERE connector_uri = 'discord://agents/hotel-dev'",
      )
      expect(connector?.agent_id).toBe('hotel-dev')
      expect(connector?.status).toBe('active')

      const bindings = await db.query<any>(
        `SELECT b.*, c.agent_id
           FROM channel_connector_bindings b
           JOIN connector_instances c ON c.connector_instance_id = b.connector_instance_id
          WHERE b.channel_id IN ('hotel-channel', 'hotel-secondary-channel')
          ORDER BY b.channel_id`,
      )
      expect(bindings).toHaveLength(2)
      expect(new Set(bindings.map((binding) => binding.agent_id))).toEqual(new Set(['hotel-dev']))
      expect(new Set(bindings.map((binding) => binding.binding_role))).toEqual(new Set(['outbound']))
      expect(new Set(bindings.map((binding) => binding.ordering_scope))).toEqual(new Set(['thread']))

      const connectors = await db.query(
        "SELECT * FROM connector_instances WHERE connector_uri = 'discord://agents/hotel-dev'",
      )
      expect(connectors).toHaveLength(1)

      const second = await syncChannelPolicyConnectors(db, { dryRun: false, channel: 'hotel-channel' })
      expect(second.created_connectors).toBe(0)
      expect(second.created_bindings).toBe(0)
      expect(second.planned[0].connector_action).toBe('reuse')
      expect(second.planned[0].binding_action).toBe('reuse')
    })
  })

  test('multiple channels with the same owner reuse one planned connector during execute', async () => {
    await withSyncDb(async (db) => {
      const dryRun = await syncChannelPolicyConnectors(db, { dryRun: true })
      const hotelPlans = dryRun.planned.filter((item) => item.adapter_owner_agent_id === 'hotel-dev')
      expect(hotelPlans).toHaveLength(2)
      expect(hotelPlans.map((item) => item.connector_action)).toEqual(['create', 'reuse'])

      const report = await syncChannelPolicyConnectors(db, { dryRun: false })
      expect(report.created_connectors).toBe(1)
      expect(report.created_bindings).toBe(2)

      const connectors = await db.query(
        "SELECT * FROM connector_instances WHERE connector_uri = 'discord://agents/hotel-dev'",
      )
      const bindings = await db.query(
        `SELECT * FROM channel_connector_bindings
          WHERE channel_id IN ('hotel-channel', 'hotel-secondary-channel')
          ORDER BY channel_id`,
      )
      expect(connectors).toHaveLength(1)
      expect(bindings).toHaveLength(2)
    })
  })

  test('skips Discord adapter owners without token-backed evidence', async () => {
    await withSyncDb(async (db) => {
      await db.execute(
        `INSERT INTO channels (id, name, members)
         VALUES ('other-channel', 'other-kanri', $1)`,
        [JSON.stringify(['other-dev'])],
      )
      await db.execute(
        `INSERT INTO channel_routing_policy
           (channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist)
         VALUES ('other-channel', 'other-dev', 'other-dev', $1)`,
        [JSON.stringify(['other-dev'])],
      )

      const report = await syncChannelPolicyConnectors(db, {
        dryRun: false,
        channel: 'other-kanri',
      })
      expect(report.planned).toHaveLength(0)
      expect(report.skipped).toHaveLength(1)
      expect(report.skipped[0]).toMatchObject({
        channel_id: 'other-channel',
        channel_name: 'other-kanri',
        adapter_owner_agent_id: 'other-dev',
        reason: 'missing_token_evidence',
      })
      expect(report.skipped[0].details).toMatchObject({
        provider: 'discord',
        required: 'token-backed Discord connector evidence',
      })

      const connectors = await db.query(
        "SELECT * FROM connector_instances WHERE connector_uri = 'discord://agents/other-dev'",
      )
      const bindings = await db.query(
        `SELECT * FROM channel_connector_bindings
          WHERE channel_id = 'other-channel'
            AND provider = 'discord'
            AND binding_role = 'outbound'`,
      )
      expect(connectors).toHaveLength(0)
      expect(bindings).toHaveLength(0)
    })
  })

  test('active binding conflicts are reported without creating duplicate active bindings', async () => {
    await withSyncDb(async (db) => {
      await db.execute(
        `INSERT INTO connector_instances
           (agent_id, provider, connector_uri, status)
         VALUES ($1, 'discord', 'discord://agents/other-dev', 'active')`,
        ['other-dev'],
      )
      const connector = await db.queryOne<any>(
        "SELECT connector_instance_id FROM connector_instances WHERE connector_uri = 'discord://agents/other-dev'",
      )
      await db.execute(
        `INSERT INTO channel_connector_bindings
           (channel_id, provider, connector_instance_id, binding_role, status)
         VALUES ('hotel-channel', 'discord', $1, 'outbound', 'active')`,
        [connector.connector_instance_id],
      )

      const report = await syncChannelPolicyConnectors(db, {
        dryRun: false,
        channel: 'hotel-channel',
      })
      expect(report.planned).toHaveLength(0)
      expect(report.skipped[0].reason).toBe('active_binding_conflict')

      const bindings = await db.query(
        `SELECT * FROM channel_connector_bindings
          WHERE channel_id = 'hotel-channel'
            AND provider = 'discord'
            AND binding_role = 'outbound'
            AND status = 'active'`,
      )
      expect(bindings).toHaveLength(1)
    })
  })
})
