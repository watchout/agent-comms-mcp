/**
 * ADR-050 fixture (6d) — wake-daemon 経由 message delivery regression.
 *
 * Pins that the de jure primary delivery mechanism (wake-daemon, ADR-050)
 * still works end-to-end after the in-process signaling code is removed:
 *   1. Spawn a real tmux session
 *   2. Boot the real wake-daemon (bin/wake-daemon.ts) against a real
 *      SQLite DB
 *   3. INSERT one agent_messages + message_queue row
 *   4. Verify the wake-daemon delivers a wake event (tmux pane Enter
 *      arrival + log marker) within 5s
 *   5. SIGTERM the daemon, assert clean exit
 *
 * This is a sister fixture to tests/contract/test_0_wake_daemon.test.ts —
 * the existing test pins the original spec v3 contract; this one pins the
 * post-ADR-050 invariant explicitly so a regression that re-introduced
 * an in-process bus path would be visible here without depending on the
 * pre-existing test's history.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DAEMON = join(REPO_ROOT, 'bin', 'wake-daemon.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')

const AGENT_ID = `adr050-${randomUUID().slice(0, 8)}`
const SESSION = `discord-${AGENT_ID}`

const HAS_TMUX = spawnSync('which', ['tmux']).status === 0

function tmuxHas(s: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', s], { stdio: 'ignore' }).status === 0
}
function tmuxKill(s: string): void {
  if (tmuxHas(s)) spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' })
}
function tmuxCapture(s: string): string {
  const r = spawnSync('tmux', ['capture-pane', '-pt', s], { encoding: 'utf-8' })
  return r.stdout ?? ''
}

async function waitFor<T>(
  poll: () => T | Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await poll()
    if (pred(v)) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

describe.skipIf(!HAS_TMUX)('ADR-050 §6d — wake-daemon delivery still works post-removal', () => {
  let tmpDir: string
  let dbPath: string
  let daemon: ChildProcess | null = null

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'adr050-wake-'))
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

  afterAll(() => {
    if (daemon && daemon.pid && !daemon.killed) {
      try { daemon.kill('SIGKILL') } catch {}
    }
    tmuxKill(SESSION)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('1 message_queue INSERT → wake-daemon → tmux send-keys → ≤5s', async () => {
    expect(existsSync(DAEMON)).toBe(true)

    // Real tmux session; `cat` keeps the pane alive and echoes any keys.
    const created = spawnSync('tmux', ['new-session', '-d', '-s', SESSION, 'cat'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(created.status).toBe(0)
    expect(tmuxHas(SESSION)).toBe(true)

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
    daemon.stderr!.on('data', (d: Buffer) => {
      dStderr += d.toString()
    })

    // Wait for the daemon to announce sqlite polling mode.
    const ready = await waitFor(
      () => dStderr,
      (s) => /sqlite polling mode/.test(s),
      8000,
    )
    expect(ready).not.toBeNull()

    const baseline = tmuxCapture(SESSION)

    // INSERT one inbound + queue row.
    const db = new Database(dbPath)
    const messageId = `adr050-msg-${randomUUID()}`
    db.exec(
      `INSERT INTO agent_messages (id, author_id, content, message_type, source) VALUES ('${messageId}', 'adr050-tester', 'wake', 'chat', 'agent-comms')`,
    )
    db.exec(
      `INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('${AGENT_ID}', '${messageId}', '{}', 'pending')`,
    )
    db.close()

    const woke = await waitFor(
      () => {
        if (/wake .* for /.test(dStderr)) return true
        return tmuxCapture(SESSION) !== baseline
      },
      (v) => v === true,
      5000,
      100,
    )
    expect(woke).toBe(true)
    expect(dStderr).toMatch(new RegExp(`wake .* for ${AGENT_ID}/${messageId}`))

    // Verify the daemon stderr does NOT mention any in-process signaling
    // (regression-pin for ADR-050).
    expect(dStderr).not.toMatch(/UnixSignalBus/)
    expect(dStderr).not.toMatch(/SIGUSR1.*bot_/)

    // Clean shutdown.
    daemon.kill('SIGTERM')
    const exited = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 30_000)
      daemon!.once('exit', () => { clearTimeout(t); res(true) })
    })
    expect(exited).toBe(true)
  }, 30_000)
})
