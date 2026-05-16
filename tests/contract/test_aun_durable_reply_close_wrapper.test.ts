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

function seedPending(opts: {
  agentId?: string
  channelId?: string
  content?: string
} = {}): { messageId: string; queueId: number } {
  const agentId = opts.agentId ?? 'probe-dev'
  const channelId = opts.channelId ?? 'probe-ch'
  const content = opts.content ?? 'durable close request'
  const db = new Database(dbPath)
  try {
    const messageId = randomUUID()
    db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content)
      VALUES (?, ?, 'codex-cto', ?)`).run(messageId, channelId, content)
    const payload = JSON.stringify({
      content,
      channel_id: channelId,
      author_id: 'codex-cto',
      message_id: messageId,
    })
    const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status)
      VALUES (?, ?, ?, 'pending') RETURNING id`).get(agentId, messageId, payload) as { id: number }
    return { messageId, queueId: row.id }
  } finally {
    db.close()
  }
}

function explicitReply(queueId: number, extra: string[] = []): { status: number; stdout: string; stderr: string } {
  return runAun([
    'reply',
    '--agent-id', 'probe-dev',
    '--queue-id', String(queueId),
    '--content', 'durable done',
    '--mentions', 'codex-cto',
    ...extra,
  ])
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-durable-close-'))
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
      VALUES ('probe-ch', 'probe-ch', '["probe-dev","other-dev","codex-cto"]'),
             ('no-probe-ch', 'no-probe-ch', '["codex-cto"]');
  `)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_durable_reply_close_wrapper - explicit queue close', () => {
  test('active claim compatibility still closes without explicit queue id', () => {
    const { queueId } = seedPending({ content: 'active claim' })
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)

    const reply = runAun([
      'reply',
      '--agent-id', 'probe-dev',
      '--content', 'done',
      '--mentions', 'codex-cto',
    ])

    expect(reply.status).toBe(0)
    const body = JSON.parse(reply.stdout)
    expect(body.work_closed).toBe(true)
    expect(body.close_mode).toBe('active_claim')
    expect(body.queue_id).toBe(queueId)
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', replied_with: body.message_id })
  })

  test('ACK/progress reply with --no-close leaves active claim open', () => {
    const { queueId } = seedPending({ content: 'ack progress no close' })
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)

    const ack = runAun([
      'reply',
      '--agent-id', 'probe-dev',
      '--content', 'ack: investigating',
      '--mentions', 'codex-cto',
      '--no-close',
    ])

    expect(ack.status).toBe(0)
    const body = JSON.parse(ack.stdout)
    expect(body.work_closed).toBe(false)
    expect(body.close_mode).toBe('none')
    expect(body.queue_id).toBe(queueId)
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'probe-dev', replied_with: null })
  })

  test('final explicit close closes the same queue after ACK/progress no-close', () => {
    const { queueId, messageId } = seedPending({ content: 'ack then final' })
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)
    const ack = runAun([
      'reply',
      '--agent-id', 'probe-dev',
      '--content', 'progress update',
      '--mentions', 'codex-cto',
      '--no-close',
    ])
    expect(ack.status).toBe(0)
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', replied_with: null })

    const final = explicitReply(queueId, ['--message-id', messageId, '--close'])

    expect(final.status).toBe(0)
    const body = JSON.parse(final.stdout)
    expect(body.work_closed).toBe(true)
    expect(body.close_mode).toBe('explicit')
    expect(body.queue_id).toBe(queueId)
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', replied_with: body.message_id })
  })

  test('unclaimed pending row closes by explicit queue id', () => {
    const { queueId } = seedPending({ content: 'pending explicit close' })

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(0)
    const body = JSON.parse(reply.stdout)
    expect(body.work_closed).toBe(true)
    expect(body.close_mode).toBe('explicit')
    expect(body.queue_id).toBe(queueId)
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', replied_with: body.message_id })
  })

  test('expired caller-owned claim closes by explicit queue id', () => {
    const { queueId } = seedPending({ content: 'expired self claim' })
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)
    dbExec(`UPDATE message_queue
      SET claim_expires_at='2000-01-01T00:00:00.000Z'
      WHERE id=${queueId}`)

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(0)
    const body = JSON.parse(reply.stdout)
    expect(body.close_mode).toBe('explicit')
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', replied_with: body.message_id })
  })

  test('aged caller-owned claim closes by explicit queue id', () => {
    const { queueId } = seedPending({ content: 'aged self claim' })
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)
    dbExec(`UPDATE message_queue
      SET created_at='2000-01-01T00:00:00.000Z',
          claimed_at='2000-01-01T00:00:00.000Z',
          claim_expires_at='2999-01-01T00:00:00.000Z'
      WHERE id=${queueId}`)

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(0)
    const body = JSON.parse(reply.stdout)
    expect(body.close_mode).toBe('explicit')
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', replied_with: body.message_id })
  })

  test('another active owner fails with NOT_CLAIM_OWNER', () => {
    const { queueId } = seedPending({ content: 'owned elsewhere' })
    dbExec(`UPDATE message_queue
      SET status='received', claimed_by='other-dev', claimed_at=datetime('now'),
          claim_expires_at='2999-01-01T00:00:00.000Z'
      WHERE id=${queueId}`)

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body.code).toBe('NOT_CLAIM_OWNER')
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', replied_with: null })
  })

  test('already closed row fails with ALREADY_CLOSED and returns replied_with', () => {
    const { queueId } = seedPending({ content: 'already closed' })
    const repliedWith = randomUUID()
    dbExec(`UPDATE message_queue
      SET status='replied', replied_at=datetime('now'), replied_with='${repliedWith}'
      WHERE id=${queueId}`)

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({ code: 'ALREADY_CLOSED', replied_with: repliedWith })
  })

  test('queue id and message id mismatch fails with QUEUE_MESSAGE_MISMATCH', () => {
    const first = seedPending({ content: 'first' })
    const second = seedPending({ content: 'second' })

    const reply = explicitReply(first.queueId, ['--message-id', second.messageId])

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({
      code: 'QUEUE_MESSAGE_MISMATCH',
      queue_id: first.queueId,
      expected_message_id: first.messageId,
      supplied_message_id: second.messageId,
    })
  })

  test('wrong routed recipient fails with NOT_MENTIONED', () => {
    const { queueId } = seedPending({ agentId: 'other-dev', content: 'wrong recipient' })

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({ code: 'NOT_MENTIONED', queue_id: queueId })
  })

  test('non-member routed recipient fails with NOT_CHANNEL_MEMBER', () => {
    const { queueId } = seedPending({ channelId: 'no-probe-ch', content: 'not a channel member' })

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({ code: 'NOT_CHANNEL_MEMBER', queue_id: queueId, channel_id: 'no-probe-ch' })
  })

  test('missing queue id fails with QUEUE_NOT_FOUND', () => {
    const reply = explicitReply(999_999)

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({ code: 'QUEUE_NOT_FOUND', queue_id: '999999' })
  })

  test('legacy no-claim reply emits machine-readable reclaim guidance', () => {
    const reply = runAun([
      'reply',
      '--agent-id', 'probe-dev',
      '--content', 'late legacy reply',
      '--mentions', 'codex-cto',
    ])

    expect(reply.status).toBe(1)
    expect(reply.stderr).toContain('INVALID_REPLY_TO')
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({
      ok: false,
      code: 'RECLAIM_REQUIRED',
      reason: 'CLAIM_EXPIRED',
      legacy_code: 'INVALID_REPLY_TO',
    })
  })

  test('notify remains non-close and refuses queue id', () => {
    const { queueId } = seedPending({ content: 'notify cannot close' })

    const notify = runAun([
      'notify',
      '--agent-id', 'probe-dev',
      '--channel', 'probe-ch',
      '--queue-id', String(queueId),
      '--content', 'status only',
      '--mentions', 'codex-cto',
    ])

    expect(notify.status).toBe(2)
    expect(notify.stderr).toContain('NOTIFY_IS_NOT_REPLY')
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', replied_with: null })
    expect(dbRead(`SELECT count(*) AS n FROM agent_messages WHERE author_id = 'probe-dev'`)[0].n).toBe(0)
  })
})
