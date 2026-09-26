import * as hostObserver from '../core/host-runtime-observer'
import { unitRuntimeObservation } from './helpers/logical-runtime-unit-fixture'
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { runRuntimeMemoryReadyFleetRefresh } from '../core/runtime-memory-ready-refresher'
import { parseRuntimeMemoryReadyPolicy } from '../core/runtime-current-resolver'

const observations = new Map<string, hostObserver.HostRuntimeObservation>()
let hostSpy: ReturnType<typeof spyOn>
let tmp: string
let db: SqliteAdapter
const now = new Date('2026-08-21T00:10:00.000Z')
const policy = parseRuntimeMemoryReadyPolicy(JSON.stringify({
  schema_version: 'runtime-memory-ready-policy/v1',
  default_liveness_ttl_ms: 1_800_000,
  default_reap_ttl_ms: 86_400_000,
  backoff: { base_ms: 30_000, cap_ms: 1_800_000 },
  groups: [{ runtime_kind: 'local_process', source: 'server.ts', heartbeat_interval_ms: 300_000 }],
}), '/tmp/runtime-memory-ready-policy.refresher.test.json')

beforeEach(() => {
  observations.clear()
  hostSpy = spyOn(hostObserver, 'inspectHostRuntime').mockImplementation(input => {
    const o=observations.get(input.agentId)
    return {reasonCode:o?'OBSERVED':'NO_LIVE_RUNTIME',observations:o?[o]:[]}
  })
  tmp = mkdtempSync(join(tmpdir(), 'memory-ready-refresher-'))
  const dbPath = join(tmp, 'test.db')
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
})

afterEach(async () => {
  hostSpy?.mockRestore()
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedSeatHuman(agentId: string, status: 'idle' | 'busy' = 'idle'): Promise<void> {
  await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,profile_enabled) VALUES($1,$1,'human',1)`,[agentId])
}

async function seedSeat(agentId: string, status: 'idle' | 'busy' = 'idle'): Promise<void> {
  await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,profile_enabled) VALUES($1,$1,'dev',1)`,[agentId])
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind) VALUES($1,$2,'local_process')`,['runtime-'+agentId,agentId])
  await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,acquired_at,expires_at)
    VALUES($1,'runtime_instance',$2,'worker',$3,$2,1,'active','2026-08-20T00:01:00Z','2099-01-01T00:00:00Z')`,['lease-'+agentId,'runtime-'+agentId,agentId])
  observations.set(agentId,unitRuntimeObservation(agentId,{runtime_instance_id:'runtime-'+agentId,workspace:'/tmp/'+agentId,
    process_started_at:'2026-08-20T00:00:00Z',observed_at:now.toISOString()}))
}

describe('memory-ready fleet refresher', () => {
  test('default liveness refresh cannot manufacture a recovery receipt', async () => {
    await seedSeat('no-recovery')
    const report = await runRuntimeMemoryReadyFleetRefresh(db as any, {
      now, policy,
      resolveProject: async (_db, agentId) => ({ agent_id: agentId, project: agentId, workspace_path: null, source: 'agent_metadata_override' }),
    })
    expect(report.ok).toBe(false)
    expect(report.seats[0].status).toBe('failed')
    expect(report.seats[0].details.error).toContain('MEMORY_CONTEXT_RECOVERY_REQUIRED')
    expect(await db.query('SELECT * FROM runtime_memory_ready_evidence')).toHaveLength(0)
  })
  test('returns N/N terminal results and isolates one seat failure', async () => {
    await seedSeat('alpha', 'idle')
    await seedSeat('bravo', 'busy')
    await seedSeatHuman('denied', 'idle')
    const visited: string[] = []

    const report = await runRuntimeMemoryReadyFleetRefresh(db as any, {
      now,
      policy,
      resolveProject: async (_db, agentId) => ({
        agent_id: agentId,
        project: agentId,
        workspace_path: `/tmp/${agentId}`,
        source: 'canonical_workspace',
      }),
      refreshSeat: async ({ resolution }) => {
        visited.push(resolution.agent_id)
        if (resolution.agent_id === 'alpha') throw new Error('fixture failure')
        return { evidence_id: 42, evidence_log_id: 'fixture-log' }
      },
    })

    expect(visited).toEqual(['alpha', 'bravo'])
    expect(report.ok).toBe(false)
    expect(report.summary).toEqual({
      inventory: 2,
      eligible: 2,
      ready: 1,
      failed: 1,
      skipped: 0,
      terminal_results: 2,
    })
    expect(report.seats.map(row => [row.agent_id, row.status, row.reason])).toEqual([
      ['alpha', 'failed', 'SEAT_REFRESH_ERROR'],
      ['bravo', 'ready', 'READY'],
    ])
    expect(report.provider_effects).toBe(0)
    expect(report.discord_visible_sends).toBe(0)
  })

  test('dry-run uses current observation while rejecting physical profile mutation', async () => {
    await seedSeat('healthy')
    await seedSeat('broken')
    await expect(db.execute(`UPDATE agent_runtime_instances SET session_name='wrong' WHERE agent_id='broken'`)).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
    observations.set('broken',{...observations.get('broken')!,session_name:'current-session'})

    const report = await runRuntimeMemoryReadyFleetRefresh(db as any, {
      now,
      dryRun: true,
      policy,
      resolveProject: async (_db, agentId) => ({
        agent_id: agentId,
        project: agentId,
        workspace_path: `/tmp/${agentId}`,
        source: 'canonical_workspace',
      }),
    })

    expect(report.seats.every(row=>!('registration_profile_mismatch' in row.details))).toBe(true)
    expect(report.summary.inventory).toBe(2)
    expect(report.summary.terminal_results).toBe(2)
    expect(report.seats).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: 'healthy', status: 'dry_run_ready' }),
      expect.objectContaining({
        agent_id: 'broken',
        status: 'dry_run_ready',
        reason: 'DRY_RUN_READY',
        runtime_instance_id: 'runtime-broken',
        details: expect.objectContaining({project_resolution_source:'canonical_workspace'}),
      }),
    ]))
  })
})
