#!/usr/bin/env bun
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { buildNotifyPlan, buildReplyPlan, resolveWrapperBunExecutable } from '../../bin/aun/reply'

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

function seedPending(content = 'review request'): { messageId: string; queueId: number } {
  const db = new Database(dbPath)
  try {
    const messageId = randomUUID()
    db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content)
      VALUES (?, 'probe-ch', 'codex-cto', ?)`).run(messageId, content)
    const payload = JSON.stringify({
      content,
      channel_id: 'probe-ch',
      author_id: 'codex-cto',
      message_id: messageId,
    })
    const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status)
      VALUES ('probe-dev', ?, ?, 'pending') RETURNING id`).get(messageId, payload) as { id: number }
    return { messageId, queueId: row.id }
  } finally {
    db.close()
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-reply-notify-'))
  dbPath = join(tmpDir, 'test.db')
  env = {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    AGENT_COM_PG_NOTIFY: 'false',
    DATABASE_URL: '',
  }
  const migrated = spawnSync('bun', [MIGRATE], { cwd: REPO_ROOT, env, encoding: 'utf-8' })
  if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
  dbExec(`
    INSERT INTO agents (agent_id, display_name, agent_type, status)
      VALUES ('probe-dev', 'probe-dev', 'dev', 'idle');
    INSERT INTO channels (id, name, members)
      VALUES ('probe-ch', 'probe-ch', '["probe-dev","codex-cto"]');
    INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('probe-ch', '["probe-dev","codex-cto"]', 'aun-reply-notify-test');
  `)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_reply_notify_wrapper — claim close semantics', () => {
  test('reply and notify wrapper plans do not rely on bare bun under launchd PATH', () => {
    const originalAunOverride = process.env.AUN_BUN_EXECUTABLE
    const originalStateDaemonOverride = process.env.STATE_DAEMON_BUN_EXECUTABLE
    try {
      delete process.env.AUN_BUN_EXECUTABLE
      process.env.STATE_DAEMON_BUN_EXECUTABLE = ''
      expect(resolveWrapperBunExecutable()).toBe(process.execPath)
      expect(resolveWrapperBunExecutable()).not.toBe('bun')

      process.env.STATE_DAEMON_BUN_EXECUTABLE = '/operator/bin/bun'
      expect(resolveWrapperBunExecutable()).toBe('/operator/bin/bun')

      process.env.AUN_BUN_EXECUTABLE = '/operator/aun-bun'
      expect(resolveWrapperBunExecutable()).toBe('/operator/aun-bun')

      const replyPlan = buildReplyPlan({
        agentId: 'probe-dev',
        content: 'done',
        mentions: 'codex-cto',
        env,
      })
      const notifyPlan = buildNotifyPlan({
        agentId: 'probe-dev',
        channelId: 'probe-ch',
        content: 'notice',
        mentions: 'codex-cto',
        env,
      })
      expect(replyPlan.argv[0]).toBe('/operator/aun-bun')
      expect(notifyPlan.argv[0]).toBe('/operator/aun-bun')
    } finally {
      if (originalAunOverride === undefined) {
        delete process.env.AUN_BUN_EXECUTABLE
      } else {
        process.env.AUN_BUN_EXECUTABLE = originalAunOverride
      }
      if (originalStateDaemonOverride === undefined) {
        delete process.env.STATE_DAEMON_BUN_EXECUTABLE
      } else {
        process.env.STATE_DAEMON_BUN_EXECUTABLE = originalStateDaemonOverride
      }
    }
  })

  test('active claim reply closes the original queue row and records replied_with', () => {
    const { queueId } = seedPending('active claim')
    const next = runAun(['receive', '--agent-id', 'probe-dev'])
    expect(next.status).toBe(0)

    const reply = runAun([
      'reply',
      '--agent-id', 'probe-dev',
      '--content', 'done',
      '--mentions', 'codex-cto',
    ])
    expect(reply.status).toBe(0)
    const payload = JSON.parse(reply.stdout) as { message_id: string; reply_to: string }
    const rows = dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])
    expect(rows[0]).toEqual({ status: 'replied', replied_with: payload.message_id })
  })

  test('expired/reclaimed claim failure is distinguishable and fail-closed', () => {
    const { queueId } = seedPending('expired claim')
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)

    dbExec(`UPDATE message_queue
      SET status='pending', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL, read_at=NULL
      WHERE id=${queueId}`)

    const reply = runAun([
      'reply',
      '--agent-id', 'probe-dev',
      '--content', 'late reply',
      '--mentions', 'codex-cto',
    ])
    expect(reply.status).not.toBe(0)
    expect(reply.stderr).toContain('INVALID_REPLY_TO')
    expect(reply.stderr).toContain('CLAIM_EXPIRED_OR_MISSING')
    const rows = dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])
    expect(rows[0]).toEqual({ status: 'pending', replied_with: null })
  })

  test('notify wrapper refuses to masquerade as a reply', () => {
    const notify = runAun([
      'notify',
      '--agent-id', 'probe-dev',
      '--channel-id', 'probe-ch',
      '--content', 'fallback text',
      '--mentions', 'codex-cto',
      '--reply-to', randomUUID(),
    ])
    expect(notify.status).toBe(2)
    expect(notify.stderr).toContain('NOTIFY_IS_NOT_REPLY')
    expect(dbRead(`SELECT count(*) AS n FROM agent_messages WHERE author_id = 'probe-dev'`)[0].n).toBe(0)
  })
})
