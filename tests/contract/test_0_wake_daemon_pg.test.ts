import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

// Spec §contract_test test_0 — PG branch (cycle 2 addendum for PR #232).
// Auditor Layer 2 flagged §4.1 "PG/SQLite 両 pass" as BLOCKER because the
// primary test_0 file exercises SQLite only. This file closes the gap:
// when DATABASE_URL is set, it drives the same daemon end-to-end against
// PostgreSQL, verifying the `trg_mq_enqueued_notify` trigger → NOTIFY
// mq_enqueued path plus the daemon's LISTEN loop all the way through to
// `tmux send-keys`. When DATABASE_URL is not set the suite skips (CI adds
// a dedicated PG job; the SQLite merge-gate test continues to run on all
// CI matrix cells).
//
// Usage (local): DATABASE_URL=postgresql://yuji@localhost/agent_comms \
//   bun test tests/contract/test_0_wake_daemon_pg.test.ts

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DAEMON = join(REPO_ROOT, 'bin', 'wake-daemon.ts')
const MIGRATE = join(REPO_ROOT, 'db', 'migrate.ts')

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

const AGENT_ID = `test-wake-pg-${randomUUID().slice(0, 8)}`
const SESSION = `discord-${AGENT_ID}`

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

async function pidAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true } catch { return false }
}

dbDescribe('test_0 wake_daemon PG (PR #232 cycle 2, §4.1 PG/SQLite 両 pass)', () => {
  let daemon: ChildProcess | null = null
  let client: Client | null = null
  let insertedMessageId: string | null = null

  beforeAll(async () => {
    // Idempotent re-run of the PR #0 migration block — ensures the
    // `trg_mq_enqueued_notify` trigger is present before the daemon starts
    // LISTENing. On production PG where the trigger already exists this is
    // a no-op thanks to CREATE OR REPLACE + DROP/CREATE TRIGGER.
    const mig = spawnSync('bun', [MIGRATE], {
      env: { ...process.env, DATABASE_URL, AGENT_COM_DB: 'postgres' },
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    })
    if (mig.status !== 0) {
      throw new Error(`PG migrate failed (status=${mig.status}):\n${mig.stderr}`)
    }
  })

  afterAll(async () => {
    if (daemon && daemon.pid && !daemon.killed) {
      try { daemon.kill('SIGKILL') } catch {}
    }
    tmuxKill(SESSION)
    // Row cleanup — delete our probe row if the test managed to insert it.
    if (client && insertedMessageId) {
      try {
        await client.query(
          `DELETE FROM message_queue WHERE agent_id = $1 AND message_id = $2`,
          [AGENT_ID, insertedMessageId],
        )
        await client.query(
          `DELETE FROM agent_messages WHERE id = $1`,
          [insertedMessageId],
        )
        await client.query(`DELETE FROM agents WHERE agent_id = $1`, [AGENT_ID])
      } catch {}
    }
    if (client) {
      try { await client.end() } catch {}
    }
  })

  test('LISTEN mq_enqueued → NOTIFY via trigger → tmux wake → SIGTERM clean', async () => {
    expect(tmuxHas(SESSION)).toBe(false)
    const created = spawnSync('tmux', ['new-session', '-d', '-s', SESSION, 'cat'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(created.status).toBe(0)

    // Start the daemon in PG mode.
    daemon = spawn('bun', [DAEMON], {
      env: {
        ...process.env,
        AGENT_COM_DB: 'postgres',
        DATABASE_URL,
        WAKE_DAEMON_DEBUG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    })
    let dStderr = ''
    daemon.stderr!.on('data', (d: Buffer) => { dStderr += d.toString() })

    // Wait for the daemon to complete LISTEN setup.
    const ready = await waitFor(
      () => dStderr,
      (s) => /listening on pg channel mq_enqueued/.test(s),
      8000,
    )
    expect(ready).not.toBeNull()

    // INSERT a fresh agent_messages + message_queue row. The
    // `trg_mq_enqueued_notify` trigger fires in the INSERT's own
    // transaction and emits `NOTIFY mq_enqueued` with the expected
    // `{agent_id, message_id}` payload.
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    const messageId = randomUUID()
    insertedMessageId = messageId
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, metadata, profile_enabled)
       VALUES ($1, $1, 'dev', 'claude-code', 'online', jsonb_build_object('tmux_session', $2::text), true)
       ON CONFLICT (agent_id) DO UPDATE SET metadata = EXCLUDED.metadata, profile_enabled = true`,
      [AGENT_ID, SESSION],
    )
    await client.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata, source, direction, role)
       VALUES ($1::uuid, 'pr232-cycle2-pg-probe', 'pg-probe-author', 'pg wake probe', 'chat', '{}'::jsonb, 'agent-comms', 'inbound', 'agent')`,
      [messageId],
    )
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status)
       VALUES ($1, $2, '{}', 'pending')`,
      [AGENT_ID, messageId],
    )

    // Within 5s the daemon must log `wake <session> for <agent_id>/<message_id>`.
    const woke = await waitFor(
      () => dStderr,
      (s) => new RegExp(`wake ${SESSION} for ${AGENT_ID}/${messageId}`).test(s),
      5000,
    )
    expect(woke).not.toBeNull()

    // SIGTERM → ≤30s clean exit + PID gone (§1.4).
    const daemonPid = daemon.pid!
    daemon.kill('SIGTERM')
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 30_000)
      daemon!.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    expect(exited).toBe(true)
    expect(await pidAlive(daemonPid)).toBe(false)

    // tmux cleanup.
    tmuxKill(SESSION)
    expect(tmuxHas(SESSION)).toBe(false)
  }, 30_000)

  test('PG migration leaves outbound_queue claim vocabulary at claimed', async () => {
    const probe = new Client({ connectionString: DATABASE_URL })
    await probe.connect()

    try {
      const constraint = await probe.query<{ constraint_def: string }>(
        `SELECT pg_get_constraintdef(oid) AS constraint_def
           FROM pg_constraint
          WHERE conrelid = 'outbound_queue'::regclass
            AND conname = 'outbound_queue_status_check'`,
      )
      expect(constraint.rowCount).toBe(1)
      const constraintDef = constraint.rows[0].constraint_def
      expect(constraintDef).toContain('claimed')
      expect(constraintDef).not.toContain('processing')

      const drift = await probe.query<{ processing_count: string }>(
        `SELECT count(*)::text AS processing_count
           FROM outbound_queue
          WHERE status = 'processing'`,
      )
      expect(Number(drift.rows[0].processing_count)).toBe(0)

      await probe.query('BEGIN')
      try {
        await probe.query(
          `INSERT INTO outbound_queue
             (message_id, agent_id, channel_external_id, content, status)
           VALUES ($1, $2, $3, $4, 'claimed')`,
          [randomUUID(), AGENT_ID, 'pr585-claim-vocabulary-probe', 'claim vocabulary probe'],
        )
      } finally {
        await probe.query('ROLLBACK')
      }
    } finally {
      await probe.end()
    }
  }, 30_000)
})
