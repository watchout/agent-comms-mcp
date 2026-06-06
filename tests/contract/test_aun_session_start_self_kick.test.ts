#!/usr/bin/env bun
/**
 * CTO spec dispatch (CEO P0) — cold-start LLM kick (SessionStart self-prime).
 *
 * Contract tests T-1..T-4 for hooks/aun-session-start-self-kick.sh.
 *
 * The script invokes `tmux send-keys` to drive the TUI when pending > 0.
 * Tests stub `tmux` via PATH-prefix so the assertions inspect a recorded
 * call log rather than the real terminal multiplexer. DB query is exercised
 * against a real Postgres when DATABASE_URL is reachable; T-3 covers the
 * unreachable case explicitly with a bogus URL.
 *
 *   T-1: pending=0 → tmux send-keys NOT called
 *   T-2: pending>0 → tmux send-keys called with <session> + prompt + Enter
 *   T-3: DB unreachable → exit 0, send-keys NOT called, stderr warning
 *   T-4: lock file <5min stale → send-keys NOT called
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOK = join(REPO_ROOT, 'hooks', 'aun-session-start-self-kick.sh')
const MEMORY_READY_MIGRATION = join(REPO_ROOT, 'db/migrations/2026-06-06-runtime-memory-ready-evidence.up.sql')
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const TEST_AGENT = `test-self-kick-${process.pid}`

let dbReachable = false
let memoryReadyMigrationApplied = false

async function ensureMemoryReadySchema(c: Client): Promise<void> {
  if (memoryReadyMigrationApplied) return
  await c.query(readFileSync(MEMORY_READY_MIGRATION, 'utf-8'))
  memoryReadyMigrationApplied = true
}

async function cleanupSelfKickAgent(c: Client): Promise<void> {
  await c.query(`DELETE FROM message_queue WHERE agent_id=$1`, [TEST_AGENT])
  await c.query(`DELETE FROM outbound_queue WHERE agent_id=$1`, [TEST_AGENT])
  await c.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id=$1`, [TEST_AGENT])
  await c.query(`DELETE FROM agent_runtime_instances WHERE agent_id=$1`, [TEST_AGENT])
  await c.query(`DELETE FROM agents WHERE agent_id=$1`, [TEST_AGENT])
}

async function seedSelfKickMemoryReady(c: Client): Promise<void> {
  await ensureMemoryReadySchema(c)
  const runtimeId = randomUUID()
  const port = 32_000 + Number.parseInt(runtimeId.slice(0, 4), 16) % 20_000
  const sessionName = 'test-session'
  const checkoutPath = `/tmp/${TEST_AGENT}-memory-ready`
  await c.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id=$1`, [TEST_AGENT])
  await c.query(`DELETE FROM agent_runtime_instances WHERE agent_id=$1`, [TEST_AGENT])
  await c.query(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, channel_port,
        metadata, profile_revision, profile_source, home_directory)
     VALUES ($1, $1, 'dev', 'mcp', 'idle', $2, $3::jsonb, 1, 'legacy', $4)
     ON CONFLICT (agent_id) DO UPDATE SET
       runtime = EXCLUDED.runtime,
       status = EXCLUDED.status,
       channel_port = EXCLUDED.channel_port,
       metadata = EXCLUDED.metadata,
       profile_revision = 1,
       profile_source = 'legacy',
       home_directory = EXCLUDED.home_directory`,
    [TEST_AGENT, port, JSON.stringify({ tmux_session: sessionName }), checkoutPath],
  )
  await c.query(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port,
        checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
     VALUES ($1, $2, 'mcp', 'local_process', $3, $4,
             $5, 'self-kick-test-head', 'running',
             '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z',
             '{"source":"self-kick-test"}'::jsonb)`,
    [runtimeId, TEST_AGENT, sessionName, port, checkoutPath],
  )
  await c.query(
    `INSERT INTO runtime_memory_ready_evidence
       (agent_id, project, runtime_instance_id, profile_revision, profile_source,
        session_name, port, expected_agent_id, checkout_path, checkout_commit_sha,
        recovery_command, result_status, completed_at, evidence_path, evidence_log_id,
        valid_until, source, metadata)
     VALUES
       ($1, 'agent-comms-mcp', $2, 1, 'legacy',
        $3, $4, $1, $5, 'self-kick-test-head',
        'test:mcp__wasurezu__recover_context', 'ready', '2026-06-01T00:00:02.000Z',
        '/tmp/self-kick-memory-ready.json', 'self-kick-memory-ready',
        '2099-01-01T00:00:00.000Z', 'agent_memory_boot_recovery',
        '{"fixture":true}'::jsonb)`,
    [TEST_AGENT, runtimeId, sessionName, port, checkoutPath],
  )
}

beforeAll(async () => {
  try {
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    await ensureMemoryReadySchema(c)
    await cleanupSelfKickAgent(c)
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
    await cleanupSelfKickAgent(c)
    await c.end()
  } catch {}
})

function makeStubDir(opts?: { tmuxSucceeds?: boolean }): { dir: string; tmuxLog: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'self-kick-stub-'))
  const tmuxLog = join(dir, 'tmux.log')
  // Stub tmux: log argv to tmuxLog, return 0. `display-message -p '#S'`
  // is special-cased to print a fixed session name so the script can
  // proceed past the session-name check.
  const tmuxScript = `#!/usr/bin/env bash
echo "$@" >> "${tmuxLog}"
case "$1" in
  display-message) echo "test-session";;
esac
exit 0
`
  const tmuxPath = join(dir, 'tmux')
  writeFileSync(tmuxPath, tmuxScript)
  chmodSync(tmuxPath, 0o755)
  return {
    dir,
    tmuxLog,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function runHook(env: Record<string, string>, stubDir: string, stdin = '{}'): { stdout: string; stderr: string; status: number } {
  // Wait for the backgrounded tmux call (sleep 3) to land before we
  // sample the log. The script returns synchronously; the kick is async.
  const fullEnv = {
    ...process.env,
    ...env,
    PATH: `${stubDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  }
  const r = spawnSync('bash', [HOOK], {
    input: stdin,
    env: fullEnv,
    encoding: 'utf-8',
    timeout: 10_000,
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// axis 6 BLOCK resolve: the prior `if (!dbReachable) return` made T-1/T-2/T-4
// silent skips when the merge gate could not reach Postgres, which let CI
// pass on a non-test. The hook's whole point is exercising the real DB
// path, so any environment that runs this contract test without DB must
// fail loudly. CI always has DATABASE_URL; local dev without Postgres
// should still see the failure rather than a silent green.
function requireDb() {
  if (!dbReachable) {
    throw new Error(
      `DB unreachable at ${DATABASE_URL}. ` +
      `This contract test requires a real Postgres — silent skip would ` +
      `let the merge gate pass on a non-test (auditor cycle 1 axis 6 BLOCK).`,
    )
  }
}

// Lock path now keys on (agent, tmux session) per axis 3 BLOCK resolve.
// The stub `tmux display-message` returns "test-session" so every test
// shares the same session-scoped lock filename.
const LOCK_PATH = `/tmp/aun-self-kick-${TEST_AGENT}-test-session.lock`

describe('test_aun_session_start_self_kick — cold-start LLM kick contract', () => {
  beforeEach(() => {
    // Always clear stale lock between tests so T-4 owns its semantics.
    if (existsSync(LOCK_PATH)) rmSync(LOCK_PATH, { force: true })
  })

  test('T-1: pending=0 → tmux send-keys NOT called', async () => {
    requireDb()
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    try {
      await seedSelfKickMemoryReady(c)
    } finally {
      await c.end()
    }
    const stub = makeStubDir()
    try {
      const r = runHook({
        TMUX: 'fake',
        AGENT_ID: TEST_AGENT,
        DATABASE_URL,
      }, stub.dir)
      expect(r.status).toBe(0)
      // Wait past sleep 3 — even if a (buggy) kick fired, we'd see it.
      await sleep(3500)
      const log = existsSync(stub.tmuxLog) ? readFileSync(stub.tmuxLog, 'utf-8') : ''
      // Only the display-message preflight is allowed; no send-keys.
      expect(log).not.toMatch(/send-keys/)
    } finally {
      stub.cleanup()
    }
  })

  test('T-2: pending>0 → send-keys called with prompt + Enter', async () => {
    requireDb()
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    try {
      await seedSelfKickMemoryReady(c)
      // One pending row in message_queue.
      await c.query(
        `INSERT INTO message_queue (message_id, agent_id, payload, status, created_at)
         VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'pending', now())`,
        [TEST_AGENT],
      )
    } finally {
      await c.end()
    }

    const stub = makeStubDir()
    try {
      const r = runHook({
        TMUX: 'fake',
        AGENT_ID: TEST_AGENT,
        DATABASE_URL,
      }, stub.dir)
      expect(r.status).toBe(0)
      // Wait for the backgrounded sleep 3 + send-keys to flush.
      await sleep(4000)
      const log = readFileSync(stub.tmuxLog, 'utf-8')
      expect(log).toMatch(/send-keys/)
      expect(log).toMatch(/test-session/)
      expect(log).toMatch(/mcp__aun__next/)
      expect(log).toMatch(/mcp__agent_comms__next/)
      expect(log).toMatch(/mcp__agent-comms__next/)
      // Two send-keys calls: the prompt body and a separate Enter.
      const sendKeysLines = log.split('\n').filter(l => l.includes('send-keys'))
      expect(sendKeysLines.length).toBe(2)
      expect(sendKeysLines.some(l => /Enter\b/.test(l))).toBe(true)
    } finally {
      stub.cleanup()
      // Cleanup happens in afterAll too, but keep T-3 isolated.
      const c2 = new Client({ connectionString: DATABASE_URL })
      await c2.connect()
      await c2.query(`DELETE FROM message_queue WHERE agent_id=$1`, [TEST_AGENT])
      await c2.end()
    }
  })

  test('T-3: DB unreachable → exit 0, send-keys NOT called, stderr warning', async () => {
    const stub = makeStubDir()
    try {
      const r = runHook({
        TMUX: 'fake',
        AGENT_ID: TEST_AGENT,
        DATABASE_URL: 'postgresql://localhost:1/no_such_db',
      }, stub.dir)
      expect(r.status).toBe(0)
      await sleep(500)
      const log = existsSync(stub.tmuxLog) ? readFileSync(stub.tmuxLog, 'utf-8') : ''
      expect(log).not.toMatch(/send-keys/)
      expect(r.stderr).toMatch(/aun-self-kick/)
    } finally {
      stub.cleanup()
    }
  })

  test('T-4: lock file <5min stale → send-keys NOT called', async () => {
    requireDb()
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    try {
      await seedSelfKickMemoryReady(c)
      await c.query(
        `INSERT INTO message_queue (message_id, agent_id, payload, status, created_at)
         VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'pending', now())`,
        [TEST_AGENT],
      )
    } finally {
      await c.end()
    }

    writeFileSync(LOCK_PATH, '')
    // Fresh mtime guarantees the <5min stale check fires.
    const now = new Date()
    utimesSync(LOCK_PATH, now, now)

    const stub = makeStubDir()
    try {
      const r = runHook({
        TMUX: 'fake',
        AGENT_ID: TEST_AGENT,
        DATABASE_URL,
      }, stub.dir)
      expect(r.status).toBe(0)
      await sleep(3500)
      const log = existsSync(stub.tmuxLog) ? readFileSync(stub.tmuxLog, 'utf-8') : ''
      expect(log).not.toMatch(/send-keys/)
    } finally {
      stub.cleanup()
      rmSync(LOCK_PATH, { force: true })
      const c2 = new Client({ connectionString: DATABASE_URL })
      await c2.connect()
      await c2.query(`DELETE FROM message_queue WHERE agent_id=$1`, [TEST_AGENT])
      await c2.end()
    }
  })

  test('T-5: pending>0 but missing memory-ready evidence → send-keys NOT called', async () => {
    requireDb()
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    try {
      await seedSelfKickMemoryReady(c)
      await c.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id=$1`, [TEST_AGENT])
      await c.query(
        `INSERT INTO message_queue (message_id, agent_id, payload, status, created_at)
         VALUES (gen_random_uuid(), $1, '{}'::jsonb, 'pending', now())`,
        [TEST_AGENT],
      )
    } finally {
      await c.end()
    }

    const stub = makeStubDir()
    try {
      const r = runHook({
        TMUX: 'fake',
        AGENT_ID: TEST_AGENT,
        DATABASE_URL,
      }, stub.dir)
      expect(r.status).toBe(0)
      await sleep(3500)
      const log = existsSync(stub.tmuxLog) ? readFileSync(stub.tmuxLog, 'utf-8') : ''
      expect(log).not.toMatch(/send-keys/)
    } finally {
      stub.cleanup()
      const c2 = new Client({ connectionString: DATABASE_URL })
      await c2.connect()
      await c2.query(`DELETE FROM message_queue WHERE agent_id=$1`, [TEST_AGENT])
      await c2.end()
    }
  })
})
