/**
 * ADR-050 fixture (6d) — wake-daemon 経由 message delivery regression.
 *
 * Pin the post-ADR-050 invariant: when the daemon picks up a freshly-
 * inserted message_queue row, its observable behavior MUST NOT involve
 * any in-process signaling primitives (UnixSignalBus / SIGUSR1 'bot_*').
 *
 * Scope split with the sister fixture `tests/contract/test_0_wake_daemon.test.ts`:
 *
 *   - test_0 (spec v3 contract test) covers the full e2e physical-delivery
 *     path: tmux session → daemon → INSERT → Enter arrival → SIGTERM.
 *   - This file (§6d) covers ONLY the ADR-050 invariant: daemon stderr
 *     contains zero UnixSignalBus / SIGUSR1 'bot_*' references while it
 *     processes a real pending row.
 *
 * The earlier cycle-2 shape of this fixture also re-asserted the tmux
 * pane-arrival check, duplicating test_0's coverage. The duplicated
 * timing-dependent assertion was the primary source of full-suite-load
 * flakiness (two concurrent tmux + bun-spawn races). Cycle 3 removes the
 * duplicated physical check and keeps only the unique ADR-050 invariant
 * — daemon stderr assertion — which does not depend on tmux at all.
 * No `--bail`, no skip, no retry: the flakiness root cause is the
 * eliminated duplicate physical check.
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

describe('ADR-050 §6d — wake-daemon stderr regression (no UnixSignalBus / SIGUSR1)', () => {
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
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('daemon stderr contains zero UnixSignalBus / SIGUSR1 \'bot_*\' references during real row processing', async () => {
    expect(existsSync(DAEMON)).toBe(true)

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

    // Wait for the daemon to announce sqlite polling mode. Generous
    // budget for bun cold-start under full-suite parallel CPU load
    // (observed worst case ~15–20s on contended runs).
    const ready = await waitFor(
      () => dStderr,
      (s) => /sqlite polling mode/.test(s),
      30000,
    )
    expect(ready).not.toBeNull()

    // INSERT one inbound + queue row. We do NOT create a DB profile/tmux
    // session; the daemon will log a DB-profile session miss (which still
    // proves it picked up the row from the queue without going through any
    // in-process bus). The ADR-050 invariant assertions below are independent
    // of tmux delivery success.
    const db = new Database(dbPath)
    const messageId = `adr050-msg-${randomUUID()}`
    db.exec(
      `INSERT INTO agent_messages (id, author_id, content, message_type, source) VALUES ('${messageId}', 'adr050-tester', 'wake', 'chat', 'agent-comms')`,
    )
    db.exec(
      `INSERT INTO message_queue (agent_id, message_id, payload, status) VALUES ('${AGENT_ID}', '${messageId}', '{}', 'pending')`,
    )
    db.close()

    // Wait until the daemon's stderr proves it observed the row. Either
    // "wake .* for <agent>/<msg>" (would-be success path) OR
    // "no active DB-profile tmux session for agent <agent>" (no-profile path used here) is
    // a positive proof; we accept either to keep the test independent
    // of tmux setup state.
    const observed = await waitFor(
      () => dStderr,
      (s) =>
        new RegExp(`wake .* for ${AGENT_ID}/${messageId}`).test(s)
          || new RegExp(`no active DB-profile tmux session for agent ${AGENT_ID}`).test(s),
      15000,
      100,
    )
    expect(observed).not.toBeNull()

    // Core ADR-050 invariants (this is the unique value of §6d vs §6a).
    // §6a's grep covers static source; this check covers dynamic stderr
    // emission while the daemon actually processes a queue row, which
    // would catch a regression that re-imports the bus only inside the
    // hot path (impossible to catch by static grep alone).
    expect(dStderr).not.toMatch(/UnixSignalBus/)
    expect(dStderr).not.toMatch(/SIGUSR1.*bot_/)

    // Clean shutdown — separate from invariant assertions above.
    daemon.kill('SIGTERM')
    const exited = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 30_000)
      daemon!.once('exit', () => { clearTimeout(t); res(true) })
    })
    expect(exited).toBe(true)
  }, 90_000)
})
