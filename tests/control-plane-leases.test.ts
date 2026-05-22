import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db'
import {
  acquireControlPlaneLease,
  heartbeatControlPlaneLease,
  releaseControlPlaneLease,
  verifyControlPlaneFence,
} from '../core/control-plane-leases'

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.ts')

async function withLeaseDb<T>(
  fn: (db: SqliteAdapter, ids: { dbPath: string; runtimeId: string; connectorId: string; bindingId: string }) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-lease-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.prepare("INSERT INTO agents (agent_id, display_name, agent_type) VALUES (?, ?, ?)").run(
      'lease-bot',
      'Lease Bot',
      'dev',
    )
    seed.prepare("INSERT INTO channels (id, name) VALUES (?, ?)").run(
      'lease-channel',
      'Lease Channel',
    )
    seed.prepare("INSERT INTO agent_runtime_instances (agent_id, runtime_engine, status) VALUES (?, ?, ?)").run(
      'lease-bot',
      'codex',
      'active',
    )
    const runtime = seed.prepare(
      "SELECT runtime_instance_id FROM agent_runtime_instances WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get('lease-bot') as any
    seed.prepare(
      `INSERT INTO connector_instances
         (agent_id, runtime_instance_id, provider, connector_uri, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'lease-bot',
      runtime.runtime_instance_id,
      'discord',
      'discord://lease-bot',
      'active',
    )
    const connector = seed.prepare(
      "SELECT connector_instance_id FROM connector_instances WHERE connector_uri = ?",
    ).get('discord://lease-bot') as any
    seed.prepare(
      `INSERT INTO channel_connector_bindings
         (channel_id, provider, connector_instance_id, binding_role, ordering_scope)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'lease-channel',
      'discord',
      connector.connector_instance_id,
      'outbound',
      'thread',
    )
    const binding = seed.prepare(
      "SELECT channel_binding_id FROM channel_connector_bindings WHERE channel_id = ?",
    ).get('lease-channel') as any
    seed.close()

    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter, {
      dbPath,
      runtimeId: runtime.runtime_instance_id,
      connectorId: connector.connector_instance_id,
      bindingId: binding.channel_binding_id,
    })
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('control plane leases', () => {
  test('acquires, heartbeats, verifies, and releases a lease', async () => {
    await withLeaseDb(async (db, ids) => {
      const t0 = new Date('2026-05-22T00:00:00Z')
      const acquired = await acquireControlPlaneLease(db, {
        scopeType: 'channel_binding',
        scopeId: ids.bindingId,
        purpose: 'outbound',
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        ttlMs: 30_000,
        now: t0,
        metadata: { source: 'test' },
      })

      expect(acquired.ok).toBe(true)
      if (!acquired.ok) throw new Error('expected acquired')
      expect(acquired.lease.fencing_token).toBe(1)
      expect(acquired.lease.status).toBe('active')
      expect(acquired.lease.holder_agent_id).toBe('lease-bot')
      expect(acquired.expiredLeaseIds).toEqual([])

      const blocked = await acquireControlPlaneLease(db, {
        scopeType: 'channel_binding',
        scopeId: ids.bindingId,
        purpose: 'outbound',
        holderAgentId: 'lease-bot',
        ttlMs: 30_000,
        now: new Date('2026-05-22T00:00:10Z'),
      })
      expect(blocked.ok).toBe(false)
      if (blocked.ok) throw new Error('expected active lease block')
      expect(blocked.reason).toBe('active_lease_exists')
      expect(blocked.activeLease.lease_id).toBe(acquired.lease.lease_id)

      const heartbeat = await heartbeatControlPlaneLease(db, {
        leaseId: acquired.lease.lease_id,
        fencingToken: acquired.lease.fencing_token,
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        ttlMs: 60_000,
        now: new Date('2026-05-22T00:00:20Z'),
      })
      expect(heartbeat.ok).toBe(true)
      if (!heartbeat.ok) throw new Error('expected heartbeat')
      expect(new Date(heartbeat.lease.expires_at).getTime()).toBe(new Date('2026-05-22T00:01:20Z').getTime())

      const verified = await verifyControlPlaneFence(db, {
        leaseId: acquired.lease.lease_id,
        fencingToken: acquired.lease.fencing_token,
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        now: new Date('2026-05-22T00:00:30Z'),
      })
      expect(verified.ok).toBe(true)

      const tokenOnlyVerified = await verifyControlPlaneFence(db, {
        leaseId: acquired.lease.lease_id,
        fencingToken: acquired.lease.fencing_token,
        now: new Date('2026-05-22T00:00:31Z'),
      })
      expect(tokenOnlyVerified.ok).toBe(true)

      const released = await releaseControlPlaneLease(db, {
        leaseId: acquired.lease.lease_id,
        fencingToken: acquired.lease.fencing_token,
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        now: new Date('2026-05-22T00:00:40Z'),
      })
      expect(released.ok).toBe(true)
      if (!released.ok) throw new Error('expected release')
      expect(released.lease.status).toBe('released')

      const reacquired = await acquireControlPlaneLease(db, {
        scopeType: 'channel_binding',
        scopeId: ids.bindingId,
        purpose: 'outbound',
        holderAgentId: 'lease-bot',
        ttlMs: 30_000,
        now: new Date('2026-05-22T00:00:41Z'),
      })
      expect(reacquired.ok).toBe(true)
      if (!reacquired.ok) throw new Error('expected reacquire')
      expect(reacquired.lease.fencing_token).toBe(2)
    })
  })

  test('expires stale active leases and rejects stale fencing tokens', async () => {
    await withLeaseDb(async (db, ids) => {
      const first = await acquireControlPlaneLease(db, {
        scopeType: 'channel_binding',
        scopeId: ids.bindingId,
        purpose: 'outbound',
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        ttlMs: 1_000,
        now: new Date('2026-05-22T00:00:00Z'),
      })
      expect(first.ok).toBe(true)
      if (!first.ok) throw new Error('expected first lease')

      const takeover = await acquireControlPlaneLease(db, {
        scopeType: 'channel_binding',
        scopeId: ids.bindingId,
        purpose: 'outbound',
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        ttlMs: 30_000,
        now: new Date('2026-05-22T00:00:02Z'),
      })
      expect(takeover.ok).toBe(true)
      if (!takeover.ok) throw new Error('expected takeover')
      expect(takeover.expiredLeaseIds).toEqual([first.lease.lease_id])
      expect(takeover.lease.fencing_token).toBe(2)

      const oldFence = await verifyControlPlaneFence(db, {
        leaseId: first.lease.lease_id,
        fencingToken: first.lease.fencing_token,
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        now: new Date('2026-05-22T00:00:03Z'),
      })
      expect(oldFence.ok).toBe(false)
      if (oldFence.ok) throw new Error('expected old fence failure')
      expect(oldFence.reason).toBe('not_active')
      expect(oldFence.lease?.status).toBe('expired')

      const wrongToken = await heartbeatControlPlaneLease(db, {
        leaseId: takeover.lease.lease_id,
        fencingToken: takeover.lease.fencing_token - 1,
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        ttlMs: 30_000,
        now: new Date('2026-05-22T00:00:03Z'),
      })
      expect(wrongToken.ok).toBe(false)
      if (wrongToken.ok) throw new Error('expected wrong token failure')
      expect(wrongToken.reason).toBe('fencing_token_mismatch')

      const wrongHolder = await releaseControlPlaneLease(db, {
        leaseId: takeover.lease.lease_id,
        fencingToken: takeover.lease.fencing_token,
        holderAgentId: 'other-bot',
        now: new Date('2026-05-22T00:00:04Z'),
      })
      expect(wrongHolder.ok).toBe(false)
      if (wrongHolder.ok) throw new Error('expected holder failure')
      expect(wrongHolder.reason).toBe('holder_mismatch')

      const currentFence = await verifyControlPlaneFence(db, {
        leaseId: takeover.lease.lease_id,
        fencingToken: takeover.lease.fencing_token,
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        now: new Date('2026-05-22T00:00:05Z'),
      })
      expect(currentFence.ok).toBe(true)

      const expiredRelease = await releaseControlPlaneLease(db, {
        leaseId: takeover.lease.lease_id,
        fencingToken: takeover.lease.fencing_token,
        holderAgentId: 'lease-bot',
        holderRuntimeInstanceId: ids.runtimeId,
        holderConnectorInstanceId: ids.connectorId,
        now: new Date('2026-05-22T00:00:33Z'),
      })
      expect(expiredRelease.ok).toBe(false)
      if (expiredRelease.ok) throw new Error('expected expired release failure')
      expect(expiredRelease.reason).toBe('expired')
    })
  })

  test('CLI acquires and verifies a SQLite-backed lease', async () => {
    await withLeaseDb(async (_db, ids) => {
      const env = {
        ...process.env,
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: ids.dbPath,
        AGENT_ID: 'lease-bot',
      }
      delete env.AGENT_COM_EXPECTED_AGENT_ID

      const acquire = spawnSync('bun', [
        CLI_PATH,
        'lease',
        'acquire',
        '--scope-type',
        'channel_binding',
        '--scope-id',
        ids.bindingId,
        '--purpose',
        'outbound',
        '--holder-agent-id',
        'lease-bot',
        '--holder-runtime-instance-id',
        ids.runtimeId,
        '--holder-connector-instance-id',
        ids.connectorId,
        '--ttl-sec',
        '30',
      ], { env, encoding: 'utf8' })

      expect(acquire.status, acquire.stderr).toBe(0)
      const acquired = JSON.parse(acquire.stdout)
      expect(acquired.ok).toBe(true)
      expect(acquired.lease.fencing_token).toBe(1)

      const verify = spawnSync('bun', [
        CLI_PATH,
        'lease',
        'verify',
        '--lease-id',
        acquired.lease.lease_id,
        '--fencing-token',
        String(acquired.lease.fencing_token),
      ], { env, encoding: 'utf8' })

      expect(verify.status, verify.stderr).toBe(0)
      const verified = JSON.parse(verify.stdout)
      expect(verified.ok).toBe(true)
      expect(verified.lease.lease_id).toBe(acquired.lease.lease_id)
    })
  })
})
