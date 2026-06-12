#!/usr/bin/env bun
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const AUN = join(REPO_ROOT, 'bin', 'aun.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')
const TEST_AGENT = 'targeted-dev'
const OTHER_AGENT = 'other-targeted-dev'

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

function seedQueue(opts: {
  agentId?: string
  messageType?: string
  content: string
  status?: string
  claimedBy?: string | null
  ageSeconds?: number
  presentation?: Record<string, unknown>
}): { messageId: string; queueId: number } {
  return withDb((db) => {
    const messageId = randomUUID()
    const createdAt = new Date(Date.now() - (opts.ageSeconds ?? 30) * 1000).toISOString()
    const messageType = opts.messageType ?? 'instruction'
    const agentId = opts.agentId ?? TEST_AGENT
    db.prepare(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, created_at)
       VALUES (?, 'targeted-ch', 'codex-cto', ?, ?, ?)`,
    ).run(messageId, opts.content, messageType, createdAt)
    const payload = JSON.stringify({
      content: opts.content,
      channel_id: 'targeted-ch',
      author_id: 'codex-cto',
      message_id: messageId,
      message_type: messageType,
      ...(opts.presentation ? { canonical_presentation: opts.presentation } : {}),
    })
    const claimedAt = opts.claimedBy ? new Date(Date.now() - 10_000).toISOString() : null
    const claimExpiresAt = opts.claimedBy ? new Date(Date.now() + 60_000).toISOString() : null
    const row = db.prepare(
      `INSERT INTO message_queue
        (agent_id, message_id, payload, status, created_at, claimed_by, claimed_at, claim_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).get(
      agentId,
      messageId,
      payload,
      opts.status ?? 'pending',
      createdAt,
      opts.claimedBy ?? null,
      claimedAt,
      claimExpiresAt,
    ) as { id: number }
    return { messageId, queueId: row.id }
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function row(queueId: number): { status: string; claimed_by: string | null; claim_ttl: number } {
  return withDb((db) => db.prepare(
    `SELECT status, claimed_by, claim_expires_at IS NOT NULL AS claim_ttl
       FROM message_queue WHERE id = ?`,
  ).get(queueId) as { status: string; claimed_by: string | null; claim_ttl: number })
}

function rowPayload(queueId: number): Record<string, unknown> {
  return withDb((db) => {
    const found = db.prepare(`SELECT payload FROM message_queue WHERE id = ?`).get(queueId) as { payload: string }
    return JSON.parse(found.payload)
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-targeted-receive-'))
  dbPath = join(tmpDir, 'test.db')
  env = {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    AGENT_COM_PG_NOTIFY: 'false',
    DATABASE_URL: '',
    AGENT_ID: TEST_AGENT,
    AGENT_COM_EXPECTED_AGENT_ID: TEST_AGENT,
    AGENT_COMMS_CLAIM_TTL_SEC: '60',
  }
  const migrated = spawnSync('bun', [MIGRATE], { cwd: REPO_ROOT, env, encoding: 'utf-8' })
  if (migrated.status !== 0) throw new Error(`migrate failed: ${migrated.stderr}`)
  withDb((db) => {
    db.exec(`
      INSERT INTO agents (agent_id, display_name, agent_type, status)
        VALUES ('${TEST_AGENT}', '${TEST_AGENT}', 'dev', 'idle'),
               ('${OTHER_AGENT}', '${OTHER_AGENT}', 'dev', 'idle'),
               ('codex-cto', 'codex-cto', 'cto', 'idle');
      INSERT INTO channels (id, name, members)
        VALUES ('targeted-ch', 'targeted-ch', '["${TEST_AGENT}","${OTHER_AGENT}","codex-cto"]');
    `)
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_targeted_receive - exact queue_id receive runner', () => {
  test('receive --queue-id claims only the requested pending row without FIFO drain', () => {
    const requested = seedQueue({ messageType: 'chat', content: 'old chat still exact target', ageSeconds: 300 })
    const newer = seedQueue({ messageType: 'instruction', content: 'newer instruction must stay pending', ageSeconds: 10 })

    const r = runAun(['receive', '--agent-id', TEST_AGENT, '--queue-id', String(requested.queueId)])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      queue_id: requested.queueId,
      message_id: requested.messageId,
      content: 'old chat still exact target',
      message_type: 'chat',
    })
    expect(row(requested.queueId)).toEqual({ status: 'received', claimed_by: TEST_AGENT, claim_ttl: 1 })
    expect(row(newer.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
  })

  test('next --queue-id uses the same targeted claim path', () => {
    const first = seedQueue({ content: 'first exact request', ageSeconds: 120 })
    const second = seedQueue({ content: 'second must remain pending', ageSeconds: 60 })

    const r = runAun(['next', '--agent-id', TEST_AGENT, '--queue-id', String(first.queueId)])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.queue_id).toBe(first.queueId)
    expect(body.content).toBe('first exact request')
    expect(row(first.queueId)).toEqual({ status: 'received', claimed_by: TEST_AGENT, claim_ttl: 1 })
    expect(row(second.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
    expect(rowPayload(first.queueId).receive_claim).toBeUndefined()
  })

  test('receive --queue-id can persist daemon claim source evidence without changing claim semantics', () => {
    const target = seedQueue({ content: 'daemon exact request', ageSeconds: 30 })
    env = {
      ...env,
      AUN_RECEIVE_CLAIM_SOURCE: 'state-daemon-queue-work-scheduler',
    }

    const r = runAun(['receive', '--agent-id', TEST_AGENT, '--queue-id', String(target.queueId)])

    expect(r.status).toBe(0)
    expect(row(target.queueId)).toEqual({ status: 'received', claimed_by: TEST_AGENT, claim_ttl: 1 })
    expect(rowPayload(target.queueId).receive_claim).toEqual({
      mode: 'targeted-receive',
      source: 'state-daemon-queue-work-scheduler',
      agent_id: TEST_AGENT,
      queue_id: String(target.queueId),
    })
  })

  test('dry-run reports the target row without mutating it', () => {
    const target = seedQueue({ content: 'dry target' })

    const r = runAun(['receive', '--agent-id', TEST_AGENT, '--queue-id', String(target.queueId), '--dry-run'])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      mode: 'targeted-receive',
      queue_id: String(target.queueId),
      blocked_reason: null,
      observed_status: 'pending',
    })
    expect(body.selected.queue_id).toBe(target.queueId)
    expect(row(target.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
  })

  test('wrong owner fails closed and leaves unrelated rows untouched', () => {
    const other = seedQueue({ agentId: OTHER_AGENT, content: 'belongs to another agent' })
    const own = seedQueue({ content: 'own row must not be claimed as fallback' })

    const r = runAun(['receive', '--agent-id', TEST_AGENT, '--queue-id', String(other.queueId)])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('TARGETED_RECEIVE_BLOCKED')
    expect(r.stderr).toContain('target_queue_not_found')
    expect(row(other.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
    expect(row(own.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
  })

  test('non-pending target fails closed and does not fall back to a newer pending row', () => {
    const active = seedQueue({ content: 'already claimed', status: 'received', claimedBy: TEST_AGENT })
    const pending = seedQueue({ content: 'must remain pending' })

    const r = runAun(['next', '--agent-id', TEST_AGENT, '--queue-id', String(active.queueId)])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('TARGETED_RECEIVE_BLOCKED')
    expect(r.stderr).toContain('target_queue_not_pending')
    expect(row(active.queueId)).toEqual({ status: 'received', claimed_by: TEST_AGENT, claim_ttl: 1 })
    expect(row(pending.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
  })

  test('fragment target fails closed and leaves unrelated rows untouched', () => {
    const fragment = seedQueue({
      content: 'part 1/3',
      presentation: {
        presentation_group_id: 'audit-split-1',
        fragment_count: 3,
        fragment_index: 1,
        is_claimable: false,
        fragment_body_hash: sha256('part 1/3'),
      },
    })
    const pending = seedQueue({ content: 'canonical work must remain pending' })

    const r = runAun(['receive', '--agent-id', TEST_AGENT, '--queue-id', String(fragment.queueId)])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('TARGETED_RECEIVE_BLOCKED')
    expect(r.stderr).toContain('FRAGMENT_NOT_CLAIMABLE')
    expect(row(fragment.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
    expect(row(pending.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
  })

  test('ambiguous split target fails closed before runtime claim', () => {
    const ambiguous = seedQueue({
      content: '1/2 without canonical evidence',
      presentation: {
        fragment_count: 2,
        fragment_index: 1,
      },
    })

    const r = runAun(['next', '--agent-id', TEST_AGENT, '--queue-id', String(ambiguous.queueId)])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('TARGETED_RECEIVE_BLOCKED')
    expect(r.stderr).toContain('PRESENTATION_GROUP_INCOMPLETE')
    expect(row(ambiguous.queueId)).toEqual({ status: 'pending', claimed_by: null, claim_ttl: 0 })
  })

  test('claimable canonical split row returns presentation evidence with one body', () => {
    const content = 'complete canonical audit request'
    const canonical = seedQueue({
      content,
      presentation: {
        presentation_group_id: 'audit-split-2',
        fragment_count: 3,
        fragment_index: 0,
        is_claimable: true,
        canonical_body_hash: sha256(content),
      },
    })

    const r = runAun(['receive', '--agent-id', TEST_AGENT, '--queue-id', String(canonical.queueId)])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      queue_id: canonical.queueId,
      message_id: canonical.messageId,
      content,
      presentation: {
        kind: 'canonical',
        presentation_group_id: 'audit-split-2',
        fragment_count: 3,
        fragment_index: 0,
        is_claimable: true,
        canonical_body_hash: sha256(content),
      },
    })
    expect(row(canonical.queueId)).toEqual({ status: 'received', claimed_by: TEST_AGENT, claim_ttl: 1 })
  })
})
