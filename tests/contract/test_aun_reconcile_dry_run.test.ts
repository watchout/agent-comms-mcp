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
const TEST_AGENT = 'reconcile-dev'

let tmpDir: string
let dbPath: string
let env: Record<string, string>

function runAun(args: string[], envOverride: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', ['run', AUN, ...args], {
    cwd: '/tmp',
    env: { ...env, ...envOverride },
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
  messageType: string
  ageSeconds: number
  status?: string
  source?: string
  content?: string
  claimedBy?: string | null
  repliedWith?: string | null
  failedReason?: string | null
  doneAt?: string | null
}): number {
  return withDb((db) => {
    const messageId = randomUUID()
    const createdAt = new Date(Date.now() - opts.ageSeconds * 1000).toISOString()
    const content = opts.content ?? `${opts.messageType} body`
    db.prepare(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source, created_at)
       VALUES (?, 'reconcile-ch', 'codex-cto', ?, ?, ?, ?)`,
    ).run(messageId, content, opts.messageType, opts.source ?? 'agent-comms', createdAt)
    const payload = JSON.stringify({
      message_id: messageId,
      channel_id: 'reconcile-ch',
      author_id: 'codex-cto',
      content,
      message_type: opts.messageType,
      source: opts.source ?? 'agent-comms',
    })
    const claimedAt = opts.claimedBy ? new Date(Date.now() - 30_000).toISOString() : null
    const claimExpiresAt = opts.claimedBy ? new Date(Date.now() + 60_000).toISOString() : null
    const row = db.prepare(
      `INSERT INTO message_queue
        (agent_id, message_id, payload, status, priority, created_at, claimed_by,
         claimed_at, claim_expires_at, replied_with, failed_reason, done_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).get(
      opts.agentId ?? TEST_AGENT,
      messageId,
      payload,
      opts.status ?? 'pending',
      createdAt,
      opts.claimedBy ?? null,
      claimedAt,
      claimExpiresAt,
      opts.repliedWith ?? null,
      opts.failedReason ?? null,
      opts.doneAt ?? null,
    ) as { id: number }
    return row.id
  })
}

function statuses(): Array<{ id: number; status: string; claimed_by: string | null; replied_with: string | null }> {
  return withDb((db) => db.prepare(
    `SELECT id, status, claimed_by, replied_with FROM message_queue WHERE agent_id = ? ORDER BY id ASC`,
  ).all(TEST_AGENT) as Array<{ id: number; status: string; claimed_by: string | null; replied_with: string | null }>)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-reconcile-'))
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
        VALUES ('reconcile-ch', 'reconcile-ch', '["${TEST_AGENT}","cto","codex-cto"]');
    `)
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_reconcile_dry_run - read-only backlog reconciliation inventory', () => {
  test('requires explicit dry-run and never mutates queue state', () => {
    seedQueue({ messageType: 'instruction', ageSeconds: 60 })

    const rejected = runAun(['reconcile', '--agent-id', TEST_AGENT, '--limit', '10'])
    expect(rejected.status).toBe(2)
    expect(rejected.stderr).toContain('pass --dry-run')

    const r = runAun(['reconcile', '--dry-run', '--agent-id', TEST_AGENT, '--limit', '10'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      mode: 'reconcile',
      agent_id: TEST_AGENT,
      limit: 10,
      inspected_count: 1,
    })
    expect(body.rows[0]).toMatchObject({
      classification: 'actionable_current',
      proposed_action: 'claim_for_work',
      required_authority: 'routed_agent',
    })
    expect(statuses()).toMatchObject([{ status: 'pending', claimed_by: null, replied_with: null }])
  })

  test('returns classes, proposed actions, required evidence, warnings, and stable fingerprints', () => {
    seedQueue({ messageType: 'instruction', ageSeconds: 60 })
    seedQueue({ messageType: 'chat', ageSeconds: 120 })
    seedQueue({ messageType: 'projection', ageSeconds: 180, source: 'discord-projection' })
    seedQueue({ messageType: 'mystery_v1', ageSeconds: 240 })
    seedQueue({ messageType: 'request', ageSeconds: 300, status: 'received', claimedBy: TEST_AGENT })
    seedQueue({ messageType: 'chat', ageSeconds: 360, status: 'replied' })

    const r1 = runAun(['reconcile', '--dry-run', '--agent-id', TEST_AGENT, '--limit', '20'])
    const r2 = runAun(['reconcile', '--dry-run', '--agent-id', TEST_AGENT, '--limit', '20'])
    expect(r1.status).toBe(0)
    expect(r2.status).toBe(0)
    const body1 = JSON.parse(r1.stdout)
    const body2 = JSON.parse(r2.stdout)

    expect(body1.counts_by_class).toMatchObject({
      actionable_current: 1,
      obsolete_notice: 1,
      projection_only: 1,
      unknown_type: 1,
      active_claim: 1,
      terminal_legacy_invariant: 1,
    })
    expect(body1.counts_by_action.claim_for_work).toBe(1)
    expect(body1.counts_by_action.request_human_review).toBeGreaterThanOrEqual(3)
    expect(body1.warnings).toContain('missing_replied_at')
    expect(body1.warnings).toContain('missing_replied_with')
    const unknown = body1.rows.find((row: any) => row.classification === 'unknown_type')
    expect(unknown.required_evidence).toContain('raw_message_type')
    expect(unknown.evidence.payload_keys).toContain('message_type')
    expect(unknown.fingerprint).toMatchObject({ version: 1, algorithm: 'sha256' })
    expect(unknown.fingerprint.hash).toMatch(/^[a-f0-9]{64}$/)

    const hashes1 = body1.rows.map((row: any) => row.fingerprint.hash)
    const hashes2 = body2.rows.map((row: any) => row.fingerprint.hash)
    expect(hashes1).toEqual(hashes2)
  })

  test('uses bounded cursor pagination without claiming rows', () => {
    const first = seedQueue({ messageType: 'instruction', ageSeconds: 300 })
    const second = seedQueue({ messageType: 'chat', ageSeconds: 200 })
    const third = seedQueue({ messageType: 'question', ageSeconds: 100 })

    const page1 = runAun(['reconcile', '--dry-run', '--agent-id', TEST_AGENT, '--limit', '2'])
    expect(page1.status).toBe(0)
    const body1 = JSON.parse(page1.stdout)
    expect(body1.truncated).toBe(true)
    expect(typeof body1.cursor_next).toBe('string')
    expect(body1.rows.map((row: any) => row.queue_id)).toEqual([first, second])

    const page2 = runAun(['reconcile', '--dry-run', '--agent-id', TEST_AGENT, '--limit', '2', '--cursor', body1.cursor_next])
    expect(page2.status).toBe(0)
    const body2 = JSON.parse(page2.stdout)
    expect(body2.truncated).toBe(false)
    expect(body2.cursor).toBe(body1.cursor_next)
    expect(body2.cursor_next).toBeNull()
    expect(body2.rows.map((row: any) => row.queue_id)).toEqual([third])
    expect(statuses().map((row) => row.status)).toEqual(['pending', 'pending', 'pending'])
  })

  test('identity split remains human-review only until alias schema is approved', () => {
    seedQueue({ agentId: 'cto', messageType: 'instruction', ageSeconds: 100 })

    const r = runAun(
      ['reconcile', '--dry-run', '--agent-id', 'cto', '--limit', '5'],
      { AGENT_ID: 'cto', AGENT_COM_EXPECTED_AGENT_ID: 'cto' },
    )
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.rows[0]).toMatchObject({
      classification: 'identity_split',
      proposed_action: 'request_human_review',
      required_authority: 'cto_or_alias_policy',
    })
    expect(body.rows[0].required_evidence).toContain('alias_rule_id')
  })

  test('notify fallback candidates require deterministic evidence and do not close source rows', () => {
    seedQueue({
      messageType: 'notice',
      source: 'cli-notify',
      content: 'sent fallback: notify (reason: claim_missing)',
      ageSeconds: 100,
    })

    const r = runAun(['reconcile', '--dry-run', '--agent-id', TEST_AGENT, '--limit', '5'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.rows[0]).toMatchObject({
      classification: 'notify_fallback_result',
      proposed_action: 'request_human_review',
      required_authority: 'cto_approved_reconciliation',
    })
    expect(body.rows[0].required_evidence).toContain('notify_message_id')
    expect(statuses()[0].status).toBe('pending')
  })
})
