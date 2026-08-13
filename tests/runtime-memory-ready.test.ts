import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  assertRuntimeMemoryReadyAuthorityCurrent,
  buildWasurezuBootstrapEvidence,
  evaluateRuntimeMemoryReadyGate,
  recordRuntimeMemoryReadyEvidence,
  resolveRuntimeMemoryReadyProject,
  runtimeMemoryReadyProjectOverrideFromEnv,
  RuntimeMemoryReadyProjectResolutionError,
} from '../core/runtime-memory-ready'
import { memoryReadyBootstrap } from '../bin/aun/memory-ready'

let tmp: string
let dbPath: string
let db: SqliteAdapter
const runtimeAuthority = new Map<string, { workspace: string; workspaceId: string; commit: string; port: number }>()

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'memory-ready-'))
  dbPath = join(tmp, 'test.db')
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
  runtimeAuthority.clear()
})

afterEach(async () => {
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedRuntime(agentId = 'agent-com-dev', port = 39100, bindAuthority = true): Promise<void> {
  const workspace = join(tmp, 'workspaces', agentId, 'agent-comms-mcp')
  mkdirSync(workspace, { recursive: true })
  execFileSync('/usr/bin/git', ['init', '-q', workspace])
  writeFileSync(join(workspace, 'tracked.txt'), `${agentId}\n`)
  execFileSync('/usr/bin/git', ['-C', workspace, 'add', 'tracked.txt'])
  execFileSync('/usr/bin/git', ['-C', workspace, '-c', 'user.name=AUN Test', '-c', 'user.email=aun@example.invalid', 'commit', '-qm', 'fixture'])
  const commit = execFileSync('/usr/bin/git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const workspaceId = `workspace-${agentId}`
  runtimeAuthority.set(agentId, { workspace: realpathSync(workspace), workspaceId, commit, port })
  await db.execute(
    `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, channel_port, metadata, home_directory)
     VALUES ($1, $1, 'dev', 'codex', 'idle', $2, $3, $4)`,
    [agentId, port, JSON.stringify({ tmux_session: `${agentId}-session` }), workspace],
  )
  if (bindAuthority) {
    await db.execute(
      `INSERT INTO agent_workspaces (workspace_id, name, local_path) VALUES ($1, 'agent-comms-mcp', $2)`,
      [workspaceId, workspace],
    )
    await db.execute(
      `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
       VALUES ($1, $2, 'primary', true)`,
      [agentId, workspaceId],
    )
  }
  await db.execute(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind, session_name, port,
        checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
     VALUES ($1, $2, $3, 'codex', 'local_process', $4, $5, $6, $7, 'running', $8, $9, $10)`,
    [`runtime-${agentId}`, agentId, bindAuthority ? workspaceId : null, `${agentId}-session`, port, workspace, commit,
      '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z', JSON.stringify({ tuple_digest: `transport-${agentId}` })],
  )
}

async function recordReady(agentId = 'agent-com-dev', overrides: Record<string, unknown> = {}): Promise<void> {
  const authority = runtimeAuthority.get(agentId)
  if (!authority) throw new Error(`runtime authority fixture missing for ${agentId}`)
  await recordRuntimeMemoryReadyEvidence(db as any, {
    agent_id: agentId,
    project: 'agent-comms-mcp',
    runtime_instance_id: `runtime-${agentId}`,
    profile_revision: 1,
    profile_source: 'legacy',
    session_name: `${agentId}-session`,
    port: authority.port,
    expected_agent_id: agentId,
    checkout_path: authority.workspace,
    checkout_commit_sha: authority.commit,
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
    await recordReady()
    await db.execute(`UPDATE runtime_memory_ready_evidence SET runtime_instance_id='runtime-other'`)
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('runtime_instance_mismatch')

    await db.execute(`UPDATE runtime_memory_ready_evidence SET runtime_instance_id='runtime-agent-com-dev', checkout_path=NULL, checkout_commit_sha=NULL`)
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('checkout_path_mismatch')
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

  test('ready evidence may bind exact queue/message and created-after metadata', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', {
      metadata: { queue_scope: { queue_id: '42', message_id: 'message-42', created_after: '2026-06-01T00:00:00.000Z' } },
    })
    let gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: { queue_id: 42, message_id: 'message-42', created_at: '2026-06-01T00:00:01.000Z' },
    })
    expect(gate.ok).toBe(true)
    gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: { queue_id: 43, message_id: 'message-42', created_at: '2026-06-01T00:00:01.000Z' },
    })
    expect(gate.reason).toBe('queue_scope_mismatch')
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

  test('same-basename checkout at a different root and null runtime identity fail closed', async () => {
    await seedRuntime()
    const authority = runtimeAuthority.get('agent-com-dev')!
    const shadow = join(tmp, 'shadow', 'agent-comms-mcp')
    mkdirSync(join(tmp, 'shadow'), { recursive: true })
    execFileSync('/usr/bin/git', ['clone', '-q', authority.workspace, shadow])
    await db.execute(`UPDATE agent_runtime_instances SET checkout_path=$1 WHERE agent_id='agent-com-dev'`, [shadow])
    let gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.reason).toBe('authority_tuple_invalid')
    expect(gate.details.reason).toBe('runtime_checkout_realpath_mismatch')

    await db.execute(`UPDATE agent_runtime_instances SET checkout_path=NULL, commit_sha=NULL WHERE agent_id='agent-com-dev'`)
    gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.reason).toBe('authority_tuple_invalid')
    expect(gate.details.field).toBe('runtime.checkout_path')
  })

  test('dirty worktree and evidence tree tampering fail closed', async () => {
    await seedRuntime()
    await recordReady()
    const authority = runtimeAuthority.get('agent-com-dev')!
    writeFileSync(join(authority.workspace, 'untracked.txt'), 'dirty\n')
    let gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.reason).toBe('authority_tuple_invalid')
    expect(gate.details.reason).toBe('git_worktree_dirty')
    rmSync(join(authority.workspace, 'untracked.txt'))

    const row = await db.queryOne<{ metadata: string }>(`SELECT metadata FROM runtime_memory_ready_evidence LIMIT 1`)
    const metadata = JSON.parse(row!.metadata)
    metadata.memory_ready_authority.git_tree_sha = '0'.repeat(40)
    metadata.memory_ready_authority.workspace_owner_uid += 1
    await db.execute(`UPDATE runtime_memory_ready_evidence SET metadata=$1`, [JSON.stringify(metadata)])
    gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.reason).toBe('authority_tuple_mismatch')
    expect(gate.details.changed_fields).toContain('git_tree_sha')
    expect(gate.details.changed_fields).toContain('workspace_owner_uid')
  })

  test('profile, session, port, and transport drift invalidate the pre-gate tuple', async () => {
    await seedRuntime()
    await recordReady()
    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.ok).toBe(true)
    const token = gate.project_resolution!

    await db.execute(`UPDATE agents SET profile_revision=profile_revision+1 WHERE agent_id='agent-com-dev'`)
    await expect(assertRuntimeMemoryReadyAuthorityCurrent(db as any, token)).rejects.toMatchObject({ code: 'authority_tuple_drift' })
    await db.execute(`UPDATE agents SET profile_revision=profile_revision-1 WHERE agent_id='agent-com-dev'`)
    await db.execute(`UPDATE agent_runtime_instances SET session_name='retargeted-session' WHERE agent_id='agent-com-dev'`)
    await expect(assertRuntimeMemoryReadyAuthorityCurrent(db as any, token)).rejects.toMatchObject({ code: 'authority_tuple_drift' })
    await db.execute(`UPDATE agent_runtime_instances SET session_name='agent-com-dev-session', port=39101 WHERE agent_id='agent-com-dev'`)
    await db.execute(`UPDATE agents SET channel_port=39101 WHERE agent_id='agent-com-dev'`)
    await expect(assertRuntimeMemoryReadyAuthorityCurrent(db as any, token)).rejects.toMatchObject({ code: 'authority_tuple_drift' })
    await db.execute(`UPDATE agent_runtime_instances SET port=39100, metadata=$1 WHERE agent_id='agent-com-dev'`, [JSON.stringify({ tuple_digest: 'transport-drift' })])
    await db.execute(`UPDATE agents SET channel_port=39100 WHERE agent_id='agent-com-dev'`)
    await expect(assertRuntimeMemoryReadyAuthorityCurrent(db as any, token)).rejects.toMatchObject({ code: 'authority_tuple_drift' })
  })

  test('symlink retarget after pre-gate is detected before a protected boundary', async () => {
    await seedRuntime()
    const authority = runtimeAuthority.get('agent-com-dev')!
    const lexical = join(tmp, 'workspace-link')
    symlinkSync(authority.workspace, lexical)
    await db.execute(`UPDATE agent_workspaces SET local_path=$1 WHERE workspace_id=$2`, [lexical, authority.workspaceId])
    await recordReady()
    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.ok).toBe(true)

    const shadow = join(tmp, 'retarget', 'agent-comms-mcp')
    mkdirSync(join(tmp, 'retarget'), { recursive: true })
    execFileSync('/usr/bin/git', ['clone', '-q', authority.workspace, shadow])
    rmSync(lexical)
    symlinkSync(shadow, lexical)
    await expect(assertRuntimeMemoryReadyAuthorityCurrent(db as any, gate.project_resolution!))
      .rejects.toMatchObject({ code: 'workspace_resolution_drift' })
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
    const authority = runtimeAuthority.get('wasurezu')!

    const result = await memoryReadyBootstrap({
      agentId: 'wasurezu',
      project: 'agent-comms-mcp',
      runtimeInstanceId: 'runtime-wasurezu',
      sessionName: 'wasurezu-session',
      port: '39120',
      profileRevision: '1',
      profileSource: 'legacy',
      checkoutPath: authority.workspace,
      checkoutCommitSha: authority.commit,
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

describe('runtime memory-ready target project resolution', () => {
  test('derives codex project from the exact active primary workspace binding', async () => {
    const codexWorkspace = join(tmp, 'codex')
    mkdirSync(codexWorkspace)
    await seedRuntime('codex-cto', 39130, false)
    await db.execute(
      `INSERT INTO agent_workspaces (workspace_id, name, local_path)
       VALUES ('codex-primary', 'codex', $1)`,
      [codexWorkspace],
    )
    await db.execute(
      `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
       VALUES ('codex-cto', 'codex-primary', 'primary', true)`,
    )

    const resolved = await resolveRuntimeMemoryReadyProject(db as any, {
      agent_id: 'codex-cto',
      explicit_project: 'codex',
    })

    expect(resolved).toEqual({
      agent_id: 'codex-cto',
      project: 'codex',
      workspace_path: realpathSync(codexWorkspace),
      canonical_workspace_path: realpathSync(codexWorkspace),
      workspace_id: 'codex-primary',
      source: 'active_primary_workspace',
      explicit_project: 'codex',
    })
  })

  test('uses canonical workspace when no primary binding exists', async () => {
    const codexWorkspace = join(tmp, 'codex')
    mkdirSync(codexWorkspace)
    await seedRuntime('codex-cto', 39130, false)
    await db.execute(`ALTER TABLE agents ADD COLUMN canonical_workspace TEXT`)
    await db.execute(
      `UPDATE agents SET canonical_workspace=$1 WHERE agent_id='codex-cto'`,
      [codexWorkspace],
    )

    const resolved = await resolveRuntimeMemoryReadyProject(db as any, { agent_id: 'codex-cto' })

    expect(resolved.project).toBe('codex')
    expect(resolved.source).toBe('canonical_workspace')
  })

  test('fails closed on ambiguous primary bindings and mismatched explicit override', async () => {
    const codexWorkspace = join(tmp, 'codex')
    mkdirSync(codexWorkspace)
    await seedRuntime('codex-cto', 39130, false)
    await db.execute(
      `INSERT INTO agent_workspaces (workspace_id, name, local_path)
       VALUES ('codex-primary-a', 'codex-a', $1),
              ('codex-primary-b', 'codex-b', $2)`,
      [codexWorkspace, join(tmp, 'codex-shadow')],
    )
    await db.execute(
      `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
       VALUES ('codex-cto', 'codex-primary-a', 'primary', true),
              ('codex-cto', 'codex-primary-b', 'primary', true)`,
    )

    await expect(resolveRuntimeMemoryReadyProject(db as any, {
      agent_id: 'codex-cto',
    })).rejects.toMatchObject({ code: 'primary_workspace_ambiguous' })

    await db.execute(
      `UPDATE agent_workspace_bindings SET active=false WHERE workspace_id='codex-primary-b'`,
    )
    await expect(resolveRuntimeMemoryReadyProject(db as any, {
      agent_id: 'codex-cto',
      explicit_project: 'agent-comms-mcp',
    })).rejects.toMatchObject({ code: 'project_override_mismatch' })
  })

  test('canonicalizes a symlink workspace before deriving the project', async () => {
    const canonicalWorkspace = join(tmp, 'canonical-project')
    const lexicalWorkspace = join(tmp, 'lexical-project')
    mkdirSync(canonicalWorkspace)
    symlinkSync(canonicalWorkspace, lexicalWorkspace)
    await seedRuntime('codex-cto', 39130, false)
    await db.execute(
      `INSERT INTO agent_workspaces (workspace_id, name, local_path)
       VALUES ('codex-primary', 'lexical-project', $1)`,
      [lexicalWorkspace],
    )
    await db.execute(
      `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
       VALUES ('codex-cto', 'codex-primary', 'primary', true)`,
    )

    const resolved = await resolveRuntimeMemoryReadyProject(db as any, { agent_id: 'codex-cto' })

    expect(resolved.project).toBe('canonical-project')
    expect(resolved.workspace_path).toBe(realpathSync(canonicalWorkspace))
    expect(resolved.canonical_workspace_path).toBe(realpathSync(canonicalWorkspace))
    expect(resolved.workspace_id).toBe('codex-primary')
  })

  test('fails closed when the authoritative workspace is missing or not a directory', async () => {
    const regularFile = join(tmp, 'workspace-file')
    writeFileSync(regularFile, 'not a directory')
    await seedRuntime('codex-cto', 39130, false)
    await db.execute(`ALTER TABLE agents ADD COLUMN canonical_workspace TEXT`)

    await db.execute(
      `UPDATE agents SET canonical_workspace=$1 WHERE agent_id='codex-cto'`,
      [join(tmp, 'missing-workspace')],
    )
    await expect(resolveRuntimeMemoryReadyProject(db as any, {
      agent_id: 'codex-cto',
    })).rejects.toMatchObject({ code: 'workspace_path_not_found' })

    await db.execute(
      `UPDATE agents SET canonical_workspace=$1 WHERE agent_id='codex-cto'`,
      [regularFile],
    )
    await expect(resolveRuntimeMemoryReadyProject(db as any, {
      agent_id: 'codex-cto',
    })).rejects.toMatchObject({ code: 'workspace_path_not_directory' })
  })

  test('rejects conflicting explicit project variables', () => {
    expect(() => runtimeMemoryReadyProjectOverrideFromEnv({
      AGENT_MEMORY_PROJECT: 'codex',
      AGENT_COMMS_MEMORY_READY_PROJECT: 'agent-comms-mcp',
    })).toThrow(RuntimeMemoryReadyProjectResolutionError)
  })
})
