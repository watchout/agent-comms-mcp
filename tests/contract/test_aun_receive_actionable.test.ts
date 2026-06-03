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
const TEST_AGENT = 'actionable-dev'

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
  messageType: string
  ageSeconds: number
  content?: string
  source?: string
  authorId?: string
  metadata?: Record<string, unknown>
  inputMentions?: string[]
  payloadMentions?: string[]
  status?: string
  claimedBy?: string | null
}): number {
  return withDb((db) => {
    const messageId = randomUUID()
    const createdAt = new Date(Date.now() - opts.ageSeconds * 1000).toISOString()
    const claimedAt = opts.claimedBy ? new Date(Date.now() - Math.max(opts.ageSeconds - 1, 0) * 1000).toISOString() : null
    const claimExpiresAt = opts.claimedBy ? new Date(Date.now() + 60_000).toISOString() : null
    const content = opts.content ?? `${opts.messageType} body`
    const authorId = opts.authorId ?? 'codex-cto'
    db.prepare(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source, created_at, metadata, input_mentions)
       VALUES (?, 'actionable-ch', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      authorId,
      content,
      opts.messageType,
      opts.source ?? 'agent-comms',
      createdAt,
      JSON.stringify(opts.metadata ?? {}),
      JSON.stringify(opts.inputMentions ?? []),
    )
    const payload = JSON.stringify({
      message_id: messageId,
      channel_id: 'actionable-ch',
      author_id: authorId,
      content,
      message_type: opts.messageType,
      source: opts.source ?? 'agent-comms',
      ...(opts.payloadMentions ? { mentions: opts.payloadMentions } : {}),
    })
    const row = db.prepare(
      `INSERT INTO message_queue
        (agent_id, message_id, payload, status, priority, created_at, claimed_by, claimed_at, claim_expires_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING id`,
    ).get(
      TEST_AGENT,
      messageId,
      payload,
      opts.status ?? 'pending',
      createdAt,
      opts.claimedBy ?? null,
      claimedAt,
      claimExpiresAt,
    ) as { id: number }
    return row.id
  })
}

function rows(): Array<{ id: number; status: string; claimed_by: string | null; content: string; message_type: string }> {
  return withDb((db) => db.prepare(
    `SELECT mq.id, mq.status, mq.claimed_by, am.content, am.message_type
       FROM message_queue mq
       JOIN agent_messages am ON am.id = mq.message_id
      WHERE mq.agent_id = ?
      ORDER BY mq.id ASC`,
  ).all(TEST_AGENT) as Array<{ id: number; status: string; claimed_by: string | null; content: string; message_type: string }>)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aun-actionable-'))
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
      INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, metadata)
        VALUES ('${TEST_AGENT}', '${TEST_AGENT}', 'dev', 'codex', 'idle', '{"discord_id":"999001"}'),
               ('codex-cto', 'codex-cto', 'dev', 'codex', 'idle', '{"discord_id":"999002"}'),
               ('auditor', 'auditor', 'auditor', 'codex', 'idle', '{}');
      INSERT INTO channels (id, name, members)
        VALUES ('actionable-ch', 'actionable-ch', '["${TEST_AGENT}","codex-cto","auditor"]');
      INSERT INTO channel_routing_policy (channel_id, primary_agent_id, outbound_allowlist, policy_source)
        VALUES ('actionable-ch', '${TEST_AGENT}', '["${TEST_AGENT}","codex-cto"]', 'receive-actionable-test');
    `)
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('test_aun_receive_actionable - bounded actionable selection', () => {
  test('dry-run surfaces a newer instruction behind stale non-action rows without mutation', () => {
    seedQueue({ messageType: 'chat', ageSeconds: 300, content: 'old FYI' })
    seedQueue({ messageType: 'notice', ageSeconds: 240, content: 'old projection notice' })
    const instructionId = seedQueue({ messageType: 'instruction', ageSeconds: 60, content: 'CTO instruction: review PR #451 HEAD abc123' })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '10', '--dry-run'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      mode: 'receive-actionable',
      inspected_count: 3,
      skipped_non_action_count: 2,
      selection_reason: 'newest_explicit_instruction',
    })
    expect(body.selected.queue_id).toBe(instructionId)
    expect(body.selected.message_type).toBe('instruction')
    expect(rows().map((row) => row.status)).toEqual(['pending', 'pending', 'pending'])
  })

  test('claims only the selected actionable row, leaving stale backlog pending', () => {
    const chatId = seedQueue({ messageType: 'chat', ageSeconds: 300, content: 'old FYI' })
    const requestId = seedQueue({ messageType: 'request', ageSeconds: 240, content: 'older request' })
    const instructionId = seedQueue({ messageType: 'instruction', ageSeconds: 60, content: 'CTO instruction: use HEAD fedcba' })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '10'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.queue_id).toBe(instructionId)
    expect(body.message_type).toBe('instruction')
    expect(body.waiting).toBe(2)

    const after = rows()
    expect(after.find((row) => row.id === chatId)).toMatchObject({ status: 'pending', claimed_by: null })
    expect(after.find((row) => row.id === requestId)).toMatchObject({ status: 'pending', claimed_by: null })
    expect(after.find((row) => row.id === instructionId)).toMatchObject({ status: 'received', claimed_by: TEST_AGENT })
  })

  test('queue-id mode claims the requested actionable row instead of selecting another row', () => {
    const requestedId = seedQueue({
      messageType: 'instruction',
      ageSeconds: 300,
      content: 'CTO instruction: exact queued request',
    })
    const newerId = seedQueue({
      messageType: 'instruction',
      ageSeconds: 30,
      content: 'CTO instruction: newer but not requested',
    })

    const r = runAun([
      'receive-actionable',
      '--agent-id', TEST_AGENT,
      '--queue-id', String(requestedId),
      '--max-inspect', '1',
    ])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.queue_id).toBe(requestedId)
    expect(body.content).toBe('CTO instruction: exact queued request')
    expect(body.waiting).toBe(1)

    const after = rows()
    expect(after.find((row) => row.id === requestedId)).toMatchObject({ status: 'received', claimed_by: TEST_AGENT })
    expect(after.find((row) => row.id === newerId)).toMatchObject({ status: 'pending', claimed_by: null })
  })

  test('queue-id mode accepts Discord direct-mention chat through routing_decision without changing message_type', () => {
    const chatId = seedQueue({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 60,
      content: '<@999001> テスト',
      payloadMentions: ['999001'],
    })

    const r = runAun([
      'receive-actionable',
      '--agent-id', TEST_AGENT,
      '--queue-id', String(chatId),
      '--max-inspect', '10',
    ])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      queue_id: chatId,
      message_type: 'chat',
      routing: {
        routing_decision: 'wake_agent',
        route_reason: 'direct_mention',
        llm_classification_used: false,
      },
    })
    expect(rows().find((row) => row.id === chatId)).toMatchObject({ status: 'received', claimed_by: TEST_AGENT })
  })

  test('queue-id mode fails closed when ambient chat is not actionable', () => {
    const chatId = seedQueue({ messageType: 'chat', ageSeconds: 300, content: 'old FYI' })
    const instructionId = seedQueue({ messageType: 'instruction', ageSeconds: 30, content: 'CTO instruction: do not claim' })

    const r = runAun([
      'receive-actionable',
      '--agent-id', TEST_AGENT,
      '--queue-id', String(chatId),
      '--max-inspect', '10',
    ])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECEIVE_ACTIONABLE_BLOCKED')
    expect(r.stderr).toContain('non_actionable_type')
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: false,
      blocked_reason: 'queue_not_claimable',
      selection_reason: 'non_actionable_type',
      selected: null,
      claimed: null,
    })

    const after = rows()
    expect(after.find((row) => row.id === chatId)).toMatchObject({ status: 'pending', claimed_by: null })
    expect(after.find((row) => row.id === instructionId)).toMatchObject({ status: 'pending', claimed_by: null })
  })

  test('self-authored Discord mention chat does not wake the target agent', () => {
    const chatId = seedQueue({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 60,
      authorId: '999001',
      content: '<@999001> self echo',
      payloadMentions: ['999001'],
    })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--queue-id', String(chatId)])
    expect(r.status).toBe(1)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: false,
      selection_reason: 'author_is_self',
    })
    expect(rows().find((row) => row.id === chatId)).toMatchObject({ status: 'pending', claimed_by: null })
  })

  test('Discord chat with missing target binding fails closed without LLM classification', () => {
    withDb((db) => db.exec(`UPDATE agents SET metadata = '{}' WHERE agent_id = '${TEST_AGENT}'`))
    const chatId = seedQueue({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 60,
      content: '<@999001> missing binding',
    })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--queue-id', String(chatId)])
    expect(r.status).toBe(1)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: false,
      selection_reason: 'missing_mention_binding',
    })
    expect(body.selected).toBeNull()
    expect(rows().find((row) => row.id === chatId)).toMatchObject({ status: 'pending', claimed_by: null })
  })

  test('Discord chat with only agent-id mention metadata and missing target binding fails closed', () => {
    withDb((db) => db.exec(`UPDATE agents SET metadata = '{}' WHERE agent_id = '${TEST_AGENT}'`))
    const chatId = seedQueue({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 60,
      content: 'metadata-only mention should not wake without Discord binding',
      metadata: { mentions: [TEST_AGENT] },
      inputMentions: [TEST_AGENT],
      payloadMentions: [TEST_AGENT],
    })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--queue-id', String(chatId)])
    expect(r.status).toBe(1)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: false,
      selection_reason: 'missing_mention_binding',
    })
    expect(body.selected).toBeNull()
    expect(rows().find((row) => row.id === chatId)).toMatchObject({ status: 'pending', claimed_by: null })
  })

  test('disabled target profile blocks direct mention wake', () => {
    withDb((db) => db.exec(`UPDATE agents SET profile_enabled = 0 WHERE agent_id = '${TEST_AGENT}'`))
    const chatId = seedQueue({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 60,
      content: '<@999001> disabled target',
    })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--queue-id', String(chatId)])
    expect(r.status).toBe(1)
    const body = JSON.parse(r.stdout)
    expect(body.selection_reason).toBe('disabled_agent')
    expect(rows().find((row) => row.id === chatId)).toMatchObject({ status: 'pending', claimed_by: null })
  })

  test('notice and projection remain non-actionable even when mentioned', () => {
    const noticeId = seedQueue({
      messageType: 'notice',
      source: 'discord',
      ageSeconds: 60,
      content: '<@999001> notice',
      payloadMentions: ['999001'],
    })
    const projectionId = seedQueue({
      messageType: 'projection',
      source: 'discord',
      ageSeconds: 30,
      content: '<@999001> projection',
      payloadMentions: ['999001'],
    })

    for (const id of [noticeId, projectionId]) {
      const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--queue-id', String(id)])
      expect(r.status).toBe(1)
      const body = JSON.parse(r.stdout)
      expect(body.selection_reason).toBe('non_actionable_type')
    }
    expect(rows().filter((row) => row.status === 'received')).toHaveLength(0)
  })

  test('multiple pending instructions select the newest PR/head-specific CTO instruction', () => {
    const oldInstruction = seedQueue({
      messageType: 'instruction',
      ageSeconds: 300,
      content: 'CTO instruction: old PR #449 HEAD 111111',
    })
    const newInstruction = seedQueue({
      messageType: 'instruction',
      ageSeconds: 30,
      content: 'CTO instruction: final review PR #451 HEAD 222222',
    })

    const r = runAun(['next-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '10'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.queue_id).toBe(newInstruction)

    const after = rows()
    expect(after.find((row) => row.id === oldInstruction)).toMatchObject({ status: 'pending', claimed_by: null })
    expect(after.find((row) => row.id === newInstruction)).toMatchObject({ status: 'received', claimed_by: TEST_AGENT })
  })

  test('auditor-style backlog does not hide newest CTO review request', () => {
    for (let i = 0; i < 8; i++) {
      seedQueue({ messageType: i % 2 === 0 ? 'chat' : 'notice', ageSeconds: 900 - i * 10, content: `auditor backlog ${i}` })
    }
    const reviewId = seedQueue({
      messageType: 'instruction',
      ageSeconds: 20,
      content: 'CTO review request: re-review PR #451 after audit PASS',
    })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '20'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.queue_id).toBe(reviewId)
    expect(body.content).toContain('CTO review request')
    expect(rows().filter((row) => row.status === 'received')).toHaveLength(1)
  })

  test('bounded inspection refuses to scan past max-inspect', () => {
    seedQueue({ messageType: 'chat', ageSeconds: 300 })
    seedQueue({ messageType: 'notice', ageSeconds: 240 })
    seedQueue({ messageType: 'instruction', ageSeconds: 60 })

    const r = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '2'])
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.waiting).toBe(3)
    expect(rows().map((row) => row.status)).toEqual(['pending', 'pending', 'pending'])
  })

  test('received active claim blocks receive-actionable from claiming a newer instruction', () => {
    const activeId = seedQueue({
      messageType: 'request',
      ageSeconds: 120,
      status: 'received',
      claimedBy: TEST_AGENT,
      content: 'already active work',
    })
    const instructionId = seedQueue({
      messageType: 'instruction',
      ageSeconds: 30,
      content: 'CTO instruction: do not start while busy',
    })

    const dryRun = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '10', '--dry-run'])
    expect(dryRun.status).toBe(0)
    const dryBody = JSON.parse(dryRun.stdout)
    expect(dryBody).toMatchObject({
      ok: true,
      dry_run: true,
      blocked_reason: 'active_claim',
      selection_reason: 'blocked_by_active_claim',
      selected: null,
      claimed: null,
    })
    expect(dryBody.active_claim).toMatchObject({ busy: true, queue_id: activeId, status: 'received' })

    const claimed = runAun(['receive-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '10'])
    expect(claimed.status).toBe(1)
    expect(claimed.stderr).toContain('RECEIVE_ACTIONABLE_BLOCKED')
    const claimedBody = JSON.parse(claimed.stdout)
    expect(claimedBody.ok).toBe(false)
    expect(claimedBody.blocked_reason).toBe('active_claim')
    expect(claimedBody.active_claim.queue_id).toBe(activeId)

    const after = rows()
    expect(after.find((row) => row.id === activeId)).toMatchObject({ status: 'received', claimed_by: TEST_AGENT })
    expect(after.find((row) => row.id === instructionId)).toMatchObject({ status: 'pending', claimed_by: null })
  })

  test('in_progress active claim blocks next-actionable from claiming a newer instruction', () => {
    const activeId = seedQueue({
      messageType: 'request',
      ageSeconds: 300,
      content: 'work already in progress',
      status: 'in_progress',
      claimedBy: TEST_AGENT,
    })
    const instructionId = seedQueue({
      messageType: 'instruction',
      ageSeconds: 30,
      content: 'CTO instruction: wait for active in_progress',
    })

    const r = runAun(['next-actionable', '--agent-id', TEST_AGENT, '--max-inspect', '10'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECEIVE_ACTIONABLE_BLOCKED')
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: false,
      dry_run: false,
      blocked_reason: 'active_claim',
      selection_reason: 'blocked_by_active_claim',
      selected: null,
      claimed: null,
    })
    expect(body.active_claim).toMatchObject({ busy: true, queue_id: activeId, status: 'in_progress' })

    const after = rows()
    expect(after.find((row) => row.id === activeId)).toMatchObject({ status: 'in_progress', claimed_by: TEST_AGENT })
    expect(after.find((row) => row.id === instructionId)).toMatchObject({ status: 'pending', claimed_by: null })
  })
})
