#!/usr/bin/env bun
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const AUN = join(REPO_ROOT, 'bin', 'aun.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')
const TEST_AGENT = 'diag-dev'

let tmpDir: string
let dbPath: string
let env: Record<string, string>

function runAun(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', ['run', AUN, ...args], {
    cwd: '/tmp',
    env,
    encoding: 'utf-8',
    timeout: 15_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function seedQueue(agentId: string, messageType: string, ageSeconds: number, status = 'pending'): number {
  return withDb((db) => {
    const messageId = randomUUID()
    const createdAt = new Date(Date.now() - ageSeconds * 1000).toISOString()
    db.prepare(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, created_at)
       VALUES (?, 'diag-ch', 'codex-cto', ?, ?, ?)`,
    ).run(messageId, `${messageType} body`, messageType, createdAt)
    const payload = JSON.stringify({
      message_id: messageId,
      channel_id: 'diag-ch',
      author_id: 'codex-cto',
      content: `${messageType} body`,
      message_type: messageType,
    })
    const row = db.prepare(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
       VALUES (?, ?, ?, ?, 0, ?) RETURNING id`,
    ).get(agentId, messageId, payload, status, createdAt) as { id: number }
    return row.id
  })
}

function claimQueue(queueId: number, agentId = TEST_AGENT): void {
  withDb((db) => {
    db.prepare(
      `UPDATE message_queue
          SET status = 'received',
              claimed_by = ?,
              claimed_at = ?,
              claim_expires_at = ?
        WHERE id = ?`,
    ).run(agentId, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), queueId)
  })
}

function readStatuses(agentId = TEST_AGENT): Array<{ id: number; status: string; claimed_by: string | null }> {
  return withDb((db) => db.prepare(
    `SELECT id, status, claimed_by FROM message_queue WHERE agent_id = ? ORDER BY id ASC`,
  ).all(agentId) as Array<{ id: number; status: string; claimed_by: string | null }>)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-diagnose-'))
  dbPath = join(tmpDir, 'test.db')
  env = {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    AGENT_COM_PG_NOTIFY: 'false',
    DATABASE_URL: '',
    AGENT_ID: TEST_AGENT,
    AGENT_COM_EXPECTED_AGENT_ID: TEST_AGENT,
  }
  const migrated = spawnSync('bun', [MIGRATE], { cwd: REPO_ROOT, env, encoding: 'utf-8' })
  if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
  withDb((db) => {
    db.exec(`
      INSERT INTO agents (agent_id, display_name, agent_type, status)
        VALUES ('${TEST_AGENT}', '${TEST_AGENT}', 'dev', 'idle'),
               ('cto', 'cto', 'dev', 'idle'),
               ('codex-cto', 'codex-cto', 'dev', 'idle');
      INSERT INTO channels (id, name, members)
        VALUES ('diag-ch', 'diag-ch', '["${TEST_AGENT}","cto","codex-cto"]');
    `)
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_diagnose_receive - deterministic receive selector diagnostics', () => {
  test('skips stale non-action rows and selects a newer actionable instruction', () => {
    seedQueue(TEST_AGENT, 'chat', 300)
    seedQueue(TEST_AGENT, 'notice', 240)
    const actionableId = seedQueue(TEST_AGENT, 'instruction', 60)

    const r = runAun(['diagnose-receive', '--agent-id', TEST_AGENT, '--max-inspect', '10', '--dry-run'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      mode: 'diagnose-receive',
      agent_id: TEST_AGENT,
      inspected_count: 3,
      total_pending: 3,
      skipped_non_action_before_candidate: 2,
      selection_blocked_reason: null,
    })
    expect(body.selected.queue_id).toBe(actionableId)
    expect(body.selected.message_type).toBe('instruction')
    expect(readStatuses().every((row) => row.status === 'pending' && row.claimed_by === null)).toBe(true)
  })

  test('surfaces unknown message types instead of silently treating them as chat', () => {
    const unknownId = seedQueue(TEST_AGENT, 'workflow_projection_v2', 120)

    const r = runAun(['diagnose-receive', '--agent-id', TEST_AGENT, '--max-inspect', '5'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.unknown_type_count).toBe(1)
    expect(body.unknown_type_samples[0]).toMatchObject({
      queue_id: unknownId,
      message_type: 'workflow_projection_v2',
      classification: 'unknown',
    })
    expect(body.selection_blocked_reason).toBe('none_found')
  })

  test('active claim reports busy and does not return a selected row', () => {
    const activeId = seedQueue(TEST_AGENT, 'request', 180)
    claimQueue(activeId)
    const candidateId = seedQueue(TEST_AGENT, 'instruction', 60)

    const r = runAun(['diagnose-receive', '--agent-id', TEST_AGENT])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.active_claim).toMatchObject({ busy: true, queue_id: activeId, status: 'received' })
    expect(body.candidate.queue_id).toBe(candidateId)
    expect(body.selected).toBeNull()
    expect(body.selection_blocked_reason).toBe('active_claim')
  })

  test('detects cto and codex-cto identity split without mutating either queue', () => {
    seedQueue('cto', 'instruction', 90)
    seedQueue('codex-cto', 'request', 80)

    const r = runAun(['diagnose-receive', '--agent-id', TEST_AGENT])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.cto_identity_split.split_detected).toBe(true)
    expect(body.cto_identity_split.pending.cto.pending_count).toBe(1)
    expect(body.cto_identity_split.pending['codex-cto'].pending_count).toBe(1)
    expect(readStatuses('cto')[0].status).toBe('pending')
    expect(readStatuses('codex-cto')[0].status).toBe('pending')
  })

  test('honors hard max-inspect and leaves every row unclaimed', () => {
    seedQueue(TEST_AGENT, 'chat', 500)
    seedQueue(TEST_AGENT, 'notice', 400)
    seedQueue(TEST_AGENT, 'instruction', 300)

    const r = runAun(['diagnose-receive', '--agent-id', TEST_AGENT, '--max-inspect', '2'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.max_inspect).toBe(2)
    expect(body.inspected_count).toBe(2)
    expect(body.total_pending).toBe(3)
    expect(body.candidate).toBeNull()
    expect(body.selected).toBeNull()
    expect(body.skipped_non_action_count).toBe(2)
    expect(readStatuses().map((row) => row.status)).toEqual(['pending', 'pending', 'pending'])
  })
})
