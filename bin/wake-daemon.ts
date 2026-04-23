#!/usr/bin/env bun
/**
 * PR #0 — wake-on-insert daemon (spec v3 Phase C Gap 1 fix).
 *
 * Single responsibility: detect `message_queue` INSERT (PG NOTIFY or SQLite
 * polling fallback), resolve the target bot's tmux session from
 * `scripts/bot-registry.txt`, and send Enter to wake the Claude Code REPL so
 * the bot picks up its queue via the `auto-next` hook.
 *
 * Scope (frozen §1.1 / §1.2):
 *   - DB LISTEN `mq_enqueued` (PG) or `message_queue` polling (SQLite)
 *   - tmux send-keys to `discord-<agent_id>` or `discord-<agent_id>-runbot`
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
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DB_TYPE = process.env.AGENT_COM_DB || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')
const PG_NOTIFY_CHANNEL = 'mq_enqueued'
const DEDUP_WINDOW = 512
const SQLITE_POLL_MS = 500
const RECONNECT_MIN_MS = 100
const RECONNECT_MAX_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 30_000

const PROJECT_ROOT = dirname(dirname(new URL(import.meta.url).pathname))
const BOT_REGISTRY = join(PROJECT_ROOT, 'scripts', 'bot-registry.txt')

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
}

// ---------- tmux session resolution ----------
function resolveSessionFromRegistry(agentId: string): string | null {
  if (!existsSync(BOT_REGISTRY)) return null
  const lines = readFileSync(BOT_REGISTRY, 'utf-8').split('\n')
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue
    const cols = line.split('|')
    if (cols.length < 3) continue
    if (cols[2] === agentId) return cols[0]
  }
  return null
}

function sessionExists(sessionName: string): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  return result.status === 0
}

function resolveSession(agentId: string): string | null {
  const registryHit = resolveSessionFromRegistry(agentId)
  const candidates: string[] = []
  if (registryHit) candidates.push(registryHit, `${registryHit}-runbot`)
  candidates.push(`discord-${agentId}`, `discord-${agentId}-runbot`)
  for (const name of candidates) {
    if (sessionExists(name)) return name
  }
  return null
}

// ---------- tmux send-keys (wake trigger) ----------
function tmuxWake(sessionName: string): void {
  // Send empty literal + Enter — harmless REPL re-render, triggers Claude
  // to observe the event loop (auto-next hook re-fires on SessionStart /
  // UserPromptSubmit depending on settings.json registration).
  spawnSync('tmux', ['send-keys', '-t', sessionName, '', 'Enter'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

function wake(agentId: string, messageId: string): void {
  if (markSeen(messageId)) {
    log('debug', `dedup skip: ${agentId}/${messageId}`)
    return
  }
  const session = resolveSession(agentId)
  if (!session) {
    log('warn', `no tmux session for agent ${agentId}`)
    return
  }
  tmuxWake(session)
  log('info', `wake ${session} for ${agentId}/${messageId}`)
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
        try {
          const parsed = JSON.parse(msg.payload) as { agent_id?: string; message_id?: string }
          if (!parsed.agent_id || !parsed.message_id) {
            log('warn', `invalid payload: ${msg.payload}`)
            return
          }
          wake(parsed.agent_id, parsed.message_id)
        } catch (err) {
          log('warn', `parse error: ${err}`)
        }
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
        if (row.message_id) wake(row.agent_id, row.message_id)
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
