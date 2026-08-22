#!/usr/bin/env bun
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { renderAckContent, resolveCodexExecutable, resolveNestedBunExecutable } from '../../bin/aun/codex-runner'

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

function fakeCodexExecutable(content: string): string {
  const path = join(tmpDir, 'fake-codex.sh')
  writeFileSync(path, [
    '#!/bin/sh',
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output-last-message" ]; then',
    '    shift',
    '    out="$1"',
    '  fi',
    '  shift',
    'done',
    'cat >/dev/null',
    'if [ -z "$out" ]; then',
    '  echo "missing --output-last-message" >&2',
    '  exit 2',
    'fi',
    `printf '%s' ${JSON.stringify(content)} > "$out"`,
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

function seedPending(
  content = 'codex runner request',
  presentation?: Record<string, unknown>,
): { messageId: string; queueId: number } {
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
      ...(presentation ? { canonical_presentation: presentation } : {}),
    })
    const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status)
      VALUES ('codex-aun', ?, ?, 'pending') RETURNING id`).get(messageId, payload) as { id: number }
    return { messageId, queueId: row.id }
  } finally {
    db.close()
  }
}

function seedTypedPending(opts: {
  content: string
  messageType: string
  ageSeconds: number
  source?: string
  authorId?: string
  mentions?: string[]
}): { messageId: string; queueId: number } {
  const db = new Database(dbPath)
  try {
    const messageId = randomUUID()
    const createdAt = new Date(Date.now() - opts.ageSeconds * 1000).toISOString()
    const authorId = opts.authorId ?? 'codex-cto'
    db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source, created_at, metadata, input_mentions)
      VALUES (?, 'runner-ch', ?, ?, ?, ?, ?, ?, ?)`).run(
      messageId,
      authorId,
      opts.content,
      opts.messageType,
      opts.source ?? 'agent-comms',
      createdAt,
      JSON.stringify({ mentions: opts.mentions ?? [] }),
      JSON.stringify(opts.mentions ?? []),
    )
    const payload = JSON.stringify({
      content: opts.content,
      channel_id: 'runner-ch',
      author_id: authorId,
      message_id: messageId,
      message_type: opts.messageType,
      source: opts.source ?? 'agent-comms',
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
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
    INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, metadata, home_directory)
      VALUES ('codex-aun', 'codex-aun', 'dev', 'codex', 'idle', '{"discord_id":"999010","tmux_session":"codex-aun-session"}', '/tmp/codex-aun'),
             ('codex-cto', 'codex-cto', 'cto', 'codex', 'idle', '{"discord_id":"999011"}', NULL);
    UPDATE agents SET channel_port = 39002 WHERE agent_id = 'codex-aun';
    INSERT INTO agent_runtime_instances
      (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port, checkout_path, commit_sha, status, started_at, last_seen_at)
      VALUES ('runtime-codex-aun', 'codex-aun', 'codex', 'local_process', 'codex-aun-session', 39002, '/tmp/codex-aun', 'test-head', 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    INSERT INTO runtime_memory_ready_evidence
      (agent_id, project, runtime_instance_id, profile_revision, profile_source, session_name, port, expected_agent_id,
       checkout_path, checkout_commit_sha, recovery_command, result_status, completed_at, evidence_path, evidence_log_id, valid_until, source, metadata)
      VALUES ('codex-aun', 'agent-comms-mcp', 'runtime-codex-aun', 1, 'legacy', 'codex-aun-session', 39002, 'codex-aun',
       '/tmp/codex-aun', 'test-head', 'test:mcp__wasurezu__recover_context', 'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       '/tmp/codex-aun-memory-ready.json', 'sqlite-codex-aun-memory-ready', '2099-01-01T00:00:00.000Z', 'agent_memory_boot_recovery', '{}');
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

  test('Codex executable can be overridden for non-interactive final replies', () => {
    const priorAun = process.env.AUN_CODEX_EXECUTABLE
    const priorGeneric = process.env.CODEX_EXECUTABLE
    try {
      delete process.env.AUN_CODEX_EXECUTABLE
      delete process.env.CODEX_EXECUTABLE
      expect(resolveCodexExecutable()).toBe('codex')

      process.env.CODEX_EXECUTABLE = '/operator/bin/codex'
      expect(resolveCodexExecutable()).toBe('/operator/bin/codex')

      process.env.AUN_CODEX_EXECUTABLE = '/operator/aun-codex'
      expect(resolveCodexExecutable()).toBe('/operator/aun-codex')
    } finally {
      if (priorAun === undefined) delete process.env.AUN_CODEX_EXECUTABLE
      else process.env.AUN_CODEX_EXECUTABLE = priorAun
      if (priorGeneric === undefined) delete process.env.CODEX_EXECUTABLE
      else process.env.CODEX_EXECUTABLE = priorGeneric
    }
  })

  test('claims pending work and retains queue/message identity', () => {
    const { messageId, queueId } = seedPending('retain identity')

    const r = runAun(['codex-runner', '--agent-id', 'codex-aun', '--limit', '1'])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.receive_mode).toBe('receive-actionable')
    expect(body.retained_count).toBe(1)
    expect(body.result_contract_version).toBe(1)
    expect(body.runner_result).toMatchObject({
      contract_version: 1,
      result_status: 'needs_human',
      retained_count: 1,
      queue_ids: [String(queueId)],
      reason_code: 'final_close_required',
      fail_closed: true,
    })
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

  test('queue-id mode claims only the requested pending row', () => {
    const first = seedPending('first requested instruction')
    const second = seedPending('second instruction must remain pending')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(first.queueId),
    ])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.limit).toBe(1)
    expect(body.retained_count).toBe(1)
    expect(body.retained[0]).toMatchObject({
      queue_id: String(first.queueId),
      message_id: first.messageId,
      content: 'first requested instruction',
    })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [first.queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'codex-aun' })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [second.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('queue-id mode fails closed instead of falling back to another actionable row', () => {
    const stale = seedTypedPending({ messageType: 'chat', ageSeconds: 300, content: 'old chat backlog' })
    const current = seedTypedPending({ messageType: 'instruction', ageSeconds: 30, content: 'current instruction' })

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(stale.queueId),
      '--max-inspect', '10',
    ])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECEIVE_ACTIONABLE_BLOCKED')
    expect(r.stderr).toContain('non_actionable_type')
    const body = JSON.parse(r.stdout)
    expect(body.retained).toEqual([])
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [stale.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [current.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('queue-id mode retains Discord direct-mention chat via deterministic routing decision', () => {
    const direct = seedTypedPending({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 30,
      content: '<@999010> テスト',
      mentions: ['999010'],
    })

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(direct.queueId),
      '--max-inspect', '10',
    ])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.retained).toHaveLength(1)
    expect(body.retained[0]).toMatchObject({
      queue_id: String(direct.queueId),
      message_type: 'chat',
      routing_decision: 'wake_agent',
      route_reason: 'direct_mention',
      content: '<@999010> テスト',
    })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [direct.queueId])[0])
      .toEqual({ status: 'received', claimed_by: 'codex-aun' })
  })

  test('complete-no-reply terminalizes only the explicitly targeted retained row', () => {
    const direct = seedTypedPending({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 30,
      content: '<@999010> テスト',
      mentions: ['999010'],
    })
    const fallback = seedPending('fallback must not be drained')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(direct.queueId),
      '--max-inspect', '10',
      '--complete-no-reply',
      '--completion-reason', 'direct_mention_smoke_completed_without_substantive_reply',
    ])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.retained_count).toBe(1)
    expect(body.retained[0]).toMatchObject({
      queue_id: String(direct.queueId),
      routing_decision: 'wake_agent',
      route_reason: 'direct_mention',
    })
    expect(body.completion).toMatchObject({
      outcome: 'completed_no_reply',
      terminal_queue_ids: [String(direct.queueId)],
      applied_count: 1,
      reason: 'direct_mention_smoke_completed_without_substantive_reply',
    })
    expect(body.runner_result).toMatchObject({
      result_status: 'completed_no_reply',
      terminal_queue_ids: [String(direct.queueId)],
      reason_code: 'completed_no_reply',
      fail_closed: false,
    })
    const row = dbRead(`SELECT status, claimed_by, replied_with, payload FROM message_queue WHERE id = ?`, [direct.queueId])[0]
    expect(row.status).toBe('done')
    expect(row.claimed_by).toBe('codex-aun')
    expect(row.replied_with).toBeNull()
    expect(JSON.parse(row.payload).terminal_baton).toMatchObject({
      no_reply_required: true,
      source: 'record_no_reply_command',
      reason: 'direct_mention_smoke_completed_without_substantive_reply',
    })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [fallback.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('auto-final-reply generates final content and closes the exact retained row without ACK', () => {
    const direct = seedTypedPending({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 30,
      content: '<@999010> 日本語で返答して',
      mentions: ['999010'],
    })
    const fallback = seedPending('fallback must remain pending')
    const fakeCodex = fakeCodexExecutable('はい、日本語で返答します。')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(direct.queueId),
      '--max-inspect', '10',
      '--auto-final-reply',
    ], {
      AUN_CODEX_EXECUTABLE: fakeCodex,
    })

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.acked_count).toBe(0)
    expect(body.acks).toEqual([])
    expect(body.completion).toMatchObject({
      outcome: 'completed_reply',
      terminal_queue_ids: [String(direct.queueId)],
      applied_count: 1,
      reason: 'auto_final_reply_completed',
      command: {
        mode: 'reply',
        queue_id: String(direct.queueId),
      },
    })
    expect(body.runner_result).toMatchObject({
      result_status: 'completed_reply',
      terminal_queue_ids: [String(direct.queueId)],
      reason_code: 'completed_reply',
      fail_closed: false,
    })
    const row = dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [direct.queueId])[0]
    expect(row.status).toBe('replied')
    expect(row.claimed_by).toBeNull()
    expect(row.replied_with).toBeTruthy()
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [fallback.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
    const replyMessage = dbRead(
      `SELECT content, author_id, reply_to FROM agent_messages
        WHERE id = ?`,
      [row.replied_with],
    )[0]
    expect(replyMessage).toEqual({
      content: 'はい、日本語で返答します。',
      author_id: 'codex-aun',
      reply_to: direct.messageId,
    })
  })

  test('auto-final-reply completes an already claimed exact row without drain fallback', () => {
    const active = seedTypedPending({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 30,
      content: '<@999010> すでに掴んだqueueにも返答して',
      mentions: ['999010'],
    })
    const fallback = seedPending('fallback must remain pending while active exact row replies')
    dbExec(`
      UPDATE message_queue
         SET status='received',
             claimed_by='codex-aun',
             claimed_at=datetime('now'),
             claim_expires_at=datetime('now', '+60 seconds')
       WHERE id=${active.queueId};
    `)
    const fakeCodex = fakeCodexExecutable('既存の受信済みqueueにも返答します。')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(active.queueId),
      '--max-inspect', '10',
      '--auto-final-reply',
    ], {
      AUN_CODEX_EXECUTABLE: fakeCodex,
    })

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.retained_count).toBe(1)
    expect(body.retained[0]).toMatchObject({
      queue_id: String(active.queueId),
      content: '<@999010> すでに掴んだqueueにも返答して',
      routing_decision: 'wake_agent',
      route_reason: 'direct_mention',
    })
    expect(body.receive_error.stderr).toContain('active claim exists')
    expect(body.completion).toMatchObject({
      outcome: 'completed_reply',
      terminal_queue_ids: [String(active.queueId)],
      applied_count: 1,
      reason: 'auto_final_reply_completed',
    })
    const row = dbRead(`SELECT status, claimed_by, replied_with FROM message_queue WHERE id = ?`, [active.queueId])[0]
    expect(row.status).toBe('replied')
    expect(row.claimed_by).toBeNull()
    expect(row.replied_with).toBeTruthy()
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [fallback.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
    const replyMessage = dbRead(
      `SELECT content, author_id, reply_to FROM agent_messages
        WHERE id = ?`,
      [row.replied_with],
    )[0]
    expect(replyMessage).toEqual({
      content: '既存の受信済みqueueにも返答します。',
      author_id: 'codex-aun',
      reply_to: active.messageId,
    })
  })

  test('complete-no-reply terminalizes an already claimed exact row without drain fallback', () => {
    const active = seedTypedPending({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 30,
      content: '<@999010> テスト',
      mentions: ['999010'],
    })
    const fallback = seedPending('fallback must remain pending while active exact row closes')
    dbExec(`
      UPDATE message_queue
         SET status='received',
             claimed_by='codex-aun',
             claimed_at=datetime('now'),
             claim_expires_at=datetime('now', '+60 seconds')
       WHERE id=${active.queueId};
    `)

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(active.queueId),
      '--max-inspect', '10',
      '--complete-no-reply',
      '--completion-reason', 'active_claim_direct_mention_smoke_completed_without_substantive_reply',
    ])

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.retained_count).toBe(0)
    expect(body.receive_error.stderr).toContain('active claim exists')
    expect(body.completion).toMatchObject({
      outcome: 'completed_no_reply',
      terminal_queue_ids: [String(active.queueId)],
      applied_count: 1,
      reason: 'active_claim_direct_mention_smoke_completed_without_substantive_reply',
    })
    const row = dbRead(`SELECT status, claimed_by, replied_with, payload FROM message_queue WHERE id = ?`, [active.queueId])[0]
    expect(row.status).toBe('done')
    expect(row.claimed_by).toBe('codex-aun')
    expect(row.replied_with).toBeNull()
    expect(JSON.parse(row.payload).terminal_baton).toMatchObject({
      no_reply_required: true,
      source: 'record_no_reply_command',
      reason: 'active_claim_direct_mention_smoke_completed_without_substantive_reply',
    })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [fallback.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('complete-no-reply rejects exact rows claimed by another agent without mutation', () => {
    const active = seedTypedPending({
      messageType: 'chat',
      source: 'discord',
      ageSeconds: 30,
      content: '<@999010> テスト claimed elsewhere',
      mentions: ['999010'],
    })
    dbExec(`
      UPDATE message_queue
         SET status='received',
             claimed_by='other-dev',
             claimed_at=datetime('now'),
             claim_expires_at=datetime('now', '+60 seconds')
       WHERE id=${active.queueId};
    `)

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(active.queueId),
      '--max-inspect', '10',
      '--complete-no-reply',
      '--completion-reason', 'must_not_apply_to_wrong_claim_owner',
    ])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECEIVE_ACTIONABLE_BLOCKED')
    expect(r.stderr).toContain('target_queue_not_pending')
    const row = dbRead(`SELECT status, claimed_by, replied_with, payload FROM message_queue WHERE id = ?`, [active.queueId])[0]
    expect(row.status).toBe('received')
    expect(row.claimed_by).toBe('other-dev')
    expect(row.replied_with).toBeNull()
    expect(JSON.parse(row.payload).terminal_baton).toBeUndefined()
  })

  test('complete-no-reply requires exact queue-id before claiming work', () => {
    const { queueId } = seedPending('must remain pending')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--complete-no-reply',
    ])

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CODEX_RUNNER_COMPLETION_INVALID')
    expect(r.stderr).toContain('--complete-no-reply requires --queue-id')
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('auto-final-reply requires exact queue-id before claiming work', () => {
    const { queueId } = seedPending('must remain pending')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--auto-final-reply',
    ], {
      AUN_CODEX_EXECUTABLE: fakeCodexExecutable('should not run'),
    })

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CODEX_RUNNER_COMPLETION_INVALID')
    expect(r.stderr).toContain('--auto-final-reply requires --queue-id')
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('auto-final-reply is mutually exclusive with complete-no-reply', () => {
    const { queueId } = seedPending('must remain pending')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(queueId),
      '--complete-no-reply',
      '--auto-final-reply',
    ], {
      AUN_CODEX_EXECUTABLE: fakeCodexExecutable('should not run'),
    })

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('mutually exclusive')
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('queue-id mode rejects batch limits above one before claiming', () => {
    const { queueId } = seedPending('bad queue limit')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(queueId),
      '--limit', '2',
    ])

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CODEX_RUNNER_INVALID_LIMIT')
    expect(r.stderr).toContain('--queue-id requires --limit 1')
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('queue-id mode rejects non-claimable presentation fragments before claim', () => {
    const fragment = seedPending('part 1/3', {
      presentation_group_id: 'runner-split-1',
      fragment_count: 3,
      fragment_index: 1,
      is_claimable: false,
    })
    const fallback = seedPending('fallback must remain pending')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(fragment.queueId),
      '--limit', '1',
    ])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECEIVE_ACTIONABLE_BLOCKED')
    expect(r.stderr).toContain('FRAGMENT_NOT_CLAIMABLE')
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, retained: [] })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [fragment.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [fallback.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
  })

  test('queue-id mode rejects incomplete split presentation before claim', () => {
    const ambiguous = seedPending('1/2 missing canonical evidence', {
      fragment_count: 2,
      fragment_index: 1,
    })
    const fallback = seedPending('newer canonical fallback must remain pending')

    const r = runAun([
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', String(ambiguous.queueId),
      '--limit', '1',
    ])

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECEIVE_ACTIONABLE_BLOCKED')
    expect(r.stderr).toContain('PRESENTATION_GROUP_INCOMPLETE')
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, retained: [] })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [ambiguous.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
    expect(dbRead(`SELECT status, claimed_by FROM message_queue WHERE id = ?`, [fallback.queueId])[0])
      .toEqual({ status: 'pending', claimed_by: null })
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
