#!/usr/bin/env bun
/**
 * PR #0 — wake-on-insert daemon (spec v3 Phase C Gap 1 fix).
 *
 * Single responsibility: detect `message_queue` INSERT (PG NOTIFY or SQLite
 * polling fallback), resolve the target bot's tmux session from the DB
 * `agents` profile, and send Enter to wake the Claude Code REPL so the bot
 * picks up its queue via the `auto-next` hook.
 *
 * Scope (frozen §1.1 / §1.2):
 *   - DB LISTEN `mq_enqueued` (PG) or `message_queue` polling (SQLite)
 *   - tmux send-keys to `agents.metadata.tmux_session`
 *   - Sliding-window de-dup on `message_id` (N=512)
 *   - SIGINT/SIGTERM → clean exit ≤30 s (LISTEN unsubscribe + conn close)
 *
 * Forbidden (§3):
 *   - No MCP / Discord / outbound client (§3.1)
 *   - No env switch for real/mock/replay (§3.2)
 *   - No polling to supplement PG LISTEN (§3.4)
 *   - No `process.exit(0)` on normal path (SIGTERM/SIGINT only)
 */
import { Client as PgClient } from 'pg'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DB_TYPE = process.env.AGENT_COM_DB || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')
const PG_NOTIFY_CHANNEL = 'mq_enqueued'
const DEDUP_WINDOW = 512
const WAKE_DEDUP_MS = 1000
const SQLITE_POLL_MS = 500
const RECONNECT_MIN_MS = 100
const RECONNECT_MAX_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 30_000
// v4 §77-2: literal sent via `tmux send-keys` on wake. Empty string was
// observed to fail the xmarketing pilot (2026-04-24 08:19) because Claude
// Code does not start a new LLM turn on a bare Enter — the prompt must
// contain visible text. `check inbox` is a natural-language cue that also
// nudges the session toward the auto-next hook's additionalContext.
const WAKE_PROMPT = 'check inbox'

const PROJECT_ROOT = dirname(dirname(new URL(import.meta.url).pathname))

// ---------- sliding-window de-dup ----------
// Set gives O(1) membership; order array drops oldest at overflow (O(1) amortised).
const seenIds = new Set<string>()
const seenOrder: string[] = []
export function markSeen(messageId: string): boolean {
  if (seenIds.has(messageId)) return true
  seenIds.add(messageId)
  seenOrder.push(messageId)
  while (seenOrder.length > DEDUP_WINDOW) {
    const evicted = seenOrder.shift()
    if (evicted !== undefined) seenIds.delete(evicted)
  }
  return false
}
// Exported for unit testing.
export function dedupStats(): { size: number; capacity: number } {
  return { size: seenOrder.length, capacity: DEDUP_WINDOW }
}
export function __resetDedup(): void {
  seenIds.clear()
  seenOrder.length = 0
  lastWakeByAgent.clear()
}

// ---------- agent-id time-window dedup (v4 §77-1) ----------
// Second-stage dedup alongside `markSeen(message_id)`. When the same agent
// receives multiple inserts in < 1 s (e.g. a fanout on a group mention),
// one wake suffices — further send-keys would just create duplicate "check
// inbox" prompts in the REPL with no extra value.
const lastWakeByAgent = new Map<string, number>()
export function shouldWake(agentId: string, now: number = Date.now()): boolean {
  const last = lastWakeByAgent.get(agentId)
  if (last !== undefined && now - last < WAKE_DEDUP_MS) return false
  lastWakeByAgent.set(agentId, now)
  return true
}
export function wakeDedupStats(): { tracked: number; windowMs: number } {
  return { tracked: lastWakeByAgent.size, windowMs: WAKE_DEDUP_MS }
}
export function __resetWakeDedup(): void {
  lastWakeByAgent.clear()
}

// ---------- tmux session resolution ----------
type SessionResolver = (agentId: string) => Promise<string | null> | string | null

function sessionExists(sessionName: string): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  return result.status === 0
}

async function resolveSession(agentId: string, resolveProfileSession: SessionResolver): Promise<string | null> {
  const profileSession = await resolveProfileSession(agentId)
  if (!profileSession) return null
  return sessionExists(profileSession) ? profileSession : null
}

async function resolvePgProfileSession(client: PgClient, agentId: string): Promise<string | null> {
  const result = await client.query<{ tmux_session: string | null }>(
    `SELECT metadata->>'tmux_session' AS tmux_session
       FROM agents
      WHERE agent_id = $1
        AND agent_type NOT IN ('human', 'system')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
        AND status IS DISTINCT FROM 'disabled'
      LIMIT 1`,
    [agentId],
  )
  const value = result.rows[0]?.tmux_session
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveSqliteProfileSession(db: SqliteDatabase, agentId: string): string | null {
  const row = db.query<{ tmux_session: string | null }, [string]>(
    `SELECT json_extract(metadata, '$.tmux_session') AS tmux_session
       FROM agents
      WHERE agent_id = ?
        AND agent_type NOT IN ('human', 'system')
        AND COALESCE(profile_enabled, 1) = 1
        AND disabled_at IS NULL
        AND (status IS NULL OR status <> 'disabled')
      LIMIT 1`,
  ).get(agentId)
  const value = row?.tmux_session
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// ---------- tmux send-keys (wake trigger) ----------
function tmuxWake(sessionName: string): void {
  // v4 §77-2: send `check inbox` + Enter. A bare Enter does not open a new
  // LLM turn in Claude Code; the prompt must carry visible text. `check
  // inbox` is also a direct hint that aligns with the auto-next hook's
  // additionalContext wording.
  spawnSync('tmux', ['send-keys', '-t', sessionName, WAKE_PROMPT, 'Enter'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

async function wake(agentId: string, messageId: string, resolveProfileSession: SessionResolver): Promise<void> {
  if (markSeen(messageId)) {
    log('debug', `dedup skip (message_id): ${agentId}/${messageId}`)
    return
  }
  if (!shouldWake(agentId)) {
    log('debug', `dedup skip (agent_id 1s): ${agentId}/${messageId}`)
    return
  }
  const session = await resolveSession(agentId, resolveProfileSession)
  if (!session) {
    log('warn', `no active DB-profile tmux session for agent ${agentId}`)
    return
  }
  tmuxWake(session)
  log('info', `wake ${session} for ${agentId}/${messageId}`)
}

export function dispatchPgNotificationPayload(payload: string, resolveProfileSession: SessionResolver): void {
  void (async () => {
    try {
      const parsed = JSON.parse(payload) as { agent_id?: string; message_id?: string }
      if (!parsed.agent_id || !parsed.message_id) {
        log('warn', `invalid payload: ${payload}`)
        return
      }
      await wake(parsed.agent_id, parsed.message_id, resolveProfileSession)
    } catch (err) {
      log('warn', `parse/wake error: ${err}`)
    }
  })()
}

// ---------- logging ----------
function log(level: 'info' | 'warn' | 'debug', msg: string): void {
  if (level === 'debug' && !process.env.WAKE_DAEMON_DEBUG) return
  const ts = new Date().toISOString()
  process.stderr.write(`wake-daemon: [${level}] ${ts} ${msg}\n`)
}

// ---------- graceful shutdown ----------
let shuttingDown = false
type Cleanup = () => Promise<void> | void
const cleanups: Cleanup[] = []

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('info', `${signal} received, shutting down`)
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  for (const fn of cleanups) {
    if (Date.now() >= deadline) break
    try { await fn() } catch (err) { log('warn', `cleanup error: ${err}`) }
  }
  // SIGTERM/SIGINT-driven clean exit is allowed by §3.4.
  process.exit(0)
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })

// ---------- PG mode ----------
async function runPg(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    log('warn', 'DATABASE_URL not set but AGENT_COM_DB=postgres; exiting')
    process.exit(1)
  }
  let reconnectDelay = RECONNECT_MIN_MS
  while (!shuttingDown) {
    let client: PgClient | null = null
    try {
      client = new PgClient({ connectionString: dbUrl })
      await client.connect()
      await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`)
      log('info', `listening on pg channel ${PG_NOTIFY_CHANNEL}`)
      reconnectDelay = RECONNECT_MIN_MS

      const currentClient = client
      const unregister: Cleanup = async () => {
        try { await currentClient.query(`UNLISTEN ${PG_NOTIFY_CHANNEL}`) } catch {}
        try { await currentClient.end() } catch {}
      }
      cleanups.push(unregister)

      currentClient.on('notification', (msg) => {
        if (msg.channel !== PG_NOTIFY_CHANNEL || !msg.payload) return
        dispatchPgNotificationPayload(msg.payload, (agentId) => resolvePgProfileSession(currentClient, agentId))
      })

      // Hold the loop until the client signals error/end (reconnect).
      await new Promise<void>((resolve) => {
        currentClient.once('error', (err) => {
          log('warn', `pg error: ${err}`)
          resolve()
        })
        currentClient.once('end', () => resolve())
      })

      // Drop the just-used cleanup; reconnect below creates a new one.
      const idx = cleanups.indexOf(unregister)
      if (idx !== -1) cleanups.splice(idx, 1)
    } catch (err) {
      log('warn', `pg connect failed: ${err}; retry in ${reconnectDelay}ms`)
      try { if (client) await client.end() } catch {}
    }
    if (shuttingDown) break
    await new Promise(r => setTimeout(r, reconnectDelay))
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  }
}

// ---------- SQLite mode ----------
async function runSqlite(): Promise<void> {
  const path = process.env.AGENT_COM_SQLITE_PATH ?? join(PROJECT_ROOT, 'agent-com.db')
  if (!existsSync(path)) {
    log('warn', `sqlite db not found at ${path}; exiting`)
    process.exit(1)
  }
  const db = new SqliteDatabase(path, { readonly: true })
  cleanups.push(() => { db.close() })

  // Start cursor at current tail so we don't replay historical rows on startup.
  const seed = db.query<{ max: number | null }, []>(
    'SELECT MAX(id) as max FROM message_queue',
  ).get()
  let lastId = seed?.max ?? 0
  log('info', `sqlite polling mode (interval=${SQLITE_POLL_MS}ms, start id=${lastId})`)

  const stmt = db.query<
    { id: number; agent_id: string; message_id: string | null },
    [number]
  >('SELECT id, agent_id, message_id FROM message_queue WHERE id > ? ORDER BY id LIMIT 100')

  while (!shuttingDown) {
    try {
      const rows = stmt.all(lastId)
      for (const row of rows) {
        if (row.message_id) await wake(row.agent_id, row.message_id, (agentId) => resolveSqliteProfileSession(db, agentId))
        lastId = row.id
      }
    } catch (err) {
      log('warn', `sqlite poll error: ${err}`)
    }
    await new Promise(r => setTimeout(r, SQLITE_POLL_MS))
  }
}

// ---------- entry ----------
async function main(): Promise<void> {
  log('info', `starting wake-daemon (db=${DB_TYPE}, pid=${process.pid})`)
  if (DB_TYPE === 'postgres') {
    await runPg()
  } else {
    await runSqlite()
  }
}

if (import.meta.main) {
  main().catch((err) => {
    log('warn', `fatal: ${err}`)
    // Non-zero exit on fatal init error is acceptable (§1.4 allows process
    // exit only on SIGINT/SIGTERM OR init-time throw); restart is orchestrator's job.
    process.exit(1)
  })
}
