import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { buildDirectoryReport } from '../core/directory'
import {
  type AgentRetirementReadPhase,
  buildAuditRouteReconciliationPlan,
  buildAgentRetirementPlan,
  executeAuditRouteReconciliation,
  executeAgentRetirement,
  resolveCanonicalAuditRouteForInputStrict,
  resolveAuditSeatRoute,
} from '../core/audit-identity'
import type { DbAdapter } from '../core/db'

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

class FailingRoleRoutingAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const
  transactions: string[] = []
  writes: string[] = []

  constructor(private readonly failOnQuery: number) {}

  async query<T = any>(sql: string): Promise<T[]> {
    if (sql.includes('FROM role_routing')) {
      this.failOnQuery -= 1
      if (this.failOnQuery === 0) throw new Error('role_routing schema unreadable')
      return [
        {
          role_key: 'evidence_audit_gate',
          agent_id: 'codex-audit',
          active_function: 'evidence_audit_gate',
          canonical_seat: 'codex-audit',
          historical_only: 0,
          new_work_allowed: 1,
          description: 'canonical',
        },
      ] as T[]
    }
    return []
  }

  async execute(sql: string): Promise<{ rowCount: number }> {
    this.writes.push(sql)
    return { rowCount: 1 }
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    this.transactions.push('BEGIN')
    try {
      const result = await fn(this)
      this.transactions.push('COMMIT')
      return result
    } catch (err) {
      this.transactions.push('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {}
}

type RetirementReadFailureCase = {
  phase: AgentRetirementReadPhase
  surface: string
  matches: (sql: string) => boolean
}

const RETIREMENT_READ_FAILURE_CASES: RetirementReadFailureCase[] = [
  {
    phase: 'agent_exists',
    surface: 'agents',
    matches: (sql) => sql.includes('FROM agents') && sql.includes('WHERE agent_id = $1') && sql.includes('LIMIT 1'),
  },
  {
    phase: 'connector_instances',
    surface: 'connector_instances',
    matches: (sql) => sql.includes('FROM connector_instances') && sql.includes("status IN ('registered', 'active', 'standby', 'draining')"),
  },
  {
    phase: 'channel_connector_bindings',
    surface: 'channel_connector_bindings',
    matches: (sql) => sql.includes('FROM channel_connector_bindings b') && sql.includes('JOIN connector_instances ci'),
  },
  {
    phase: 'connector_credentials',
    surface: 'connector_credentials',
    matches: (sql) => sql.includes('FROM connector_credentials'),
  },
  {
    phase: 'agent_provider_identities',
    surface: 'agent_provider_identities',
    matches: (sql) => sql.includes('FROM agent_provider_identities'),
  },
  {
    phase: 'provider_channel_access',
    surface: 'provider_channel_access',
    matches: (sql) => sql.includes('FROM provider_channel_access pca'),
  },
  {
    phase: 'agent_ui_bindings',
    surface: 'agent_ui_bindings',
    matches: (sql) => sql.includes('FROM agent_ui_bindings'),
  },
  {
    phase: 'agent_workspace_bindings',
    surface: 'agent_workspace_bindings',
    matches: (sql) => sql.includes('FROM agent_workspace_bindings'),
  },
  {
    phase: 'agent_runtime_instances',
    surface: 'agent_runtime_instances',
    matches: (sql) => sql.includes('FROM agent_runtime_instances'),
  },
  {
    phase: 'channel_memberships',
    surface: 'channels',
    matches: (sql) => sql.includes('FROM channels') && sql.includes('ORDER BY id'),
  },
  {
    phase: 'role_routing',
    surface: 'role_routing',
    matches: (sql) => sql.includes('FROM role_routing') && sql.includes('WHERE agent_id = $1'),
  },
  {
    phase: 'channel_routing_policies',
    surface: 'channel_routing_policy',
    matches: (sql) => sql.includes('FROM channel_routing_policy'),
  },
]

class FailingRetirementPreflightAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const
  transactions: string[] = []
  writes: string[] = []
  queries: string[] = []

  constructor(private readonly failCase: RetirementReadFailureCase) {}

  async query<T = any>(sql: string): Promise<T[]> {
    this.queries.push(sql)
    if (this.failCase.matches(sql)) throw new Error(`${this.failCase.surface} unreadable`)
    if (sql.includes('FROM agents') && sql.includes('WHERE agent_id = $1')) {
      return [{ agent_id: 'l2auditor', metadata: '{}' }] as T[]
    }
    return []
  }

  async execute(sql: string): Promise<{ rowCount: number }> {
    this.writes.push(sql)
    return { rowCount: 1 }
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    this.transactions.push('BEGIN')
    try {
      const result = await fn(this)
      this.transactions.push('COMMIT')
      return result
    } catch (err) {
      this.transactions.push('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {}
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

  test('canonical audit route resolver fails closed on contradictory explicit tuples', () => {
    expect(resolveCanonicalAuditRouteForInputStrict({
      activeFunction: 'evidence_audit_gate',
      canonicalSeat: 'devauditor',
      agentId: 'devauditor',
    })).toMatchObject({
      ok: false,
      code: 'CANONICAL_SEAT_MISMATCH',
      active_function: 'evidence_audit_gate',
      canonical_seat: 'devauditor',
      requested_agent_id: 'devauditor',
    })

    expect(resolveCanonicalAuditRouteForInputStrict({
      activeFunction: 'scenario_verification_gate',
      canonicalSeat: 'codex-audit',
      agentId: 'codex-audit',
    })).toMatchObject({
      ok: false,
      code: 'CANONICAL_SEAT_MISMATCH',
      active_function: 'scenario_verification_gate',
      canonical_seat: 'codex-audit',
      requested_agent_id: 'codex-audit',
    })
  })

  test('retirement dry-run is default-shaped and execute disables projections before final tombstone', async () => {
    await withSqlite(async (dbPath, adapter) => {
      const db = new Database(dbPath)
      try {
        db.exec(`
          INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, historical_only, new_work_allowed, profile_enabled)
          VALUES
            ('codex-audit', 'codex-audit', 'dev', 'codex', 'idle', 0, 1, 1),
            ('l2auditor', 'l2auditor', 'dev', 'TUI', 'idle', 0, 1, 1);
          INSERT INTO channels (id, name, type, members)
          VALUES ('audit-ch', 'audit-ch', 'channel', '["l2auditor"]');
          INSERT INTO role_routing (role_key, channel_id, agent_id, description, new_work_allowed, active_function, canonical_seat, historical_only)
          VALUES ('pr_audit_l2', 'audit-ch', 'l2auditor', 'legacy L2 route', 1, NULL, NULL, 0);
          INSERT INTO channel_routing_policy (
            channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist,
            native_role_outbound_owners, native_projection_identities
          )
          VALUES (
            'audit-ch', 'l2auditor', 'l2auditor', '["codex-audit","l2auditor"]',
            '{"l2":"l2auditor","codex":"codex-audit"}',
            '{"l2auditor":"legacy","codex-audit":"canonical"}'
          );
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
      expect(dry.affected.role_routing).toEqual([expect.objectContaining({
        role_key: 'pr_audit_l2',
        before_agent_id: 'l2auditor',
        after_agent_id: 'codex-audit',
        after_historical_only: true,
        after_new_work_allowed: false,
      })])
      expect(dry.affected.channel_routing_policies).toEqual([expect.objectContaining({
        channel_id: 'audit-ch',
        before_primary_agent_id: 'l2auditor',
        after_primary_agent_id: null,
        before_adapter_owner_agent_id: 'l2auditor',
        after_adapter_owner_agent_id: null,
        before_outbound_allowlist: ['codex-audit', 'l2auditor'],
        after_outbound_allowlist: ['codex-audit'],
      })])

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
        expect(read.prepare(`SELECT agent_id, historical_only, new_work_allowed, active_function, canonical_seat FROM role_routing WHERE role_key = 'pr_audit_l2'`).get()).toEqual({
          agent_id: 'codex-audit',
          historical_only: 1,
          new_work_allowed: 0,
          active_function: 'evidence_audit_gate',
          canonical_seat: 'codex-audit',
        })
        expect(read.prepare(`SELECT primary_agent_id, adapter_owner_agent_id, outbound_allowlist, native_role_outbound_owners, native_projection_identities FROM channel_routing_policy WHERE channel_id = 'audit-ch'`).get()).toEqual({
          primary_agent_id: null,
          adapter_owner_agent_id: null,
          outbound_allowlist: '["codex-audit"]',
          native_role_outbound_owners: '{"codex":"codex-audit"}',
          native_projection_identities: '{"codex-audit":"canonical"}',
        })
      } finally {
        read.close()
      }
    })
  })

  test('retirement dry-run fails closed for every required preflight read family', async () => {
    for (const failCase of RETIREMENT_READ_FAILURE_CASES) {
      const adapter = new FailingRetirementPreflightAdapter(failCase)

      const plan = await buildAgentRetirementPlan(adapter, {
        agentId: 'l2auditor',
        reason: 'schema blocker',
        dryRun: true,
      })

      expect(plan).toEqual({
        ok: false,
        dry_run: true,
        agent_id: 'l2auditor',
        reason: 'schema blocker',
        blocker: {
          code: 'RETIREMENT_PREFLIGHT_READ_FAILED',
          phase: failCase.phase,
          surface: failCase.surface,
          detail: `${failCase.surface} unreadable`,
        },
        affected: {
          connector_instances: [],
          channel_connector_bindings: [],
          connector_credentials: [],
          agent_provider_identities: [],
          provider_channel_access: [],
          agent_ui_bindings: [],
          agent_workspace_bindings: [],
          agent_runtime_instances: [],
          channel_memberships: [],
          role_routing: [],
          channel_routing_policies: [],
        },
      })
      expect(adapter.transactions).toEqual([])
      expect(adapter.writes).toEqual([])
    }
  })

  test('retirement execute rolls back before writes for every required preflight read family', async () => {
    for (const failCase of RETIREMENT_READ_FAILURE_CASES) {
      const adapter = new FailingRetirementPreflightAdapter(failCase)

      await expect(executeAgentRetirement(adapter, {
        agentId: 'l2auditor',
        reason: 'schema blocker',
      })).rejects.toThrow(`RETIREMENT_PREFLIGHT_READ_FAILED:${failCase.phase}:${failCase.surface}:${failCase.surface} unreadable`)
      expect(adapter.transactions).toEqual(['BEGIN', 'ROLLBACK'])
      expect(adapter.writes).toEqual([])
    }
  })

  test('audit-route reconciliation canonicalizes devauditor-owned legacy audit rows without requiring l2auditor routes', async () => {
    await withSqlite(async (dbPath, adapter) => {
      const db = new Database(dbPath)
      try {
        db.exec(`
          INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, historical_only, new_work_allowed, profile_enabled)
          VALUES
            ('codex-audit', 'codex-audit', 'dev', 'codex', 'idle', 0, 1, 1),
            ('devauditor', 'devauditor', 'dev', 'codex', 'idle', 0, 1, 1);
          INSERT INTO role_routing (role_key, agent_id, description, new_work_allowed, historical_only)
          VALUES
            ('audit', 'devauditor', 'legacy active audit route', 1, 0),
            ('contract_audit_viewpoint', 'devauditor', 'legacy active audit route', 1, 0),
            ('pr_audit_l1', 'devauditor', 'legacy active audit route', 1, 0),
            ('pr_audit_l2', 'devauditor', 'legacy active audit route', 1, 0),
            ('primary_audit', 'devauditor', 'legacy active audit route', 1, 0),
            ('secondary_audit', 'devauditor', 'legacy active audit route', 1, 0);
        `)
      } finally {
        db.close()
      }

      const dry = await buildAuditRouteReconciliationPlan(adapter, {
        reason: 'test route reconcile',
        dryRun: true,
      })
      expect(dry.dry_run).toBe(true)
      expect(dry.canonical_routes).toEqual([
        expect.objectContaining({
          role_key: 'evidence_audit_gate',
          action: 'create',
          after: expect.objectContaining({
            agent_id: 'codex-audit',
            active_function: 'evidence_audit_gate',
            canonical_seat: 'codex-audit',
            historical_only: false,
            new_work_allowed: true,
          }),
        }),
        expect.objectContaining({
          role_key: 'scenario_verification_gate',
          action: 'create',
          after: expect.objectContaining({
            agent_id: 'devauditor',
            active_function: 'scenario_verification_gate',
            canonical_seat: 'devauditor',
            historical_only: false,
            new_work_allowed: true,
          }),
        }),
      ])
      expect(dry.legacy_routes.map((route) => route.role_key)).toEqual([
        'audit',
        'contract_audit_viewpoint',
        'pr_audit_l1',
        'pr_audit_l2',
        'primary_audit',
        'secondary_audit',
      ])
      expect(dry.legacy_routes.every((route) => route.before.agent_id === 'devauditor')).toBe(true)
      expect(dry.legacy_routes.every((route) => route.after.historical_only === true && route.after.new_work_allowed === false)).toBe(true)

      const executed = await executeAuditRouteReconciliation(adapter, {
        reason: 'test route reconcile',
      })
      expect(executed.dry_run).toBe(false)

      const read = new Database(dbPath)
      try {
        expect(read.prepare(`SELECT agent_id, active_function, canonical_seat, historical_only, new_work_allowed FROM role_routing WHERE role_key = 'evidence_audit_gate'`).get()).toEqual({
          agent_id: 'codex-audit',
          active_function: 'evidence_audit_gate',
          canonical_seat: 'codex-audit',
          historical_only: 0,
          new_work_allowed: 1,
        })
        expect(read.prepare(`SELECT agent_id, active_function, canonical_seat, historical_only, new_work_allowed FROM role_routing WHERE role_key = 'scenario_verification_gate'`).get()).toEqual({
          agent_id: 'devauditor',
          active_function: 'scenario_verification_gate',
          canonical_seat: 'devauditor',
          historical_only: 0,
          new_work_allowed: 1,
        })
        expect(read.prepare(`
          SELECT count(*) AS count
            FROM role_routing
           WHERE agent_id = 'devauditor'
             AND role_key LIKE '%audit%'
             AND historical_only = 0
             AND new_work_allowed = 1
        `).get()).toEqual({ count: 0 })
        expect(read.prepare(`
          SELECT count(*) AS count
            FROM role_routing
           WHERE role_key IN ('audit','contract_audit_viewpoint','pr_audit_l1','pr_audit_l2','primary_audit','secondary_audit')
             AND historical_only = 1
             AND new_work_allowed = 0
        `).get()).toEqual({ count: 6 })
      } finally {
        read.close()
      }
    })
  })

  test('audit-route reconciliation dry-run returns a typed blocker when canonical role rows are unreadable', async () => {
    const adapter = new FailingRoleRoutingAdapter(1)

    const plan = await buildAuditRouteReconciliationPlan(adapter, {
      reason: 'schema blocker',
      dryRun: true,
    })

    expect(plan).toEqual({
      ok: false,
      dry_run: true,
      reason: 'schema blocker',
      blocker: {
        code: 'ROLE_ROUTING_READ_FAILED',
        phase: 'canonical_routes',
        detail: 'role_routing schema unreadable',
      },
      canonical_routes: [],
      legacy_routes: [],
    })
  })

  test('audit-route reconciliation execute rolls back when legacy route read fails', async () => {
    const adapter = new FailingRoleRoutingAdapter(2)

    await expect(executeAuditRouteReconciliation(adapter, {
      reason: 'schema blocker',
    })).rejects.toThrow('ROLE_ROUTING_READ_FAILED:legacy_routes:role_routing schema unreadable')
    expect(adapter.transactions).toEqual(['BEGIN', 'ROLLBACK'])
    expect(adapter.writes).toEqual([])
  })

  test('DB triggers reject active projections for disabled or historical-only agents', async () => {
    await withSqlite(async (dbPath) => {
      const db = new Database(dbPath)
      try {
        db.exec(`
          INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, historical_only, new_work_allowed, profile_enabled)
          VALUES
            ('disabled-audit', 'disabled-audit', 'dev', 'TUI', 'disabled', 1, 0, 0),
            ('active-audit', 'active-audit', 'dev', 'codex', 'idle', 0, 1, 1),
            ('binding-owner', 'binding-owner', 'dev', 'codex', 'idle', 0, 1, 1),
            ('access-owner', 'access-owner', 'dev', 'codex', 'idle', 0, 1, 1),
            ('direct-owner', 'direct-owner', 'dev', 'codex', 'idle', 0, 1, 1),
            ('direct-access-agent', 'direct-access-agent', 'dev', 'codex', 'idle', 0, 1, 1);
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

        db.exec(`
          INSERT INTO channels (id, name, type, members)
          VALUES ('binding-ch', 'binding-ch', 'channel', '[]');
          INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
          VALUES ('stopped-connector', 'binding-owner', 'discord', 'discord://agents/binding-owner', 'disabled');
          INSERT INTO channel_connector_bindings (channel_binding_id, channel_id, provider, connector_instance_id, status)
          VALUES ('active-binding-through-disabled-connector', 'binding-ch', 'discord', 'stopped-connector', 'active');
        `)
        expect(() => {
          db.exec(`UPDATE connector_instances SET agent_id = 'disabled-audit' WHERE connector_instance_id = 'stopped-connector'`)
        }).toThrow('DISABLED_OR_HISTORICAL_AGENT_ACTIVE_CONNECTOR')
        expect(() => {
          db.exec(`UPDATE agents SET historical_only = 1, new_work_allowed = 0, status = 'disabled' WHERE agent_id = 'binding-owner'`)
        }).toThrow('DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES')

        db.exec(`
          INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
          VALUES ('access-connector', 'access-owner', 'discord', 'discord://agents/access-owner', 'disabled');
          INSERT INTO provider_channel_access (provider_channel_access_id, provider, provider_channel_id, connector_instance_id, agent_id, status)
          VALUES ('access-through-connector', 'discord', 'access-channel', 'access-connector', NULL, 'active');
        `)
        expect(() => {
          db.exec(`UPDATE connector_instances SET agent_id = 'disabled-audit' WHERE connector_instance_id = 'access-connector'`)
        }).toThrow('DISABLED_OR_HISTORICAL_AGENT_ACTIVE_CONNECTOR')
        expect(db.prepare(`SELECT agent_id, status FROM connector_instances WHERE connector_instance_id = 'access-connector'`).get()).toEqual({
          agent_id: 'access-owner',
          status: 'disabled',
        })
        expect(db.prepare(`SELECT agent_id, status FROM provider_channel_access WHERE provider_channel_access_id = 'access-through-connector'`).get()).toEqual({
          agent_id: null,
          status: 'active',
        })
        expect(() => {
          db.exec(`UPDATE agents SET historical_only = 1, new_work_allowed = 0, status = 'disabled' WHERE agent_id = 'access-owner'`)
        }).toThrow('DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES')
        expect(db.prepare(`SELECT status, historical_only, new_work_allowed FROM agents WHERE agent_id = 'access-owner'`).get()).toEqual({
          status: 'idle',
          historical_only: 0,
          new_work_allowed: 1,
        })

        db.exec(`
          INSERT INTO connector_instances (connector_instance_id, agent_id, provider, connector_uri, status)
          VALUES ('direct-access-connector', 'direct-owner', 'discord', 'discord://agents/direct-owner', 'disabled');
          INSERT INTO provider_channel_access (provider_channel_access_id, provider, provider_channel_id, connector_instance_id, agent_id, status)
          VALUES ('direct-access', 'discord', 'direct-access-channel', 'direct-access-connector', 'direct-access-agent', 'active');
          UPDATE agents SET historical_only = 1, new_work_allowed = 0, status = 'disabled' WHERE agent_id = 'direct-owner';
        `)
        expect(db.prepare(`SELECT status, historical_only, new_work_allowed FROM agents WHERE agent_id = 'direct-owner'`).get()).toEqual({
          status: 'disabled',
          historical_only: 1,
          new_work_allowed: 0,
        })
        expect(() => {
          db.exec(`UPDATE agents SET historical_only = 1, new_work_allowed = 0, status = 'disabled' WHERE agent_id = 'direct-access-agent'`)
        }).toThrow('DISABLED_OR_HISTORICAL_AGENT_HAS_ACTIVE_DEPENDENCIES')
      } finally {
        db.close()
      }
    })
  })
})
