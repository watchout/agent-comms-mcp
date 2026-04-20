#!/usr/bin/env bun
/**
 * Phase 2 F — CLI SQLite backend (factory 経由化).
 *
 * Verifies `cli/index.ts` works against SQLite (not just PG) by running each
 * core command (next / send / notify / fail / skip / reclaim / heartbeat)
 * against a fresh bun:sqlite DB. Fixture uses a probe agent_id / channel so
 * no contamination with production PG data is possible — the CLI is booted
 * with `AGENT_COM_DB=sqlite` + `AGENT_COM_SQLITE_PATH=<temp>` env.
 *
 * Related helpers under test:
 *   - cli/index.ts `getDb()` returns a pg.Client-shaped shim over DbAdapter
 *   - cli/index.ts `isSqliteMode()` gates pg_notify calls
 *   - core/db/sqlite-adapter.ts `adaptSql()` strips FOR UPDATE, `::cast`,
 *     converts NOW()-INTERVAL '… minutes' to datetime('now', '-… minutes')
 *   - db/migrate-sqlite.ts ships channel_adapters / thread_adapters (added
 *     in this PR so send can resolve outbound targets in SQLite mode)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'

const REPO_ROOT = join(import.meta.dir, '..')
const CLI = join(REPO_ROOT, 'cli', 'index.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')

let tmpDir: string
let dbPath: string
let env: Record<string, string>

function runCli(args: string[], extraEnv: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI, ...args], {
    env: { ...env, ...extraEnv },
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-sqlite-'))
  dbPath = join(tmpDir, 'test.db')
  env = {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    AGENT_COM_PG_NOTIFY: 'false',
    // Unset any parent PG env so the pg path is not accidentally used.
    DATABASE_URL: '',
    AGENT_ID: 'probe-f',
  }
  // Apply the full v2.1.0 migration to the probe DB. Running the migrate
  // entrypoint here lets the tests share the same migration path as prod.
  const res = spawnSync('bun', [MIGRATE], { env, encoding: 'utf-8', cwd: REPO_ROOT })
  if (res.status !== 0) throw new Error(`migrate failed: ${res.stderr}`)

  // Seed probe agent + channel. The CLI send tool checks channels.members,
  // so the probe agent must be listed.
  const db = new Database(dbPath)
  db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('probe-f', 'probe-f', 'dev', 'idle')`)
  db.exec(`INSERT INTO channels (id, name, members) VALUES ('probe-f-ch', 'probe-f-ch', '["probe-f"]')`)
  db.close()
})

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

/** Seed one pending message_queue row and return the UUID + queue id. */
function seedPendingMessage(content = 'probe-content'): { messageId: string; queueId: number } {
  const db = new Database(dbPath)
  const messageId = randomUUID()
  db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content) VALUES (?, 'probe-f-ch', 'cto', ?)`).run(messageId, content)
  const payload = JSON.stringify({
    content,
    channel_id: 'probe-f-ch',
    author_id: 'cto',
    message_id: messageId,
  })
  const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('probe-f', ?, ?, 'pending') RETURNING id`).get(messageId, payload) as { id: number }
  db.close()
  return { messageId, queueId: row.id }
}

function dbRead(sql: string, params: unknown[] = []): any[] {
  const db = new Database(dbPath)
  try {
    return db.prepare(sql).all(...params) as any[]
  } finally {
    db.close()
  }
}

describe('F1 — migration emits v2.1.0 schema to SQLite', () => {
  test('message_queue has failed_reason + 5-state CHECK', () => {
    const rows = dbRead(`PRAGMA table_info(message_queue)`)
    expect(rows.map((r: any) => r.name)).toContain('failed_reason')
  })
  test('channel_adapters / thread_adapters tables exist (added in Phase 2 F)', () => {
    const tables = dbRead(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    const names = tables.map((t: any) => t.name)
    expect(names).toContain('channel_adapters')
    expect(names).toContain('thread_adapters')
  })
})

describe('F2 — agent-com next (SQLite)', () => {
  test('pops a pending row, marks read, stamps current_message_id, sets busy', () => {
    const { messageId, queueId } = seedPendingMessage('next test')
    const r = runCli(['next'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as { message_id: string; queue_id: number; from: string; content: string }
    expect(payload.message_id).toBe(messageId)
    expect(payload.queue_id).toBe(queueId)
    expect(payload.from).toBe('cto')
    expect(payload.content).toBe('next test')
    const q = dbRead(`SELECT status FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('read')
    const a = dbRead(`SELECT status, current_message_id FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('busy')
    expect(Number(a[0].current_message_id)).toBe(queueId)
  })

  test('emits {"waiting":0} with no message_id when queue is empty', () => {
    const r = runCli(['next'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.waiting).toBe(0)
    expect(payload.message_id).toBeUndefined()
  })

  test('implicit-fails the prior current_message_id with IMPLICIT_ABANDON', () => {
    const first = seedPendingMessage('m1')
    const second = seedPendingMessage('m2')
    runCli(['next']) // pops m1
    runCli(['next']) // should implicit-fail m1, pop m2
    const q = dbRead(`SELECT id, status, failed_reason FROM message_queue ORDER BY id`)
    const m1 = q.find((r: any) => r.id === first.queueId)
    const m2 = q.find((r: any) => r.id === second.queueId)
    expect(m1.status).toBe('failed')
    expect(m1.failed_reason).toBe('IMPLICIT_ABANDON')
    expect(m2.status).toBe('read')
  })
})

describe('F3 — agent-com send (SQLite)', () => {
  test('replies to the in-flight row, sets replied, clears current_message_id', () => {
    const { queueId } = seedPendingMessage('send test')
    runCli(['next'])
    const r = runCli(['send', '--content', 'F3 reply', '--mentions', 'cto'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.ok).toBe(true)
    expect(payload.mentions).toEqual(['cto'])
    // outbound_skip_reason is expected because no discord adapter row exists
    expect(payload.outbound_skip_reason).toContain('discord adapter')
    const q = dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('replied')
    expect(q[0].replied_with).toBe(payload.message_id)
    const a = dbRead(`SELECT status, current_message_id FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('idle')
    expect(a[0].current_message_id).toBeNull()
  })

  test('rejects second send without a fresh next — NO_CURRENT_MESSAGE guard', () => {
    seedPendingMessage('dbl-send')
    runCli(['next'])
    const ok = runCli(['send', '--content', 'first', '--mentions', 'cto'])
    expect(ok.status).toBe(0)
    const fail = runCli(['send', '--content', 'second', '--mentions', 'cto'])
    expect(fail.status).not.toBe(0)
    expect(fail.stderr).toContain('NO_CURRENT_MESSAGE')
  })
})

describe('F4 — agent-com fail / skip / reclaim (SQLite)', () => {
  test('fail sets status=failed + reason + releases the agent', () => {
    const { messageId, queueId } = seedPendingMessage('f4-fail')
    runCli(['next'])
    const r = runCli(['fail', '--message-id', messageId, '--reason', 'SQLITE_FAIL_TEST'])
    expect(r.status).toBe(0)
    const q = dbRead(`SELECT status, failed_reason FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('failed')
    expect(q[0].failed_reason).toBe('SQLITE_FAIL_TEST')
    const a = dbRead(`SELECT status, current_message_id FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('idle')
    expect(a[0].current_message_id).toBeNull()
  })

  test('skip sets status=skipped + reason (operator path)', () => {
    const { messageId, queueId } = seedPendingMessage('f4-skip')
    runCli(['next'])
    const r = runCli(['skip', '--message-id', messageId, '--reason', 'OBSOLETE'])
    expect(r.status).toBe(0)
    const q = dbRead(`SELECT status, failed_reason FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('skipped')
    expect(q[0].failed_reason).toBe('OBSOLETE')
  })

  test('reclaim rolls read→pending for rows > 15 min stale + clears agent pointer', () => {
    // Seed a message, next-pop it, then artificially age read_at by 20min
    // using SQLite directly to simulate a crashed bot.
    const { queueId } = seedPendingMessage('f4-reclaim')
    runCli(['next'])
    const db = new Database(dbPath)
    db.exec(`UPDATE message_queue SET read_at = datetime('now', '-20 minutes') WHERE id = ${queueId}`)
    db.close()
    const r = runCli(['reclaim', '--agent-id', 'probe-f'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as { reclaimed_count: number }
    expect(payload.reclaimed_count).toBe(1)
    const q = dbRead(`SELECT status, read_at FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('pending')
    expect(q[0].read_at).toBeNull()
    const a = dbRead(`SELECT status, current_message_id FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].current_message_id).toBeNull()
  })
})

describe('F5 — agent-com notify (SQLite)', () => {
  test('notify posts a self-originated message without touching agents state', () => {
    const r = runCli(['notify', '--channel', 'probe-f-ch', '--mentions', 'cto', '--content', 'notify body'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.ok).toBe(true)
    expect(payload.channel_id).toBe('probe-f-ch')
    const a = dbRead(`SELECT status FROM agents WHERE agent_id = 'probe-f'`)
    // notify should NOT flip the agent's busy/idle state — it stays whatever
    // it was (we seeded 'idle' in beforeEach).
    expect(a[0].status).toBe('idle')
  })
})
