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

  test('profile home directory is the schema-stable canonical workspace fallback', async () => {
    const workspace = join(tmp, 'canonical-project')
    mkdirSync(workspace)
    await seedRuntime('canonical-fallback', 39136)
    await db.execute(
      `UPDATE agents SET home_directory=$1 WHERE agent_id='canonical-fallback'`,
      [workspace],
    )

    await expect(resolveRuntimeMemoryReadyProject(db as any, 'canonical-fallback')).resolves.toEqual({
      agent_id: 'canonical-fallback',
      project: 'canonical-project',
      workspace_path: workspace,
      source: 'canonical_workspace',
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

  test('gate follows the common freshest exact-profile resolver instead of evidence-bound precedence', async () => {
    await seedRuntime('aun', 8811)
    await db.execute(
      `UPDATE agents
          SET metadata=$1, home_directory=$2
        WHERE agent_id='aun'`,
      [JSON.stringify({ tmux_session: 'discord-aun' }), '/tmp/aun'],
    )
    await db.execute(
      `UPDATE agent_runtime_instances
          SET runtime_instance_id='runtime-aun-canonical', session_name='discord-aun', last_seen_at='2026-06-01T00:00:01.000Z'
        WHERE agent_id='aun'`,
    )
    await db.execute(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port, checkout_path, commit_sha, status, started_at, last_seen_at)
       VALUES ('runtime-aun-competing', 'aun', 'codex', 'local_process', 'discord-aun', 8811, '/tmp/aun', 'wrong-sha', 'running',
               '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:05.000Z')`,
    )
    await recordReady('aun', {
      project: 'codex-aun',
      runtime_instance_id: 'runtime-aun-canonical',
      session_name: 'discord-aun',
      port: 8811,
    })
    await recordReady('aun', {
      project: 'agent-comms-mcp',
      runtime_instance_id: 'runtime-aun-competing',
      session_name: 'discord-aun',
      port: 8811,
      checkout_path: '/tmp/aun',
      checkout_commit_sha: 'wrong-sha',
    })

    const evaluate = () => evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'aun',
      project: 'codex-aun',
      now: new Date('2026-06-01T00:00:06.000Z'),
    })
    const competingNewest = await evaluate()
    expect(competingNewest.ok).toBe(false)
    expect(competingNewest.reason).toBe('runtime_instance_mismatch')
    expect(competingNewest.runtime_instance_id).toBe('runtime-aun-competing')
    expect(competingNewest.evidence_id).not.toBeNull()

    await db.execute(
      `UPDATE agent_runtime_instances
          SET last_seen_at=CASE runtime_instance_id
            WHEN 'runtime-aun-canonical' THEN '2026-06-01T00:00:10.000Z'
            ELSE '2026-06-01T00:00:02.000Z'
          END
        WHERE agent_id='aun'`,
    )
    const canonicalNewest = await evaluate()
    expect(canonicalNewest.ok).toBe(true)
    expect(canonicalNewest.runtime_instance_id).toBe('runtime-aun-canonical')
    expect(canonicalNewest.evidence_id).toBe(competingNewest.evidence_id)
  })

  test('latest exact-project evidence never falls back when its runtime is inactive', async () => {
    await seedRuntime('no-fallback', 39140)
    await recordReady('no-fallback', {
      completed_at: '2026-06-01T00:00:02.000Z',
    })
    await recordReady('no-fallback', {
      runtime_instance_id: 'runtime-no-fallback-stopped',
      completed_at: '2026-06-01T00:00:04.000Z',
    })
    await db.execute(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port, checkout_path, commit_sha, status, started_at, last_seen_at)
       VALUES ('runtime-no-fallback-stopped', 'no-fallback', 'codex', 'local_process', 'no-fallback-session',
               39140, '/tmp/no-fallback', 'head-sha', 'stopped', '2026-06-01T00:00:03.000Z',
               '2026-06-01T00:00:04.000Z')`,
    )

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'no-fallback',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:05.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('runtime_instance_mismatch')
    expect(gate.evidence_id).not.toBeNull()
    expect(gate.details.evidence_runtime_instance_id).toBe('runtime-no-fallback-stopped')
  })

  test('equal evidence timestamps select the highest id without runtime fallback', async () => {
    await seedRuntime('evidence-order', 39141)
    await recordReady('evidence-order', {
      completed_at: '2026-06-01T00:00:02.000Z',
    })
    await recordReady('evidence-order', {
      runtime_instance_id: 'runtime-evidence-order-missing',
      completed_at: '2026-06-01T00:00:02.000Z',
    })

    const latest = await db.queryOne<{ id: number }>(
      `SELECT id FROM runtime_memory_ready_evidence
        WHERE agent_id='evidence-order' AND project='agent-comms-mcp'
        ORDER BY completed_at DESC, id DESC LIMIT 1`,
    )
    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'evidence-order',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('runtime_instance_mismatch')
    expect(Number(gate.evidence_id)).toBe(Number(latest?.id))
    expect(gate.details.evidence_runtime_instance_id).toBe('runtime-evidence-order-missing')
  })

  const profileMismatchCases = [
    {
      label: 'session',
      agentId: 'profile-session-mismatch',
      update: `session_name='runtime-only-session'`,
      evidence: { session_name: 'runtime-only-session' },
      reason: 'session_mismatch',
      details: {
        profile_session_name: 'profile-session-mismatch-session',
        runtime_session_name: 'runtime-only-session',
      },
    },
    {
      label: 'port',
      agentId: 'profile-port-mismatch',
      update: 'port=39152',
      evidence: { port: 39152 },
      reason: 'port_mismatch',
      details: {
        profile_port: 39142,
        runtime_port: 39152,
      },
    },
    {
      label: 'checkout',
      agentId: 'profile-checkout-mismatch',
      update: `checkout_path='/tmp/runtime-only-checkout'`,
      evidence: { checkout_path: '/tmp/runtime-only-checkout' },
      reason: 'checkout_path_mismatch',
      details: {
        profile_checkout_path: '/tmp/profile-checkout-mismatch',
        runtime_checkout_path: '/tmp/runtime-only-checkout',
      },
    },
  ] as const

  for (const profileMismatch of profileMismatchCases) {
    test(`exact evidence fails closed on ${profileMismatch.label} mismatch between profile and runtime`, async () => {
      await seedRuntime(profileMismatch.agentId, 39142)
      await db.execute(
        `UPDATE agent_runtime_instances
            SET ${profileMismatch.update}
          WHERE agent_id=$1`,
        [profileMismatch.agentId],
      )
      await recordReady(profileMismatch.agentId, profileMismatch.evidence)

      const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
        agent_id: profileMismatch.agentId,
        project: 'agent-comms-mcp',
        now: new Date('2026-06-01T00:00:03.000Z'),
      })

      expect(gate.ok).toBe(false)
      expect(gate.reason).toBe(profileMismatch.reason)
      expect(gate.details).toMatchObject(profileMismatch.details)
      if (profileMismatch.label !== 'port') {
        expect(gate.details).toMatchObject({
          profile_mismatch_observations: [expect.objectContaining({
            code: 'REGISTRATION_PROFILE_MISMATCH',
            current: true,
            handling: 'WARN_ONLY_CURRENT_FALLBACK',
          })],
        })
      }
    })
  }

  test('exact evidence fails closed on a resolver-reported runtime-engine-only profile mismatch', async () => {
    const agentId = 'profile-runtime-engine-mismatch'
    await seedRuntime(agentId, 39142)
    await db.execute(
      `UPDATE agent_runtime_instances
          SET runtime_engine='claude-code'
        WHERE agent_id=$1`,
      [agentId],
    )
    await recordReady(agentId, { port: 39142 })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: agentId,
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('registration_profile_mismatch')
    expect(gate.details).toMatchObject({
      current_resolution_source: 'live_profile_mismatch_fallback',
      registration_profile_mismatch: {
        code: 'REGISTRATION_PROFILE_MISMATCH',
        runtime_instance_id: `runtime-${agentId}`,
        current: true,
        handling: 'WARN_ONLY_CURRENT_FALLBACK',
        mismatches: [{
          field: 'runtime_engine',
          expected: 'codex',
          observed: 'claude-code',
        }],
      },
      repair_signal: 'RUNTIME_REGISTRATION_PROFILE_CORRECTION_REQUIRED',
    })
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

  test('newer same-agent B5 runtime cannot shadow an older wrong-agent port occupant', async () => {
    await seedRuntime('port-shadow-target', 39111)
    await db.execute(
      `UPDATE agent_runtime_instances
          SET runtime_kind='bootstrap_bound_provider', last_seen_at='2026-06-01T00:00:05.000Z'
        WHERE runtime_instance_id='runtime-port-shadow-target'`,
    )
    await db.execute(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, channel_port)
       VALUES ('port-shadow-other', 'port-shadow-other', 'dev', 'codex', 'idle', 39111)`,
    )
    await db.execute(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port, checkout_path, commit_sha, status, started_at, last_seen_at)
       VALUES ('runtime-port-shadow-same-agent', 'port-shadow-target', 'codex', 'local_process',
               'port-shadow-target-session', 39111, '/tmp/port-shadow-target', 'head-sha', 'running',
               '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:10.000Z'),
              ('runtime-port-shadow-other', 'port-shadow-other', 'codex', 'local_process',
               'port-shadow-other-session', 39111, '/tmp/port-shadow-other', 'other-sha', 'active',
               '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z')`,
    )
    await recordReady('port-shadow-target', {
      runtime_instance_id: 'runtime-port-shadow-target',
      port: 39111,
    })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'port-shadow-target',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:11.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('port_identity_mismatch')
    expect(gate.details).toMatchObject({
      expected_port: 39111,
      occupant_agent_id: 'port-shadow-other',
      occupant_runtime_instance_id: 'runtime-port-shadow-other',
    })
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
    await db.execute(
      `UPDATE agent_runtime_instances SET last_seen_at=$1 WHERE runtime_instance_id='runtime-wasurezu'`,
      [new Date().toISOString()],
    )

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
