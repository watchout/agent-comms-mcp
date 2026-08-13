#!/usr/bin/env bun
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const AUN = join(REPO_ROOT, 'bin', 'aun.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')

let tmpDir: string
let dbPath: string
let env: Record<string, string>
const WORKSPACE_ID = 'codex-aun-preflight-primary'

function runAun(args: string[], extraEnv: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', ['run', AUN, ...args], {
    cwd: '/tmp',
    env: { ...env, ...extraEnv },
    encoding: 'utf-8',
    timeout: 20_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function dbExec(sql: string): void {
  const db = new Database(dbPath)
  try { db.exec(sql) } finally { db.close() }
}

function dbRead(sql: string, params: unknown[] = []): any[] {
  const db = new Database(dbPath)
  try { return db.prepare(sql).all(...params) as any[] } finally { db.close() }
}

function seedPending(content = 'codex runner preflight request'): { messageId: string; queueId: number } {
  const db = new Database(dbPath)
  try {
    const messageId = randomUUID()
    db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source)
      VALUES (?, 'runner-preflight-ch', 'codex-cto', ?, 'instruction', 'agent-comms')`).run(messageId, content)
    const payload = JSON.stringify({
      content,
      channel_id: 'runner-preflight-ch',
      author_id: 'codex-cto',
      message_id: messageId,
      message_type: 'instruction',
      source: 'agent-comms',
    })
    const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status)
      VALUES ('codex-aun', ?, ?, 'pending') RETURNING id`).get(messageId, payload) as { id: number }
    return { messageId, queueId: row.id }
  } finally {
    db.close()
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-codex-runner-preflight-'))
  let workspaceDir = join(tmpDir, 'agent-comms-mcp')
  mkdirSync(workspaceDir)
  spawnSync('/usr/bin/git', ['init', '-q', workspaceDir])
  writeFileSync(join(workspaceDir, 'tracked.txt'), 'preflight fixture\n')
  spawnSync('/usr/bin/git', ['-C', workspaceDir, 'add', 'tracked.txt'])
  spawnSync('/usr/bin/git', ['-C', workspaceDir, '-c', 'user.name=AUN Test', '-c', 'user.email=aun@example.invalid', 'commit', '-qm', 'fixture'])
  workspaceDir = realpathSync(workspaceDir)
  const workspaceHead = spawnSync('/usr/bin/git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const workspaceTree = spawnSync('/usr/bin/git', ['-C', workspaceDir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).stdout.trim()
  const owner = statSync(workspaceDir)
  const transport = {
    runtime_engine: 'codex', runtime_kind: 'local_process', host_id: null, endpoint_uri: null,
    runtime_transport_token: 'preflight-transport',
  }
  const authorityWithoutDigest = {
    schema: 'aun.runtime-memory-authority.v1', agent_id: 'codex-aun', project: 'agent-comms-mcp',
    workspace_id: WORKSPACE_ID, workspace_realpath: workspaceDir,
    workspace_owner_uid: owner.uid, workspace_owner_gid: owner.gid,
    runtime_instance_id: 'runtime-codex-aun', profile_revision: 1, profile_source: 'legacy',
    session_name: 'codex-aun-session', port: 39002, runtime_engine: 'codex', runtime_kind: 'local_process',
    transport_digest: createHash('sha256').update(JSON.stringify(transport)).digest('hex'),
    git_toplevel_realpath: workspaceDir, git_commit_sha: workspaceHead, git_tree_sha: workspaceTree, git_clean: true,
  }
  const authorityMetadata = JSON.stringify({
    memory_ready_authority: {
      ...authorityWithoutDigest,
      tuple_digest: createHash('sha256').update(JSON.stringify(authorityWithoutDigest)).digest('hex'),
    },
  })
  dbPath = join(tmpDir, 'test.db')
  env = {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    AGENT_COM_PG_NOTIFY: 'false',
    DATABASE_URL: '',
    AGENT_COMMS_CLAIM_TTL_SEC: '60',
    AGENT_ID: 'codex-aun',
    AGENT_COM_EXPECTED_AGENT_ID: 'codex-aun',
    AGENT_MEMORY_PROJECT: 'agent-comms-mcp',
    AGENT_COMMS_MEMORY_READY_PROJECT: 'agent-comms-mcp',
  }
  const migrated = spawnSync('bun', [MIGRATE], { cwd: REPO_ROOT, env, encoding: 'utf-8' })
  if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
  dbExec(`
    INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, metadata)
      VALUES ('codex-aun', 'codex-aun', 'dev', 'codex', 'idle', '{"discord_id":"999010"}'),
             ('codex-cto', 'codex-cto', 'cto', 'codex', 'idle', '{"discord_id":"999011"}');
    UPDATE agents
       SET channel_port = 39002,
           home_directory = '${workspaceDir}'
     WHERE agent_id = 'codex-aun';
    INSERT INTO agent_workspaces (workspace_id, name, local_path)
      VALUES ('${WORKSPACE_ID}', 'agent-comms-mcp', '${workspaceDir}');
    INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
      VALUES ('codex-aun', '${WORKSPACE_ID}', 'primary', true);
    INSERT INTO agent_runtime_instances
      (runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind, session_name, port, checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
      VALUES ('runtime-codex-aun', 'codex-aun', '${WORKSPACE_ID}', 'codex', 'local_process', 'codex-aun-session', 39002, '${workspaceDir}', '${workspaceHead}', 'running', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z', '{"tuple_digest":"preflight-transport"}');
    INSERT INTO runtime_memory_ready_evidence
      (agent_id, project, runtime_instance_id, profile_revision, profile_source, session_name, port, expected_agent_id,
       checkout_path, checkout_commit_sha, recovery_command, result_status, completed_at, evidence_path, evidence_log_id, valid_until, source, metadata)
      VALUES ('codex-aun', 'agent-comms-mcp', 'runtime-codex-aun', 1, 'legacy', 'codex-aun-session', 39002, 'codex-aun',
       '${workspaceDir}', '${workspaceHead}', 'test:mcp__wasurezu__recover_context', 'ready', '2026-06-01T00:00:02.000Z',
       '/tmp/codex-aun-memory-ready.json', 'sqlite-codex-aun-memory-ready', '2099-01-01T00:00:00.000Z', 'agent_memory_boot_recovery', '${authorityMetadata}');
    INSERT INTO channels (id, name, members)
      VALUES ('runner-preflight-ch', 'runner-preflight-ch', '["codex-aun","codex-cto"]');
    INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('runner-preflight-ch', '["codex-aun","codex-cto"]', 'aun-codex-runner-preflight-test');
  `)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_codex_runner_preflight - read-only lifecycle readiness', () => {
  test('reports runner readiness without claiming or replying', () => {
    const { messageId, queueId } = seedPending('preflight should not expose this content')

    const r = runAun([
      'codex-runner-preflight',
      '--agent-id', 'codex-aun',
      '--queue-id', String(queueId),
      '--max-inspect', '10',
    ])

    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('preflight should not expose this content')
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      mode: 'codex-runner-preflight',
      agent_id: 'codex-aun',
      expected_agent_id: 'codex-aun',
      queue_id: String(queueId),
      identity: { ok: true, error: null },
      database: { reachable: true },
      mutation_policy: {
        read_only: true,
        no_queue_claim: true,
        no_queue_drain: true,
        no_reply: true,
        no_launch_process: true,
        no_state_daemon_restart: true,
        no_launchctl: true,
        no_discord_write: true,
        no_secret_output: true,
      },
      receive_actionable: {
        ok: true,
        selected_queue_id: queueId,
        selected_message_id: messageId,
        selected_message_type: 'instruction',
        selected_routing_decision: 'wake_agent',
        blocked_reason: null,
        memory_ready: { ok: true, reason: 'ready' },
      },
      findings: [],
    })
    expect(body.command_preview.argv).toContain('codex-runner')
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null, replied_with: null })
    expect(dbRead(`SELECT count(*) AS n FROM agent_messages WHERE author_id = 'codex-aun'`)[0].n).toBe(0)
  })

  test('uses codex-cto-like target workspace project instead of stale global evidence', () => {
    const { queueId } = seedPending('per-target memory project preflight')
    let codexWorkspace = join(tmpDir, 'codex')
    mkdirSync(codexWorkspace)
    spawnSync('/usr/bin/git', ['init', '-q', codexWorkspace])
    writeFileSync(join(codexWorkspace, 'tracked.txt'), 'codex target fixture\n')
    spawnSync('/usr/bin/git', ['-C', codexWorkspace, 'add', 'tracked.txt'])
    spawnSync('/usr/bin/git', ['-C', codexWorkspace, '-c', 'user.name=AUN Test', '-c', 'user.email=aun@example.invalid', 'commit', '-qm', 'fixture'])
    codexWorkspace = realpathSync(codexWorkspace)
    const codexHead = spawnSync('/usr/bin/git', ['-C', codexWorkspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const codexTree = spawnSync('/usr/bin/git', ['-C', codexWorkspace, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).stdout.trim()
    const codexOwner = statSync(codexWorkspace)
    const transport = {
      runtime_engine: 'codex', runtime_kind: 'local_process', host_id: null, endpoint_uri: null,
      runtime_transport_token: 'preflight-transport',
    }
    const codexAuthorityWithoutDigest = {
      schema: 'aun.runtime-memory-authority.v1', agent_id: 'codex-aun', project: 'codex',
      workspace_id: WORKSPACE_ID, workspace_realpath: codexWorkspace,
      workspace_owner_uid: codexOwner.uid, workspace_owner_gid: codexOwner.gid,
      runtime_instance_id: 'runtime-codex-aun', profile_revision: 1, profile_source: 'legacy',
      session_name: 'codex-aun-session', port: 39002, runtime_engine: 'codex', runtime_kind: 'local_process',
      transport_digest: createHash('sha256').update(JSON.stringify(transport)).digest('hex'),
      git_toplevel_realpath: codexWorkspace, git_commit_sha: codexHead, git_tree_sha: codexTree, git_clean: true,
    }
    const codexAuthorityMetadata = JSON.stringify({
      memory_ready_authority: {
        ...codexAuthorityWithoutDigest,
        tuple_digest: createHash('sha256').update(JSON.stringify(codexAuthorityWithoutDigest)).digest('hex'),
      },
    })
    dbExec(`
      UPDATE agents
         SET home_directory = '${codexWorkspace}'
       WHERE agent_id = 'codex-aun';
      UPDATE agent_workspaces SET name='codex', local_path='${codexWorkspace}' WHERE workspace_id='${WORKSPACE_ID}';
      UPDATE agent_runtime_instances SET checkout_path='${codexWorkspace}', commit_sha='${codexHead}'
       WHERE runtime_instance_id='runtime-codex-aun';
      UPDATE runtime_memory_ready_evidence
         SET valid_until = '2026-06-01T00:00:03.000Z'
       WHERE agent_id = 'codex-aun' AND project = 'agent-comms-mcp';
      INSERT INTO runtime_memory_ready_evidence
        (agent_id, project, runtime_instance_id, profile_revision, profile_source, session_name, port, expected_agent_id,
         checkout_path, checkout_commit_sha, recovery_command, result_status, completed_at, evidence_path, evidence_log_id, valid_until, source, metadata)
        VALUES ('codex-aun', 'codex', 'runtime-codex-aun', 1, 'legacy', 'codex-aun-session', 39002, 'codex-aun',
         '${codexWorkspace}', '${codexHead}', 'test:mcp__wasurezu__recover_context', 'ready', '2026-06-01T00:00:04.000Z',
         '/tmp/codex-aun-memory-ready-codex.json', 'sqlite-codex-aun-memory-ready-codex', '2099-01-01T00:00:00.000Z', 'agent_memory_boot_recovery', '${codexAuthorityMetadata}');
    `)

    const mismatched = runAun([
      'codex-runner-preflight', '--agent-id', 'codex-aun', '--queue-id', String(queueId),
    ], {
      AGENT_MEMORY_PROJECT: 'agent-comms-mcp',
      AGENT_COMMS_MEMORY_READY_PROJECT: 'agent-comms-mcp',
    })
    expect(mismatched.status).toBe(1)
    expect(JSON.parse(mismatched.stdout).receive_actionable.memory_ready).toMatchObject({
      ok: false,
      reason: 'project_resolution_failed',
    })

    const exact = runAun([
      'codex-runner-preflight', '--agent-id', 'codex-aun', '--queue-id', String(queueId),
    ], {
      AGENT_MEMORY_PROJECT: 'codex',
      AGENT_COMMS_MEMORY_READY_PROJECT: 'codex',
    })
    expect(exact.status).toBe(0)
    expect(JSON.parse(exact.stdout).receive_actionable.memory_ready).toMatchObject({
      ok: true,
      reason: 'ready',
    })

    dbExec(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id='codex-aun' AND project='codex'`)
    const missingTargetEvidence = runAun([
      'codex-runner-preflight', '--agent-id', 'codex-aun', '--queue-id', String(queueId),
    ], {
      AGENT_MEMORY_PROJECT: 'codex',
      AGENT_COMMS_MEMORY_READY_PROJECT: 'codex',
    })
    expect(missingTargetEvidence.status).toBe(1)
    expect(JSON.parse(missingTargetEvidence.stdout).receive_actionable.memory_ready).toMatchObject({
      ok: false,
      reason: 'missing_evidence',
    })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('active claim is reported as a blocker without mutation', () => {
    const { queueId } = seedPending('active claim preflight')
    dbExec(`
      UPDATE message_queue
         SET status='received',
             claimed_by='codex-aun',
             claimed_at=datetime('now'),
             claim_expires_at=datetime('now', '+60 seconds')
       WHERE id=${queueId};
    `)

    const r = runAun(['codex-runner-preflight', '--agent-id', 'codex-aun', '--max-inspect', '10'])

    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('active claim preflight')
    const body = JSON.parse(r.stdout)
    expect(body.ok).toBe(false)
    expect(body.receive_actionable.active_claim).toMatchObject({
      busy: true,
      queue_id: queueId,
      status: 'received',
    })
    expect(body.findings).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_CLAIM_PRESENT',
      severity: 'blocker',
    }))
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'codex-aun' })
  })

  test('identity mismatch fails closed before queue mutation', () => {
    const { queueId } = seedPending('identity mismatch preflight')

    const r = runAun(
      ['codex-runner-preflight', '--agent-id', 'wrong-agent', '--queue-id', String(queueId)],
      { AGENT_COM_EXPECTED_AGENT_ID: 'codex-aun' },
    )

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CODEX_RUNNER_PREFLIGHT_FAILED')
    const body = JSON.parse(r.stdout)
    expect(body.ok).toBe(false)
    expect(body.findings).toContainEqual(expect.objectContaining({
      code: 'AGENT_IDENTITY_MISMATCH',
      severity: 'blocker',
    }))
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('invalid max-inspect fails before queue mutation', () => {
    const { queueId } = seedPending('invalid max inspect preflight')

    const r = runAun([
      'codex-runner-preflight',
      '--agent-id', 'codex-aun',
      '--queue-id', String(queueId),
      '--max-inspect', '0',
    ])

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CODEX_RUNNER_PREFLIGHT_FAILED')
    const body = JSON.parse(r.stdout)
    expect(body.ok).toBe(false)
    expect(body.identity).toEqual({ ok: true, error: null })
    expect(body.findings).toContainEqual(expect.objectContaining({
      code: 'INVALID_MAX_INSPECT',
      severity: 'blocker',
    }))
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('database URL credentials are redacted from preflight output', () => {
    seedPending('secret redaction preflight')

    const r = runAun(
      ['codex-runner-preflight', '--agent-id', 'codex-aun'],
      { DATABASE_URL: 'postgresql://runner:super-secret@db.example.test/agent_comms' },
    )

    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('super-secret')
    expect(r.stdout).toContain('runner:***@db.example.test')
    const body = JSON.parse(r.stdout)
    expect(body.database.candidates[0]).toBe('postgresql://runner:***@db.example.test/agent_comms')
  })
})
