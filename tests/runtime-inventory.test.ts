import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { buildRuntimeInventoryReport, formatRuntimeInventoryText } from '../core/runtime-inventory'

async function withRuntimeDb<T>(fn: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-runtime-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.exec(`
      INSERT INTO agents (agent_id, display_name, agent_type, cli_type, status)
      VALUES
        ('hotel-dev', 'Hotel Dev', 'dev', 'TUI', 'idle'),
        ('stale-dev', 'Stale Dev', 'dev', 'TUI', 'idle'),
        ('gap-dev', 'Gap Dev', 'dev', 'TUI', 'idle');

      INSERT INTO channels (id, name, type, members)
      VALUES
        ('hotel-channel', 'hotel-kanri', 'channel', '["hotel-dev"]'),
        ('bidirectional-channel', 'bidirectional-gap', 'channel', '["hotel-dev"]'),
        ('role-gap-channel', 'role-gap', 'channel', '["hotel-dev"]'),
        ('wrong-owner-channel', 'wrong-owner', 'channel', '["hotel-dev", "stale-dev"]'),
        ('gap-channel', 'gap', 'channel', '["gap-dev"]');

      INSERT INTO channel_routing_policy (channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist)
      VALUES
        ('hotel-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev"]'),
        ('bidirectional-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev"]'),
        ('role-gap-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev"]'),
        ('wrong-owner-channel', 'hotel-dev', 'hotel-dev', '["hotel-dev", "stale-dev"]'),
        ('gap-channel', 'gap-dev', 'gap-dev', '["gap-dev"]');

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id, checkout_path, commit_sha, status, last_seen_at)
      VALUES
        ('runtime-hotel', 'hotel-dev', 'codex', 'local_process', 'discord-hotel', 101, '/tmp/hotel', 'abc123', 'active', datetime('now')),
        ('runtime-stale', 'stale-dev', 'codex', 'local_process', 'discord-stale', 202, '/tmp/stale', 'old999', 'active', '2020-01-01T00:00:00Z');

      INSERT INTO connector_instances
        (connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri, status, trust_status)
      VALUES
        ('connector-hotel', 'hotel-dev', 'runtime-hotel', 'discord', 'discord://agents/hotel-dev', 'active', 'local'),
        ('connector-stale', 'stale-dev', 'runtime-stale', 'discord', 'discord://agents/stale-dev', 'active', 'local');

      INSERT INTO channel_connector_bindings
        (channel_binding_id, channel_id, provider, connector_instance_id, binding_role, status)
      VALUES
        ('binding-hotel', 'hotel-channel', 'discord', 'connector-hotel', 'outbound', 'active'),
        ('binding-bidirectional-gap', 'bidirectional-channel', 'discord', 'connector-hotel', 'bidirectional', 'active'),
        ('binding-role-gap', 'role-gap-channel', 'discord', 'connector-hotel', 'inbound', 'active'),
        ('binding-wrong-owner', 'wrong-owner-channel', 'discord', 'connector-stale', 'outbound', 'active');
    `)
    seed.close()

    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runtime inventory', () => {
  test('reports runtime freshness, connector linkage, and policy projection gaps', async () => {
    await withRuntimeDb(async (db) => {
      const report = await buildRuntimeInventoryReport(db, {
        staleMinutes: 60,
        expectedCommit: 'abc123',
      })

      const hotel = report.agents.find((agent) => agent.agent_id === 'hotel-dev')
      const stale = report.agents.find((agent) => agent.agent_id === 'stale-dev')
      const hotelConnector = report.connectors.find((connector) => connector.agent_id === 'hotel-dev')

      expect(report.policy.db_is_source_of_truth).toBe(true)
      expect(hotel?.freshness).toBe('fresh')
      expect(hotel?.warnings).not.toContain('runtime_commit_mismatch')
      expect(stale?.freshness).toBe('stale')
      expect(stale?.warnings).toContain('runtime_stale')
      expect(stale?.warnings).toContain('runtime_commit_mismatch')
      expect(hotelConnector?.active_binding_count).toBe(3)
      expect(report.policy_gaps).toEqual([
        {
          channel_id: 'bidirectional-channel',
          channel_name: 'bidirectional-gap',
          adapter_owner_agent_id: 'hotel-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'missing_active_binding',
          active_binding_agents: [],
        },
        {
          channel_id: 'gap-channel',
          channel_name: 'gap',
          adapter_owner_agent_id: 'gap-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'missing_active_binding',
          active_binding_agents: [],
        },
        {
          channel_id: 'role-gap-channel',
          channel_name: 'role-gap',
          adapter_owner_agent_id: 'hotel-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'missing_active_binding',
          active_binding_agents: [],
        },
        {
          channel_id: 'wrong-owner-channel',
          channel_name: 'wrong-owner',
          adapter_owner_agent_id: 'hotel-dev',
          provider: 'discord',
          binding_role: 'outbound',
          reason: 'active_binding_wrong_owner',
          active_binding_agents: ['stale-dev'],
        },
      ])
      expect(report.blockers).toContain('stale-dev:runtime_stale')
      expect(report.blockers).toContain('bidirectional-channel:missing_active_binding')
      expect(report.blockers).toContain('gap-channel:missing_active_binding')
      expect(report.blockers).toContain('role-gap-channel:missing_active_binding')
      expect(report.blockers).toContain('wrong-owner-channel:active_binding_wrong_owner')
      expect(formatRuntimeInventoryText(report)).toContain('Runtime Inventory')
    })
  })

  test('policy gaps are scoped to the requested binding role', async () => {
    await withRuntimeDb(async (db) => {
      const report = await buildRuntimeInventoryReport(db, {
        staleMinutes: 60,
        bindingRole: 'inbound',
      })

      expect(report.options.binding_role).toBe('inbound')
      expect(report.policy_gaps.map((gap) => gap.channel_id)).not.toContain('role-gap-channel')
      expect(report.policy_gaps).toContainEqual({
        channel_id: 'hotel-channel',
        channel_name: 'hotel-kanri',
        adapter_owner_agent_id: 'hotel-dev',
        provider: 'discord',
        binding_role: 'inbound',
        reason: 'missing_active_binding',
        active_binding_agents: [],
      })
    })
  })
})
