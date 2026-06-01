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
    AGENT_COM_EXPECTED_AGENT_ID: 'probe-dev',
  }
  const migrated = spawnSync('bun', [MIGRATE], { cwd: REPO_ROOT, env, encoding: 'utf-8' })
  if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
  dbExec(`
    INSERT INTO agents (agent_id, display_name, agent_type, status)
      VALUES ('probe-dev', 'probe-dev', 'dev', 'idle'),
             ('other-dev', 'other-dev', 'dev', 'idle'),
             ('codex-cto', 'codex-cto', 'cto', 'idle');
    INSERT INTO channels (id, name, members)
      VALUES ('probe-ch', 'probe-ch', '["probe-dev","other-dev","codex-cto"]'),
             ('no-probe-ch', 'no-probe-ch', '["codex-cto"]');
    INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('probe-ch', '["probe-dev","codex-cto"]', 'aun-durable-reply-close-test');
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

  test('next -> processing -> explicit close replies against the same queue row', () => {
    const { queueId, messageId } = seedPending({ content: 'processing then final close' })
    const next = runAun(['receive', '--agent-id', 'probe-dev'])
    expect(next.status).toBe(0)
    expect(JSON.parse(next.stdout)).toMatchObject({ queue_id: queueId, message_id: messageId })

    const processing = runAun(['processing', '--agent-id', 'probe-dev', '--queue-id', String(queueId)])
    expect(processing.status).toBe(0)
    expect(JSON.parse(processing.stdout)).toMatchObject({
      ok: true,
      mode: 'processing',
      queue_id: String(queueId),
      message_id: messageId,
      status: 'in_progress',
    })
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'in_progress', claimed_by: 'probe-dev', replied_with: null })

    const final = explicitReply(queueId, ['--message-id', messageId, '--close'])

    expect(final.status).toBe(0)
    const body = JSON.parse(final.stdout)
    expect(body.work_closed).toBe(true)
    expect(body.close_mode).toBe('explicit')
    expect(body.queue_id).toBe(queueId)
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', claimed_by: null, replied_with: body.message_id })
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

  test('unclaimed pending row fails closed by explicit queue id without writes', () => {
    const { queueId } = seedPending({ content: 'pending explicit close' })
    const beforeMessages = dbRead(`SELECT count(*) AS n FROM agent_messages`)[0].n
    const beforeOutbound = dbRead(`SELECT count(*) AS n FROM outbound_queue`)[0].n

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({
      ok: false,
      code: 'INVALID_STATE',
      queue_id: queueId,
      status: 'pending',
      claimed_by: null,
    })
    expect(body.queue_id).toBe(queueId)
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null, replied_with: null })
    expect(dbRead(`SELECT count(*) AS n FROM agent_messages`)[0].n).toBe(beforeMessages)
    expect(dbRead(`SELECT count(*) AS n FROM outbound_queue`)[0].n).toBe(beforeOutbound)
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
    expect(body.claim_renewal).toMatchObject({
      renewed: true,
      mode: 'exact_queue_id_same_owner',
      reason: 'expired_same_owner_before_reply_close',
      queue_id: queueId,
      agent_id: 'probe-dev',
      claimed_by: 'probe-dev',
      prior_claim_expires_at: '2000-01-01T00:00:00.000Z',
      audit_event_type: 'queue.claim_renewed',
      authorization: 'exact_queue_id_and_same_claim_owner',
      free_form_text_authorizes_renewal: false,
    })
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'replied', replied_with: body.message_id })
    const audit = dbRead(`SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type='queue.claim_renewed'`)[0]
    expect(audit).toMatchObject({ event_type: 'queue.claim_renewed', agent_id: 'probe-dev', target: String(queueId) })
    expect(JSON.parse(audit.detail)).toMatchObject({
      authorization: 'exact_queue_id_and_same_claim_owner',
      free_form_text_authorizes_renewal: false,
    })
  })

  test('expired caller-owned claim cannot renew through message-id-only close', () => {
    const { queueId, messageId } = seedPending({ content: 'expired self claim message-id only' })
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)
    dbExec(`UPDATE message_queue
      SET claim_expires_at='2000-01-01T00:00:00.000Z'
      WHERE id=${queueId}`)

    const reply = runAun([
      'reply',
      '--agent-id', 'probe-dev',
      '--message-id', messageId,
      '--content', 'late close',
      '--mentions', 'codex-cto',
      '--close',
    ])

    expect(reply.status).toBe(2)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({
      ok: false,
      code: 'QUEUE_ID_REQUIRED_FOR_RENEWAL',
      message_id: messageId,
      status: 'received',
      claimed_by: 'probe-dev',
    })
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', replied_with: null })
    expect(dbRead(`SELECT count(*) AS n FROM audit_log WHERE event_type='queue.claim_renewed'`)[0].n).toBe(0)
    expect(dbRead(`SELECT count(*) AS n FROM agent_messages WHERE author_id='probe-dev' AND reply_to=?`, [messageId])[0].n).toBe(0)
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

  test('already closed row with missing reply evidence fails closed for reconcile', () => {
    const { queueId } = seedPending({ content: 'already closed' })
    const repliedWith = randomUUID()
    dbExec(`UPDATE message_queue
      SET status='replied', replied_at=datetime('now'), replied_with='${repliedWith}'
      WHERE id=${queueId}`)

    const reply = explicitReply(queueId)

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({
      code: 'RECONCILE_REQUIRED',
      queue_id: queueId,
      status: 'replied',
      replied_with: repliedWith,
      evidence: {
        reply_message_present: false,
        outbound_queue_count: 0,
      },
    })
  })

  test('already closed row with unambiguous reply evidence is idempotent and does not duplicate outbound', () => {
    const { queueId, messageId } = seedPending({ content: 'already closed with evidence' })
    const repliedWith = randomUUID()
    dbExec(`
      INSERT INTO agent_messages (id, channel_id, author_id, content, reply_to)
        VALUES ('${repliedWith}', 'probe-ch', 'probe-dev', 'prior durable reply', '${messageId}');
      UPDATE message_queue
        SET status='replied', replied_at=datetime('now'), replied_with='${repliedWith}'
        WHERE id=${queueId};
    `)

    const reply = explicitReply(queueId, ['--message-id', messageId, '--close'])

    expect(reply.status).toBe(0)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({
      ok: true,
      code: 'IDEMPOTENT_REPLY_CLOSE',
      idempotent: true,
      queue_id: queueId,
      message_id: messageId,
      replied_with: repliedWith,
      outbound_message_id: repliedWith,
      work_closed: true,
      close_mode: 'idempotent',
    })
    expect(dbRead(`SELECT count(*) AS n FROM agent_messages WHERE author_id='probe-dev' AND reply_to=?`, [messageId])[0].n).toBe(1)
    expect(dbRead(`SELECT count(*) AS n FROM outbound_queue WHERE message_id=?`, [repliedWith])[0].n).toBe(0)
  })

  test('active row with replied_with evidence fails closed without duplicate outbound', () => {
    const { queueId, messageId } = seedPending({ content: 'active with partial reply evidence' })
    const repliedWith = randomUUID()
    dbExec(`
      INSERT INTO agent_messages (id, channel_id, author_id, content, reply_to)
        VALUES ('${repliedWith}', 'probe-ch', 'probe-dev', 'partial durable reply', '${messageId}');
      UPDATE message_queue
        SET status='received', claimed_by='probe-dev', claimed_at=datetime('now'),
            claim_expires_at='2999-01-01T00:00:00.000Z',
            replied_with='${repliedWith}'
        WHERE id=${queueId};
    `)

    const reply = explicitReply(queueId, ['--message-id', messageId, '--close'])

    expect(reply.status).toBe(1)
    const body = JSON.parse(reply.stdout)
    expect(body).toMatchObject({
      code: 'RECONCILE_REQUIRED',
      queue_id: queueId,
      status: 'received',
      replied_with: repliedWith,
      evidence: {
        reply_message_present: true,
        reply_message_matches_queue: true,
        outbound_queue_count: 0,
      },
    })
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'probe-dev', replied_with: repliedWith })
    expect(dbRead(`SELECT count(*) AS n FROM agent_messages WHERE author_id='probe-dev' AND reply_to=?`, [messageId])[0].n).toBe(1)
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
    expect(runAun(['receive', '--agent-id', 'probe-dev', '--queue-id', String(queueId)]).status).toBe(0)

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

describe('test_aun_durable_reply_close_wrapper - exact claim renewal', () => {
  test('renew-claim requires explicit queue id', () => {
    const renew = runAun(['renew-claim', '--agent-id', 'probe-dev', '--reason', 'long running'])

    expect(renew.status).toBe(2)
    expect(renew.stderr).toContain('--queue-id is required')
  })

  test('renew-claim rejects pending rows without mutating lifecycle state', () => {
    const { queueId } = seedPending({ content: 'pending cannot renew' })

    const renew = runAun([
      'renew-claim',
      '--agent-id', 'probe-dev',
      '--queue-id', String(queueId),
      '--reason', 'long running',
    ])

    expect(renew.status).toBe(1)
    expect(renew.stderr).toContain('INVALID_STATE')
    expect(dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null, replied_with: null })
    expect(dbRead(`SELECT count(*) AS n FROM audit_log WHERE event_type='queue.claim_renewed'`)[0].n).toBe(0)
  })

  test('renew-claim extends only exact in-progress same-owner claim and records audit evidence', () => {
    const { queueId, messageId } = seedPending({ content: 'renew exact in progress' })
    expect(runAun(['receive', '--agent-id', 'probe-dev']).status).toBe(0)
    expect(runAun(['processing', '--agent-id', 'probe-dev', '--queue-id', String(queueId)]).status).toBe(0)
    dbExec(`UPDATE message_queue
      SET claim_expires_at='2000-01-01T00:00:00.000Z'
      WHERE id=${queueId}`)

    const renew = runAun([
      'renew-claim',
      '--agent-id', 'probe-dev',
      '--queue-id', String(queueId),
      '--reason', 'long running reply close',
      '--ttl-seconds', '90',
    ])

    expect(renew.status).toBe(0)
    const body = JSON.parse(renew.stdout)
    expect(body).toMatchObject({
      ok: true,
      mode: 'renew-claim',
      queue_id: String(queueId),
      message_id: messageId,
      status: 'in_progress',
      claimed_by: 'probe-dev',
      prior_claim_expires_at: '2000-01-01T00:00:00.000Z',
      ttl_seconds: 90,
      reason: 'long running reply close',
      audit_event_type: 'queue.claim_renewed',
      authorization: 'exact_queue_id_and_same_claim_owner',
      free_form_text_authorizes_renewal: false,
    })
    expect(new Date(body.new_claim_expires_at).getTime()).toBeGreaterThan(Date.now())
    const row = dbRead(`SELECT status, claimed_by, replied_with, claim_expires_at FROM message_queue WHERE id = ?`, [queueId])[0]
    expect(row.status).toBe('in_progress')
    expect(row.claimed_by).toBe('probe-dev')
    expect(row.replied_with).toBe(null)
    expect(row.claim_expires_at).not.toBe('2000-01-01T00:00:00.000Z')
    const audit = dbRead(`SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type='queue.claim_renewed'`)[0]
    expect(audit).toMatchObject({ event_type: 'queue.claim_renewed', agent_id: 'probe-dev', target: String(queueId) })
    expect(JSON.parse(audit.detail)).toMatchObject({
      queue_id: String(queueId),
      status: 'in_progress',
      authorization: 'exact_queue_id_and_same_claim_owner',
      free_form_text_authorizes_renewal: false,
    })
  })

  test('renew-claim rejects another owner exact id', () => {
    const { queueId } = seedPending({ content: 'renew wrong owner' })
    dbExec(`UPDATE message_queue
      SET status='received', claimed_by='other-dev', claimed_at=datetime('now'),
          claim_expires_at='2000-01-01T00:00:00.000Z'
      WHERE id=${queueId}`)

    const renew = runAun([
      'renew-claim',
      '--agent-id', 'probe-dev',
      '--queue-id', String(queueId),
      '--reason', 'long running',
    ])

    expect(renew.status).toBe(1)
    expect(renew.stderr).toContain('NOT_CLAIM_OWNER')
    expect(dbRead(`SELECT status, claimed_by, claim_expires_at FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'other-dev', claim_expires_at: '2000-01-01T00:00:00.000Z' })
    expect(dbRead(`SELECT count(*) AS n FROM audit_log WHERE event_type='queue.claim_renewed'`)[0].n).toBe(0)
  })
})
