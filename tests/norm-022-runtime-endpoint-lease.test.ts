import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db'
import {
  acquireControlPlaneLease,
  verifyControlPlaneFence,
} from '../core/control-plane-leases'
import { checkBotHealth, type BotHealthDeps } from '../core/bot-health'
import {
  destructiveLifecycleGateFailure,
  endpointLeaseGateFailure,
  evaluateCleanupPort,
} from '../core/bot-lifecycle'
import type { BotStatusDbRow } from '../core/bot-status-db'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_PATH = join(REPO_ROOT, 'cli', 'index.ts')

type FixtureIds = {
  agentId: string
  workspaceId: string
  runtimeId: string
  connectorId: string
}

function runCli(dbPath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: dbPath,
      AGENT_COM_PG_NOTIFY: 'false',
      DATABASE_URL: '',
      AGENT_ID: 'norm022-operator',
    },
    encoding: 'utf8',
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function withNorm022Db<T>(fn: (ctx: { dbPath: string; ids: FixtureIds }) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'norm-022-'))
  const dbPath = join(dir, 'norm-022.db')
  try {
    migrateSqlite(dbPath)
    const ids = seedRuntimeEndpointFixture(dbPath)
    return await fn({ dbPath, ids })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seedRuntimeEndpointFixture(dbPath: string): FixtureIds {
  const db = new Database(dbPath)
  const ids = {
    agentId: `norm022-${randomUUID().slice(0, 8)}`,
    workspaceId: randomUUID(),
    runtimeId: randomUUID(),
    connectorId: randomUUID(),
  }
  const home = `/tmp/${ids.agentId}`
  db.prepare(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, metadata,
        ui_id, ui_handle, home_directory, channel_port,
        runtime_engine_preference, profile_enabled)
     VALUES
       (?, ?, 'dev', 'codex', 'idle', ?, 22022, ?, ?, 19022, 'codex', 1)`,
  ).run(
    ids.agentId,
    ids.agentId,
    JSON.stringify({ tmux_session: `tmux-${ids.agentId}`, supervisor_type: 'tmux' }),
    ids.agentId,
    home,
  )
  db.prepare(
    `INSERT INTO agent_workspaces
       (workspace_id, org_id, name, workspace_type, local_path, metadata)
     VALUES
       (?, 'default', ?, 'local_path', ?, ?)`,
  ).run(ids.workspaceId, ids.agentId, home, JSON.stringify({ source: 'norm022_fixture' }))
  db.prepare(
    `INSERT INTO agent_workspace_bindings
       (agent_id, workspace_id, binding_role, active)
     VALUES
       (?, ?, 'primary', 1)`,
  ).run(ids.agentId, ids.workspaceId)
  db.prepare(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind,
        endpoint_uri, status, started_at, last_seen_at, metadata)
     VALUES
       (?, ?, ?, 'codex', 'local_process',
        'http://127.0.0.1:19022', 'active', datetime('now'), datetime('now'), ?)`,
  ).run(ids.runtimeId, ids.agentId, ids.workspaceId, JSON.stringify({
    source: 'norm022_fixture',
    supervisor_type: 'tmux',
    supervisor_id: `tmux-${ids.agentId}`,
  }))
  db.prepare(
    `INSERT INTO connector_instances
       (connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri,
        status, trust_status, metadata)
     VALUES
       (?, ?, ?, 'discord', ?, 'active', 'local', ?)`,
  ).run(
    ids.connectorId,
    ids.agentId,
    ids.runtimeId,
    `discord://agents/${ids.agentId}`,
    JSON.stringify({ source: 'runtime_heartbeat' }),
  )
  db.close()
  return ids
}

function insertRuntimeEndpointLease(dbPath: string, ids: FixtureIds, overrides: { status?: string; expires?: string } = {}): void {
  const db = new Database(dbPath)
  db.prepare(
    `INSERT INTO control_plane_leases
       (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id,
        holder_runtime_instance_id, holder_connector_instance_id,
        fencing_token, status, expires_at, metadata)
     VALUES
       ('runtime_instance', ?, 'worker', ?, ?, ?, 1, ?, ${overrides.expires ?? "datetime('now', '+5 minutes')"}, ?)`,
  ).run(
    ids.runtimeId,
    ids.agentId,
    ids.runtimeId,
    ids.connectorId,
    overrides.status ?? 'active',
    JSON.stringify({ endpoint_kind: 'tcp', endpoint_uri: 'http://127.0.0.1:19022', readiness_probe: 'ok' }),
  )
  db.close()
}

function botHealthDeps(overrides: Partial<BotHealthDeps> = {}): BotHealthDeps {
  return {
    hasSession: () => true,
    capture: () => 'Codex running\n',
    getPids: () => ['1234'],
    psCommand: () => 'bun run /Users/yuji/Developer/agent-comms-mcp/server.ts',
    ...overrides,
  }
}

function endpointRow(overrides: Partial<BotStatusDbRow> = {}): BotStatusDbRow {
  return {
    agent_id: 'norm022-agent',
    status: 'idle',
    last_seen_at: new Date().toISOString(),
    heartbeat_ok: true,
    pending_count: 0,
    oldest_pending_at: null,
    newest_pending_at: null,
    active_claim_count: 0,
    oldest_active_claim_at: null,
    health_state: 'healthy',
    agent_last_wake_attempt_at: null,
    pending_last_wake_attempt_at: null,
    latest_wake_progress_at: null,
    queue_wake_state: 'none',
    active_connector_count: 1,
    runtime_linked_connector_count: 1,
    active_endpoint_lease_count: 1,
    endpoint_lease_state: 'ok',
    endpoint_lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
    endpoint_lease_heartbeat_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('NORM-022 frozen runtime endpoint lease fixtures', () => {
  test('healthy_endpoint_lease', async () => {
    await withNorm022Db(({ dbPath, ids }) => {
      insertRuntimeEndpointLease(dbPath, ids)

      const doctor = runCli(dbPath, ['agent', 'profile', 'doctor', '--strict'])
      expect(doctor.status, doctor.stdout + doctor.stderr).toBe(0)
      expect(JSON.parse(doctor.stdout).ok).toBe(true)
    })
  })

  test('missing_lease_refusal', async () => {
    await withNorm022Db(({ dbPath, ids }) => {
      const doctor = runCli(dbPath, ['agent', 'profile', 'doctor', '--strict'])
      expect(doctor.status).toBe(1)
      const payload = JSON.parse(doctor.stdout)
      expect(payload.blockers).toContainEqual(expect.objectContaining({
        agent_id: ids.agentId,
        connector_instance_id: ids.connectorId,
        runtime_instance_id: ids.runtimeId,
        code: 'active_connector_missing_endpoint_lease',
      }))
    })
  })

  test('stale_ttl_expiry', async () => {
    await withNorm022Db(async ({ dbPath, ids }) => {
      const adapter = new SqliteAdapter(dbPath)
      try {
        const first = await acquireControlPlaneLease(adapter, {
          scopeType: 'runtime_instance',
          scopeId: ids.runtimeId,
          purpose: 'worker',
          holderAgentId: ids.agentId,
          holderRuntimeInstanceId: ids.runtimeId,
          holderConnectorInstanceId: ids.connectorId,
          ttlMs: 1_000,
          now: new Date('2026-05-22T00:00:00Z'),
        })
        expect(first.ok).toBe(true)
        if (!first.ok) throw new Error('expected first lease')

        const takeover = await acquireControlPlaneLease(adapter, {
          scopeType: 'runtime_instance',
          scopeId: ids.runtimeId,
          purpose: 'worker',
          holderAgentId: ids.agentId,
          holderRuntimeInstanceId: ids.runtimeId,
          holderConnectorInstanceId: ids.connectorId,
          ttlMs: 30_000,
          now: new Date('2026-05-22T00:00:02Z'),
        })
        expect(takeover.ok).toBe(true)
        if (!takeover.ok) throw new Error('expected takeover')
        expect(takeover.expiredLeaseIds).toEqual([first.lease.lease_id])
        expect(takeover.lease.fencing_token).toBe(2)
      } finally {
        await adapter.close()
      }
    })
  })

  test('duplicate_active_lease_fenced', async () => {
    await withNorm022Db(async ({ dbPath, ids }) => {
      const adapter = new SqliteAdapter(dbPath)
      try {
        const first = await acquireControlPlaneLease(adapter, {
          scopeType: 'runtime_instance',
          scopeId: ids.runtimeId,
          purpose: 'worker',
          holderAgentId: ids.agentId,
          holderRuntimeInstanceId: ids.runtimeId,
          holderConnectorInstanceId: ids.connectorId,
          ttlMs: 30_000,
          now: new Date('2026-05-22T00:00:00Z'),
        })
        expect(first.ok).toBe(true)
        const duplicate = await acquireControlPlaneLease(adapter, {
          scopeType: 'runtime_instance',
          scopeId: ids.runtimeId,
          purpose: 'worker',
          holderAgentId: 'other-holder',
          ttlMs: 30_000,
          now: new Date('2026-05-22T00:00:01Z'),
        })
        expect(duplicate.ok).toBe(false)
        if (duplicate.ok) throw new Error('expected duplicate lease refusal')
        expect(duplicate.reason).toBe('active_lease_exists')
      } finally {
        await adapter.close()
      }
    })
  })

  test('supervisor_down_fail_closed', () => {
    const result = checkBotHealth(
      { supervisorType: 'tmux', session: 'missing-session', port: 19022 },
      botHealthDeps({ hasSession: () => false }),
    )
    expect(result.status).toBe('dead')
    expect(result.details).toBe('tmux session not found')
  })

  test('restart_gated_by_lease_heartbeat_fencing', async () => {
    await withNorm022Db(async ({ dbPath, ids }) => {
      const adapter = new SqliteAdapter(dbPath)
      try {
        const acquired = await acquireControlPlaneLease(adapter, {
          scopeType: 'runtime_instance',
          scopeId: ids.runtimeId,
          purpose: 'worker',
          holderAgentId: ids.agentId,
          holderRuntimeInstanceId: ids.runtimeId,
          holderConnectorInstanceId: ids.connectorId,
          ttlMs: 30_000,
          now: new Date('2026-05-22T00:00:00Z'),
        })
        expect(acquired.ok).toBe(true)
        if (!acquired.ok) throw new Error('expected acquired lease')

        const wrongFence = await verifyControlPlaneFence(adapter, {
          leaseId: acquired.lease.lease_id,
          fencingToken: acquired.lease.fencing_token + 1,
          holderAgentId: ids.agentId,
          holderRuntimeInstanceId: ids.runtimeId,
          holderConnectorInstanceId: ids.connectorId,
          now: new Date('2026-05-22T00:00:01Z'),
        })
        expect(wrongFence.ok).toBe(false)
        if (wrongFence.ok) throw new Error('expected wrong fence failure')
        expect(wrongFence.reason).toBe('fencing_token_mismatch')

        const wrongHolder = await verifyControlPlaneFence(adapter, {
          leaseId: acquired.lease.lease_id,
          fencingToken: acquired.lease.fencing_token,
          holderAgentId: 'other-holder',
          now: new Date('2026-05-22T00:00:01Z'),
        })
        expect(wrongHolder.ok).toBe(false)
        if (wrongHolder.ok) throw new Error('expected holder failure')
        expect(wrongHolder.reason).toBe('holder_mismatch')

        const ok = await verifyControlPlaneFence(adapter, {
          leaseId: acquired.lease.lease_id,
          fencingToken: acquired.lease.fencing_token,
          holderAgentId: ids.agentId,
          holderRuntimeInstanceId: ids.runtimeId,
          holderConnectorInstanceId: ids.connectorId,
          now: new Date('2026-05-22T00:00:01Z'),
        })
        expect(ok.ok).toBe(true)
      } finally {
        await adapter.close()
      }
    })
  })

  test('disabled_or_revoked_fail_closed', async () => {
    await withNorm022Db(({ dbPath, ids }) => {
      insertRuntimeEndpointLease(dbPath, ids, { status: 'revoked' })
      const doctor = runCli(dbPath, ['agent', 'profile', 'doctor', '--strict'])
      expect(doctor.status).toBe(1)
      const payload = JSON.parse(doctor.stdout)
      expect(payload.blockers).toContainEqual(expect.objectContaining({
        agent_id: ids.agentId,
        connector_instance_id: ids.connectorId,
        code: 'active_connector_missing_endpoint_lease',
      }))
    })
  })

  test('multi_channel_single_runtime', async () => {
    await withNorm022Db(({ dbPath, ids }) => {
      insertRuntimeEndpointLease(dbPath, ids)
      const db = new Database(dbPath)
      db.prepare(`INSERT INTO channels (id, name, members) VALUES ('norm022-a', 'norm022-a', ?), ('norm022-b', 'norm022-b', ?)`)
        .run(JSON.stringify([ids.agentId]), JSON.stringify([ids.agentId]))
      db.prepare(
        `INSERT INTO channel_connector_bindings
           (channel_id, provider, connector_instance_id, binding_role, ordering_scope)
         VALUES
           ('norm022-a', 'discord', ?, 'outbound', 'thread'),
           ('norm022-b', 'discord', ?, 'outbound', 'thread')`,
      ).run(ids.connectorId, ids.connectorId)
      const counts = db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM agent_runtime_instances WHERE agent_id = ?) AS runtimes,
           (SELECT COUNT(*) FROM channel_connector_bindings WHERE connector_instance_id = ?) AS bindings`,
      ).get(ids.agentId, ids.connectorId) as { runtimes: number; bindings: number }
      db.close()

      expect(counts.runtimes).toBe(1)
      expect(counts.bindings).toBe(2)
      expect(runCli(dbPath, ['agent', 'profile', 'doctor', '--strict']).status).toBe(0)
    })
  })

  test('partial_active_connector_coverage_fails_closed', async () => {
    expect(endpointLeaseGateFailure(
      { agentId: 'norm022-agent' },
      endpointRow({
        active_connector_count: 2,
        runtime_linked_connector_count: 1,
        active_endpoint_lease_count: 1,
      }),
    )).toContain('state=missing_runtime')
    expect(endpointLeaseGateFailure(
      { agentId: 'norm022-agent' },
      endpointRow({
        active_connector_count: 2,
        runtime_linked_connector_count: 2,
        active_endpoint_lease_count: 1,
      }),
    )).toContain('state=missing_lease')

    await withNorm022Db(({ dbPath, ids }) => {
      insertRuntimeEndpointLease(dbPath, ids)
      const missingRuntimeConnectorId = randomUUID()
      const db = new Database(dbPath)
      db.prepare(
        `INSERT INTO connector_instances
           (connector_instance_id, agent_id, provider, connector_uri, status, trust_status, metadata)
         VALUES
           (?, ?, 'discord', ?, 'active', 'local', ?)`,
      ).run(
        missingRuntimeConnectorId,
        ids.agentId,
        `discord://agents/${ids.agentId}/missing-runtime`,
        JSON.stringify({ source: 'runtime_heartbeat' }),
      )
      db.close()

      const doctor = runCli(dbPath, ['agent', 'profile', 'doctor', '--strict'])
      expect(doctor.status).toBe(1)
      const payload = JSON.parse(doctor.stdout)
      expect(payload.blockers).toContainEqual(expect.objectContaining({
        agent_id: ids.agentId,
        connector_instance_id: missingRuntimeConnectorId,
        code: 'active_connector_missing_runtime_instance',
      }))
    })

    await withNorm022Db(({ dbPath, ids }) => {
      insertRuntimeEndpointLease(dbPath, ids)
      const secondRuntimeId = randomUUID()
      const missingLeaseConnectorId = randomUUID()
      const db = new Database(dbPath)
      db.prepare(
        `INSERT INTO agent_runtime_instances
           (runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind,
            endpoint_uri, status, started_at, last_seen_at, metadata)
         VALUES
           (?, ?, ?, 'codex', 'local_process',
            'http://127.0.0.1:19023', 'active', datetime('now'), datetime('now'), ?)`,
      ).run(secondRuntimeId, ids.agentId, ids.workspaceId, JSON.stringify({
        source: 'norm022_fixture',
        supervisor_type: 'tmux',
        supervisor_id: `tmux-${ids.agentId}`,
      }))
      db.prepare(
        `INSERT INTO connector_instances
           (connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri,
            status, trust_status, metadata)
         VALUES
           (?, ?, ?, 'discord', ?, 'active', 'local', ?)`,
      ).run(
        missingLeaseConnectorId,
        ids.agentId,
        secondRuntimeId,
        `discord://agents/${ids.agentId}/missing-lease`,
        JSON.stringify({ source: 'runtime_heartbeat' }),
      )
      db.close()

      const doctor = runCli(dbPath, ['agent', 'profile', 'doctor', '--strict'])
      expect(doctor.status).toBe(1)
      const payload = JSON.parse(doctor.stdout)
      expect(payload.blockers).toContainEqual(expect.objectContaining({
        agent_id: ids.agentId,
        connector_instance_id: missingLeaseConnectorId,
        runtime_instance_id: secondRuntimeId,
        code: 'active_connector_missing_endpoint_lease',
      }))
    })
  })

  test('tmux_diagnostics_only_for_tmux_supervisor', () => {
    let tmuxChecked = false
    const result = checkBotHealth(
      { supervisorType: 'stdio', session: null, port: null },
      botHealthDeps({
        hasSession: () => {
          tmuxChecked = true
          return false
        },
      }),
    )

    expect(result.status).toBe('healthy')
    expect(result.details).toContain('tmux diagnostics skipped')
    expect(tmuxChecked).toBe(false)
  })

  test('non_tmux_destructive_lifecycle_fails_closed_without_tmux_evidence', () => {
    const liveEndpoint = endpointRow()
    const entry = {
      agentId: 'norm022-agent',
      supervisorType: 'stdio',
      session: null,
      port: 19022,
    }

    expect(destructiveLifecycleGateFailure(entry, liveEndpoint)).toBe(
      'unsupported_supervisor_for_restart_cleanup: supervisor_type=stdio',
    )

    let tmuxChecked = false
    let pidsChecked = false
    const cleanup = evaluateCleanupPort(entry, liveEndpoint, {
      hasTmuxSession: () => {
        tmuxChecked = true
        throw new Error('tmux must not be consulted for non-tmux supervisor')
      },
      getProcessOnPort: () => {
        pidsChecked = true
        throw new Error('port owners must not be inspected for non-tmux supervisor')
      },
    })

    expect(cleanup.action).toBe('skip')
    expect(cleanup.reason).toBe('unsupported_supervisor_for_restart_cleanup: supervisor_type=stdio')
    expect(tmuxChecked).toBe(false)
    expect(pidsChecked).toBe(false)
  })
})
