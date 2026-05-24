#!/usr/bin/env bun
/**
 * #530 — `agent-com status` extended output regression.
 *
 * The pre-#530 `status` printed only channels/agents/messages summary.
 * The #530 extension adds: per-agent table, queue summary per agent, and
 * drift warnings. Tests run the real CLI against a fresh SQLite DB so the
 * schema + queries remain in sync with prod, but they isolate from the
 * production PG cluster via AGENT_COM_DB=sqlite + a per-test temp path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const REPO_ROOT = join(import.meta.dir, '..')
const CLI = join(REPO_ROOT, 'cli', 'index.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')

let tmpDir: string
let dbPath: string
let env: Record<string, string>

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI, ...args], { env, encoding: 'utf-8', cwd: REPO_ROOT })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-status-530-'))
  dbPath = join(tmpDir, 'test.db')
  env = {
    ...process.env,
    AGENT_COM_DB: 'sqlite',
    AGENT_COM_SQLITE_PATH: dbPath,
    DATABASE_URL: '',
  }
  const res = spawnSync('bun', [MIGRATE], { env, encoding: 'utf-8', cwd: REPO_ROOT })
  if (res.status !== 0) throw new Error(`migrate failed: ${res.stderr}`)

  const db = new Database(dbPath)
  // Seed two agents: a healthy dev bot and a retired one with stale queue rows.
  db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, runtime, status) VALUES ('bot-a', 'bot-a', 'dev', 'TUI', 'idle')`)
  db.exec(`UPDATE agents SET metadata = '{"tmux_session":"bot-a-tmux"}' WHERE agent_id='bot-a'`)
  db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, runtime, status) VALUES ('bot-retired', 'bot-retired', 'dev', 'TUI', 'offline')`)
  db.exec(`UPDATE agents SET metadata = '{"retired":true}' WHERE agent_id='bot-retired'`)
  // Human agent (CEO-like) — must NOT be flagged for queue drift unless rows
  // exist for it. We add the row but no queue, so no warning.
  db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, runtime, status) VALUES ('human-ceo', 'human-ceo', 'human', 'discord', 'online')`)
  // Channel.
  db.exec(`INSERT INTO channels (id, name, members) VALUES ('ch-1', 'ch-1', '["bot-a","bot-retired","human-ceo"]')`)
  // Queue: bot-retired has 2 stale pending rows → drift trigger.
  db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('bot-retired', ?, '{}', 'pending')`).run('msg-1')
  db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('bot-retired', ?, '{}', 'pending')`).run('msg-2')
  db.close()
})

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

describe('#530 status — extended JSON shape', () => {
  test('default JSON includes agents[] + drifts[] alongside legacy fields', () => {
    const r = runCli(['status', '--format', 'json'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim())
    // Legacy fields preserved (backward compat for scripting callers).
    expect(typeof payload.channels).toBe('number')
    expect(typeof payload.agents_online).toBe('number')
    expect(typeof payload.agents_total).toBe('number')
    expect(typeof payload.messages_1h).toBe('number')
    // New fields.
    expect(Array.isArray(payload.agents)).toBe(true)
    expect(Array.isArray(payload.drifts)).toBe(true)

    const botA = payload.agents.find((a: any) => a.agent_id === 'bot-a')
    expect(botA).toBeDefined()
    expect(botA.runtime).toBe('TUI')
    expect(botA.tmux_session).toBe('bot-a-tmux')
    expect(botA.queue).toEqual({ pending: 0, received: 0, in_progress: 0, oldest: null })

    const retired = payload.agents.find((a: any) => a.agent_id === 'bot-retired')
    expect(retired.retired).toBe(true)
    expect(retired.queue.pending).toBe(2)
  })

  test('drift warning fires for retired agent with queued rows', () => {
    const r = runCli(['status', '--format', 'json'])
    const payload = JSON.parse(r.stdout.trim())
    const driftHits = payload.drifts.filter((d: string) => d.includes('bot-retired'))
    expect(driftHits.length).toBeGreaterThan(0)
    expect(driftHits[0]).toMatch(/retired agent .* still has 2 queued rows/)
  })

  test('drift warning fires for TUI agent without tmux_session metadata', () => {
    // Add a TUI bot with no metadata.tmux_session.
    const db = new Database(dbPath)
    db.exec(`INSERT INTO agents (agent_id, display_name, agent_type, runtime, status) VALUES ('bot-no-tmux', 'bot-no-tmux', 'dev', 'TUI', 'idle')`)
    db.close()
    const r = runCli(['status', '--format', 'json'])
    const payload = JSON.parse(r.stdout.trim())
    const driftHits = payload.drifts.filter((d: string) => d.includes('bot-no-tmux'))
    expect(driftHits.length).toBe(1)
    expect(driftHits[0]).toMatch(/runtime=TUI but metadata.tmux_session is missing/)
  })

  test('drift warning fires for human agent receiving queue rows (PR #533 follow-up)', () => {
    const db = new Database(dbPath)
    db.prepare(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('human-ceo', ?, '{}', 'pending')`).run('msg-h')
    db.close()
    const r = runCli(['status', '--format', 'json'])
    const payload = JSON.parse(r.stdout.trim())
    const driftHits = payload.drifts.filter((d: string) => d.includes('human-ceo'))
    expect(driftHits.length).toBe(1)
    expect(driftHits[0]).toMatch(/human agent .* has 1 queued rows/)
  })
})

describe('#530 status — text mode + --brief backward compat', () => {
  test('default text emits header, agents table, drift section', () => {
    const r = runCli(['status'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('=== agent-com status ===')
    expect(r.stdout).toContain('--- agents (active, non-disabled) ---')
    expect(r.stdout).toContain('bot-a')
    expect(r.stdout).toContain('bot-retired')
    expect(r.stdout).toContain('drift warnings')
  })

  test('--brief returns the legacy minimal summary, no agents table', () => {
    const r = runCli(['status', '--brief'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('=== agent-com status ===')
    expect(r.stdout).toContain('DB: connected')
    expect(r.stdout).toContain('Channels:')
    expect(r.stdout).not.toContain('--- agents (active, non-disabled) ---')
    expect(r.stdout).not.toContain('drift warnings')
  })
})

describe('#530 status — discord_id + workspace + launch_dir columns (CEO follow-up)', () => {
  test('JSON exposes discord_id and runtime workspace per agent', () => {
    const db = new Database(dbPath)
    db.exec(`UPDATE agents SET metadata = '{"discord_id":"1234567890"}' WHERE agent_id='bot-a'`)
    db.exec(`INSERT INTO agent_runtime_instances (agent_id, runtime_engine, runtime_kind, status, checkout_path, started_at, last_seen_at) VALUES ('bot-a', 'TUI', 'local_process', 'running', '/Users/x/Developer/bot-a', datetime('now'), datetime('now'))`)
    db.close()
    const r = runCli(['status', '--format', 'json'])
    expect(r.status).toBe(0)
    const payload = JSON.parse(r.stdout.trim())
    const botA = payload.agents.find((a: any) => a.agent_id === 'bot-a')
    expect(botA.discord_id).toBe('1234567890')
    expect(botA.workspace).toBe('/Users/x/Developer/bot-a')
  })

  test('launch_dir is read from AUN_REGISTRY_PATH when set (bot-registry.txt column 2)', () => {
    const registryPath = join(tmpDir, 'bot-registry.txt')
    require('node:fs').writeFileSync(registryPath, [
      '# test fixture — SESSION|PROJECT_DIR|AGENT_ID|PORT|CMD',
      'discord-bot-a|/Users/x/launch/bot-a|bot-a|9001|fake-cmd',
    ].join('\n'))
    const r = spawnSync('bun', [CLI, 'status', '--format', 'json'], {
      env: { ...env, AUN_REGISTRY_PATH: registryPath },
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    })
    expect(r.status).toBe(0)
    const payload = JSON.parse((r.stdout ?? '').trim())
    const botA = payload.agents.find((a: any) => a.agent_id === 'bot-a')
    expect(botA.launch_dir).toBe('/Users/x/launch/bot-a')
  })

  test('text mode header includes discord_id and launch_dir columns', () => {
    const r = runCli(['status'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('discord_id')
    expect(r.stdout).toContain('launch_dir')
  })
})
