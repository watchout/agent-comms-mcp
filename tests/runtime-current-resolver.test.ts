import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { unitRuntimeObservation, unitRuntimeId } from './helpers/logical-runtime-unit-fixture'
import type { HostRuntimeObservation } from '../core/host-runtime-observer'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  parseRuntimeMemoryReadyPolicy,
  reapRuntimeMemoryReadyStaleRows,
  resolveRuntimeMemoryReadyCurrent,
  type RuntimeMemoryReadyPolicy,
} from '../core/runtime-current-resolver'

let tmp: string
let db: SqliteAdapter
let policy: RuntimeMemoryReadyPolicy
let observations: Map<string, HostRuntimeObservation>
const inspect = () => ({reasonCode: 'OBSERVED' as const, observations: [...observations.values()]})

function testPolicy(): RuntimeMemoryReadyPolicy {
  return parseRuntimeMemoryReadyPolicy(JSON.stringify({
    schema_version: 'runtime-memory-ready-policy/v1',
    default_liveness_ttl_ms: 1_800_000,
    default_reap_ttl_ms: 86_400_000,
    backoff: { base_ms: 30_000, cap_ms: 1_800_000 },
    groups: [
      { runtime_kind: 'local_process', source: 'server.ts', heartbeat_interval_ms: 300_000 },
    ],
  }), '/tmp/runtime-memory-ready-policy.test.json')
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'runtime-current-resolver-'))
  const dbPath = join(tmp, 'test.db')
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
  policy = testPolicy()
  observations = new Map()
})

afterEach(async () => {
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedProfile(agentId: string): Promise<void> {
  await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type) VALUES($1,$1,'dev')`,[agentId])
}

async function seedRuntime(input: {
  id: string
  engine?: string
  kind?: string
  source?: string
  session?: string | null
  home?: string
  seen: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  const holder = input.kind === 'bootstrap_bound_provider' ? unitRuntimeId(`mcp-${input.id}`) : input.id
  const metadata = input.kind === 'bootstrap_bound_provider' ? {mcp_runtime_instance_id: holder} : {}
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind,runtime_engine,status,started_at,metadata)
    VALUES($1,'codex-cto',$2,NULL,NULL,NULL,$3)`,[input.id,input.kind ?? 'local_process',JSON.stringify(metadata)])
  if (holder !== input.id) await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind,runtime_engine,status,started_at)
    VALUES($1,'codex-cto','local_process',NULL,NULL,NULL)`,[holder])
  await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,acquired_at,expires_at,metadata)
    VALUES($1,'runtime_instance',$2,'worker','codex-cto',$2,1,'active','2026-08-21T00:00:00Z','2099-01-01T00:00:00Z','{}')`,[`lease-${input.id}`,holder])
  observations.set(holder,unitRuntimeObservation('codex-cto', {runtime_instance_id:holder,
    provider: 'codex', session_name: Object.hasOwn(input,'session') ? input.session ?? null : 'discord-cto',
    workspace:input.home ?? '/work/codex', observed_at:input.seen,process_started_at:'2026-07-01T00:00:00Z'}))
}

describe('runtime current resolver', () => {
  test('codex-cto sole live holder remains current and stale same-kind diagnostics cannot mutate anchors', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({
      id: 'fresh-profile-mismatch',
      session: null,
      home: '/work/agent-comms-mcp',
      seen: '2026-08-21T00:09:00.000Z',
      metadata: {
        registration_metadata_provenance: {
          schema_version: 'runtime-registration-metadata-provenance/v1',
          session_name: { source: 'ambient' },
          checkout_path: { source: 'ambient' },
        },
      },
    })
    await seedRuntime({
      id: 'stale-profile-match',
      seen: '2026-07-31T00:00:00.000Z',
    })
    await seedRuntime({
      id: 'stale-cross-group',
      kind: 'bootstrap_bound_provider',
      source: 'provider',
      seen: '2026-08-20T12:00:00.000Z',
    })
    await db.execute("UPDATE control_plane_leases SET status='released' WHERE holder_runtime_instance_id=$1",[unitRuntimeId('mcp-stale-cross-group')])

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })

    expect(resolution.ok).toBe(true)
    expect(resolution.code).toBe('RESOLVED')
    expect(resolution.current_runtime?.runtime_instance_id).toBe('fresh-profile-mismatch')
    expect(resolution.candidate_absence_reason).toBeNull()
    expect(resolution.current_candidates).toHaveLength(1)
    expect(resolution.candidate_exclusions).toHaveLength(0)
    expect(resolution.profile_mismatch_observations).toEqual([]) // NULL is absence, not drift
    expect(resolution.reap_candidates.map(row => [row.runtime_instance_id, row.reason])).toEqual([
      ['stale-profile-match', 'absolute'],
    ])
    expect(resolution.reap_candidates.some(row => row.runtime_instance_id === 'fresh-profile-mismatch')).toBe(false)
    expect(resolution.reap_candidates.some(row => row.runtime_instance_id === 'stale-cross-group')).toBe(false)

    const reaped = await reapRuntimeMemoryReadyStaleRows(db as any, resolution.reap_candidates, new Date('2026-08-21T00:10:00.000Z'))
    expect(reaped).toHaveLength(1)
    expect(reaped[0].reaped).toBe(false)
    const statuses = await db.query<{ runtime_instance_id: string; status: string }>(
      `SELECT runtime_instance_id, status FROM agent_runtime_instances ORDER BY runtime_instance_id`,
    )
    expect(statuses).toEqual(expect.arrayContaining([
      {runtime_instance_id:'fresh-profile-mismatch',status:null},
      {runtime_instance_id:unitRuntimeId('mcp-stale-cross-group'),status:null},
      {runtime_instance_id:'stale-cross-group',status:null},
      {runtime_instance_id:'stale-profile-match',status:null},
    ]))
    expect(statuses).toHaveLength(4)
  })

  test('two live holders fail closed and revocation selects the sole remaining holder', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({ id: 'older-exact', seen: '2026-08-21T00:08:00.000Z' })
    await seedRuntime({ id: 'newer-exact', seen: '2026-08-21T00:09:00.000Z' })

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })

    expect(resolution.ok).toBe(false)
    expect(resolution.code).toBe('NO_CURRENT_RUNTIME_FOR_PROFILE')
    expect(resolution.current_runtime).toBeNull()
    expect(resolution.current_candidates).toHaveLength(2)
    await db.execute("UPDATE control_plane_leases SET status='released' WHERE holder_runtime_instance_id='older-exact'")
    const sole=await resolveRuntimeMemoryReadyCurrent(db as any,{agentId:'codex-cto',requestedRuntimeKind:'local_process',now:new Date('2026-08-21T00:10:00Z'),policy,inspect})
    expect(sole.current_runtime?.runtime_instance_id).toBe('newer-exact')
  })

  test('a legacy profile tuple cannot break two-holder ambiguity or block a sole relocated holder', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({
      id: 'newest-profile-mismatch',
      session: null,
      home: '/work/agent-comms-mcp',
      seen: '2026-08-21T00:09:59.000Z',
    })
    await seedRuntime({ id: 'older-exact-current', seen: '2026-08-21T00:09:00.000Z' })

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })

    expect(resolution.ok).toBe(false)
    expect(resolution.current_runtime).toBeNull()
    expect(resolution.current_candidates.map(row=>row.runtime_instance_id).sort()).toEqual(['newest-profile-mismatch','older-exact-current'].sort())
    expect(resolution.candidate_exclusions).toEqual([])
    expect(resolution.profile_mismatch_observations).toEqual([])
    await db.execute("UPDATE control_plane_leases SET status='released' WHERE holder_runtime_instance_id='older-exact-current'")
    const sole=await resolveRuntimeMemoryReadyCurrent(db as any,{agentId:'codex-cto',requestedRuntimeKind:'local_process',now:new Date('2026-08-21T00:10:00Z'),policy,inspect})
    expect(sole.ok).toBe(true)
    expect(sole.current_runtime?.checkout_path).toBe('/work/agent-comms-mcp')
  })

  test('distinguishes no rows and stale rows while a sole live mismatch remains resolvable', async () => {
    await seedProfile('codex-cto')
    const noRows = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })
    expect(noRows.code).toBe('NO_CURRENT_RUNTIME_FOR_PROFILE')
    expect(noRows.candidate_absence_reason).toBe('NO_RUNTIME_ROWS')
    expect(noRows.candidate_exclusions).toHaveLength(0)

    await seedRuntime({
      id: 'live-mismatch-only',
      session: null,
      home: '/work/agent-comms-mcp',
      seen: '2026-08-21T00:09:59.000Z',
    })
    const fallback = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })
    expect(fallback).toMatchObject({ ok: true, code: 'RESOLVED', candidate_absence_reason: null })
    expect(fallback.current_runtime?.runtime_instance_id).toBe('live-mismatch-only')
    expect(fallback.candidate_exclusions).toHaveLength(0)

    observations.set('live-mismatch-only',{...observations.get('live-mismatch-only')!,observed_at:'2026-08-20T00:00:00.000Z'})
    const staleOnly = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })
    expect(staleOnly).toMatchObject({
      ok: false,
      code: 'NO_CURRENT_RUNTIME_FOR_PROFILE',
      candidate_absence_reason: 'ONLY_STALE_RUNTIME_ROWS',
    })
  })

  test('ordinary current resolution excludes a fresher bootstrap-bound receipt', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({ id: 'ordinary-exact', seen: '2026-08-21T00:08:00.000Z' })
    await seedRuntime({
      id: 'bootstrap-fresher',
      kind: 'bootstrap_bound_provider',
      seen: '2026-08-21T00:09:59.000Z',
    })

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })

    // The bootstrap receipt has no independent ordinary lease; its underlying MCP is released for this case.
    await db.execute("UPDATE control_plane_leases SET status='released' WHERE holder_runtime_instance_id=$1",[unitRuntimeId('mcp-bootstrap-fresher')])
    const ordinary=await resolveRuntimeMemoryReadyCurrent(db as any,{agentId:'codex-cto',requestedRuntimeKind:'local_process',now:new Date('2026-08-21T00:10:00Z'),policy,inspect})
    expect(ordinary.current_runtime?.runtime_instance_id).toBe('ordinary-exact')
    expect(ordinary.runtime_rows.map(row => row.runtime_instance_id)).toEqual(['ordinary-exact'])
  })

  test('requested kind defines an independent ordinary ranking surface', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({ id: 'local-process-fresher', seen: '2026-08-21T00:09:59.000Z' })
    await seedRuntime({
      id: 'local-tmux-requested',
      kind: 'local_tmux',
      seen: '2026-08-21T00:08:00.000Z',
    })

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_tmux',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })

    expect(resolution.requested_runtime_kind).toBe('local_tmux')
    expect(resolution.current_runtime?.runtime_instance_id).toBe('local-tmux-requested')
    expect(resolution.runtime_rows.map(row => row.runtime_instance_id)).toEqual(['local-tmux-requested'])
  })

  test('bootstrap-bound current resolves only the sealed selected receipt exact binding', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({
      id: 'selected-bootstrap',
      engine: 'codex',
      kind: 'bootstrap_bound_provider',
      seen: '2026-08-21T00:09:00.000Z',
    })

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'bootstrap_bound_provider',
      selectedBootstrapReceipt: {
        runtime_instance_id: 'selected-bootstrap',
        runtime_engine: 'codex',
        session_name: 'discord-cto',
        checkout_path: '/work/codex',
      },
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })

    expect(resolution.ok).toBe(true)
    expect(resolution.current_runtime?.runtime_instance_id).toBe('selected-bootstrap')
    expect(resolution.profile?.runtime_kind).toBeNull()
  })

  test('bootstrap-bound current fails closed without an exact sealed receipt row', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({
      id: 'selected-bootstrap',
      engine: 'codex',
      kind: 'bootstrap_bound_provider',
      seen: '2026-08-21T00:09:00.000Z',
    })

    const missingReceipt = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'bootstrap_bound_provider',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })
    const wrongBinding = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'bootstrap_bound_provider',
      selectedBootstrapReceipt: {
        runtime_instance_id: 'selected-bootstrap',
        runtime_engine: 'codex',
        session_name: 'discord-cto',
        checkout_path: '/work/not-the-sealed-receipt',
      },
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })

    expect(missingReceipt).toMatchObject({ ok: false, code: 'NO_BOOTSTRAP_BOUND_ROW' })
    expect(wrongBinding).toMatchObject({ ok: false, code: 'NO_BOOTSTRAP_BOUND_ROW' })
  })

  test('unknown group uses the frozen 30m/24h defaults', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({
      id: 'unknown-group',
      kind: 'local_tmux',
      source: 'legacy-heartbeat',
      seen: '2026-08-20T23:50:00.000Z',
    })
    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_tmux',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy, inspect,
    })
    expect(resolution.current_runtime).toMatchObject({
      runtime_instance_id: 'unknown-group',
      liveness_ttl_ms: 1_800_000,
      reap_ttl_ms: 86_400_000,
    })
  })

  test('policy rejects unsupported or unsafe values', () => {
    expect(() => parseRuntimeMemoryReadyPolicy('{}')).toThrow('RUNTIME_MEMORY_READY_POLICY_UNSUPPORTED')
    expect(() => parseRuntimeMemoryReadyPolicy(JSON.stringify({
      schema_version: 'runtime-memory-ready-policy/v1',
      default_liveness_ttl_ms: 1,
      default_reap_ttl_ms: 1000,
      backoff: { base_ms: 30_000, cap_ms: 1 },
      groups: [],
    }))).toThrow('default_reap_ttl_ms must be at least 24h')
  })
})
