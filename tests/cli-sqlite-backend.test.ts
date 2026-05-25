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
  test('message_queue has failed_reason/done_at + v0.9-compatible CHECK', () => {
    const rows = dbRead(`PRAGMA table_info(message_queue)`)
    expect(rows.map((r: any) => r.name)).toContain('failed_reason')
    expect(rows.map((r: any) => r.name)).toContain('done_at')
  })
  test('channel_adapters / thread_adapters tables exist (added in Phase 2 F)', () => {
    const tables = dbRead(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    const names = tables.map((t: any) => t.name)
    expect(names).toContain('channel_adapters')
    expect(names).toContain('thread_adapters')
  })
  test('agents has NORM-021 bot profile SSOT columns', () => {
    const rows = dbRead(`PRAGMA table_info(agents)`)
    const names = rows.map((r: any) => r.name)
    expect(names).toContain('home_directory')
    expect(names).toContain('channel_port')
    expect(names).toContain('runtime_engine_preference')
    expect(names).toContain('provider_token_source_ref')
    expect(names).toContain('expected_provider_identity')
    expect(names).toContain('profile_enabled')
    expect(names).toContain('profile_revision')
  })
})

describe('F1b — agent profile SSOT CLI (SQLite)', () => {
  test('profile set is dry-run by default and execute stores one editable bot profile', () => {
    const dry = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', '~/Developer/probe-f',
      '--runtime-engine', 'codex',
      '--token-source-ref', 'local-env:DISCORD_BOT_TOKEN',
      '--expected-provider', 'discord',
      '--expected-provider-subject', '123456789012345678',
    ])
    expect(dry.status).toBe(0)
    const dryPayload = JSON.parse(dry.stdout)
    expect(dryPayload.dry_run).toBe(true)
    expect(dbRead(`SELECT home_directory FROM agents WHERE agent_id = 'probe-f'`)[0].home_directory).toBeNull()

    const executed = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', '~/Developer/probe-f',
      '--runtime-engine', 'codex',
      '--token-source-ref', 'local-env:DISCORD_BOT_TOKEN',
      '--expected-provider', 'discord',
      '--expected-provider-subject', '123456789012345678',
      '--execute',
    ])
    expect(executed.status).toBe(0)
    const payload = JSON.parse(executed.stdout)
    expect(payload.profile.agent_id).toBe('probe-f')
    expect(String(payload.profile.home_directory).endsWith('/Developer/probe-f')).toBe(true)
    expect(payload.profile.runtime_engine_preference).toBe('codex')
    expect(payload.profile.provider_token_source_ref).toBe('local-env:DISCORD_BOT_TOKEN')
    expect(payload.profile.expected_provider_identity).toMatchObject({
      provider: 'discord',
      subject_id: '123456789012345678',
    })

    const stored = dbRead(`SELECT home_directory, runtime_engine_preference, provider_token_source_ref, expected_provider_identity FROM agents WHERE agent_id = 'probe-f'`)[0]
    expect(String(stored.home_directory).endsWith('/Developer/probe-f')).toBe(true)
    expect(stored.runtime_engine_preference).toBe('codex')
    expect(stored.provider_token_source_ref).toBe('local-env:DISCORD_BOT_TOKEN')
    expect(JSON.parse(stored.expected_provider_identity).subject_id).toBe('123456789012345678')

    const partial = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--runtime-engine', 'claude-code',
      '--execute',
    ])
    expect(partial.status).toBe(0)
    const preserved = dbRead(`SELECT home_directory, runtime_engine_preference, provider_token_source_ref FROM agents WHERE agent_id = 'probe-f'`)[0]
    expect(String(preserved.home_directory).endsWith('/Developer/probe-f')).toBe(true)
    expect(preserved.runtime_engine_preference).toBe('claude-code')
    expect(preserved.provider_token_source_ref).toBe('local-env:DISCORD_BOT_TOKEN')

    const cleared = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', 'none',
      '--runtime-engine', 'none',
      '--token-source-ref', 'none',
      '--expected-provider', 'none',
      '--expected-provider-subject', 'none',
      '--execute',
    ])
    expect(cleared.status).toBe(0)
    const clearedStored = dbRead(`SELECT home_directory, runtime_engine_preference, provider_token_source_ref, expected_provider_identity FROM agents WHERE agent_id = 'probe-f'`)[0]
    expect(clearedStored.home_directory).toBeNull()
    expect(clearedStored.runtime_engine_preference).toBeNull()
    expect(clearedStored.provider_token_source_ref).toBeNull()
    expect(JSON.parse(clearedStored.expected_provider_identity)).toEqual({})
  })

  test('profile set rejects raw-token-looking provider token sources', () => {
    const blocked = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--token-source-ref', 'abc.def.ghi12345678901234567890123456789012345678901234567890',
      '--execute',
    ])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('raw token')
  })

  test('profile project is dry-run first and materializes derived workspace plus connector evidence', () => {
    const profile = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', '~/Developer/probe-f',
      '--channel-port', '19991',
      '--tmux-session', 'probe-f-session',
      '--runtime-engine', 'codex',
      '--token-source-ref', 'local-env:PROBE_DISCORD_TOKEN',
      '--expected-provider', 'discord',
      '--expected-provider-subject', '123456789012345678',
      '--execute',
    ])
    expect(profile.status).toBe(0)
    const profilePayload = JSON.parse(profile.stdout)
    expect(profilePayload.profile).toMatchObject({
      channel_port: 19991,
      tmux_session: 'probe-f-session',
      runtime_engine_preference: 'codex',
    })

    const dry = runCli(['agent', 'profile', 'project', 'probe-f'])
    expect(dry.status).toBe(0)
    const dryPayload = JSON.parse(dry.stdout)
    expect(dryPayload.dry_run).toBe(true)
    expect(dryPayload.projections[0].actions.map((a: any) => a.table)).toEqual([
      'agent_workspaces',
      'agent_workspace_bindings',
      'agent_runtime_instances',
      'connector_instances',
    ])
    expect(dbRead(`SELECT * FROM agent_workspaces`)).toHaveLength(0)
    expect(dbRead(`SELECT * FROM connector_instances`)).toHaveLength(0)
    {
      const db = new Database(dbPath)
      db.exec(`INSERT INTO agent_runtime_instances (agent_id, runtime_engine, status) VALUES ('probe-f', 'codex', 'running')`)
      db.close()
    }

    const executed = runCli(['agent', 'profile', 'project', 'probe-f', '--execute'])
    expect(executed.status).toBe(0)
    const payload = JSON.parse(executed.stdout)
    expect(payload.dry_run).toBe(false)
    expect(payload.ok).toBe(true)

    const workspaces = dbRead(`SELECT workspace_id, local_path, metadata FROM agent_workspaces`)
    expect(workspaces).toHaveLength(1)
    expect(String(workspaces[0].local_path).endsWith('/Developer/probe-f')).toBe(true)
    expect(JSON.parse(workspaces[0].metadata)).toMatchObject({
      source: 'bot_profile_projector',
      agent_id: 'probe-f',
    })
    const bindings = dbRead(`SELECT agent_id, workspace_id, binding_role, active FROM agent_workspace_bindings`)
    expect(bindings).toEqual([
      {
        agent_id: 'probe-f',
        workspace_id: workspaces[0].workspace_id,
        binding_role: 'primary',
        active: 1,
      },
    ])
    const runtimes = dbRead(`SELECT agent_id, workspace_id, status FROM agent_runtime_instances`)
    expect(runtimes).toEqual([
      {
        agent_id: 'probe-f',
        workspace_id: workspaces[0].workspace_id,
        status: 'running',
      },
    ])
    const connectors = dbRead(`SELECT agent_id, provider, connector_uri, status, metadata FROM connector_instances`)
    expect(connectors).toHaveLength(1)
    expect(connectors[0]).toMatchObject({
      agent_id: 'probe-f',
      provider: 'discord',
      connector_uri: 'discord://agents/probe-f',
      status: 'registered',
    })
    expect(JSON.parse(connectors[0].metadata)).toMatchObject({
      source: 'bot_profile_projector',
      agent_id: 'probe-f',
      token_source_ref_set: true,
    })

    const strict = runCli(['agent', 'profile', 'doctor', '--strict'])
    expect(strict.status).toBe(0)
    expect(JSON.parse(strict.stdout).ok).toBe(true)
  })

  test('profile doctor enforces one token source reference per active agent', () => {
    const first = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', '~/Developer/probe-f',
      '--token-source-ref', 'local-env:DUP_TOKEN',
      '--execute',
    ])
    expect(first.status).toBe(0)
    const second = runCli([
      'agent', 'profile', 'set', 'probe-g',
      '--home-directory', '~/Developer/probe-g',
      '--token-source-ref', 'local-env:DUP_TOKEN',
      '--execute',
    ])
    expect(second.status).toBe(0)

    const failing = runCli(['agent', 'profile', 'doctor'])
    expect(failing.status).toBe(1)
    const payload = JSON.parse(failing.stdout)
    expect(payload.blockers).toContainEqual({
      code: 'duplicate_provider_token_source_ref',
      provider_token_source_ref: 'local-env:DUP_TOKEN',
      agents: ['probe-f', 'probe-g'],
    })
  })

  test('profile doctor fails missing complete bot profile fields and passes after profile set', () => {
    const failing = runCli(['agent', 'profile', 'doctor'])
    expect(failing.status).toBe(1)
    const failingPayload = JSON.parse(failing.stdout)
    expect(failingPayload.ok).toBe(false)
    expect(failingPayload.blockers).toContainEqual({ agent_id: 'probe-f', code: 'missing_home_directory' })
    expect(failingPayload.blockers).toContainEqual({ agent_id: 'probe-f', code: 'missing_channel_port' })
    expect(failingPayload.blockers).toContainEqual({ agent_id: 'probe-f', code: 'missing_tmux_session' })
    expect(failingPayload.blockers).toContainEqual({ agent_id: 'probe-f', code: 'missing_runtime_engine_preference' })

    const fixed = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', '~/Developer/probe-f',
      '--channel-port', '19992',
      '--tmux-session', 'probe-f-session',
      '--runtime-engine', 'codex',
      '--execute',
    ])
    expect(fixed.status).toBe(0)

    const passing = runCli(['agent', 'profile', 'doctor'])
    expect(passing.status).toBe(0)
    const passingPayload = JSON.parse(passing.stdout)
    expect(passingPayload.ok).toBe(true)
    expect(passingPayload.blockers).toEqual([])
  })
})

describe('F2 — agent-com next (SQLite)', () => {
  test('pops a pending row, marks received, stamps the per-row claim, sets busy', () => {
    const { messageId, queueId } = seedPendingMessage('next test')
    const r = runCli(['next'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as { message_id: string; queue_id: number; from: string; content: string }
    expect(payload.message_id).toBe(messageId)
    expect(payload.queue_id).toBe(queueId)
    expect(payload.from).toBe('cto')
    expect(payload.content).toBe('next test')
    // Issue #278 (A) segment 3d — agents.current_message_id is gone.
    // The in-flight pointer now lives on the message_queue row itself
    // via the per-row claim columns.
    const q = dbRead(`SELECT status, claimed_by, claim_expires_at FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('received')
    expect(q[0].claimed_by).toBe('probe-f')
    expect(q[0].claim_expires_at).not.toBeNull()
    const a = dbRead(`SELECT status FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('busy')
  })

  test('emits {"waiting":0} with no message_id when queue is empty', () => {
    const r = runCli(['next'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.waiting).toBe(0)
    expect(payload.message_id).toBeUndefined()
  })

  test('multi in-flight: two consecutive `next` calls produce two distinct active claims (no implicit-fail)', () => {
    // Issue #278 (A) §A — the legacy single-slot guard is gone, so
    // two `next` calls in succession both succeed and leave both
    // claims active (status='received'). Orphan recovery is structural
    // via the claim-TTL sweeper, not via in-line implicit-fail.
    const first = seedPendingMessage('m1')
    const second = seedPendingMessage('m2')
    runCli(['next']) // pops m1, status received
    runCli(['next']) // pops m2 — m1 STAYS received (segment 3c)
    const q = dbRead(`SELECT id, status, failed_reason, claimed_by FROM message_queue ORDER BY id`)
    const m1 = q.find((r: any) => r.id === first.queueId)
    const m2 = q.find((r: any) => r.id === second.queueId)
    expect(m1.status).toBe('received')
    expect(m1.claimed_by).toBe('probe-f')
    expect(m2.status).toBe('received')
    expect(m2.claimed_by).toBe('probe-f')
  })
})

describe('F3 — agent-com send (SQLite)', () => {
  test('replies to the in-flight row, sets replied, idles the agent', () => {
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
    const a = dbRead(`SELECT status FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('idle')
  })

  test('rejects second send without a fresh next — INVALID_REPLY_TO guard', () => {
    // Issue #278 §1 error taxonomy: NO_CURRENT_MESSAGE retired in
    // favour of INVALID_REPLY_TO. The CLI hits the same branch when
    // the agent has no active claim (post-reply, post-TTL, or pre-next).
    seedPendingMessage('dbl-send')
    runCli(['next'])
    const ok = runCli(['send', '--content', 'first', '--mentions', 'cto'])
    expect(ok.status).toBe(0)
    const fail = runCli(['send', '--content', 'second', '--mentions', 'cto'])
    expect(fail.status).not.toBe(0)
    expect(fail.stderr).toContain('INVALID_REPLY_TO')
  })

  test('rejects DB channel policy outbound allowlist violations before writing reply rows', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO channel_routing_policy (channel_id, outbound_allowlist) VALUES ('probe-f-ch', '["cto"]')`)
    db.close()
    const { queueId } = seedPendingMessage('acl send')
    runCli(['next'])

    const blocked = runCli(['send', '--content', 'blocked send', '--mentions', 'cto'])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('OUTBOUND_ACL_VIOLATION')
    const q = dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('received')
    expect(q[0].replied_with).toBeNull()
    const written = dbRead(`SELECT id FROM agent_messages WHERE content = 'blocked send'`)
    expect(written.length).toBe(0)
  })
})

describe('F3b — send fanout INSERTs message_queue per recipient (SQLite, PR #224 cycle 2)', () => {
  // Phase 2 F cycle 2 (CTO option (a)): the CLI must fanout to each mentioned
  // recipient itself instead of delegating to pg_notify — in SQLite mode there
  // is no LISTEN-er. A recipient's message_queue must grow one row per send.
  test('probe-f → probe-f2 send enqueues a row on probe-f2.message_queue', () => {
    // Seed a second agent + add them both as channel members
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('probe-f2', 'probe-f2', 'dev', 'idle') ON CONFLICT DO NOTHING`)
    db.exec(`UPDATE channels SET members = '["probe-f","probe-f2"]' WHERE id = 'probe-f-ch'`)
    db.close()

    // probe-f receives + replies to probe-f2
    seedPendingMessage('fanout test')
    runCli(['next'])
    const r = runCli(['send', '--content', 'hello from probe-f', '--mentions', 'probe-f2'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.ok).toBe(true)

    // probe-f2.message_queue should now have the fanout row. The sender's own
    // reply turns the in-flight row to 'replied' (status on probe-f), and the
    // recipient (probe-f2) gets a NEW pending row whose message_id == the new
    // agent_messages id the sender produced.
    const recipientRows = dbRead(`SELECT agent_id, message_id, status, payload FROM message_queue WHERE agent_id = 'probe-f2'`)
    expect(recipientRows.length).toBe(1)
    expect(recipientRows[0].status).toBe('pending')
    expect(recipientRows[0].message_id).toBe(payload.message_id)
    const parsed = JSON.parse(recipientRows[0].payload)
    expect(parsed.content).toBe('hello from probe-f')
    expect(parsed.author_id).toBe('probe-f')
    expect(parsed.source).toBe('cli-send')
  })

  test('duplicate send for same recipient no-ops via uq_mq_agent_message', () => {
    // Re-seed agents + inject two identical message_queue rows via direct SQL
    // to simulate a retry after the first INSERT already committed. The ON
    // CONFLICT clause must dedupe instead of throwing.
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('probe-f2', 'probe-f2', 'dev', 'idle') ON CONFLICT DO NOTHING`)
    db.exec(`UPDATE channels SET members = '["probe-f","probe-f2"]' WHERE id = 'probe-f-ch'`)
    // Pre-stage a conflicting row using a known agent_messages id
    const existingMsgId = randomUUID()
    db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content) VALUES (?, 'probe-f-ch', 'probe-f', 'first')`).run(existingMsgId)
    db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('probe-f2', ?, '{"content":"first"}', 'pending')`).run(existingMsgId)
    db.close()

    // Now perform a normal send — the fanout's ON CONFLICT should skip the
    // existing probe-f2 row, not throw, and the CLI should still report ok.
    seedPendingMessage('dup')
    runCli(['next'])
    const r = runCli(['send', '--content', 'second send', '--mentions', 'probe-f2'])
    expect(r.status).toBe(0)
    // probe-f2.message_queue should now have 2 rows: the pre-staged one and
    // the new fanout row (different message_id).
    const rows = dbRead(`SELECT status FROM message_queue WHERE agent_id = 'probe-f2' ORDER BY id`)
    expect(rows.length).toBe(2)
    expect(rows[0].status).toBe('pending')
    expect(rows[1].status).toBe('pending')
  })
})

describe('F4 — agent-com fail / skip / reclaim (SQLite)', () => {
  test('fail sets status=failed + reason + releases the agent', () => {
    const { messageId, queueId } = seedPendingMessage('f4-fail')
    runCli(['next'])
    const r = runCli(['fail', '--message-id', messageId, '--reason', 'SQLITE_FAIL_TEST'])
    expect(r.status).toBe(0)
    const q = dbRead(`SELECT status, failed_reason, done_at FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('failed')
    expect(q[0].failed_reason).toBe('SQLITE_FAIL_TEST')
    expect(q[0].done_at).not.toBeNull()
    const a = dbRead(`SELECT status FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('idle')
  })

  test('skip sets status=skipped + reason (operator path)', () => {
    const { messageId, queueId } = seedPendingMessage('f4-skip')
    runCli(['next'])
    const r = runCli(['skip', '--message-id', messageId, '--reason', 'OBSOLETE'])
    expect(r.status).toBe(0)
    const q = dbRead(`SELECT status, failed_reason, done_at FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('skipped')
    expect(q[0].failed_reason).toBe('OBSOLETE')
    expect(q[0].done_at).not.toBeNull()
  })

  test('reclaim rolls received→pending for received rows > 15 min stale + clears agent pointer', () => {
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
    const a = dbRead(`SELECT status FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('idle')
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

  test('notify rejects DB channel policy outbound allowlist violations before writing rows', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO channel_routing_policy (channel_id, outbound_allowlist) VALUES ('probe-f-ch', '["cto"]')`)
    db.close()

    const blocked = runCli(['notify', '--channel', 'probe-f-ch', '--mentions', 'cto', '--content', 'blocked notify'])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('OUTBOUND_ACL_VIOLATION')
    const written = dbRead(`SELECT id FROM agent_messages WHERE content = 'blocked notify'`)
    expect(written.length).toBe(0)
    const queued = dbRead(`SELECT id FROM message_queue WHERE payload LIKE '%blocked notify%'`)
    expect(queued.length).toBe(0)
  })
})
