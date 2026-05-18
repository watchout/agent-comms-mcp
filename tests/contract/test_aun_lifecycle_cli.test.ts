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
const TEST_AGENT = 'lifecycle-dev'

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

function seedQueue(status: 'pending' | 'received' | 'in_progress' | 'done', agentId = TEST_AGENT): { queueId: number; messageId: string } {
  return withDb((db) => {
    const messageId = randomUUID()
    db.prepare(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type)
       VALUES (?, 'lifecycle-ch', 'codex-cto', 'lifecycle task', 'instruction')`,
    ).run(messageId)
    const row = db.prepare(
      `INSERT INTO message_queue
        (agent_id, message_id, payload, status, claimed_by, claimed_at, claim_expires_at)
       VALUES (?, ?, '{}', ?, ?, datetime('now'), datetime('now', '+60 seconds'))
       RETURNING id`,
    ).get(agentId, messageId, status, status === 'pending' || status === 'done' ? null : agentId) as { id: number }
    return { queueId: row.id, messageId }
  })
}

function queueRow(queueId: number): { status: string; done_at: string | null } {
  return withDb((db) => db.prepare(
    `SELECT status, done_at FROM message_queue WHERE id = ?`,
  ).get(queueId) as { status: string; done_at: string | null })
}

function agentStatus(): { status: string; status_detail: string | null } {
  return withDb((db) => db.prepare(
    `SELECT status, status_detail FROM agents WHERE agent_id = ?`,
  ).get(TEST_AGENT) as { status: string; status_detail: string | null })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-lifecycle-'))
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
               ('other-dev', 'other-dev', 'dev', 'idle');
      INSERT INTO channels (id, name, members)
        VALUES ('lifecycle-ch', 'lifecycle-ch', '["${TEST_AGENT}","codex-cto"]');
    `)
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('aun lifecycle CLI transitions', () => {
  test('processing advances received to in_progress and keeps final close explicit', () => {
    const { queueId, messageId } = seedQueue('received')

    const r = runAun(['processing', '--agent-id', TEST_AGENT, '--queue-id', String(queueId)])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      mode: 'processing',
      agent_id: TEST_AGENT,
      queue_id: String(queueId),
      message_id: messageId,
      status: 'in_progress',
    })
    expect(body.final_close_contract).toContain('reply --close')
    expect(queueRow(queueId).status).toBe('in_progress')
    expect(agentStatus().status).toBe('busy')
  })

  test('done advances in_progress to done and stamps done_at without replying/closing', () => {
    const { queueId } = seedQueue('in_progress')

    const r = runAun(['done', '--agent-id', TEST_AGENT, '--queue-id', String(queueId)])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      mode: 'done',
      status: 'done',
      queue_id: String(queueId),
    })
    const row = queueRow(queueId)
    expect(row.status).toBe('done')
    expect(row.done_at).not.toBeNull()
    expect(agentStatus().status).toBe('idle')
  })

  test('processing is idempotent once already in_progress', () => {
    const { queueId } = seedQueue('in_progress')

    const r = runAun(['processing', '--agent-id', TEST_AGENT, '--queue-id', String(queueId)])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      mode: 'processing',
      status: 'in_progress',
      already_transitioned: true,
    })
  })

  test('invalid state is rejected without mutation', () => {
    const { queueId } = seedQueue('pending')

    const r = runAun(['processing', '--agent-id', TEST_AGENT, '--queue-id', String(queueId)])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('INVALID_STATE')
    expect(queueRow(queueId).status).toBe('pending')
  })

  test('agent identity guard prevents touching another agent row', () => {
    const { queueId } = seedQueue('received', 'other-dev')

    const r = runAun(['processing', '--agent-id', TEST_AGENT, '--queue-id', String(queueId)])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('NOT_FOUND')
    expect(queueRow(queueId).status).toBe('received')
  })
})
