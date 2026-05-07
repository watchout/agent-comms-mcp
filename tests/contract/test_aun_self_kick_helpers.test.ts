#!/usr/bin/env bun
/**
 * PR #321 cycle 3 (axis 5 adapter 分離) — unit tests for the three
 * adapter-port helpers in `hooks/lib/aun-self-kick-helpers.sh`.
 *
 * Each port is exercised against PATH-prefix stubs (psql / tmux) and
 * an isolated tmpdir for the lock fs, so `aun_self_kick_db_query`,
 * `aun_self_kick_resolve_session`, and `aun_self_kick_check_lock`
 * verify independently of the orchestrator.
 *
 *   U-1 db_query: agent_id present + DB reachable → integer stdout;
 *                bogus DB URL → empty stdout + stderr warning.
 *   U-2 resolve_session: $TMUX set + tmux stub returns "test-session"
 *                → stdout "test-session"; $TMUX unset → empty stdout.
 *   U-3 check_lock: absent → exit 0; fresh (<5 min) → exit 1;
 *                stale (>5 min) → exit 0.
 *
 * The helper file is loaded via `source` in a wrapper bash command,
 * matching the way the orchestrator hook consumes it in production.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Client } from 'pg'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HELPERS = join(REPO_ROOT, 'hooks', 'lib', 'aun-self-kick-helpers.sh')
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const TEST_AGENT = `test-self-kick-helpers-${process.pid}`

let dbReachable = false

beforeAll(async () => {
  try {
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    await c.query(`DELETE FROM message_queue WHERE agent_id=$1`, [TEST_AGENT])
    await c.query(`DELETE FROM outbound_queue WHERE agent_id=$1`, [TEST_AGENT])
    await c.end()
    dbReachable = true
  } catch {
    dbReachable = false
  }
})

afterAll(async () => {
  if (!dbReachable) return
  try {
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    await c.query(`DELETE FROM message_queue WHERE agent_id=$1`, [TEST_AGENT])
    await c.query(`DELETE FROM outbound_queue WHERE agent_id=$1`, [TEST_AGENT])
    await c.end()
  } catch {}
})

function requireDb() {
  if (!dbReachable) {
    throw new Error(
      `DB unreachable at ${DATABASE_URL}. ` +
      `These adapter unit tests require a real Postgres — silent skip ` +
      `would let the merge gate pass on a non-test (cycle 2 axis 6 fix).`,
    )
  }
}

/**
 * Run a bash one-liner with the helper sourced.
 * Returns stdout, stderr, exit status.
 */
function runWithHelper(
  body: string,
  env: Record<string, string> = {},
  pathPrefix?: string,
): { stdout: string; stderr: string; status: number } {
  const fullEnv = {
    ...process.env,
    ...env,
    PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH ?? '/usr/bin:/bin'}` : (process.env.PATH ?? '/usr/bin:/bin'),
  }
  const r = spawnSync('bash', ['-c', `source "${HELPERS}"; ${body}`], {
    env: fullEnv,
    encoding: 'utf-8',
    timeout: 10_000,
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 }
}

describe('test_aun_self_kick_helpers — adapter port unit tests', () => {
  test('U-1 db_query: agent_id + reachable DB → integer stdout', async () => {
    requireDb()
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    try {
      await c.query(
        `INSERT INTO message_queue (message_id, agent_id, payload, status, created_at)
         VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'pending', now())`,
        [TEST_AGENT],
      )
      const r = runWithHelper(`aun_self_kick_db_query "${TEST_AGENT}"`, { DATABASE_URL })
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('1')
    } finally {
      await c.query(`DELETE FROM message_queue WHERE agent_id=$1`, [TEST_AGENT])
      await c.end()
    }
  })

  test('U-1 db_query: bogus DB URL → empty stdout + stderr warning', () => {
    const r = runWithHelper(`aun_self_kick_db_query "${TEST_AGENT}"`, {
      DATABASE_URL: 'postgresql://localhost:1/no_such_db',
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(r.stderr).toMatch(/aun-self-kick/)
  })

  test('U-2 resolve_session: $TMUX set + tmux stub → session name on stdout', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'self-kick-u2-'))
    try {
      const tmuxScript = `#!/usr/bin/env bash
case "$1" in
  display-message) echo "test-session";;
esac
exit 0
`
      const tmuxPath = join(stubDir, 'tmux')
      writeFileSync(tmuxPath, tmuxScript)
      chmodSync(tmuxPath, 0o755)
      const r = runWithHelper('aun_self_kick_resolve_session', { TMUX: 'fake' }, stubDir)
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('test-session')
    } finally {
      rmSync(stubDir, { recursive: true, force: true })
    }
  })

  test('U-2 resolve_session: $TMUX unset → empty stdout', () => {
    // Parent test process may itself live inside tmux; explicitly clear
    // TMUX so we exercise the unset branch rather than inheriting.
    const fullEnv = { ...process.env, TMUX: '' }
    const r = spawnSync('bash', ['-c', `unset TMUX; source "${HELPERS}"; aun_self_kick_resolve_session`], {
      env: fullEnv,
      encoding: 'utf-8',
      timeout: 5_000,
    })
    expect(r.status).toBe(0)
    expect((r.stdout ?? '').trim()).toBe('')
  })

  test('U-3 check_lock: absent lock → exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-kick-u3-'))
    try {
      const lock = join(dir, 'no-such.lock')
      const r = runWithHelper(`aun_self_kick_check_lock "${lock}"; echo "rc=$?"`)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/rc=0/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('U-3 check_lock: fresh lock (<5min) → exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-kick-u3-'))
    try {
      const lock = join(dir, 'fresh.lock')
      writeFileSync(lock, '')
      const now = new Date()
      utimesSync(lock, now, now)
      const r = runWithHelper(`aun_self_kick_check_lock "${lock}"; echo "rc=$?"`)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/rc=1/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('U-3 check_lock: stale lock (>5min) → exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-kick-u3-'))
    try {
      const lock = join(dir, 'stale.lock')
      writeFileSync(lock, '')
      // 10 min ago = well past the 5 min TTL.
      const oldTs = new Date(Date.now() - 10 * 60 * 1000)
      utimesSync(lock, oldTs, oldTs)
      const r = runWithHelper(`aun_self_kick_check_lock "${lock}"; echo "rc=$?"`)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/rc=0/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
