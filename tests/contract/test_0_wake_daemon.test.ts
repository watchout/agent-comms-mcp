import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

// Spec §contract_test test_0 (specs/review/2026-04-23-lightweight-redesign-v3.md
// extension by CTO msg 14c10b46 / lead-ama PR #0 instruction)
// Impl担当: PR #0 (merge gate, executable)
//
// Scope (§4.1 merge gate):
//   (a) tmux new-session -d -s discord-<test-bot>
//   (b) wake-daemon 起動 (background)
//   (c) agent_messages + message_queue 1 row insert
//   (d) 5s 以内 対象 session に Enter 到達 (tmux capture-pane -p で確認)
//   (e) daemon SIGTERM → 30s 以内 exit + PID 不在
//   (f) tmux cleanup
//
// Requirements (§4.1):
//   - PG / SQLite 両 pass (this file runs SQLite primary; PG is covered
//     when DATABASE_URL is set and the daemon's pg branch is exercised by
//     a parallel fixture — omitted here for CI stability).
//   - Real tmux + real DB (no mocks).
//   - 30 s total budget.
//   - No leaked process / leaked session (afterAll cleanup unconditional).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DAEMON = join(REPO_ROOT, 'bin', 'wake-daemon.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')

const AGENT_ID = `test-wake-${randomUUID().slice(0, 8)}`
const SESSION = `discord-${AGENT_ID}`

let tmpDir: string
let dbPath: string
let daemon: ChildProcess | null = null

function tmuxHas(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], {
    stdio: ['ignore', 'ignore', 'ignore'],
  }).status === 0
}

function tmuxKill(session: string): void {
  if (tmuxHas(session)) {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
  }
}

function tmuxCapture(session: string): string {
  const result = spawnSync('tmux', ['capture-pane', '-pt', session], { encoding: 'utf-8' })
  return result.stdout ?? ''
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(
  poll: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await poll()
    if (predicate(v)) return v
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return null
}

describe('test_0 wake_daemon (PR #0, spec v3 contract_test test_0, merge gate)', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test0-wake-'))
    dbPath = join(tmpDir, 'wake.db')
    const mig = spawnSync('bun', [MIGRATE], {
      env: { ...process.env, AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: dbPath },
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    })
    if (mig.status !== 0) {
      throw new Error(`sqlite migrate failed (status=${mig.status}):\n${mig.stderr}`)
    }
  })

  afterAll(async () => {
    if (daemon && daemon.pid && !daemon.killed) {
      try { daemon.kill('SIGKILL') } catch {}
    }
    tmuxKill(SESSION)
    tmuxKill(`${SESSION}-status-disabled`)
    tmuxKill(`${SESSION}-system`)
    tmuxKill(`${SESSION}-disabled-at`)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('(a)-(f) end-to-end: tmux → daemon → INSERT → Enter arrival → SIGTERM', async () => {
    // (a) real tmux session — hold with cat so send-keys '' Enter leaves a
    // visible trace in the pane buffer.
    const created = spawnSync('tmux', ['new-session', '-d', '-s', SESSION, 'cat'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(created.status).toBe(0)
    expect(tmuxHas(SESSION)).toBe(true)

    // (b) wake-daemon in background (SQLite mode)
    daemon = spawn('bun', [DAEMON], {
      env: {
        ...process.env,
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        DATABASE_URL: '',
        WAKE_DAEMON_DEBUG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    })
    let dStderr = ''
    daemon.stderr!.on('data', (d: Buffer) => { dStderr += d.toString() })

    // Wait for the daemon to announce "sqlite polling mode". Under full-
    // suite parallel load the bun cold-start for the daemon child can
    // legitimately take 10–20s (CPU contention across ~120 sibling test
    // files all spawning bun subprocesses); the 30s budget reflects
    // observed worst-case cold-start latency without relaxing the spec
    // §4.1 5s wake budget that fires after this readiness gate.
    const ready = await waitFor(
      () => dStderr,
      (s) => /sqlite polling mode/.test(s),
      30000,
    )
    expect(ready).not.toBeNull()

    // Establish a baseline pane snapshot before we trigger a wake.
    const baseline = tmuxCapture(SESSION)

    // (c) INSERT agent_messages + message_queue row
    const db = new Database(dbPath)
    const messageId = `msg-${randomUUID()}`
    db.prepare(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, metadata, profile_enabled)
       VALUES (?, ?, 'dev', 'claude-code', 'online', ?, 1)`,
    ).run(AGENT_ID, AGENT_ID, JSON.stringify({ tmux_session: SESSION }))
    db.exec(`INSERT INTO agent_messages (id, author_id, content, message_type, source) VALUES ('${messageId}', 'tester', 'hi', 'chat', 'agent-comms')`)
    db.exec(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('${AGENT_ID}', '${messageId}', '{}', 'pending')`)
    db.close()

    // (d) wait ≤5 s for daemon to observe the insert and send Enter to the
    // tmux session (the `cat` process will echo any input, so the pane
    // buffer changes relative to baseline).
    const woke = await waitFor(
      () => {
        // Prefer log marker (definitive) but fall back to pane diff.
        if (/wake .* for /.test(dStderr)) return true
        return tmuxCapture(SESSION) !== baseline
      },
      (v) => v === true,
      5000,
      100,
    )
    expect(woke).toBe(true)
    expect(dStderr).toMatch(new RegExp(`wake .* for ${AGENT_ID}/${messageId}`))

    // (e) SIGTERM → ≤30 s exit + PID gone
    const daemonPid = daemon.pid!
    daemon.kill('SIGTERM')
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 30_000)
      daemon!.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    expect(exited).toBe(true)
    expect(await pidAlive(daemonPid)).toBe(false)

    // (f) tmux cleanup
    tmuxKill(SESSION)
    expect(tmuxHas(SESSION)).toBe(false)
  }, 60_000)

  test('disabled/system DB profiles are not wake targets even when tmux sessions exist', async () => {
    const blockedProfiles = [
      {
        agentId: `${AGENT_ID}-status-disabled`,
        session: `${SESSION}-status-disabled`,
        agentType: 'dev',
        status: 'disabled',
        disabledAt: null,
      },
      {
        agentId: `${AGENT_ID}-system`,
        session: `${SESSION}-system`,
        agentType: 'system',
        status: 'online',
        disabledAt: null,
      },
      {
        agentId: `${AGENT_ID}-disabled-at`,
        session: `${SESSION}-disabled-at`,
        agentType: 'dev',
        status: 'online',
        disabledAt: new Date().toISOString(),
      },
    ]

    for (const profile of blockedProfiles) {
      const created = spawnSync('tmux', ['new-session', '-d', '-s', profile.session, 'cat'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(created.status).toBe(0)
      expect(tmuxHas(profile.session)).toBe(true)
    }

    daemon = spawn('bun', [DAEMON], {
      env: {
        ...process.env,
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        DATABASE_URL: '',
        WAKE_DAEMON_DEBUG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    })
    let dStderr = ''
    daemon.stderr!.on('data', (d: Buffer) => { dStderr += d.toString() })

    const ready = await waitFor(
      () => dStderr,
      (s) => /sqlite polling mode/.test(s),
      30000,
    )
    expect(ready).not.toBeNull()

    const baselines = new Map(blockedProfiles.map((profile) => [
      profile.session,
      tmuxCapture(profile.session),
    ]))

    const db = new Database(dbPath)
    for (const profile of blockedProfiles) {
      const messageId = `msg-${randomUUID()}`
      db.prepare(
        `INSERT INTO agents
           (agent_id, display_name, agent_type, runtime, status, metadata, profile_enabled, disabled_at)
         VALUES (?, ?, ?, 'claude-code', ?, ?, 1, ?)`,
      ).run(
        profile.agentId,
        profile.agentId,
        profile.agentType,
        profile.status,
        JSON.stringify({ tmux_session: profile.session }),
        profile.disabledAt,
      )
      db.exec(`INSERT INTO agent_messages (id, author_id, content, message_type, source) VALUES ('${messageId}', 'tester', 'blocked wake', 'chat', 'agent-comms')`)
      db.exec(`INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('${profile.agentId}', '${messageId}', '{}', 'pending')`)
    }
    db.close()

    const unexpectedWake = await waitFor(
      () => dStderr,
      (s) => blockedProfiles.some((profile) => s.includes(` for ${profile.agentId}/`)),
      1500,
      100,
    )
    expect(unexpectedWake).toBeNull()
    for (const profile of blockedProfiles) {
      expect(tmuxCapture(profile.session)).toBe(baselines.get(profile.session))
    }

    const daemonPid = daemon.pid!
    daemon.kill('SIGTERM')
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 30_000)
      daemon!.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    expect(exited).toBe(true)
    expect(await pidAlive(daemonPid)).toBe(false)

    for (const profile of blockedProfiles) {
      tmuxKill(profile.session)
      expect(tmuxHas(profile.session)).toBe(false)
    }
  }, 60_000)
})
