import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { parseRuntimeMemoryReadyPolicy, type RuntimeMemoryReadyPolicy } from '../core/runtime-current-resolver'
import {
  queryRuntimeMemoryReadyIdentityMonitor,
  reconcileRuntimeMemoryReadyIdentity,
} from '../core/runtime-memory-ready-identity'
import { evaluateRuntimeMemoryReadyGate, recordRuntimeMemoryReadyEvidence } from '../core/runtime-memory-ready'

let tmp: string
let db: SqliteAdapter
let policy: RuntimeMemoryReadyPolicy
const now = new Date('2026-08-23T00:10:00.000Z')

beforeEach(() => {
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
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedAgent(input: {
  agentId: string
  session: string
  home: string
  port: number
}): Promise<void> {
  await db.execute(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, channel_port, metadata,
        home_directory, profile_enabled, disabled_at, profile_revision, profile_source)
     VALUES ($1, $1, 'dev', 'TUI', 'idle', $2, $3, $4, 1, NULL, 7, 'fixture')`,
    [input.agentId, input.port, JSON.stringify({ tmux_session: input.session }), input.home],
  )
}

async function seedRuntime(input: {
  runtimeId: string
  agentId: string
  session: string | null
  checkout: string
  port: number
  status: 'running' | 'stopped'
  seen: string
}): Promise<void> {
  await db.execute(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name,
        port, checkout_path, commit_sha, status, started_at, stopped_at, last_seen_at, metadata)
     VALUES ($1, $2, 'TUI', 'local_process', $3, $4, $5, 'head', $6, $8, $7, $8, $9)`,
    [
      input.runtimeId,
      input.agentId,
      input.session,
      input.port,
      input.checkout,
      input.status,
      input.status === 'stopped' ? input.seen : null,
      input.seen,
      JSON.stringify({ source: 'server.ts' }),
    ],
  )
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
    checkout_commit_sha: 'head',
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

describe('runtime memory-ready identity reconciliation', () => {
  test('heartbeat rotation refreshes evidence to the devauditor current instance and clears mismatch', async () => {
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
      status: 'REFRESHED',
      code: 'EVIDENCE_BINDING_REFRESHED',
      previous_evidence_runtime_instance_id: 'ec08bc6f-466f-4727-853f-81895e4f6d05',
      current_runtime_instance_id: '2e8da261-9017-4b2d-ab2d-1378432801a1',
    })

    const after = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'devauditor',
      project: 'agent-comms-mcp',
      now,
      policy,
    })
    expect(after.ok).toBe(true)
    expect(after.reason).toBe('ready')
    expect(after.runtime_instance_id).toBe('2e8da261-9017-4b2d-ab2d-1378432801a1')

    const idempotent = await reconcileRuntimeMemoryReadyIdentity(db as any, {
      agentId: 'devauditor',
      observedRuntimeInstanceId: '2e8da261-9017-4b2d-ab2d-1378432801a1',
    }, { now, policy, resolveProject })
    expect(idempotent.status).toBe('UNCHANGED')
  })

  test('read-only monitor lists codex-cto foreign heartbeat and devauditor superseded binding', async () => {
    await seedAgent({ agentId: 'codex-cto', session: 'discord-cto', home: '/work/codex', port: 8808 })
    await seedRuntime({
      runtimeId: 'eb785a47-81fb-4907-83a4-0cac5b62fce6',
      agentId: 'codex-cto',
      session: null,
      checkout: '/work/agent-comms-mcp',
      port: 8808,
      status: 'running',
      seen: '2026-08-23T00:09:59.000Z',
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
      profile_mismatch_excluded: 1,
      superseded_evidence_binding: 1,
    })
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PROFILE_MISMATCH_EXCLUDED',
        agent_id: 'codex-cto',
        runtime_instance_id: 'eb785a47-81fb-4907-83a4-0cac5b62fce6',
      }),
      expect.objectContaining({
        code: 'SUPERSEDED_EVIDENCE_BINDING',
        agent_id: 'devauditor',
        runtime_instance_id: '2e8da261-9017-4b2d-ab2d-1378432801a1',
      }),
    ]))
  })
})
