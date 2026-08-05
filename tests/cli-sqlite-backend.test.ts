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
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { canonicalJson } from '../core/registry-identity-reconciliation'

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

function seedOwnerQueue(agentId = 'probe-owner', content = 'owner handoff', channelId = 'probe-f-ch'): { messageId: string; queueId: number } {
  const db = new Database(dbPath)
  const messageId = randomUUID()
  db.prepare(`INSERT INTO agent_messages (id, channel_id, author_id, content) VALUES (?, ?, 'probe-f', ?)`).run(messageId, channelId, content)
  const payload = JSON.stringify({
    content,
    channel_id: channelId,
    author_id: 'probe-f',
    message_id: messageId,
  })
  const row = db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES (?, ?, ?, 'pending') RETURNING id`).get(agentId, messageId, payload) as { id: number }
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

function allowOutboundAgents(...agentIds: string[]): void {
  const db = new Database(dbPath)
  try {
    const insertAgent = db.prepare(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES (?, ?, 'dev', 'idle') ON CONFLICT DO NOTHING`)
    for (const agentId of agentIds) {
      if (agentId !== 'probe-f') insertAgent.run(agentId, agentId)
    }
    db.prepare(`
      INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('probe-f-ch', ?, 'cli-test')
      ON CONFLICT(channel_id) DO UPDATE SET
        outbound_allowlist = excluded.outbound_allowlist,
        policy_source = excluded.policy_source
    `).run(JSON.stringify(agentIds))
  } finally {
    db.close()
  }
}

function authorizeQueueWorkDone(
  queueId: number,
  reply: string,
  mutate?: (payload: Record<string, any>) => void,
): { claimedAt: string; completedAt: string } {
  const db = new Database(dbPath)
  try {
    const row = db.prepare(
      `SELECT payload, claimed_at FROM message_queue WHERE id = ?`,
    ).get(queueId) as { payload: string; claimed_at: string | null }
    const claimedAt = row.claimed_at
      ? new Date(row.claimed_at).toISOString()
      : new Date(Date.now() - 1_000).toISOString()
    const completedAt = new Date(Math.max(Date.parse(claimedAt), Date.now())).toISOString()
    const payload = JSON.parse(row.payload)
    payload.receive_claim = {
      mode: 'targeted-receive',
      source: 'state-daemon-queue-work-scheduler',
      agent_id: 'probe-f',
      queue_id: String(queueId),
    }
    payload.queue_work_execution = {
      source: 'state-daemon-queue-work-scheduler',
      agent_id: 'probe-f',
      queue_id: String(queueId),
      runtime_id: 'codex-exec',
      claimed_by: 'probe-f',
      claimed_at: claimedAt,
      started_at: claimedAt,
    }
    payload.runner_result = {
      schema_version: 'queue_work_result_v1',
      ok: true,
      summary: 'completed',
      reply,
      evidence: ['semantic_outcome=reply', 'outcome_reason=test'],
      writeback: null,
      next_action: 'reply',
      runtime_id: 'codex-exec',
      invocation_source: 'state-daemon-queue-work-scheduler',
      completed_at: completedAt,
      claim_fence: {
        claimed_by: 'probe-f',
        claimed_at: claimedAt,
      },
    }
    mutate?.(payload)
    db.prepare(`UPDATE message_queue
      SET status = 'done',
          claimed_by = 'probe-f',
          claimed_at = ?,
          claim_expires_at = ?,
          done_at = ?,
          payload = ?
      WHERE id = ?`).run(
      claimedAt,
      new Date(Date.now() + 300_000).toISOString(),
      completedAt,
      JSON.stringify(payload),
      queueId,
    )
    return { claimedAt, completedAt }
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
    expect(names).toContain('ui_id')
    expect(names).toContain('ui_handle')
    expect(names).toContain('home_directory')
    expect(names).toContain('channel_port')
    expect(names).toContain('runtime_engine_preference')
    expect(names).toContain('provider_token_source_ref')
    expect(names).toContain('expected_provider_identity')
    expect(names).toContain('profile_enabled')
    expect(names).toContain('profile_revision')
  })
  test('token management inventory tables exist', () => {
    const tables = dbRead(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    const names = tables.map((t: any) => t.name)
    expect(names).toContain('connector_credentials')
    expect(names).toContain('agent_provider_identities')
    expect(names).toContain('provider_channel_access')
    expect(names).toContain('agent_ui_bindings')
  })
  test('worker activity visibility table exists', () => {
    const tables = dbRead(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    const names = tables.map((t: any) => t.name)
    expect(names).toContain('worker_activity')
  })
  test('conversation/baton compatibility schema exists with one-active-baton guard', () => {
    const tables = dbRead(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    const names = tables.map((t: any) => t.name)
    expect(names).toContain('conversations')
    expect(names).toContain('conversation_batons')
    expect(names).toContain('conversation_observers')

    const messageCols = dbRead(`PRAGMA table_info(agent_messages)`).map((r: any) => r.name)
    const queueCols = dbRead(`PRAGMA table_info(message_queue)`).map((r: any) => r.name)
    expect(messageCols).toContain('conversation_id')
    expect(messageCols).toContain('baton_id')
    expect(queueCols).toContain('conversation_id')
    expect(queueCols).toContain('baton_id')

    const db = new Database(dbPath)
    try {
      const conversationId = randomUUID()
      const batonId = randomUUID()
      db.prepare(`
        INSERT INTO conversations (
          conversation_id,
          conversation_key_hash,
          surface,
          channel_id,
          thread_scope_id,
          root_request_id,
          conversation_kind
        ) VALUES (?, ?, 'cli', 'probe-f-ch', 'probe-f-ch', ?, 'request')
      `).run(conversationId, `test:${conversationId}`, `request:${conversationId}`)
      db.prepare(`
        INSERT INTO conversation_batons (
          baton_id,
          conversation_id,
          owner_agent_id,
          state
        ) VALUES (?, ?, 'probe-f', 'active')
      `).run(batonId, conversationId)

      expect(() => {
        db.prepare(`
          INSERT INTO conversation_batons (
            baton_id,
            conversation_id,
            owner_agent_id,
            state
          ) VALUES (?, ?, 'probe-f', 'escalated')
        `).run(randomUUID(), conversationId)
      }).toThrow()
    } finally {
      db.close()
    }
  })
})

describe('F1b — agent profile SSOT CLI (SQLite)', () => {
  test('profile set is dry-run by default and execute stores one editable bot profile', () => {
    const dry = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--ui-id', '1001',
      '--ui-handle', 'lead-probe',
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
      '--ui-id', '1001',
      '--ui-handle', 'lead-probe',
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
    expect(payload.profile.ui_id).toBe(1001)
    expect(payload.profile.ui_handle).toBe('lead-probe')
    expect(String(payload.profile.home_directory).endsWith('/Developer/probe-f')).toBe(true)
    expect(payload.profile.runtime_engine_preference).toBe('codex')
    expect(payload.profile.provider_token_source_ref).toBe('local-env:DISCORD_BOT_TOKEN')
    expect(payload.profile.expected_provider_identity).toMatchObject({
      provider: 'discord',
      subject_id: '123456789012345678',
    })

    const stored = dbRead(`SELECT ui_id, ui_handle, home_directory, runtime_engine_preference, provider_token_source_ref, expected_provider_identity FROM agents WHERE agent_id = 'probe-f'`)[0]
    expect(stored.ui_id).toBe(1001)
    expect(stored.ui_handle).toBe('lead-probe')
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
    const preserved = dbRead(`SELECT ui_id, ui_handle, home_directory, runtime_engine_preference, provider_token_source_ref FROM agents WHERE agent_id = 'probe-f'`)[0]
    expect(preserved.ui_id).toBe(1001)
    expect(preserved.ui_handle).toBe('lead-probe')
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
      'connector_credentials',
      'agent_provider_identities',
      'agent_ui_bindings',
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
    const connectors = dbRead(`SELECT connector_instance_id, agent_id, provider, connector_uri, status, metadata FROM connector_instances`)
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
    const credentials = dbRead(`SELECT credential_id, agent_id, provider, connector_instance_id, secret_ref, status, trust_status, source FROM connector_credentials`)
    expect(credentials).toHaveLength(1)
    expect(credentials[0]).toMatchObject({
      agent_id: 'probe-f',
      provider: 'discord',
      connector_instance_id: connectors[0].connector_instance_id,
      secret_ref: 'local-env:PROBE_DISCORD_TOKEN',
      status: 'registered',
      trust_status: 'local',
      source: 'bot_profile_projector',
    })
    const identities = dbRead(`SELECT provider_identity_id, agent_id, provider, provider_subject_id, provider_handle, status, trust_status, source FROM agent_provider_identities`)
    expect(identities).toHaveLength(1)
    expect(identities[0]).toMatchObject({
      agent_id: 'probe-f',
      provider: 'discord',
      provider_subject_id: '123456789012345678',
      provider_handle: 'probe-f',
      status: 'expected',
      trust_status: 'unverified',
      source: 'bot_profile_projector',
    })
    const uiBindings = dbRead(`SELECT agent_id, ui_type, ui_id, ui_handle, ui_token_ref, connector_instance_id, credential_id, provider_identity_id, surface_role, status, trust_status FROM agent_ui_bindings`)
    expect(uiBindings).toHaveLength(1)
    expect(uiBindings[0]).toMatchObject({
      agent_id: 'probe-f',
      ui_type: 'discord',
      ui_id: '123456789012345678',
      ui_handle: 'probe-f',
      ui_token_ref: 'local-env:PROBE_DISCORD_TOKEN',
      connector_instance_id: connectors[0].connector_instance_id,
      credential_id: credentials[0].credential_id,
      provider_identity_id: identities[0].provider_identity_id,
      surface_role: 'primary',
      status: 'registered',
      trust_status: 'unverified',
    })
    expect(dbRead(`SELECT * FROM provider_channel_access`)).toHaveLength(0)

    const strict = runCli(['agent', 'profile', 'doctor', '--strict'])
    expect(strict.status).toBe(0)
    expect(JSON.parse(strict.stdout).ok).toBe(true)

    {
      const db = new Database(dbPath)
      db.exec(`UPDATE connector_instances SET status = 'active'`)
      db.exec(`UPDATE connector_credentials SET status = 'active'`)
      db.close()
    }
    const rerun = runCli(['agent', 'profile', 'project', 'probe-f', '--execute'])
    expect(rerun.status).toBe(0)
    expect(dbRead(`SELECT status FROM connector_instances`)[0].status).toBe('active')
    expect(dbRead(`SELECT status FROM connector_credentials`)[0].status).toBe('active')
  })

  test('worker activity report writes DB-backed progress evidence and status exposes it', () => {
    const { queueId } = seedPendingMessage('worker visibility probe')
    const reported = runCli([
      'worker', 'report',
      '--agent-id', 'probe-f',
      '--queue-id', String(queueId),
      '--summary', 'Implement worker visibility table',
      '--status', 'running',
      '--repository', 'codex-aun',
      '--branch', 'codex/token-backed-discord-channel-bots',
      '--pull-request', '#visibility',
      '--progress', '12',
      '--progress-label', 'schema',
      '--stale-after-sec', '300',
      '--metadata', '{"source":"test"}',
    ])
    expect(reported.status).toBe(0)
    const payload = JSON.parse(reported.stdout)
    expect(payload.ok).toBe(true)
    expect(payload.activity).toMatchObject({
      agent_id: 'probe-f',
      queue_id: queueId,
      status: 'running',
      summary: 'Implement worker visibility table',
      repository: 'codex-aun',
      branch: 'codex/token-backed-discord-channel-bots',
      pull_request: '#visibility',
      progress_percent: 12,
      progress_label: 'schema',
      stale_after_sec: 300,
      visibility_state: 'moving',
      metadata: { source: 'test' },
    })

    const pinged = runCli([
      'worker', 'ping',
      '--agent-id', 'probe-f',
      '--activity-id', payload.activity.activity_id,
      '--summary', 'Running targeted worker visibility tests',
      '--progress', '33',
      '--progress-label', 'tests',
    ])
    expect(pinged.status).toBe(0)
    const pingPayload = JSON.parse(pinged.stdout)
    expect(pingPayload.activity).toMatchObject({
      activity_id: payload.activity.activity_id,
      status: 'running',
      summary: 'Running targeted worker visibility tests',
      progress_percent: 33,
      progress_label: 'tests',
      stale_after_sec: 300,
      visibility_state: 'moving',
    })

    const rows = dbRead(`SELECT agent_id, queue_id, status, summary, repository, branch, pull_request, progress_percent, progress_label, stale_after_sec FROM worker_activity`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agent_id: 'probe-f',
      queue_id: queueId,
      status: 'running',
      summary: 'Running targeted worker visibility tests',
      repository: 'codex-aun',
      branch: 'codex/token-backed-discord-channel-bots',
      pull_request: '#visibility',
      progress_percent: 33,
      progress_label: 'tests',
      stale_after_sec: 300,
    })

    const listed = runCli(['worker', 'list', '--agent-id', 'probe-f', '--format', 'json'])
    expect(listed.status).toBe(0)
    const listPayload = JSON.parse(listed.stdout)
    expect(listPayload.activities).toHaveLength(1)
    expect(listPayload.activities[0].activity_id).toBe(payload.activity.activity_id)

    const status = runCli(['status', '--format', 'json'])
    expect(status.status).toBe(0)
    const statusPayload = JSON.parse(status.stdout)
    expect(statusPayload.worker_activity).toMatchObject({
      activity_id: payload.activity.activity_id,
      status: 'running',
      summary: 'Running targeted worker visibility tests',
      progress_percent: 33,
      progress_label: 'tests',
      stale_after_sec: 300,
      visibility_state: 'moving',
    })
  })

  test('worker report accepts handoff only when target owner queue row exists', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('probe-owner', 'probe-owner', 'dev', 'idle')`)
    db.exec(`UPDATE channels SET members = '["probe-f","probe-owner"]' WHERE id = 'probe-f-ch'`)
    db.exec(`INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source) VALUES ('probe-f-ch', '["probe-f","probe-owner"]', 'cli-test')`)
    db.close()
    const { queueId } = seedOwnerQueue()

    const reported = runCli([
      'worker', 'report',
      '--agent-id', 'probe-f',
      '--queue-id', String(queueId),
      '--summary', 'Owner queue row created',
      '--status', 'running',
      '--handoff-target', 'probe-owner',
      '--pull-request', '#592',
      '--metadata', '{"source":"test"}',
    ])

    expect(reported.status).toBe(0)
    const payload = JSON.parse(reported.stdout)
    expect(payload.activity).toMatchObject({
      agent_id: 'probe-f',
      queue_id: queueId,
      status: 'running',
      handoff_target_agent_id: 'probe-owner',
    })
    expect(payload.activity.metadata.owner_handoff_evidence).toMatchObject({
      ok: true,
      status: 'queued_owner',
      intended_recipient_agent_id: 'probe-owner',
      queue: { queue_id: queueId, agent_id: 'probe-owner' },
    })
  })

  test('worker report rejects handoff-only comments without false started state', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('probe-owner', 'probe-owner', 'dev', 'idle')`)
    db.exec(`UPDATE channels SET members = '["probe-f","probe-owner"]' WHERE id = 'probe-f-ch'`)
    db.exec(`INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source) VALUES ('probe-f-ch', '["probe-f","probe-owner"]', 'cli-test')`)
    db.close()

    const blocked = runCli([
      'worker', 'report',
      '--agent-id', 'probe-f',
      '--summary', 'Implementation owner started',
      '--status', 'running',
      '--handoff-target', 'probe-owner',
      '--handoff-channel', 'probe-f-ch',
      '--pull-request', '#592',
    ])

    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('OWNER_HANDOFF_QUEUE_EVIDENCE_REQUIRED')
    expect(dbRead(`SELECT * FROM worker_activity`)).toHaveLength(0)
    const audits = dbRead(`SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type = 'owner_handoff.route_diagnostic'`)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ agent_id: 'probe-f', target: 'probe-owner' })
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      status: 'handoff_only',
      sender_agent_id: 'probe-f',
      intended_recipient_agent_id: 'probe-owner',
      channel_id: 'probe-f-ch',
    })
  })

  test('worker report rejects owner queue evidence from a different handoff channel', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('probe-owner', 'probe-owner', 'dev', 'idle')`)
    db.exec(`UPDATE channels SET members = '["probe-f","probe-owner"]' WHERE id = 'probe-f-ch'`)
    db.exec(`INSERT INTO channels (id, name, members) VALUES ('other-ch', 'other-ch', '["probe-f","probe-owner"]')`)
    db.exec(`INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source) VALUES ('other-ch', '["probe-f","probe-owner"]', 'cli-test')`)
    db.close()
    const { queueId } = seedOwnerQueue('probe-owner', 'old owner queue', 'probe-f-ch')

    const blocked = runCli([
      'worker', 'report',
      '--agent-id', 'probe-f',
      '--queue-id', String(queueId),
      '--summary', 'Implementation owner started',
      '--status', 'running',
      '--handoff-target', 'probe-owner',
      '--handoff-channel', 'other-ch',
      '--pull-request', '#592',
    ])

    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('OWNER_HANDOFF_QUEUE_EVIDENCE_MISMATCH')
    expect(blocked.stderr).toContain(`queue_id ${queueId} belongs to channel probe-f-ch, not other-ch`)
    expect(dbRead(`SELECT * FROM worker_activity`)).toHaveLength(0)
    const audits = dbRead(`SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type = 'owner_handoff.route_diagnostic'`)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ agent_id: 'probe-f', target: 'probe-owner' })
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      status: 'queue_evidence_mismatch',
      sender_agent_id: 'probe-f',
      intended_recipient_agent_id: 'probe-owner',
      channel_id: 'other-ch',
      queue: {
        queue_id: queueId,
        agent_id: 'probe-owner',
        channel_id: 'probe-f-ch',
      },
    })
  })

  test('worker report accepts explicit relay policy handoff evidence', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('probe-owner', 'probe-owner', 'dev', 'idle')`)
    db.close()

    const reported = runCli([
      'worker', 'report',
      '--agent-id', 'probe-f',
      '--summary', 'Relay policy owns handoff',
      '--status', 'running',
      '--handoff-target', 'probe-owner',
      '--metadata', '{"owner_handoff":{"evidence_type":"relay_policy","policy_ref":"ops-routing#592","relay_agent_id":"codex-cto"}}',
    ])

    expect(reported.status).toBe(0)
    const payload = JSON.parse(reported.stdout)
    expect(payload.activity).toMatchObject({
      agent_id: 'probe-f',
      status: 'running',
      handoff_target_agent_id: 'probe-owner',
    })
    expect(payload.activity.metadata.owner_handoff_evidence).toMatchObject({
      ok: true,
      status: 'relay_policy',
      relay_policy: {
        evidence_type: 'relay_policy',
        policy_ref: 'ops-routing#592',
        relay_agent_id: 'codex-cto',
      },
    })
  })

  test('profile project materializes replacement aliases from profile metadata', () => {
    const profile = runCli([
      'agent', 'profile', 'set', 'probe-alias',
      '--ui-handle', 'lead-probe-alias',
      '--home-directory', '~/Developer/probe-alias',
      '--channel-port', '19993',
      '--tmux-session', 'probe-alias-session',
      '--runtime-engine', 'codex',
      '--execute',
    ])
    expect(profile.status).toBe(0)
    {
      const db = new Database(dbPath)
      db.prepare(
        `UPDATE agents
            SET metadata = ?
          WHERE agent_id = 'probe-alias'`,
      ).run(JSON.stringify({ tmux_session: 'probe-alias-session', replaces: 'lead-probe-alias' }))
      db.close()
    }

    const dry = runCli(['agent', 'profile', 'project', 'probe-alias'])
    expect(dry.status).toBe(0)
    const dryPayload = JSON.parse(dry.stdout)
    expect(dryPayload.projections[0].actions[0]).toMatchObject({
      table: 'agent_aliases',
      action: 'upsert',
      alias: 'lead-probe-alias',
      canonical_agent_id: 'probe-alias',
      new_work_allowed: false,
    })

    const executed = runCli(['agent', 'profile', 'project', 'probe-alias', '--execute'])
    expect(executed.status).toBe(0)
    const aliases = dbRead(`SELECT alias, canonical_agent_id, new_work_allowed, reason FROM agent_aliases WHERE alias = 'lead-probe-alias'`)
    expect(aliases).toEqual([
      {
        alias: 'lead-probe-alias',
        canonical_agent_id: 'probe-alias',
        new_work_allowed: 0,
        reason: 'bot profile replacement alias',
      },
    ])
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

  test('profile doctor excludes disabled and test profiles by default', () => {
    const profiled = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', '~/Developer/probe-f',
      '--channel-port', '19992',
      '--tmux-session', 'probe-f-session',
      '--runtime-engine', 'codex',
      '--execute',
    ])
    expect(profiled.status).toBe(0)
    {
      const db = new Database(dbPath)
      db.exec(`
        INSERT INTO agents (agent_id, display_name, agent_type, status, metadata, profile_enabled)
        VALUES
          ('test-bot', 'test-bot', 'dev', 'idle', '{"profile_class":"test"}', 1),
          ('disabled-bot', 'disabled-bot', 'dev', 'idle', '{}', 0)
      `)
      db.close()
    }

    const defaultDoctor = runCli(['agent', 'profile', 'doctor'])
    expect(defaultDoctor.status).toBe(0)
    const defaultPayload = JSON.parse(defaultDoctor.stdout)
    expect(defaultPayload.checked_agents).toBe(1)
    expect(defaultPayload.excluded_agents).toBe(2)
    expect(defaultPayload.blockers).toEqual([])

    const includeTest = runCli(['agent', 'profile', 'doctor', '--include-test'])
    expect(includeTest.status).toBe(1)
    expect(JSON.parse(includeTest.stdout).blockers).toContainEqual({
      agent_id: 'test-bot',
      code: 'missing_home_directory',
    })

    const includeDisabled = runCli(['agent', 'profile', 'doctor', '--include-disabled'])
    expect(includeDisabled.status).toBe(1)
    expect(JSON.parse(includeDisabled.stdout).blockers).toContainEqual({
      agent_id: 'disabled-bot',
      code: 'missing_home_directory',
    })
  })

  test('runtime cleanup CLI is dry-run first, hash-confirmed, audited, and idempotent', () => {
    {
      const db = new Database(dbPath)
      db.exec(`
        INSERT INTO agents
          (agent_id, display_name, agent_type, runtime, status, metadata, channel_port, profile_enabled)
        VALUES
          ('cleanup-disabled', 'cleanup-disabled', 'dev', 'TUI', 'offline', '{"tmux_session":"cleanup-disabled-session","supervisor_type":"tmux"}', 29999, 0);

        INSERT INTO agent_runtime_instances
          (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id, port, status, started_at, last_seen_at)
        VALUES
          ('runtime-cleanup-disabled', 'cleanup-disabled', 'codex', 'local_process', 'cleanup-disabled-session', 29999, 29999, 'active', '2026-05-28T00:00:00Z', '2026-05-28T00:00:00Z');
      `)
      db.close()
    }

    const dry = runCli(['runtime', 'cleanup', '--format', 'json', '--stale-minutes', '15'])
    expect(dry.status).toBe(0)
    const plan = JSON.parse(dry.stdout)
    expect(plan.dry_run).toBe(true)
    expect(plan.summary.cleanup_targets).toBe(1)
    expect(plan.targets).toContainEqual(expect.objectContaining({
      agent_id: 'cleanup-disabled',
      classification: 'disabled-profile-residue',
      runtime_instance_id: 'runtime-cleanup-disabled',
    }))

    const refused = runCli(['runtime', 'cleanup', '--execute', '--format', 'json'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('PLAN_HASH_MISMATCH')

    const executed = runCli(['runtime', 'cleanup', '--execute', '--confirm', plan.plan_hash, '--format', 'json'])
    expect(executed.status).toBe(0)
    const executedPayload = JSON.parse(executed.stdout)
    expect(executedPayload.dry_run).toBe(false)
    expect(executedPayload.plan_hash).toBe(plan.plan_hash)

    const rows = dbRead(`
      SELECT ari.status, ari.stopped_at, al.detail
        FROM agent_runtime_instances ari
        JOIN audit_log al
          ON al.event_type = 'runtime.cleanup_target'
         AND al.agent_id = ari.agent_id
       WHERE ari.runtime_instance_id = 'runtime-cleanup-disabled'
    `)
    expect(rows[0].status).toBe('stopped')
    expect(rows[0].stopped_at).not.toBeNull()
    const detail = JSON.parse(rows[0].detail)
    expect(detail).toMatchObject({
      plan_hash: plan.plan_hash,
      runtime_instance_id: 'runtime-cleanup-disabled',
      port: 29999,
      tmux_session: 'cleanup-disabled-session',
    })
    expect(detail.evidence.agent_id).toBe('cleanup-disabled')

    const rerun = runCli(['runtime', 'cleanup', '--format', 'json'])
    expect(rerun.status).toBe(0)
    expect(JSON.parse(rerun.stdout).summary.cleanup_targets).toBe(0)
  })

  test('registry identity reconciliation CLI plans with zero writes and gates apply on OD evidence', () => {
    const sourceRef = 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5186249673'
    const sourceBody = 'owner-frozen Cell 20 registry classification\n'
    const sourceSha = createHash('sha256').update(sourceBody).digest('hex')
    const inputPath = join(tmpDir, 'classification-input.json')
    const evidencePath = join(tmpDir, 'evidence-bundle.json')
    const planPath = join(tmpDir, 'plan.json')
    writeFileSync(inputPath, `${canonicalJson({
      schema_version: 'aun-registry-classification-input/v1',
      control_source_ref: sourceRef,
      source_commit: '05045be81165d0e151baf02f9fc1b93cb46c997e',
      source_tree: '7d4e0109825fb63c7c343ae272bc8cc3b97ba89e',
      entries: [{
        agent_id: 'probe-f',
        target_profile_class: 'production',
        evidence_ref: sourceRef,
        evidence_sha256: sourceSha,
      }],
    })}\n`)
    writeFileSync(evidencePath, JSON.stringify({ [sourceRef]: sourceBody }))

    const dryRun = runCli([
      'runtime', 'reconcile-identities', 'dry-run',
      '--input', inputPath,
      '--evidence-bundle', evidencePath,
    ])
    expect(dryRun.status).toBe(0)
    const dryPayload = JSON.parse(dryRun.stdout)
    expect(dryPayload.writes).toBe(0)
    expect(dryPayload.plan.permitted_effect.cells_30_70_effect_count).toBe(0)
    expect(dbRead(`SELECT profile_revision FROM agents WHERE agent_id = 'probe-f'`)[0].profile_revision).toBe(1)
    expect(dbRead(`SELECT * FROM audit_log WHERE event_type LIKE 'registry.identity_reconciliation.%'`)).toHaveLength(0)

    const planned = runCli([
      'runtime', 'reconcile-identities', 'plan',
      '--input', inputPath,
      '--evidence-bundle', evidencePath,
    ])
    expect(planned.status).toBe(0)
    const plan = JSON.parse(planned.stdout)
    writeFileSync(planPath, planned.stdout)
    const refused = runCli([
      'runtime', 'reconcile-identities', 'apply',
      '--input', inputPath,
      '--evidence-bundle', evidencePath,
      '--plan-file', planPath,
      '--execute',
      '--confirm-plan-sha256', plan.plan_sha256,
      '--target-repository', 'watchout/agent-comms-mcp',
      '--base-commit', '05045be81165d0e151baf02f9fc1b93cb46c997e',
      '--base-tree', '7d4e0109825fb63c7c343ae272bc8cc3b97ba89e',
    ])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('REGISTRY_RECONCILIATION_FLAG_REQUIRED: --owner-decision-ref')
    expect(dbRead(`SELECT profile_revision FROM agents WHERE agent_id = 'probe-f'`)[0].profile_revision).toBe(1)
    expect(dbRead(`SELECT * FROM audit_log WHERE event_type LIKE 'registry.identity_reconciliation.%'`)).toHaveLength(0)
  })

  test('strict profile doctor gates active connectors on runtime endpoint leases', () => {
    const runtimeId = randomUUID()
    const connectorId = randomUUID()
    const profiled = runCli([
      'agent', 'profile', 'set', 'probe-f',
      '--home-directory', '~/Developer/probe-f',
      '--channel-port', '19992',
      '--tmux-session', 'probe-f-session',
      '--runtime-engine', 'codex',
      '--execute',
    ])
    expect(profiled.status).toBe(0)
    {
      const db = new Database(dbPath)
      db.prepare(
        `INSERT INTO agent_runtime_instances
           (runtime_instance_id, agent_id, runtime_engine, status)
         VALUES (?, 'probe-f', 'codex', 'active')`,
      ).run(runtimeId)
      db.close()
    }
    const projected = runCli(['agent', 'profile', 'project', 'probe-f', '--execute'])
    expect(projected.status).toBe(0)
    {
      const db = new Database(dbPath)
      const runtime = db.prepare(
        `SELECT workspace_id
           FROM agent_runtime_instances
          WHERE runtime_instance_id = ?`,
      ).get(runtimeId) as { workspace_id: string | null }
      expect(runtime.workspace_id).not.toBeNull()
      db.prepare(
        `INSERT INTO connector_instances
           (connector_instance_id, agent_id, provider, connector_uri, status, metadata)
         VALUES (?, 'probe-f', 'discord', 'discord://agents/probe-f/norm022', 'active', ?)`,
      ).run(connectorId, JSON.stringify({ source: 'runtime_heartbeat' }))
      db.close()
    }

    const missingRuntime = runCli(['agent', 'profile', 'doctor', '--strict'])
    expect(missingRuntime.status).toBe(1)
    const missingRuntimePayload = JSON.parse(missingRuntime.stdout)
    expect(missingRuntimePayload.blockers).toContainEqual(expect.objectContaining({
      agent_id: 'probe-f',
      connector_instance_id: connectorId,
      code: 'active_connector_missing_runtime_instance',
    }))

    {
      const db = new Database(dbPath)
      db.prepare(
        `UPDATE connector_instances
            SET runtime_instance_id = ?
          WHERE connector_instance_id = ?`,
      ).run(runtimeId, connectorId)
      db.close()
    }
    const missingLease = runCli(['agent', 'profile', 'doctor', '--strict'])
    expect(missingLease.status).toBe(1)
    const missingLeasePayload = JSON.parse(missingLease.stdout)
    expect(missingLeasePayload.blockers).toContainEqual(expect.objectContaining({
      agent_id: 'probe-f',
      connector_instance_id: connectorId,
      runtime_instance_id: runtimeId,
      code: 'active_connector_missing_endpoint_lease',
    }))

    {
      const db = new Database(dbPath)
      db.prepare(
        `INSERT INTO control_plane_leases
           (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id,
            holder_runtime_instance_id, holder_connector_instance_id, fencing_token, expires_at)
         VALUES
           ('runtime_instance', ?, 'worker', 'probe-f', ?, ?, 1, datetime('now', '+5 minutes'))`,
      ).run(runtimeId, runtimeId, connectorId)
      db.close()
    }
    const passing = runCli(['agent', 'profile', 'doctor', '--strict'])
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

describe('F1c — channel reconcile CLI (SQLite)', () => {
  test('dry-run plans missing Discord channel registration and execute requires approval hash', () => {
    const db = new Database(dbPath)
    for (const [agentId, discordId] of [
      ['arc', '900000000000000002'],
      ['codex-cto', '900000000000000003'],
    ] as const) {
      db.prepare(
        `INSERT INTO agents (agent_id, display_name, agent_type, status, metadata)
         VALUES (?, ?, 'dev', 'idle', ?)`,
      ).run(agentId, agentId, JSON.stringify({ discord_id: discordId }))
      db.prepare(
        `INSERT INTO agent_ui_bindings (agent_id, ui_type, ui_id, ui_handle, status)
         VALUES (?, 'discord', ?, ?, 'registered')`,
      ).run(agentId, discordId, agentId)
    }
    db.prepare(
      `INSERT INTO agent_messages (
         id, channel_id, author_id, content, metadata, input_mentions,
         source, direction, role
       ) VALUES (?, ?, 'human-discord', ?, ?, ?, 'discord', 'inbound', 'user')`,
    ).run(
      randomUUID(),
      '1509299147109306508',
      '<@900000000000000002> <@900000000000000003> inspect',
      JSON.stringify({
        discord_channel_id: '1509299147109306508',
        discord_message_id: 'discord-reconcile-cli',
        mentions: [],
      }),
      JSON.stringify([]),
    )
    db.close()

    const dry = runCli([
      'channel', 'reconcile',
      '--provider', 'discord',
      '--channel', '1509299147109306508',
      '--adapter-owner', 'probe-f',
    ])
    expect(dry.status).toBe(0)
    const dryPayload = JSON.parse(dry.stdout)
    expect(dryPayload.dry_run).toBe(true)
    expect(dryPayload.planned[0]).toMatchObject({
      external_channel_id: '1509299147109306508',
      adapter_owner_agent_id: 'probe-f',
      primary_agent_id: 'probe-f',
    })
    expect(dryPayload.planned[0].proposed_members).toEqual([
      'arc',
      'codex-cto',
      'probe-f',
    ])
    expect(dbRead(`SELECT * FROM channel_adapters WHERE external_id = '1509299147109306508'`)).toHaveLength(0)

    const refused = runCli([
      'channel', 'reconcile',
      '--provider', 'discord',
      '--channel', '1509299147109306508',
      '--adapter-owner', 'probe-f',
      '--execute',
      '--confirm', 'wrong-hash',
    ])
    expect(refused.status).not.toBe(0)
    expect(JSON.parse(refused.stdout).error).toBe('OPERATOR_APPROVAL_REQUIRED')
    expect(dbRead(`SELECT * FROM channels WHERE id = '1509299147109306508'`)).toHaveLength(0)

    const executed = runCli([
      'channel', 'reconcile',
      '--provider', 'discord',
      '--channel', '1509299147109306508',
      '--adapter-owner', 'probe-f',
      '--execute',
      '--confirm', dryPayload.plan_hash,
    ])
    expect(executed.status).toBe(0)
    expect(JSON.parse(executed.stdout).summary.executed).toBe(1)
    expect(dbRead(`SELECT * FROM channel_adapters WHERE external_id = '1509299147109306508'`)).toHaveLength(1)
    expect(dbRead(`SELECT * FROM audit_log WHERE event_type = 'channel.registration_reconcile_execute'`)).toHaveLength(1)
  })
})

describe('F3 — agent-com send (SQLite)', () => {
  test('queue-work finalizer replies once from an exact authorized done row', () => {
    allowOutboundAgents('probe-f', 'cto')
    const { messageId, queueId } = seedPendingMessage('queue-work finalizer input')
    runCli(['next'])
    const reply = 'queue-work exact reply'
    authorizeQueueWorkDone(queueId, reply)

    const args = [
      'send', '--content', reply, '--mentions', 'cto', '--queue-id', String(queueId),
      '--message-id', messageId, '--queue-work-finalizer', '--close',
    ]
    const first = runCli(args)
    expect(first.status).toBe(0)
    const firstPayload = JSON.parse(first.stdout.trim()) as any
    expect(firstPayload).toMatchObject({
      ok: true,
      queue_id: queueId,
      work_closed: true,
      close_mode: 'explicit',
    })
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId]))
      .toEqual([{ status: 'replied', replied_with: firstPayload.message_id }])

    const replay = runCli(args)
    expect(replay.status).toBe(0)
    expect(JSON.parse(replay.stdout.trim())).toMatchObject({
      ok: true,
      queue_id: queueId,
      idempotent: true,
      code: 'IDEMPOTENT_REPLY_CLOSE',
      outbound_message_id: firstPayload.message_id,
      replied_with: firstPayload.message_id,
      work_closed: true,
    })
    expect(dbRead(`SELECT id FROM agent_messages WHERE reply_to = ? AND author_id = 'probe-f'`, [messageId]))
      .toHaveLength(1)
  })

  test('queue-work finalizer rejects a done row when the stored reply differs', () => {
    allowOutboundAgents('probe-f', 'cto')
    const { messageId, queueId } = seedPendingMessage('queue-work mismatched input')
    runCli(['next'])
    authorizeQueueWorkDone(queueId, 'authorized reply')

    const rejected = runCli([
      'send', '--content', 'different reply', '--mentions', 'cto', '--queue-id', String(queueId),
      '--message-id', messageId, '--queue-work-finalizer', '--close',
    ])
    expect(rejected.status).toBe(1)
    expect(JSON.parse(rejected.stdout.trim())).toMatchObject({
      ok: false,
      code: 'QUEUE_WORK_FINALIZER_UNAUTHORIZED',
      queue_id: queueId,
      mismatches: ['runner_result.reply'],
    })
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId]))
      .toEqual([{ status: 'done', replied_with: null }])
    expect(dbRead(`SELECT id FROM agent_messages WHERE reply_to = ? AND author_id = 'probe-f'`, [messageId]))
      .toHaveLength(0)
  })

  test('queue-work finalizer rejects every claim/result identity mismatch with zero outbound and zero close', () => {
    allowOutboundAgents('probe-f', 'cto')
    const cases: Array<{
      expected: string
      mutate: (payload: Record<string, any>) => void
    }> = [
      {
        expected: 'receive_claim.source',
        mutate: (payload) => { payload.receive_claim.source = 'other-source' },
      },
      {
        expected: 'receive_claim.agent_id',
        mutate: (payload) => { payload.receive_claim.agent_id = 'other-agent' },
      },
      {
        expected: 'receive_claim.queue_id',
        mutate: (payload) => { payload.receive_claim.queue_id = '999999' },
      },
      {
        expected: 'queue_work_execution.source',
        mutate: (payload) => { payload.queue_work_execution.source = 'other-source' },
      },
      {
        expected: 'queue_work_execution.agent_id',
        mutate: (payload) => { payload.queue_work_execution.agent_id = 'other-agent' },
      },
      {
        expected: 'queue_work_execution.queue_id',
        mutate: (payload) => { payload.queue_work_execution.queue_id = '999999' },
      },
      {
        expected: 'queue_work_execution.runtime_id',
        mutate: (payload) => { payload.queue_work_execution.runtime_id = 'other-runtime' },
      },
      {
        expected: 'runner_result.runtime_id',
        mutate: (payload) => { payload.runner_result.runtime_id = 'other-runtime' },
      },
      {
        expected: 'queue_work_execution.claimed_by',
        mutate: (payload) => { payload.queue_work_execution.claimed_by = 'other-agent' },
      },
      {
        expected: 'queue_work_execution.claimed_at',
        mutate: (payload) => { payload.queue_work_execution.claimed_at = '2026-08-02T00:00:00.000Z' },
      },
      {
        expected: 'queue_work_execution.started_at',
        mutate: (payload) => { payload.queue_work_execution.started_at = '2020-01-01T00:00:00.000Z' },
      },
      {
        expected: 'runner_result.invocation_source',
        mutate: (payload) => { payload.runner_result.invocation_source = 'other-source' },
      },
      {
        expected: 'runner_result.claim_fence.claimed_by',
        mutate: (payload) => { payload.runner_result.claim_fence.claimed_by = 'other-agent' },
      },
      {
        expected: 'runner_result.claim_fence.claimed_at',
        mutate: (payload) => { payload.runner_result.claim_fence.claimed_at = '2026-08-02T00:00:00.000Z' },
      },
      {
        expected: 'runner_result.completed_at',
        mutate: (payload) => { payload.runner_result.completed_at = '2026-08-02T00:00:00.000Z' },
      },
    ]

    for (const [index, testCase] of cases.entries()) {
      const { messageId, queueId } = seedPendingMessage(`claim/result mismatch ${index}`)
      const reply = `must not escape ${index}`
      authorizeQueueWorkDone(queueId, reply, testCase.mutate)

      const rejected = runCli([
        'send', '--content', reply, '--mentions', 'cto', '--queue-id', String(queueId),
        '--message-id', messageId, '--queue-work-finalizer', '--close',
      ], { AUN_QUEUE_WORK_EXPECTED_RUNTIME_ID: 'codex-exec' })

      expect(rejected.status).toBe(1)
      const response = JSON.parse(rejected.stdout.trim())
      expect(response).toMatchObject({
        ok: false,
        code: 'QUEUE_WORK_FINALIZER_UNAUTHORIZED',
        queue_id: queueId,
      })
      expect(response.mismatches).toContain(testCase.expected)
      expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId]))
        .toEqual([{ status: 'done', replied_with: null }])
      expect(dbRead(`SELECT id FROM agent_messages WHERE reply_to = ? AND author_id = 'probe-f'`, [messageId]))
        .toHaveLength(0)
    }
  })

  test('queue-work finalizer rejects an expired exact lease with zero outbound and zero close', () => {
    allowOutboundAgents('probe-f', 'cto')
    const { messageId, queueId } = seedPendingMessage('expired claim/result fence')
    const reply = 'expired result must not escape'
    authorizeQueueWorkDone(queueId, reply)
    const db = new Database(dbPath)
    try {
      db.prepare(`UPDATE message_queue SET claim_expires_at = ? WHERE id = ?`)
        .run('2000-01-01T00:00:00.000Z', queueId)
    } finally {
      db.close()
    }

    const rejected = runCli([
      'send', '--content', reply, '--mentions', 'cto', '--queue-id', String(queueId),
      '--message-id', messageId, '--queue-work-finalizer', '--close',
    ])
    expect(rejected.status).toBe(1)
    expect(JSON.parse(rejected.stdout.trim()).mismatches).toContain('claim_expires_at')
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId]))
      .toEqual([{ status: 'done', replied_with: null }])
    expect(dbRead(`SELECT id FROM agent_messages WHERE reply_to = ? AND author_id = 'probe-f'`, [messageId]))
      .toHaveLength(0)
  })

  test('queue-work finalizer rolls back reply, fanout, outbound, and close when the lease is lost at mutation time', () => {
    allowOutboundAgents('probe-f', 'cto')
    const { messageId, queueId } = seedPendingMessage('mutation-time lease race')
    const reply = 'mutation-time lease race must not escape'
    authorizeQueueWorkDone(queueId, reply)
    const originalQueue = dbRead(
      `SELECT status, replied_with, claim_expires_at FROM message_queue WHERE id = ?`,
      [queueId],
    )

    const db = new Database(dbPath)
    try {
      const connectorId = randomUUID()
      db.prepare(`INSERT INTO channel_adapters (channel_id, platform, external_id, metadata)
        VALUES ('probe-f-ch', 'discord', 'probe-f-external', '{}')`).run()
      db.prepare(`INSERT INTO connector_instances
        (connector_instance_id, agent_id, provider, status, trust_status, metadata)
        VALUES (?, 'cto', 'discord', 'active', 'local', '{}')`).run(connectorId)
      db.prepare(`INSERT INTO connector_credentials
        (credential_id, provider, agent_id, connector_instance_id, secret_ref, status, trust_status, metadata)
        VALUES (?, 'discord', 'cto', ?, 'env:TEST_CTO_TOKEN', 'active', 'local', '{}')`)
        .run(randomUUID(), connectorId)
      db.prepare(`INSERT INTO channel_connector_bindings
        (channel_binding_id, channel_id, provider, connector_instance_id, binding_role, priority, status, metadata)
        VALUES (?, 'probe-f-ch', 'discord', ?, 'outbound', 1, 'active', '{}')`)
        .run(randomUUID(), connectorId)
      db.prepare(`INSERT INTO provider_channel_access
        (provider_channel_access_id, provider, provider_channel_id, connector_instance_id, agent_id, capabilities, status, trust_status, metadata)
        VALUES (?, 'discord', 'probe-f-external', ?, 'cto', '{"message_create":true}', 'active', 'local', '{}')`)
        .run(randomUUID(), connectorId)

      // The outbound insert proves initial validation already passed and the
      // reply transaction reached projection. Expire the exact claim inside
      // that same transaction so only the mutation-time close fence can stop
      // it. The expected CLI failure must roll this trigger update and every
      // reply/fanout/outbound write back together.
      db.exec(`CREATE TRIGGER expire_queue_work_claim_after_outbound
        AFTER INSERT ON outbound_queue
        WHEN NEW.message_id IN (
          SELECT id FROM agent_messages WHERE reply_to = '${messageId}'
        )
        BEGIN
          UPDATE message_queue
             SET claim_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE id = ${queueId};
        END`)
    } finally {
      db.close()
    }

    const rejected = runCli([
      'send', '--content', reply, '--mentions', 'cto', '--queue-id', String(queueId),
      '--message-id', messageId, '--queue-work-finalizer', '--close',
    ], { AUN_QUEUE_WORK_EXPECTED_RUNTIME_ID: 'codex-exec' })

    expect(rejected.status).toBe(1)
    expect(JSON.parse(rejected.stdout.trim())).toMatchObject({
      ok: false,
      code: 'QUEUE_WORK_FINALIZER_UNAUTHORIZED',
      queue_id: queueId,
      mismatches: ['mutation_time_claim_fence'],
    })
    expect(dbRead(
      `SELECT status, replied_with, claim_expires_at FROM message_queue WHERE id = ?`,
      [queueId],
    )).toEqual(originalQueue)
    expect(dbRead(`SELECT id FROM agent_messages WHERE reply_to = ? AND author_id = 'probe-f'`, [messageId]))
      .toHaveLength(0)
    expect(dbRead(`SELECT id FROM message_queue WHERE agent_id = 'cto'`)).toHaveLength(0)
    expect(dbRead(`SELECT id FROM outbound_queue`)).toHaveLength(0)
  })

  test('D1 reserved internal reply writes once from done and replays the same durable message id', () => {
    allowOutboundAgents('probe-f', 'cto')
    const { messageId, queueId } = seedPendingMessage('D1 internal reply')
    runCli(['next'])
    const authorizationDigest = 'a'.repeat(64)
    const claimKey = `d1:claim:${authorizationDigest}:${queueId}`
    const invocationKey = `d1:invoke:${'b'.repeat(64)}`
    const db = new Database(dbPath)
    try {
      const payload = JSON.parse((db.prepare('SELECT payload FROM message_queue WHERE id = ?').get(queueId) as { payload: string }).payload)
      payload.shirube_v4_d1 = { authorization: { authorization_digest: authorizationDigest } }
      db.prepare(`UPDATE message_queue SET status = 'done', payload = ? WHERE id = ?`).run(JSON.stringify(payload), queueId)
      db.prepare(`
        INSERT INTO shirube_d1_claims
          (claim_key, handoff_id, authorization_digest, control_source, exact_base_sha, allowed_paths_digest, status)
        VALUES (?, 'handoff-d1', ?, 'https://github.com/watchout/agent-comms-mcp/issues/887', ?, ?, 'claimed')
      `).run(claimKey, authorizationDigest, 'c'.repeat(40), 'd'.repeat(64))
      db.prepare(`
        INSERT INTO shirube_d1_invocations
          (invocation_key, claim_key, handoff_id, authorization_digest, effect, status)
        VALUES (?, ?, 'handoff-d1', ?, 'internal_reply', 'reserved')
      `).run(invocationKey, claimKey, authorizationDigest)
      db.prepare(`
        INSERT INTO shirube_d1_effect_deliveries
          (invocation_key, effect, status, lease_owner, lease_expires_at)
        VALUES (?, 'internal_reply', 'reserved', 'lease-d1', '2099-01-01T00:00:00.000Z')
      `).run(invocationKey)
    } finally {
      db.close()
    }

    const args = [
      'send', '--content', 'D1 reply', '--mentions', 'cto', '--queue-id', String(queueId),
      '--message-id', messageId, '--d1-invocation-key', invocationKey, '--no-close',
    ]
    const first = runCli(args)
    expect(first.status).toBe(0)
    const firstPayload = JSON.parse(first.stdout.trim()) as any
    expect(firstPayload).toMatchObject({
      ok: true,
      queue_id: queueId,
      work_closed: false,
      d1_invocation_key: invocationKey,
      idempotent_replay: false,
    })
    expect(dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId]))
      .toEqual([{ status: 'done', replied_with: null }])

    const replay = runCli(args)
    expect(replay.status).toBe(0)
    const replayPayload = JSON.parse(replay.stdout.trim()) as any
    expect(replayPayload).toMatchObject({
      ok: true,
      message_id: firstPayload.message_id,
      d1_invocation_key: invocationKey,
      idempotent_replay: true,
    })
    expect(dbRead(`SELECT id FROM agent_messages WHERE id = ?`, [firstPayload.message_id])).toHaveLength(1)
    expect(dbRead(`SELECT id FROM message_queue WHERE agent_id = 'cto' AND message_id = ?`, [firstPayload.message_id])).toHaveLength(1)
    expect(JSON.parse(dbRead(`SELECT metadata FROM agent_messages WHERE id = ?`, [firstPayload.message_id])[0].metadata).shirube_v4_d1)
      .toEqual({ invocation_key: invocationKey, queue_id: String(queueId), effect: 'internal_reply' })
  })

  test('replies to the in-flight row, sets replied, idles the agent', () => {
    allowOutboundAgents('probe-f', 'cto')
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
    const written = dbRead(`SELECT metadata FROM agent_messages WHERE id = ?`, [payload.message_id])
    expect(JSON.parse(written[0].metadata).routing_scope).toMatchObject({
      mode: 'anchored_queue_claim',
      surface: 'cli.send',
      channel_id: 'probe-f-ch',
      thread_id: null,
      reply_to: payload.reply_to,
      queue_id: queueId,
      alias_resolution: false,
    })
    const audits = dbRead(`SELECT event_type, target, detail FROM audit_log WHERE event_type = 'message.send'`)
    expect(audits).toHaveLength(1)
    expect(audits[0].target).toBe('probe-f-ch')
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      message_id: payload.message_id,
      reply_to: payload.reply_to,
      queue_id: queueId,
      channel_id: 'probe-f-ch',
      thread_id: null,
      sender: 'probe-f',
      active_owner: 'probe-f',
      surface: 'cli.send',
      alias_resolution: false,
    })
    const a = dbRead(`SELECT status FROM agents WHERE agent_id = 'probe-f'`)
    expect(a[0].status).toBe('idle')
  })

  test('shadow control-plane stamps the outbound message and active-owner queue row', () => {
    allowOutboundAgents('probe-f', 'cto')
    seedPendingMessage('conversation shadow')
    runCli(['next'])
    const r = runCli(
      ['send', '--content', 'shadow reply', '--mentions', 'cto'],
      { AGENT_COM_CONVERSATION_CONTROL_PLANE: 'shadow' },
    )
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.ok).toBe(true)
    expect(payload.conversation_control_plane).toMatchObject({
      ok: true,
      action: 'allocated',
      mode: 'shadow',
      conversation_action: 'created',
      baton_action: 'created',
    })

    const message = dbRead(
      `SELECT conversation_id, baton_id FROM agent_messages WHERE id = ?`,
      [payload.message_id],
    )[0]
    const queue = dbRead(
      `SELECT id, conversation_id, baton_id FROM message_queue WHERE agent_id = 'cto' AND message_id = ?`,
      [payload.message_id],
    )[0]
    expect(message.conversation_id).toBe(payload.conversation_control_plane.conversation_id)
    expect(message.baton_id).toBe(payload.conversation_control_plane.baton_id)
    expect(queue.conversation_id).toBe(message.conversation_id)
    expect(queue.baton_id).toBe(message.baton_id)

    const baton = dbRead(
      `SELECT owner_agent_id, state, source_queue_id FROM conversation_batons WHERE baton_id = ?`,
      [message.baton_id],
    )[0]
    expect(baton.owner_agent_id).toBe('cto')
    expect(baton.state).toBe('active')
    expect(String(baton.source_queue_id)).toBe(String(queue.id))

    const audits = dbRead(
      `SELECT detail FROM audit_log WHERE event_type = 'conversation.control_plane.apply'`,
    )
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      surface: 'cli.send',
      active_owner: 'cto',
      ok: true,
      action: 'allocated',
    })
  })

  test('enforce control-plane failure reports allocation error and rolls back send rows', () => {
    allowOutboundAgents('probe-f', 'cto', 'probe-owner')
    const { messageId, queueId } = seedPendingMessage('conversation enforce mismatch')
    const conversationId = randomUUID()
    const batonId = randomUUID()
    const db = new Database(dbPath)
    try {
      db.prepare(`
        INSERT INTO conversations (
          conversation_id,
          conversation_key_hash,
          conversation_key,
          surface,
          channel_id,
          thread_scope_id,
          root_message_id,
          conversation_kind
        ) VALUES (?, ?, '{}', 'cli', 'probe-f-ch', 'probe-f-ch', ?, 'request')
      `).run(conversationId, `test:${conversationId}`, messageId)
      db.prepare(`
        INSERT INTO conversation_batons (
          baton_id,
          conversation_id,
          owner_agent_id,
          state
        ) VALUES (?, ?, 'probe-owner', 'active')
      `).run(batonId, conversationId)
      db.prepare(`UPDATE agent_messages SET conversation_id = ? WHERE id = ?`).run(conversationId, messageId)
    } finally {
      db.close()
    }

    runCli(['next'])
    const r = runCli(
      ['send', '--content', 'enforce rollback reply', '--mentions', 'cto'],
      { AGENT_COM_CONVERSATION_CONTROL_PLANE: 'enforce' },
    )

    expect(r.status).toBe(1)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload).toMatchObject({
      ok: false,
      code: 'CONVERSATION_CONTROL_PLANE_ENFORCE_FAILED',
      error: 'ACTIVE_BATON_OWNER_MISMATCH',
      allocation_error: 'ACTIVE_BATON_OWNER_MISMATCH',
      allocation_error_detail: batonId,
      conversation_control_plane: {
        ok: false,
        action: 'enforce_failed',
        error: 'ACTIVE_BATON_OWNER_MISMATCH',
        allocation_error: 'ACTIVE_BATON_OWNER_MISMATCH',
        allocation_error_detail: batonId,
      },
    })
    expect(payload.detail).toContain('ACTIVE_BATON_OWNER_MISMATCH')
    expect(r.stderr).toContain('ACTIVE_BATON_OWNER_MISMATCH')

    expect(dbRead(`SELECT id FROM agent_messages WHERE content = 'enforce rollback reply'`)).toHaveLength(0)
    expect(dbRead(`SELECT id FROM message_queue WHERE agent_id = 'cto' AND message_id = ?`, [payload.outbound_message_id])).toHaveLength(0)
    const source = dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])[0]
    expect(source).toEqual({ status: 'received', replied_with: null })
  })

  test('rejects second send without a fresh next — INVALID_REPLY_TO guard', () => {
    // Issue #278 §1 error taxonomy: NO_CURRENT_MESSAGE retired in
    // favour of INVALID_REPLY_TO. The CLI hits the same branch when
    // the agent has no active claim (post-reply, post-TTL, or pre-next).
    allowOutboundAgents('probe-f', 'cto')
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
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('cto', 'cto', 'dev', 'idle') ON CONFLICT DO NOTHING`)
    db.exec(`INSERT INTO channel_routing_policy (channel_id, outbound_allowlist) VALUES ('probe-f-ch', '["cto"]')`)
    db.close()
    const { queueId } = seedPendingMessage('acl send')
    runCli(['next'])

    const blocked = runCli(['send', '--content', 'blocked send', '--mentions', 'cto'])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('OUTBOUND_ACL_VIOLATION')
    expect(blocked.stderr).toContain('allowlist=["cto"]')
    const q = dbRead(`SELECT status, replied_with FROM message_queue WHERE id = ?`, [queueId])
    expect(q[0].status).toBe('received')
    expect(q[0].replied_with).toBeNull()
    const written = dbRead(`SELECT id FROM agent_messages WHERE content = 'blocked send'`)
    expect(written.length).toBe(0)
    const audits = dbRead(`SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type = 'outbound.acl_violation'`)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ agent_id: 'probe-f', target: 'probe-f-ch' })
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      operation: 'send',
      sender: 'probe-f',
      intended_recipients: ['cto'],
      channel_id: 'probe-f-ch',
      violated_policy: 'channel.outboundAllowlist',
      outbound_allowlist: ['cto'],
      policy_source: 'db',
      violations: ['probe-f'],
    })
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
    allowOutboundAgents('probe-f', 'probe-f2')

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
    allowOutboundAgents('probe-f', 'probe-f2')

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
    allowOutboundAgents('probe-f', 'cto')
    const r = runCli(['notify', '--channel-id', 'probe-f-ch', '--mentions', 'cto', '--content', 'notify body'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.ok).toBe(true)
    expect(payload.channel_id).toBe('probe-f-ch')
    const written = dbRead(`SELECT metadata FROM agent_messages WHERE id = ?`, [payload.message_id])
    expect(JSON.parse(written[0].metadata).channel_resolution).toMatchObject({
      mode: 'canonical_channel_id',
      alias_resolution: false,
      surface: 'cli.notify',
    })
    const a = dbRead(`SELECT status FROM agents WHERE agent_id = 'probe-f'`)
    // notify should NOT flip the agent's busy/idle state — it stays whatever
    // it was (we seeded 'idle' in beforeEach).
    expect(a[0].status).toBe('idle')
  })

  test('notify rejects legacy --channel before writing', () => {
    allowOutboundAgents('probe-f', 'cto')
    const r = runCli(['notify', '--channel', 'probe-f-ch', '--mentions', 'cto', '--content', 'legacy notify'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CHANNEL_ALIAS_NOT_ALLOWED')
    expect(dbRead(`SELECT id FROM agent_messages WHERE content = 'legacy notify'`)).toHaveLength(0)
  })

  test('notify resolves channel name only through explicit human alias flags', () => {
    allowOutboundAgents('probe-f', 'cto')
    const r = runCli([
      'notify',
      '--channel-name', 'probe-f-ch',
      '--resolve-channel-name',
      '--mentions', 'cto',
      '--content', 'alias notify',
    ])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.channel_id).toBe('probe-f-ch')
    const written = dbRead(`SELECT metadata FROM agent_messages WHERE id = ?`, [payload.message_id])
    expect(JSON.parse(written[0].metadata).channel_resolution).toMatchObject({
      mode: 'human_channel_name',
      alias_resolution: true,
      input_alias: 'probe-f-ch',
      resolved_channel_id: 'probe-f-ch',
      candidate_count: 1,
    })
    const audits = dbRead(`SELECT event_type, target, detail FROM audit_log WHERE event_type = 'channel.alias_resolved'`)
    expect(audits).toHaveLength(1)
    expect(audits[0].target).toBe('probe-f-ch')
  })

  test('shadow control-plane stamps notify message and active-owner queue row', () => {
    allowOutboundAgents('probe-f', 'cto')
    const r = runCli(
      ['notify', '--channel-id', 'probe-f-ch', '--mentions', 'cto', '--content', 'shadow notify'],
      { AGENT_COM_CONVERSATION_CONTROL_PLANE: 'shadow' },
    )
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim()) as any
    expect(payload.ok).toBe(true)
    expect(payload.conversation_control_plane).toMatchObject({
      ok: true,
      action: 'allocated',
      mode: 'shadow',
      conversation_action: 'created',
      baton_action: 'created',
    })

    const message = dbRead(
      `SELECT conversation_id, baton_id FROM agent_messages WHERE id = ?`,
      [payload.message_id],
    )[0]
    const queue = dbRead(
      `SELECT id, conversation_id, baton_id FROM message_queue WHERE agent_id = 'cto' AND message_id = ?`,
      [payload.message_id],
    )[0]
    expect(message.conversation_id).toBe(payload.conversation_control_plane.conversation_id)
    expect(message.baton_id).toBe(payload.conversation_control_plane.baton_id)
    expect(queue.conversation_id).toBe(message.conversation_id)
    expect(queue.baton_id).toBe(message.baton_id)

    const baton = dbRead(
      `SELECT owner_agent_id, state, source_queue_id FROM conversation_batons WHERE baton_id = ?`,
      [message.baton_id],
    )[0]
    expect(baton.owner_agent_id).toBe('cto')
    expect(baton.state).toBe('active')
    expect(String(baton.source_queue_id)).toBe(String(queue.id))

    const audits = dbRead(`SELECT detail FROM audit_log WHERE event_type = 'conversation.control_plane.apply'`)
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      surface: 'cli.notify',
      active_owner: 'cto',
      ok: true,
      action: 'allocated',
    })
  })

  test('notify rejects DB channel policy outbound allowlist violations before writing rows', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, status) VALUES ('cto', 'cto', 'dev', 'idle') ON CONFLICT DO NOTHING`)
    db.exec(`INSERT INTO channel_routing_policy (channel_id, outbound_allowlist) VALUES ('probe-f-ch', '["cto"]')`)
    db.close()

    const blocked = runCli(['notify', '--channel-id', 'probe-f-ch', '--mentions', 'cto', '--content', 'blocked notify'])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('OUTBOUND_ACL_VIOLATION')
    expect(blocked.stderr).toContain('allowlist=["cto"]')
    const written = dbRead(`SELECT id FROM agent_messages WHERE content = 'blocked notify'`)
    expect(written.length).toBe(0)
    const queued = dbRead(`SELECT id FROM message_queue WHERE payload LIKE '%blocked notify%'`)
    expect(queued.length).toBe(0)
    const audits = dbRead(`SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type = 'outbound.acl_violation'`)
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      operation: 'notify',
      sender: 'probe-f',
      intended_recipients: ['cto'],
      channel_id: 'probe-f-ch',
      violated_policy: 'channel.outboundAllowlist',
      outbound_allowlist: ['cto'],
      policy_source: 'db',
      violations: ['probe-f'],
    })
  })
})
