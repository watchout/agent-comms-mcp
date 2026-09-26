import * as hostObserver from '../core/host-runtime-observer'
import { unitRuntimeObservation } from './helpers/logical-runtime-unit-fixture'
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { parseRuntimeMemoryReadyPolicy, resolveRuntimeMemoryReadyCurrent, type RuntimeMemoryReadyPolicy } from '../core/runtime-current-resolver'
import {
  queryRuntimeMemoryReadyIdentityMonitor,
  reconcileRuntimeMemoryReadyIdentity,
  reconcileRuntimeMemoryReadyFleetIdentity,
} from '../core/runtime-memory-ready-identity'
import { evaluateRuntimeMemoryReadyGate, recordRuntimeMemoryReadyEvidence } from '../core/runtime-memory-ready'

const observations = new Map<string, hostObserver.HostRuntimeObservation>()
let hostSpy: ReturnType<typeof spyOn>
let tmp: string
let db: SqliteAdapter
let policy: RuntimeMemoryReadyPolicy
const now = new Date('2026-08-23T00:10:00.000Z')

beforeEach(() => {
  observations.clear()
  hostSpy = spyOn(hostObserver, 'inspectHostRuntime').mockImplementation(input => {
    const rows = [...observations.values()].filter(row => row.agent_id === input.agentId && (!input.runtimeInstanceId || row.runtime_instance_id === input.runtimeInstanceId))
    return { reasonCode: rows.length ? 'OBSERVED' : 'NO_LIVE_RUNTIME', observations: rows }
  })
  tmp = mkdtempSync(join(tmpdir(), 'runtime-memory-ready-identity-'))
  const dbPath = join(tmp, 'test.db')
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
  policy = parseRuntimeMemoryReadyPolicy(JSON.stringify({
    schema_version: 'runtime-memory-ready-policy/v1',
    default_liveness_ttl_ms: 1_800_000,
    default_reap_ttl_ms: 86_400_000,
    backoff: { base_ms: 30_000, cap_ms: 1_800_000 },
    groups: [{ runtime_kind: 'local_process', source: 'server.ts', heartbeat_interval_ms: 300_000 }],
  }), '/tmp/runtime-memory-ready-identity-policy.test.json')
})

afterEach(async () => {
  hostSpy?.mockRestore()
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedAgent(input: {
  agentId: string
  session: string
  home: string
  port: number
}): Promise<void> {
  await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,profile_enabled,profile_revision,profile_source)
    VALUES($1,$1,'dev',1,7,'fixture')`,[input.agentId])
}

async function seedRuntime(input: {
  runtimeId: string
  agentId: string
  session: string | null
  checkout: string
  port: number
  status: 'running' | 'stopped'
  seen: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind,metadata)
    VALUES($1,$2,'local_process','{}')`,[input.runtimeId,input.agentId])
  if(input.status === 'running') {
    observations.set(input.runtimeId,unitRuntimeObservation(input.agentId,{runtime_instance_id:input.runtimeId,
      session_name:input.session,workspace:input.checkout,port:input.port,observed_at:input.seen,
      process_started_at:'2026-08-22T00:00:00.000Z'}))
    await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,acquired_at,expires_at)
      VALUES($1,'runtime_instance',$2,'worker',$3,$2,1,'active','2026-08-22T00:01:00Z','2099-01-01T00:00:00Z')`,['lease-'+input.runtimeId,input.runtimeId,input.agentId])
  }
}

async function seedEvidence(input: {
  agentId: string
  runtimeId: string
  session: string
  checkout: string
  port: number
}): Promise<void> {
  await recordRuntimeMemoryReadyEvidence(db as any, {
    agent_id: input.agentId,
    project: 'agent-comms-mcp',
    runtime_instance_id: input.runtimeId,
    profile_revision: 7,
    profile_source: 'fixture',
    session_name: input.session,
    port: input.port,
    expected_agent_id: input.agentId,
    checkout_path: input.checkout,
    checkout_commit_sha: 'a'.repeat(40),
    recovery_command: 'mcp__wasurezu__recover_context',
    result_status: 'ready',
    failure_reason: null,
    completed_at: new Date('2026-08-23T00:09:00.000Z'),
    valid_until: new Date('2026-08-24T00:09:00.000Z'),
    source: 'agent_memory_boot_recovery',
    metadata: { fixture: true },
  })
}

const resolveProject = async (_db: any, agentId: string) => ({
  agent_id: agentId,
  project: 'agent-comms-mcp',
  workspace_path: `/tmp/${agentId}`,
  source: 'fixture' as const,
})

describe('startup memory identity canary scope', () => {
  async function seedRotatedSeat(agentId: string, mismatched = false) {
    const home = `/work/${agentId}`
    const session = `discord-${agentId}`
    await seedAgent({ agentId, home, session, port: 8810 })
    await seedRuntime({ runtimeId: `${agentId}-old`, agentId, session, checkout: home,
      port: 8810, status: 'stopped', seen: '2026-08-22T23:50:00.000Z' })
    await seedRuntime({ runtimeId: `${agentId}-current`, agentId, session,
      checkout: mismatched ? '/work/wrong-registration' : home,
      port: 8810, status: 'running', seen: '2026-08-23T00:09:30.000Z' })
    await seedEvidence({ agentId, runtimeId: `${agentId}-old`, session, checkout: home, port: 8810 })
  }

  function observedOptions(agentAllowlist?: readonly string[] | null) {
    const resolved: string[] = [], projects: string[] = [], refreshed: string[] = []
    return {
      resolved, projects, refreshed,
      options: { now, policy, agentAllowlist,
        resolveCurrent: async (...args: Parameters<typeof resolveRuntimeMemoryReadyCurrent>) => {
          resolved.push(args[1].agentId)
          return resolveRuntimeMemoryReadyCurrent(...args)
        },
        resolveProject: async (adapter: any, agentId: string) => {
          projects.push(agentId)
          return resolveProject(adapter, agentId)
        },
        refreshSeat: async (input: any) => {
          refreshed.push(input.resolution.agent_id)
          return { evidence_id: 999, evidence_log_id: 'owned-refresh-result' } as any
        },
      },
    }
  }

  test('qa canary excludes mismatched nonQA before resolver, audit and refresh', async () => {
    await seedRotatedSeat('qa')
    await seedRotatedSeat('non-qa', true)
    const probe = observedOptions(['qa'])
    const results = await reconcileRuntimeMemoryReadyFleetIdentity(db as any, probe.options)
    expect(results.map(row => [row.agent_id, row.status])).toEqual([['qa', 'REFRESHED']])
    expect(probe.resolved).toEqual(['qa'])
    expect(probe.projects).toEqual(['qa'])
    expect(probe.refreshed).toEqual(['qa'])
    const audits = await db.query<any>("SELECT agent_id FROM audit_log WHERE event_type = 'runtime.memory_ready_identity'")
    expect(audits).toHaveLength(2)
    expect(audits.every(row => row.agent_id === 'qa')).toBe(true)
  })

  for (const allowlist of [undefined, null]) {
    test(`${String(allowlist)} keeps normal eligible fleet reconciliation`, async () => {
      await seedRotatedSeat('qa')
      await seedRotatedSeat('non-qa', true)
      const probe = observedOptions(allowlist)
      const results = await reconcileRuntimeMemoryReadyFleetIdentity(db as any, probe.options)
      expect(results.map(row => row.agent_id)).toEqual(['non-qa', 'qa'])
      expect(results.every(row => row.status === 'REFRESHED')).toBe(true)
      expect(probe.resolved).toEqual(['non-qa', 'qa'])
      expect(probe.refreshed).toEqual(['non-qa', 'qa'])
      const audits = await db.query<any>("SELECT agent_id FROM audit_log WHERE event_type = 'runtime.memory_ready_identity'")
      expect(audits.some(row => row.agent_id === 'non-qa')).toBe(true)
    })
  }

  test('explicit empty scope has no selected seats or per-seat effects', async () => {
    await seedRotatedSeat('qa')
    const probe = observedOptions([])
    expect(await reconcileRuntimeMemoryReadyFleetIdentity(db as any, probe.options)).toEqual([])
    expect(probe.resolved).toEqual([])
    expect(probe.projects).toEqual([])
    expect(probe.refreshed).toEqual([])
    expect(await db.query<any>("SELECT id FROM audit_log WHERE event_type = 'runtime.memory_ready_identity'")).toEqual([])
  })

  test('allowlist excludes logical ineligible seats and reports an unobserved seat explicitly', async () => {
    const names = ['qa', 'disabled', 'offline', 'profile-disabled', 'human', 'outside']
    for (const name of names) await seedRotatedSeat(name)
    await db.execute("UPDATE agents SET disabled_at = '2026-08-22' WHERE agent_id = 'disabled'")
    observations.delete('offline-current')
    await db.execute("UPDATE agents SET profile_enabled = 0 WHERE agent_id = 'profile-disabled'")
    await db.execute("UPDATE agents SET agent_type = 'human' WHERE agent_id = 'human'")
    expect((await db.query<any>("SELECT status FROM agents WHERE agent_id='qa'"))[0].status).toBeNull()
    const probe = observedOptions(names.filter(name => name !== 'outside'))
    const results = await reconcileRuntimeMemoryReadyFleetIdentity(db as any, probe.options)
    expect(results.map(row => row.agent_id)).toEqual(['offline','qa'])
    expect(results.find(row => row.agent_id === 'offline')?.status).not.toBe('REFRESHED')
    expect(probe.resolved).toEqual(['offline','qa'])
    expect(probe.refreshed).toEqual(['qa'])
    const audits = await db.query<any>("SELECT agent_id FROM audit_log WHERE event_type = 'runtime.memory_ready_identity'")
    expect(audits.every(row => row.agent_id === 'qa')).toBe(true)
  })

  test('actual daemon startup forwards its existing validated canary config', () => {
    const source = readFileSync(new URL('../bin/state-daemon.ts', import.meta.url), 'utf8')
    const calls = [...source.matchAll(/await reconcileRuntimeMemoryReadyFleetIdentity\(db as any,\s*\{\s*agentAllowlist: config\.agentAllowlist,?\s*\}\)/g)]
    expect(calls).toHaveLength(1)
    expect(source.indexOf('const config = loadConfig()')).toBeLessThan(calls[0].index!)
    expect(source.indexOf('await daemon.start()', calls[0].index)).toBeGreaterThan(calls[0].index!)
  })
})

describe('runtime memory-ready identity reconciliation', () => {
  test('heartbeat rotation cannot transfer a prior runtime recovery receipt', async () => {
    await seedAgent({
      agentId: 'devauditor',
      session: 'discord-auditor',
      home: '/work/dev-auditor',
      port: 8810,
    })
    await seedRuntime({
      runtimeId: 'ec08bc6f-466f-4727-853f-81895e4f6d05',
      agentId: 'devauditor',
      session: 'discord-auditor',
      checkout: '/work/dev-auditor',
      port: 8810,
      status: 'stopped',
      seen: '2026-08-22T23:50:00.000Z',
    })
    await seedRuntime({
      runtimeId: '2e8da261-9017-4b2d-ab2d-1378432801a1',
      agentId: 'devauditor',
      session: 'discord-auditor',
      checkout: '/work/dev-auditor',
      port: 8810,
      status: 'running',
      seen: '2026-08-23T00:09:30.000Z',
    })
    await seedEvidence({
      agentId: 'devauditor',
      runtimeId: 'ec08bc6f-466f-4727-853f-81895e4f6d05',
      session: 'discord-auditor',
      checkout: '/work/dev-auditor',
      port: 8810,
    })

    const before = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'devauditor',
      project: 'agent-comms-mcp',
      now,
      policy,
    })
    expect(before.ok).toBe(false)
    expect(before.reason).toBe('runtime_instance_mismatch')

    const reconciled = await reconcileRuntimeMemoryReadyIdentity(db as any, {
      agentId: 'devauditor',
      observedRuntimeInstanceId: '2e8da261-9017-4b2d-ab2d-1378432801a1',
    }, { now, policy, resolveProject })
    expect(reconciled).toMatchObject({
      status: 'REFRESH_FAILED',
      code: 'EVIDENCE_BINDING_REFRESH_FAILED',
      current_runtime_instance_id: '2e8da261-9017-4b2d-ab2d-1378432801a1',
    })

    const after = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'devauditor',
      project: 'agent-comms-mcp',
      now,
      policy,
    })
    expect(after.ok).toBe(false)
    expect(after.reason).toBe('runtime_instance_mismatch')
    expect(after.runtime_instance_id).toBe('2e8da261-9017-4b2d-ab2d-1378432801a1')

    const idempotent = await reconcileRuntimeMemoryReadyIdentity(db as any, {
      agentId: 'devauditor',
      observedRuntimeInstanceId: '2e8da261-9017-4b2d-ab2d-1378432801a1',
    }, { now, policy, resolveProject })
    expect(idempotent.status).toBe('REFRESH_FAILED')
    const evidenceRows = await db.query<any>('SELECT runtime_instance_id FROM runtime_memory_ready_evidence WHERE agent_id=$1', ['devauditor'])
    expect(evidenceRows).toHaveLength(1)
    expect(evidenceRows[0].runtime_instance_id).toBe('ec08bc6f-466f-4727-853f-81895e4f6d05')
  })

  test('read-only monitor ignores removed physical registration values and reports superseded binding', async () => {
    await seedAgent({ agentId: 'codex-cto', session: 'discord-cto', home: '/work/codex', port: 8808 })
    await seedRuntime({
      runtimeId: 'eb785a47-81fb-4907-83a4-0cac5b62fce6',
      agentId: 'codex-cto',
      session: null,
      checkout: '/work/agent-comms-mcp',
      port: 8808,
      status: 'running',
      seen: '2026-08-23T00:09:59.000Z',
      metadata: {
        registration_metadata_provenance: {
          schema_version: 'runtime-registration-metadata-provenance/v1',
          agent_id: 'codex-cto',
          profile_found: true,
          session_name: {
            source: 'missing',
            effective_value: null,
            registered_value: 'discord-cto',
            ambient_value: null,
            mismatch: true,
          },
          checkout_path: {
            source: 'ambient',
            effective_value: '/work/agent-comms-mcp',
            registered_value: '/work/codex',
            ambient_value: '/work/agent-comms-mcp',
            mismatch: true,
          },
        },
      },
    })

    await seedAgent({ agentId: 'devauditor', session: 'discord-auditor', home: '/work/dev-auditor', port: 8810 })
    await seedRuntime({
      runtimeId: 'ec08bc6f-466f-4727-853f-81895e4f6d05',
      agentId: 'devauditor',
      session: 'discord-auditor',
      checkout: '/work/dev-auditor',
      port: 8810,
      status: 'stopped',
      seen: '2026-08-22T23:50:00.000Z',
    })
    await seedRuntime({
      runtimeId: '2e8da261-9017-4b2d-ab2d-1378432801a1',
      agentId: 'devauditor',
      session: 'discord-auditor',
      checkout: '/work/dev-auditor',
      port: 8810,
      status: 'running',
      seen: '2026-08-23T00:09:30.000Z',
    })
    await seedEvidence({
      agentId: 'devauditor',
      runtimeId: 'ec08bc6f-466f-4727-853f-81895e4f6d05',
      session: 'discord-auditor',
      checkout: '/work/dev-auditor',
      port: 8810,
    })

    const report = await queryRuntimeMemoryReadyIdentityMonitor(db as any, {
      now,
      policy,
      resolveProject,
    })
    expect(report.read_only).toBe(true)
    expect(report.summary).toEqual({
      inventory: 2,
      profile_mismatch_excluded: 0,
      registration_profile_mismatch: 0,
      profile_mismatch_deprioritized: 0,
      superseded_evidence_binding: 1,
    })
    expect(report.findings.some(row => row.code === 'REGISTRATION_PROFILE_MISMATCH')).toBe(false)
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SUPERSEDED_EVIDENCE_BINDING',
        agent_id: 'devauditor',
        runtime_instance_id: '2e8da261-9017-4b2d-ab2d-1378432801a1',
      }),
    ]))
  })
})
