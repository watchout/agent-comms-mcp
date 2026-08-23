import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
})

afterEach(async () => {
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedProfile(agentId: string): Promise<void> {
  await db.execute(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, channel_port, metadata, home_directory)
     VALUES ($1, $1, 'dev', 'TUI', 'idle', 8789, $2, $3)`,
    [agentId, JSON.stringify({ tmux_session: 'discord-cto' }), '/work/codex'],
  )
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
  await db.execute(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name,
        port, checkout_path, status, started_at, last_seen_at, metadata)
     VALUES ($1, 'codex-cto', $2, $3, $4, 8789, $5, 'running', $6, $6, $7)`,
    [
      input.id,
      input.engine ?? 'TUI',
      input.kind ?? 'local_process',
      Object.hasOwn(input, 'session') ? input.session ?? null : 'discord-cto',
      input.home ?? '/work/codex',
      input.seen,
      JSON.stringify({ source: input.source ?? 'server.ts', ...(input.metadata ?? {}) }),
    ],
  )
}

describe('runtime current resolver', () => {
  test('codex-cto sole live profile mismatch remains current and only the stale same-group row is reapable', async () => {
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

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy,
    })

    expect(resolution.ok).toBe(true)
    expect(resolution.code).toBe('RESOLVED')
    expect(resolution.current_runtime?.runtime_instance_id).toBe('fresh-profile-mismatch')
    expect(resolution.candidate_absence_reason).toBeNull()
    expect(resolution.current_candidates).toHaveLength(1)
    expect(resolution.candidate_exclusions).toHaveLength(0)
    expect(resolution.profile_mismatch_observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'REGISTRATION_PROFILE_MISMATCH',
        runtime_instance_id: 'fresh-profile-mismatch',
        live: true,
        current: true,
        handling: 'WARN_ONLY_CURRENT_FALLBACK',
        registration_metadata_provenance: expect.objectContaining({
          schema_version: 'runtime-registration-metadata-provenance/v1',
        }),
      }),
    ]))
    expect(resolution.reap_candidates.map(row => [row.runtime_instance_id, row.reason])).toEqual([
      ['stale-profile-match', 'absolute'],
    ])
    expect(resolution.reap_candidates.some(row => row.runtime_instance_id === 'fresh-profile-mismatch')).toBe(false)
    expect(resolution.reap_candidates.some(row => row.runtime_instance_id === 'stale-cross-group')).toBe(false)

    const reaped = await reapRuntimeMemoryReadyStaleRows(db as any, resolution.reap_candidates, new Date('2026-08-21T00:10:00.000Z'))
    expect(reaped).toHaveLength(1)
    expect(reaped[0].reaped).toBe(true)
    const statuses = await db.query<{ runtime_instance_id: string; status: string }>(
      `SELECT runtime_instance_id, status FROM agent_runtime_instances ORDER BY runtime_instance_id`,
    )
    expect(statuses).toEqual([
      { runtime_instance_id: 'fresh-profile-mismatch', status: 'running' },
      { runtime_instance_id: 'stale-cross-group', status: 'running' },
      { runtime_instance_id: 'stale-profile-match', status: 'stopped' },
    ])
  })

  test('freshest exact profile tuple is selected deterministically', async () => {
    await seedProfile('codex-cto')
    await seedRuntime({ id: 'older-exact', seen: '2026-08-21T00:08:00.000Z' })
    await seedRuntime({ id: 'newer-exact', seen: '2026-08-21T00:09:00.000Z' })

    const resolution = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy,
    })

    expect(resolution.ok).toBe(true)
    expect(resolution.code).toBe('RESOLVED')
    expect(resolution.current_runtime?.runtime_instance_id).toBe('newer-exact')
  })

  test('de-prioritizes a newer profile mismatch when an exact live candidate exists', async () => {
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
      policy,
    })

    expect(resolution.ok).toBe(true)
    expect(resolution.current_runtime?.runtime_instance_id).toBe('older-exact-current')
    expect(resolution.current_candidates.map(row => row.runtime_instance_id)).toEqual(['older-exact-current'])
    expect(resolution.candidate_exclusions.find(row => row.runtime_instance_id === 'newest-profile-mismatch')).toMatchObject({
      code: 'PROFILE_MISMATCH_DEPRIORITIZED',
      live: true,
      handling: 'WARN_ONLY_RANK_BELOW_EXACT',
      mismatches: expect.arrayContaining([
        expect.objectContaining({ field: 'session_name', expected: 'discord-cto', observed: null }),
        expect.objectContaining({ field: 'checkout_path', expected: '/work/codex', observed: '/work/agent-comms-mcp' }),
      ]),
    })
    expect(resolution.profile_mismatch_observations).toEqual([
      expect.objectContaining({
        code: 'REGISTRATION_PROFILE_MISMATCH',
        runtime_instance_id: 'newest-profile-mismatch',
        current: false,
        handling: 'WARN_ONLY_RANK_BELOW_EXACT',
      }),
    ])
  })

  test('distinguishes no rows and stale rows while a sole live mismatch remains resolvable', async () => {
    await seedProfile('codex-cto')
    const noRows = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy,
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
      policy,
    })
    expect(fallback).toMatchObject({ ok: true, code: 'RESOLVED', candidate_absence_reason: null })
    expect(fallback.current_runtime?.runtime_instance_id).toBe('live-mismatch-only')
    expect(fallback.candidate_exclusions).toHaveLength(0)

    await db.execute(
      `UPDATE agent_runtime_instances
          SET last_seen_at = $1, started_at = $1
        WHERE runtime_instance_id = $2`,
      ['2026-08-20T00:00:00.000Z', 'live-mismatch-only'],
    )
    const staleOnly = await resolveRuntimeMemoryReadyCurrent(db as any, {
      agentId: 'codex-cto',
      requestedRuntimeKind: 'local_process',
      now: new Date('2026-08-21T00:10:00.000Z'),
      policy,
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
      policy,
    })

    expect(resolution.current_runtime?.runtime_instance_id).toBe('ordinary-exact')
    expect(resolution.runtime_rows.map(row => row.runtime_instance_id)).toEqual(['ordinary-exact'])
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
      policy,
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
      policy,
    })

    expect(resolution.ok).toBe(true)
    expect(resolution.current_runtime?.runtime_instance_id).toBe('selected-bootstrap')
    expect(resolution.profile?.runtime_kind).toBe('TUI')
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
      policy,
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
      policy,
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
      policy,
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
