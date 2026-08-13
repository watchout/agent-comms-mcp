import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  buildWasurezuBootstrapEvidence,
  evaluateRuntimeMemoryReadyGate,
  recordRuntimeMemoryReadyEvidence,
  resolveRuntimeMemoryReadyProject,
} from '../core/runtime-memory-ready'
import { memoryReadyBootstrap } from '../bin/aun/memory-ready'

let tmp: string
let dbPath: string
let db: SqliteAdapter

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'memory-ready-'))
  dbPath = join(tmp, 'test.db')
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
})

afterEach(async () => {
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedRuntime(agentId = 'agent-com-dev', port = 39100): Promise<void> {
  await db.execute(
    `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, channel_port, metadata, home_directory)
     VALUES ($1, $1, 'dev', 'codex', 'idle', $2, $3, $4)`,
    [agentId, port, JSON.stringify({ tmux_session: `${agentId}-session` }), `/tmp/${agentId}`],
  )
  await db.execute(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port, checkout_path, commit_sha, status, started_at, last_seen_at)
     VALUES ($1, $2, 'codex', 'local_process', $3, $4, $5, 'head-sha', 'running', $6, $7)`,
    [`runtime-${agentId}`, agentId, `${agentId}-session`, port, `/tmp/${agentId}`, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z'],
  )
}

async function recordReady(agentId = 'agent-com-dev', overrides: Record<string, unknown> = {}): Promise<void> {
  await recordRuntimeMemoryReadyEvidence(db as any, {
    agent_id: agentId,
    project: 'agent-comms-mcp',
    runtime_instance_id: `runtime-${agentId}`,
    profile_revision: 1,
    profile_source: 'legacy',
    session_name: `${agentId}-session`,
    port: 39100,
    expected_agent_id: agentId,
    checkout_path: `/tmp/${agentId}`,
    checkout_commit_sha: 'head-sha',
    recovery_command: 'mcp__wasurezu__recover_context',
    result_status: 'ready',
    completed_at: '2026-06-01T00:00:02.000Z',
    evidence_path: `/tmp/${agentId}-memory-ready.json`,
    evidence_log_id: `${agentId}-memory-ready-log`,
    valid_until: '2099-01-01T00:00:00.000Z',
    source: 'agent_memory_boot_recovery',
    metadata: {},
    ...overrides,
  } as any)
}

async function bindPrimaryWorkspace(agentId: string, workspacePath: string, workspaceId: string): Promise<void> {
  await db.execute(
    `INSERT INTO agent_workspaces (workspace_id, name, local_path)
     VALUES ($1, $2, $3)`,
    [workspaceId, workspaceId, workspacePath],
  )
  await db.execute(
    `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
     VALUES ($1, $2, 'primary', 1)`,
    [agentId, workspaceId],
  )
}

function auditedBypassMetadata(agentId = 'agent-com-dev', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: 'codex-cto',
    reason: 'operator-approved memory-ready queue resume bypass',
    timestamp: '2026-06-01T00:00:02.000Z',
    target_agent: agentId,
    queue_scope: {
      status: 'pending',
      action_kind: 'invoke_codex_runner',
    },
    expires_at: '2026-06-01T00:10:00.000Z',
    ...overrides,
  }
}

describe('runtime memory-ready evidence gate', () => {
  test('per-agent project resolution admits only current exact-runtime evidence for the target workspace', async () => {
    const workspace = join(tmp, 'codex')
    mkdirSync(workspace)
    await seedRuntime('codex-cto', 39130)
    await bindPrimaryWorkspace('codex-cto', workspace, 'workspace-codex')
    await recordReady('codex-cto', {
      project: 'agent-comms-mcp',
      port: 39130,
      valid_until: '2026-06-01T00:00:02.000Z',
    })
    await recordReady('codex-cto', {
      project: 'codex',
      port: 39130,
      valid_until: '2099-01-01T00:00:00.000Z',
    })

    const resolution = await resolveRuntimeMemoryReadyProject(db as any, 'codex-cto')
    expect(resolution).toEqual({
      agent_id: 'codex-cto',
      project: 'codex',
      workspace_path: workspace,
      source: 'active_primary_workspace',
    })
    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'codex-cto',
      project: resolution.project,
      now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.ok).toBe(true)
    expect(gate.project).toBe('codex')
    expect(gate.reason).toBe('ready')
  })

  test('per-agent project resolution fails closed on missing, ambiguous, relative, and absent workspaces', async () => {
    await seedRuntime('missing-workspace', 39131)
    await db.execute(`UPDATE agents SET home_directory=NULL WHERE agent_id='missing-workspace'`)
    await expect(resolveRuntimeMemoryReadyProject(db as any, 'missing-workspace'))
      .rejects.toMatchObject({ code: 'WORKSPACE_MISSING' })

    await seedRuntime('ambiguous-workspace', 39132)
    const first = join(tmp, 'first-project')
    const second = join(tmp, 'second-project')
    mkdirSync(first)
    mkdirSync(second)
    await bindPrimaryWorkspace('ambiguous-workspace', first, 'workspace-first')
    await bindPrimaryWorkspace('ambiguous-workspace', second, 'workspace-second')
    await expect(resolveRuntimeMemoryReadyProject(db as any, 'ambiguous-workspace'))
      .rejects.toMatchObject({ code: 'WORKSPACE_AMBIGUOUS' })

    await seedRuntime('relative-workspace', 39133)
    await bindPrimaryWorkspace('relative-workspace', 'relative/project', 'workspace-relative')
    await expect(resolveRuntimeMemoryReadyProject(db as any, 'relative-workspace'))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_ABSOLUTE' })

    await seedRuntime('absent-workspace', 39134)
    await bindPrimaryWorkspace('absent-workspace', join(tmp, 'absent-project'), 'workspace-absent')
    await expect(resolveRuntimeMemoryReadyProject(db as any, 'absent-workspace'))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
  })

  test('explicit per-agent memory project override is deterministic without a workspace fallback', async () => {
    await seedRuntime('project-override', 39135)
    await db.execute(
      `UPDATE agents SET home_directory=NULL, metadata=$1 WHERE agent_id='project-override'`,
      [JSON.stringify({ memory_project: 'iyasaka-arc' })],
    )
    await expect(resolveRuntimeMemoryReadyProject(db as any, 'project-override')).resolves.toEqual({
      agent_id: 'project-override',
      project: 'iyasaka-arc',
      workspace_path: null,
      source: 'agent_metadata_override',
    })
  })

  test('valid current-runtime-bound evidence passes', async () => {
    await seedRuntime()
    await recordReady()

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(true)
    expect(gate.reason).toBe('ready')
    expect(gate.runtime_instance_id).toBe('runtime-agent-com-dev')
    expect(gate.evidence_path).toBe('/tmp/agent-com-dev-memory-ready.json')
  })

  test('missing, stale, and mismatched evidence fail closed', async () => {
    await seedRuntime()
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('missing_evidence')

    await recordReady('agent-com-dev', { valid_until: '2026-06-01T00:00:02.000Z' })
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('expired')

    await db.execute(`DELETE FROM runtime_memory_ready_evidence`)
    await recordReady('agent-com-dev', { runtime_instance_id: 'runtime-other' })
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('runtime_instance_mismatch')
  })

  test('bypassed evidence without audited metadata fails closed', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', {
      result_status: 'bypassed',
      source: 'explicit_operator_bypass',
      metadata: {},
    })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: {
        status: 'pending',
        action_kind: 'invoke_codex_runner',
      },
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('bypass_metadata_missing')
    const missing = gate.details.missing as string[]
    expect(missing).toContain('actor')
    expect(missing).toContain('queue_scope')
  })

  test('bypassed evidence passes only with bounded audited metadata', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', {
      result_status: 'bypassed',
      source: 'explicit_operator_bypass',
      metadata: auditedBypassMetadata(),
    })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: {
        status: 'pending',
        action_kind: 'invoke_codex_runner',
      },
    })

    expect(gate.ok).toBe(true)
    expect(gate.reason).toBe('bypassed')
  })

  test('bypassed evidence with mismatched queue scope fails closed', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', {
      result_status: 'bypassed',
      source: 'explicit_operator_bypass',
      metadata: auditedBypassMetadata('agent-com-dev', {
        queue_scope: {
          status: 'received',
          action_kind: 'wake_received',
        },
      }),
    })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: {
        status: 'pending',
        action_kind: 'invoke_codex_runner',
      },
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('bypass_scope_mismatch')
  })

  test('wrong identity on occupied expected port fails readiness', async () => {
    await db.execute(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, channel_port)
       VALUES ('target-dev', 'target-dev', 'dev', 'codex', 'idle', 39110),
              ('other-dev', 'other-dev', 'dev', 'codex', 'idle', 39110)`,
    )
    await db.execute(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, session_name, port, status, started_at, last_seen_at)
       VALUES ('runtime-other-dev', 'other-dev', 'codex', 'other-session', 39110, 'running', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z')`,
    )

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'target-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('port_identity_mismatch')
    expect(gate.details.occupant_agent_id).toBe('other-dev')
  })

  test('Wasurezu bootstrap evidence is queue-independent metadata', () => {
    const evidence = buildWasurezuBootstrapEvidence({
      agent_id: 'wasurezu',
      project: 'agent-comms-mcp',
      runtime_instance_id: 'runtime-wasurezu',
      session_name: 'wasurezu-session',
      port: 39120,
      completed_at: '2026-06-01T00:00:00.000Z',
    })

    expect(evidence.source).toBe('wasurezu_boot_recovery')
    expect(evidence.metadata).toMatchObject({
      bootstrap_without_aun_queue: true,
      live_discord_send: false,
      launchagent_mutation: false,
    })
  })

  test('Wasurezu bootstrap command records ready evidence without queue or live activation dependencies', async () => {
    await seedRuntime('wasurezu', 39120)

    const result = await memoryReadyBootstrap({
      agentId: 'wasurezu',
      project: 'agent-comms-mcp',
      runtimeInstanceId: 'runtime-wasurezu',
      sessionName: 'wasurezu-session',
      port: '39120',
      checkoutPath: '/tmp/wasurezu',
      checkoutCommitSha: 'head-sha',
      evidencePath: '/tmp/wasurezu-bootstrap-memory-ready.json',
      evidenceLogId: 'wasurezu-bootstrap-memory-ready-log',
      env: {
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        AGENT_ID: 'wasurezu',
        AGENT_COM_EXPECTED_AGENT_ID: 'wasurezu',
      },
    })

    expect(result.code).toBe(0)
    const body = JSON.parse(result.stdout)
    expect(body).toMatchObject({
      ok: true,
      mode: 'memory-ready-bootstrap',
      mutation_performed: true,
      live_discord_send: false,
      launchagent_mutation: false,
      queue_dependency: false,
      evidence_log_id: 'wasurezu-bootstrap-memory-ready-log',
      memory_ready: {
        ok: true,
        reason: 'ready',
        evidence_path: '/tmp/wasurezu-bootstrap-memory-ready.json',
      },
    })
    const evidenceRow = await db.queryOne<{ metadata: string }>(
      `SELECT metadata FROM runtime_memory_ready_evidence WHERE agent_id=$1 AND evidence_log_id=$2`,
      ['wasurezu', 'wasurezu-bootstrap-memory-ready-log'],
    )
    expect(JSON.parse(evidenceRow?.metadata ?? '{}')).toMatchObject({
      bootstrap_without_aun_queue: true,
      live_discord_send: false,
      launchagent_mutation: false,
    })
  })
})
