import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { buildDirectoryReport } from '../core/directory'
import {
  buildAgentRetirementPlan,
  executeAgentRetirement,
  resolveAuditSeatRoute,
} from '../core/audit-identity'

async function withSqlite<T>(fn: (dbPath: string, adapter: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'audit-identity-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    adapter = new SqliteAdapter(dbPath)
    return await fn(dbPath, adapter)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function seedDirectoryRows(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(`
      INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, historical_only, new_work_allowed, profile_enabled, metadata)
      VALUES
        ('codex-audit', 'codex-audit', 'dev', 'codex', 'idle', 0, 1, 1, '{}'),
        ('l2auditor', 'l2auditor', 'dev', 'TUI', 'disabled', 1, 0, 0, '{"historical_only":true,"non_routable":true}');
      INSERT INTO channels (id, name, type, members)
      VALUES ('audit-ch', 'audit-ch', 'channel', '["codex-audit","l2auditor"]');
    `)
  } finally {
    db.close()
  }
}

describe('audit identity canonicalization', () => {
  test('directory omits historical-only l2auditor by default and exposes it only explicitly', async () => {
    await withSqlite(async (dbPath, adapter) => {
      seedDirectoryRows(dbPath)

      const current = await buildDirectoryReport({
        query: async (sql: string, params?: unknown[]) => ({ rows: await adapter.query(sql, params) }),
      })
      expect(current.agents.map((agent) => agent.agent_id)).toEqual(['codex-audit'])
      expect(current.channels[0].members).toEqual(['codex-audit'])
      expect(current.mention_directory.channels[0].candidates.map((candidate) => candidate.agent_id)).toEqual(['codex-audit'])

      const historical = await buildDirectoryReport({
        query: async (sql: string, params?: unknown[]) => ({ rows: await adapter.query(sql, params) }),
      }, { includeHistorical: true })
      const tombstone = historical.agents.find((agent) => agent.agent_id === 'l2auditor')
      expect(tombstone).toMatchObject({
        historical_only: true,
        new_work_allowed: false,
        sendability: 'blocked',
      })
      expect(tombstone?.warnings).toEqual(expect.arrayContaining(['historical_only', 'new_work_blocked', 'disabled']))
      expect(historical.mention_directory.channels[0].candidates.find((candidate) => candidate.agent_id === 'l2auditor')?.hard_block_reasons).toContain('historical_only')
    })
  })

  test('audit routing requires evidence_audit_gate canonical_seat codex-audit', () => {
    expect(resolveAuditSeatRoute({ active_function: 'evidence_audit_gate' })).toMatchObject({
      ok: false,
      code: 'CANONICAL_SEAT_REQUIRED',
    })
    expect(resolveAuditSeatRoute({
      active_function: 'evidence_audit_gate',
      canonical_seat: 'devauditor',
    })).toMatchObject({
      ok: false,
      code: 'CANONICAL_SEAT_MISMATCH',
    })
    expect(resolveAuditSeatRoute({
      active_function: 'evidence_audit_gate',
      canonical_seat: 'codex-audit',
      requested_agent_id: 'devauditor',
    })).toMatchObject({
      ok: false,
      code: 'AGENT_FUNCTION_MISMATCH',
    })
    expect(resolveAuditSeatRoute({
      active_function: 'evidence_audit_gate',
      canonical_seat: 'codex-audit',
      requested_agent_id: 'l2auditor',
    })).toMatchObject({
      ok: false,
      code: 'HISTORICAL_AGENT_NOT_ROUTABLE',
    })
    expect(resolveAuditSeatRoute({
      active_function: 'evidence_audit_gate',
      canonical_seat: 'codex-audit',
    })).toMatchObject({
      ok: true,
      agent_id: 'codex-audit',
      reason: 'evidence_audit_gate_canonical_seat',
    })
    expect(resolveAuditSeatRoute({
      active_function: 'scenario_verification_gate',
      requested_agent_id: 'devauditor',
    })).toMatchObject({
      ok: true,
      agent_id: 'devauditor',
      reason: 'scenario_verification_gate',
    })
  })

  test('retirement dry-run is default-shaped and execute disables projections before final tombstone', async () => {
    await withSqlite(async (dbPath, adapter) => {
      const db = new Database(dbPath)
      try {
        db.exec(`
          INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, historical_only, new_work_allowed, profile_enabled)
          VALUES ('l2auditor', 'l2auditor', 'dev', 'TUI', 'idle', 0, 1, 1);
          INSERT INTO channels (id, name, type, members)
          VALUES ('audit-ch', 'audit-ch', 'channel', '["l2auditor"]');
          INSERT INTO agent_runtime_instances (runtime_instance_id, agent_id, runtime_engine, status)
          VALUES ('runtime-l2', 'l2auditor', 'claude-code', 'running');
          INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
          VALUES ('connector-l2', 'l2auditor', 'discord', 'discord://agents/l2auditor', 'active');
          INSERT INTO channel_connector_bindings (channel_binding_id, channel_id, provider, connector_instance_id, status)
          VALUES ('binding-l2', 'audit-ch', 'discord', 'connector-l2', 'active');
        `)
      } finally {
        db.close()
      }

      const dry = await buildAgentRetirementPlan(adapter, {
        agentId: 'l2auditor',
        reason: 'test retirement',
        dryRun: true,
      })
      expect(dry.dry_run).toBe(true)
      expect(dry.affected.connector_instances).toEqual(['connector-l2'])
      expect(dry.affected.channel_connector_bindings).toEqual(['binding-l2'])
      expect(dry.affected.agent_runtime_instances).toEqual(['runtime-l2'])
      expect(dry.affected.channel_memberships).toEqual([{
        channel_id: 'audit-ch',
        before_members: ['l2auditor'],
        after_members: [],
      }])

      const executed = await executeAgentRetirement(adapter, {
        agentId: 'l2auditor',
        reason: 'test retirement',
      })
      expect(executed.dry_run).toBe(false)

      const read = new Database(dbPath)
      try {
        expect(read.prepare(`SELECT status, historical_only, new_work_allowed, profile_enabled FROM agents WHERE agent_id = 'l2auditor'`).get()).toEqual({
          status: 'disabled',
          historical_only: 1,
          new_work_allowed: 0,
          profile_enabled: 0,
        })
        expect(read.prepare(`SELECT status FROM connector_instances WHERE connector_instance_id = 'connector-l2'`).get()).toEqual({ status: 'disabled' })
        expect(read.prepare(`SELECT status FROM channel_connector_bindings WHERE channel_binding_id = 'binding-l2'`).get()).toEqual({ status: 'disabled' })
        expect(read.prepare(`SELECT status FROM agent_runtime_instances WHERE runtime_instance_id = 'runtime-l2'`).get()).toEqual({ status: 'stopped' })
        expect(read.prepare(`SELECT members FROM channels WHERE id = 'audit-ch'`).get()).toEqual({ members: '[]' })
      } finally {
        read.close()
      }
    })
  })

  test('DB triggers reject active projections for disabled or historical-only agents', async () => {
    await withSqlite(async (dbPath) => {
      const db = new Database(dbPath)
      try {
        db.exec(`
          INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, historical_only, new_work_allowed, profile_enabled)
          VALUES
            ('disabled-audit', 'disabled-audit', 'dev', 'TUI', 'disabled', 1, 0, 0),
            ('active-audit', 'active-audit', 'dev', 'codex', 'idle', 0, 1, 1);
        `)
        expect(() => {
          db.exec(`
            INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
            VALUES ('blocked-connector', 'disabled-audit', 'discord', 'discord://agents/disabled-audit', 'active')
          `)
        }).toThrow('DISABLED_OR_HISTORICAL_AGENT_ACTIVE_CONNECTOR')

        db.exec(`
          INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
          VALUES ('active-connector', 'active-audit', 'discord', 'discord://agents/active-audit', 'active')
        `)
        expect(() => {
          db.exec(`UPDATE agents SET historical_only = 1, new_work_allowed = 0, status = 'disabled' WHERE agent_id = 'active-audit'`)
        }).toThrow('DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES')
      } finally {
        db.close()
      }
    })
  })
})
