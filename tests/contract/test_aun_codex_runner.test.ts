#!/usr/bin/env bun
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { renderAckContent, resolveNestedBunExecutable } from '../../bin/aun/codex-runner'

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

function seedPending(content = 'codex runner request'): { messageId: string; queueId: number } {
  const db = new Database(dbPath)
  try {
    const messageId = randomUUID()
    db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content, message_type)
      VALUES (?, 'runner-ch', 'codex-cto', ?, 'instruction')`).run(messageId, content)
    const payload = JSON.stringify({
      content,
      channel_id: 'runner-ch',
      author_id: 'codex-cto',
      message_id: messageId,
      message_type: 'instruction',
    })
    const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status)
      VALUES ('codex-aun', ?, ?, 'pending') RETURNING id`).get(messageId, payload) as { id: number }
    return { messageId, queueId: row.id }
  } finally {
    db.close()
  }
}

function seedTypedPending(opts: { content: string; messageType: string; ageSeconds: number }): { messageId: string; queueId: number } {
  const db = new Database(dbPath)
  try {
    const messageId = randomUUID()
    const createdAt = new Date(Date.now() - opts.ageSeconds * 1000).toISOString()
    db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, created_at)
      VALUES (?, 'runner-ch', 'codex-cto', ?, ?, ?)`).run(messageId, opts.content, opts.messageType, createdAt)
    const payload = JSON.stringify({
      content: opts.content,
      channel_id: 'runner-ch',
      author_id: 'codex-cto',
      message_id: messageId,
      message_type: opts.messageType,
    })
    const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status, created_at)
      VALUES ('codex-aun', ?, ?, 'pending', ?) RETURNING id`).get(messageId, payload, createdAt) as { id: number }
    return { messageId, queueId: row.id }
  } finally {
    db.close()
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-codex-runner-'))
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
    INSERT INTO agents (agent_id, display_name, agent_type, status)
      VALUES ('codex-aun', 'codex-aun', 'dev', 'idle'),
             ('codex-cto', 'codex-cto', 'cto', 'idle');
    INSERT INTO channels (id, name, members)
      VALUES ('runner-ch', 'runner-ch', '["codex-aun","codex-cto"]');
    INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('runner-ch', '["codex-aun","codex-cto"]', 'aun-codex-runner-test');
  `)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_codex_runner - DB-primary Codex receive tick', () => {
  test('nested receive-actionable command does not rely on bare bun under launchd PATH', () => {
    const originalAunOverride = process.env.AUN_BUN_EXECUTABLE
    const originalOverride = process.env.STATE_DAEMON_BUN_EXECUTABLE
    try {
      delete process.env.AUN_BUN_EXECUTABLE
      process.env.STATE_DAEMON_BUN_EXECUTABLE = ''
      expect(resolveNestedBunExecutable()).toBe(process.execPath)
      expect(resolveNestedBunExecutable()).not.toBe('bun')

      process.env.STATE_DAEMON_BUN_EXECUTABLE = '/operator/bin/bun'
      expect(resolveNestedBunExecutable()).toBe('/operator/bin/bun')

      process.env.AUN_BUN_EXECUTABLE = '/operator/aun-bun'
      expect(resolveNestedBunExecutable()).toBe('/operator/aun-bun')
    } finally {
      if (originalAunOverride === undefined) {
        delete process.env.AUN_BUN_EXECUTABLE
      } else {
        process.env.AUN_BUN_EXECUTABLE = originalAunOverride
      }
      if (originalOverride === undefined) {
        delete process.env.STATE_DAEMON_BUN_EXECUTABLE
      } else {
        process.env.STATE_DAEMON_BUN_EXECUTABLE = originalOverride
      }
    }
  })

  test('claims pending work and retains queue/message identity', () => {
    const { messageId, queueId } = seedPending('retain identity')

    const r = runAun(['codex-runner', '--agent-id', 'codex-aun', '--limit', '1'])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.receive_mode).toBe('receive-actionable')
    expect(body.retained_count).toBe(1)
    expect(body.retained[0]).toMatchObject({
      queue_id: String(queueId),
      message_id: messageId,
      channel_id: 'runner-ch',
      from: 'codex-cto',
      content: 'retain identity',
    })
    expect(body.final_close_contract).toContain('--close --queue-id')
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'codex-aun', replied_with: null })
  })

  test('uses actionable selection so stale non-action rows do not hide current instruction', () => {
    const stale = seedTypedPending({ messageType: 'chat', ageSeconds: 300, content: 'old chat backlog' })
    const current = seedTypedPending({ messageType: 'instruction', ageSeconds: 30, content: 'current CTO instruction' })

    const r = runAun(['codex-runner', '--agent-id', 'codex-aun', '--limit', '1', '--max-inspect', '10'])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.receive_mode).toBe('receive-actionable')
    expect(body.retained_count).toBe(1)
    expect(body.retained[0]).toMatchObject({
      queue_id: String(current.queueId),
      content: 'current CTO instruction',
      message_type: 'instruction',
    })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [stale.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [current.queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'codex-aun' })
  })

  test('optional ACK uses no-close and leaves the claimed queue open', () => {
    const { queueId } = seedPending('ack me')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--limit', '1',
      '--ack-mentions', 'codex-cto',
      '--ack-content', 'ACK: accepted',
    ])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.acked_count).toBe(1)
    expect(body.acks[0].ok).toBe(true)
    expect(body.acks[0].stdout.work_closed).toBe(false)
    expect(body.acks[0].stdout.close_mode).toBe('none')
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'codex-aun', replied_with: null })
  })

  test('ACK content placeholders render from the actually claimed row identity', () => {
    const { messageId, queueId } = seedPending('ack template')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--limit', '1',
      '--ack-mentions', 'codex-cto',
      '--ack-content', 'ACK: queue_id={queue_id}; message_id={message_id}; from={from}; channel={channel_id}',
    ])

    expect(r.status).toBe(0)
    const ackMessage = dbRead(
      `SELECT content, reply_to FROM agent_messages
        WHERE author_id = 'codex-aun'
        ORDER BY created_at DESC
        LIMIT 1`,
    )[0]
    expect(ackMessage).toEqual({
      content: `ACK: queue_id=${queueId}; message_id=${messageId}; from=codex-cto; channel=runner-ch`,
      reply_to: messageId,
    })
  })

  test('ACK template follows actionable claim rather than an older skipped pending row', () => {
    const stale = seedTypedPending({ messageType: 'chat', ageSeconds: 300, content: 'old chat backlog' })
    const current = seedTypedPending({ messageType: 'instruction', ageSeconds: 30, content: 'current instruction' })

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--limit', '1',
      '--max-inspect', '10',
      '--ack-mentions', 'codex-cto',
      '--ack-content', 'ACK: queue_id={queue_id}; message_id={message_id}',
    ])

    expect(r.status).toBe(0)
    const ackMessage = dbRead(
      `SELECT content, reply_to FROM agent_messages
        WHERE author_id = 'codex-aun'
        ORDER BY created_at DESC
        LIMIT 1`,
    )[0]
    expect(ackMessage).toEqual({
      content: `ACK: queue_id=${current.queueId}; message_id=${current.messageId}`,
      reply_to: current.messageId,
    })
    expect(ackMessage.content).not.toContain(`queue_id=${stale.queueId}`)
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [stale.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('renderAckContent leaves unknown template tokens untouched', () => {
    expect(renderAckContent('queue={queue_id}; missing={unknown}', {
      queue_id: '123',
      message_id: 'msg-123',
      channel_id: null,
      thread_id: null,
      from: null,
      message_type: null,
      content: '',
    })).toBe('queue=123; missing={unknown}')
  })

  test('final close remains explicit after runner ACK/progress', () => {
    const { messageId, queueId } = seedPending('final close')
    const tick = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--ack-mentions', 'codex-cto',
      '--ack-content', 'ACK: working',
    ])
    expect(tick.status).toBe(0)

    const final = runAun([
      'reply',
      '--agent-id', 'codex-aun',
      '--queue-id', String(queueId),
      '--message-id', messageId,
      '--close',
      '--mentions', 'codex-cto',
      '--content', 'final result',
    ])

    expect(final.status).toBe(0)
    const body = JSON.parse(final.stdout)
    expect(body.work_closed).toBe(true)
    expect(body.close_mode).toBe('explicit')
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', replied_with: body.message_id })
  })

  test('identity mismatch fails closed before receiving work', () => {
    const { queueId } = seedPending('identity mismatch')

    const r = runAun(
      ['codex-runner', '--agent-id', 'wrong-agent'],
      { AGENT_COM_EXPECTED_AGENT_ID: 'codex-aun' },
    )

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('AGENT_ID_MISMATCH')
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('partial ACK arguments fail without claiming work', () => {
    const { queueId } = seedPending('bad ack args')

    const r = runAun(['codex-runner', '--agent-id', 'codex-aun', '--ack-content', 'ACK'])

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CODEX_RUNNER_ACK_INVALID')
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })
})
