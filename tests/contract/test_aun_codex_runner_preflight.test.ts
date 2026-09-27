#!/usr/bin/env bun
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { createReadyNativeRuntime, stopNativeFixtures } from '../helpers/seat-native-runtime-fixture'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const AUN = join(REPO_ROOT, 'bin', 'aun.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')

let tmpDir: string
let dbPath: string
let env: Record<string, string>

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

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-codex-runner-preflight-'))
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
  }
  const migrated = spawnSync('bun', [MIGRATE], { cwd: REPO_ROOT, env, encoding: 'utf-8' })
  if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
  dbExec(`
    INSERT INTO agents (agent_id, display_name, agent_type, metadata)
      VALUES ('codex-aun', 'codex-aun', 'dev', '{"discord_id":"999010"}'),
             ('codex-cto', 'codex-cto', 'cto', '{"discord_id":"999011"}');
    INSERT INTO channels (id, name, members)
      VALUES ('runner-preflight-ch', 'runner-preflight-ch', '["codex-aun","codex-cto"]');
    INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('runner-preflight-ch', '["codex-aun","codex-cto"]', 'aun-codex-runner-preflight-test');
  `)
  const native = await createReadyNativeRuntime(dbPath,tmpDir,'codex-aun',randomUUID())
  env.PATH = native.cliPath + ':' + env.PATH
  env.AGENT_COMMS_MEMORY_READY_PROJECT='agent-comms-mcp'
})

afterEach(async () => {
  await stopNativeFixtures()
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
