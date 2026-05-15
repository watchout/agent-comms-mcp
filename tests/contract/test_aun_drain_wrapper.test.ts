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

function dbExec(sql: string): void {
  const db = new Database(dbPath)
  try { db.exec(sql) } finally { db.close() }
}

function dbRead(sql: string, params: unknown[] = []): any[] {
  const db = new Database(dbPath)
  try { return db.prepare(sql).all(...params) as any[] } finally { db.close() }
}

function seedPending(agentId = 'probe-dev', count = 1): number[] {
  const db = new Database(dbPath)
  try {
    const ids: number[] = []
    for (let i = 0; i < count; i++) {
      const messageId = randomUUID()
      const content = `drain request ${i}`
      db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content)
        VALUES (?, 'probe-ch', 'codex-cto', ?)`).run(messageId, content)
      const payload = JSON.stringify({
        content,
        channel_id: 'probe-ch',
        author_id: 'codex-cto',
        message_id: messageId,
      })
      const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status)
        VALUES (?, ?, ?, 'pending') RETURNING id`).get(agentId, messageId, payload) as { id: number }
      ids.push(row.id)
    }
    return ids
  } finally {
    db.close()
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-drain-'))
  dbPath = join(tmpDir, 'test.db')
  env = {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    AGENT_COM_PG_NOTIFY: 'false',
    DATABASE_URL: '',
    AGENT_COMMS_CLAIM_TTL_SEC: '60',
  }
  const migrated = spawnSync('bun', [MIGRATE], { cwd: REPO_ROOT, env, encoding: 'utf-8' })
  if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
  dbExec(`
    INSERT INTO agents (agent_id, display_name, agent_type, status)
      VALUES ('probe-dev', 'probe-dev', 'dev', 'idle'),
             ('other-dev', 'other-dev', 'dev', 'idle');
    INSERT INTO channels (id, name, members)
      VALUES ('probe-ch', 'probe-ch', '["probe-dev","other-dev","codex-cto"]');
  `)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_drain_wrapper - batch receive runner', () => {
  test('empty queue returns an empty structured batch', () => {
    const r = runAun(['drain', '--agent-id', 'probe-dev'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({ ok: true, claimed_count: 0, waiting: 0, capped: false })
    expect(body.claimed).toEqual([])
  })

  test('one row is claimed with per-row ownership and TTL', () => {
    const [queueId] = seedPending('probe-dev', 1)
    const r = runAun(['drain', '--agent-id', 'probe-dev'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.claimed_count).toBe(1)
    expect(body.claimed[0].queue_id).toBe(queueId)

    const rows = dbRead(
      `SELECT status, claimed_by, claim_expires_at IS NOT NULL AS has_ttl
       FROM message_queue WHERE id = ?`,
      [queueId],
    )
    expect(rows[0]).toEqual({ status: 'received', claimed_by: 'probe-dev', has_ttl: 1 })
  })

  test('multiple rows are claimed in one script call until empty', () => {
    seedPending('probe-dev', 3)
    const r = runAun(['drain', '--agent-id', 'probe-dev'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.claimed_count).toBe(3)
    expect(body.waiting).toBe(0)
    expect(new Set(body.claimed.map((m: any) => m.queue_id)).size).toBe(3)
    expect(dbRead(`SELECT count(*) AS n FROM message_queue WHERE agent_id='probe-dev' AND status='received'`)[0].n).toBe(3)
  })

  test('limit caps the batch and leaves the tail pending', () => {
    seedPending('probe-dev', 5)
    const r = runAun(['drain', '--agent-id', 'probe-dev', '--limit', '2'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({ claimed_count: 2, waiting: 3, limit: 2, capped: true })
    expect(dbRead(`SELECT count(*) AS n FROM message_queue WHERE agent_id='probe-dev' AND status='received'`)[0].n).toBe(2)
    expect(dbRead(`SELECT count(*) AS n FROM message_queue WHERE agent_id='probe-dev' AND status='pending'`)[0].n).toBe(3)
  })

  test('drain and next do not duplicate claims or cross agent boundaries', () => {
    seedPending('probe-dev', 3)
    seedPending('other-dev', 2)

    const drain = runAun(['drain', '--agent-id', 'probe-dev', '--limit', '2'])
    expect(drain.status).toBe(0)
    const next = runAun(['next', '--agent-id', 'probe-dev'])
    expect(next.status).toBe(0)
    const drainBody = JSON.parse(drain.stdout)
    const nextBody = JSON.parse(next.stdout)
    const claimedIds = [...drainBody.claimed.map((m: any) => m.queue_id), nextBody.queue_id]
    expect(new Set(claimedIds).size).toBe(3)

    expect(dbRead(`SELECT count(*) AS n FROM message_queue WHERE agent_id='probe-dev' AND status='received'`)[0].n).toBe(3)
    expect(dbRead(`SELECT count(*) AS n FROM message_queue WHERE agent_id='other-dev' AND status='pending'`)[0].n).toBe(2)
  })
})
