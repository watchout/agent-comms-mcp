#!/usr/bin/env bun
/**
 * Agent Communications MCP Plugin
 *
 * Bot-to-bot messaging for Claude Code sessions.
 * Platform-friendly design: respects rate limits, prevents spam,
 * and follows best practices for Discord, Telegram, Slack, and LINE.
 *
 * All configuration lives in config.json (see config.example.json).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { Client } from 'pg'
import { createDbAdapter, type DbAdapter as NewDbAdapter, toLegacy } from './core/db'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { execSync } from 'node:child_process'
import { DiscordAdapter } from './adapters/discord'
import {
  discord,
  discordClients,
  refreshAgentCache,
  resolveDiscordToken,
  connectBotDiscord,
  getDiscordClient,
  setDbGetter as setDiscordClientDbGetter,
} from './adapters/discord-client'
import {
  PollingDriver,
  pollingDriver,
  startOutboundConsumer,
  stopOutboundConsumer,
  setDbGetter as setOutboundConsumerDbGetter,
  type BufferedQueueRow,
} from './adapters/outbound-consumer'
import {
  startListener,
  stopListener,
  handleInboundMessage,
  sendHumanWarning,
  setInboundReceiverDeps,
  type InboundRouteResult,
} from './adapters/inbound-receiver'
// PR-A: pure routing functions extracted to core/ so the future receiver
// (PR-B) and this server share a single implementation. Behavioural
// contract is unchanged — see ADR-041 implementation step 1/2.
import {
  routeInbound,
  parseMentions,
  buildSendMentions,
  isEmergencyMessage,
  type AgentInfo,
  type ChannelInfo,
  type RouteResult,
} from './core/route-message'
import {
  checkBotHealth as checkBotHealthCore,
  type BotHealthResult,
} from './core/bot-health'
import {
  buildNotMentionedErrorMsg,
  validateMentionOrError,
  buildReplyContextSuffix,
} from './core/send-errors'
import { isDuplicateNonceError } from './core/outbound-delivery'
import { applyMentionsAutoFill } from './core/agent-cache'
import {
  getMessageById,
  isHumanAgent,
  resolveAgentFromDiscordId,
  resolveInboundChannel,
  loadAgentInfo,
  resolveSendDestination,
  getAgentDiscordId,
  type DbAdapter,
} from './core/route-message-db'
import { splitMessage } from './core/message-split'
import {
  fetchNewMessages as fetchNewMessagesCore,
  type InboxCursor,
} from './core/inbox-cursor'
import { fetchReplyChain, parseReplyChainDepth } from './core/reply-chain'
import { notifySenderAndObserve } from './core/sender-feedback-emit'
import { isQueueContentDup } from './core/queue-dedup'
import { startQueueTtlSweeper } from './core/queue-ttl'
import { createMessageBus, type MessageBus } from './core/message-bus'
import { truncateForDiscord } from './core/truncate'

// --- Load Config ---
interface ForwardingConfig {
  discord: { webhook_url: string | null }
  telegram: { bot_token: string | null; chat_id: string | null }
  slack: { webhook_url: string | null }
  line: { channel_token: string | null; user_id: string | null }
}

interface AuthConfig {
  mode: 'off' | 'warn' | 'enforce'
  secret_file: string
  replay_window_seconds: number
}

interface AgentRegistration {
  display_name: string
  agent_type: string
  runtime: string
  metadata?: Record<string, unknown>
}

interface Config {
  agent_id: string
  database_url: string
  channels: Record<string, { retention_days: number | null; description?: string }>
  rate_limit: { max_per_minute: number }
  loop_detection: { max_depth: number; max_count: number; window_seconds: number }
  auth: AuthConfig
  agent: AgentRegistration
  forwarding: ForwardingConfig
}

function loadConfig(): Config {
  const configPath = process.env.AGENT_COMMS_CONFIG
    ?? join(dirname(new URL(import.meta.url).pathname), 'config.json')

  let raw: any = {}
  if (existsSync(configPath)) {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'))
  } else {
    process.stderr.write(`agent-comms: config.json not found — using env vars only (OSS mode)\n`)
  }
  return {
    agent_id: process.env.AGENT_ID ?? raw.agent_id ?? 'unknown',
    database_url: process.env.DATABASE_URL ?? raw.database_url ?? 'postgresql://localhost/agent_comms',
    channels: raw.channels ?? {},
    rate_limit: { max_per_minute: raw.rate_limit?.max_per_minute ?? 30 },
    loop_detection: {
      max_depth: raw.loop_detection?.max_depth ?? 10,
      max_count: raw.loop_detection?.max_count ?? 20,
      window_seconds: raw.loop_detection?.window_seconds ?? 300,
    },
    auth: {
      mode: raw.auth?.mode ?? 'off',
      secret_file: raw.auth?.secret_file ?? join(homedir(), '.agent-com', 'secret'),
      replay_window_seconds: raw.auth?.replay_window_seconds ?? 300,
    },
    agent: {
      display_name: raw.agent?.display_name ?? raw.agent_id ?? process.env.AGENT_ID ?? 'unknown',
      agent_type: raw.agent?.agent_type ?? 'dev',
      runtime: raw.agent?.runtime ?? 'claude-code',
      metadata: raw.agent?.metadata ?? undefined,
    },
    forwarding: {
      discord: { webhook_url: process.env.DISCORD_WEBHOOK_URL ?? raw.forwarding?.discord?.webhook_url ?? null },
      telegram: {
        bot_token: process.env.TELEGRAM_BOT_TOKEN ?? raw.forwarding?.telegram?.bot_token ?? null,
        chat_id: process.env.TELEGRAM_CHAT_ID ?? raw.forwarding?.telegram?.chat_id ?? null,
      },
      slack: { webhook_url: process.env.SLACK_WEBHOOK_URL ?? raw.forwarding?.slack?.webhook_url ?? null },
      line: {
        channel_token: process.env.LINE_CHANNEL_TOKEN ?? raw.forwarding?.line?.channel_token ?? null,
        user_id: process.env.LINE_USER_ID ?? raw.forwarding?.line?.user_id ?? null,
      },
    },
  }
}

const config = loadConfig()
const AGENT_ID = config.agent_id
const STATE_DIR = process.env.AGENT_COMMS_STATE_DIR ?? join(homedir(), '.agent-com')
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '8789', 10)

// Kill orphan process on WEBHOOK_PORT (zombie survival prevention)
try {
  const orphanPid = execSync(`lsof -ti :${WEBHOOK_PORT}`, { encoding: 'utf-8' }).trim()
  if (orphanPid && orphanPid !== String(process.pid)) {
    process.stderr.write(`agent-comms: killing orphan process ${orphanPid} on port ${WEBHOOK_PORT}\n`)
    process.kill(parseInt(orphanPid), 'SIGKILL')
  }
} catch {} // no process on port — expected

const DISCORD_OUTBOUND_PORT = parseInt(process.env.DISCORD_OUTBOUND_PORT ?? String(WEBHOOK_PORT + 1000), 10)
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || ''
const REPLY_CHAIN_DEPTH = parseReplyChainDepth(process.env.AGENT_COM_REPLY_CHAIN_DEPTH)
const LOOP_WINDOW_MS = config.loop_detection.window_seconds * 1000

// --- SSE Transport (Phase 3 → Phase C I5: unified, TRANSPORT_MODE removed) ---
const SSE_PORT = parseInt(process.env.AGENT_COMMS_PORT ?? '8800', 10)
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? ''
const AUTH_SKIP_LOCALHOST = (process.env.AUTH_SKIP_LOCALHOST ?? 'true') === 'true'
const EXPECTED_BOTS = process.env.EXPECTED_BOTS ? process.env.EXPECTED_BOTS.split(',').map(b => b.trim()) : []

// PR-B.2 mixed-mode receiver pipeline canary set.
// Bots in this set get an ADDITIONAL pg_notify('agent_inbox') fanout from
// handleInboundMessage. Phase 4 (Issue #130) removed pushToChannelServer;
// delivery is now fully via message_queue + outbound_queue.
// PR-B.2 starts with auditor only; expand in PR-B.3+ after 24-48h passive observation.
// Override at runtime via env: RECEIVER_PIPELINE_BOTS=auditor,arc (comma-separated).
const RECEIVER_PIPELINE_BOTS = new Set<string>(
  (process.env.RECEIVER_PIPELINE_BOTS ?? 'auditor').split(',').map(b => b.trim()).filter(Boolean)
)

const sseStartTime = Date.now()

// --- pg_notify helper (I2: conditional notify for SQLite/PG unification) ---
// When AGENT_COM_PG_NOTIFY=false, all pg_notify calls are suppressed so
// SQLite mode works with polling only. PG mode keeps pg_notify as acceleration.
async function pgNotify(client: Client | null, channel: string, payload: string): Promise<void> {
  if (!client || process.env.AGENT_COM_PG_NOTIFY === 'false') return
  try {
    await client.query(`SELECT pg_notify($1, $2)`, [channel, payload])
  } catch (err) {
    process.stderr.write(`agent-comms: pg_notify failed (non-fatal): ${err}\n`)
  }
}

// --- Discord Adapter (Phase 5, FEAT-005: extracted to adapters/discord-client.ts) ---
// `discord`, `discordClients`, refreshAgentCache, resolveDiscordToken,
// connectBotDiscord, getDiscordClient are imported from
// adapters/discord-client.ts. DB accessor is wired below once
// tryGetDb() is defined.
const STAGGERED_CONNECT_DELAY_MS = 5_000

const INBOX_SIGNAL_TTL_MS = 5 * 60 * 1000
const GC_INTERVAL_MS = 5 * 60 * 1000

// ============================================================
// Platform-Friendly Safety Layer
// ============================================================

// Per-platform message length limits
const PLATFORM_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
  slack: 40000,
  line: 5000,
}

// Burst control: min interval between sends (ms)
const BURST_MIN_INTERVAL_MS = 500
let lastSendTime = 0

// Duplicate detection: hash of recent messages
const recentHashes = new Map<string, number>()  // hash -> timestamp
const DUPLICATE_WINDOW_MS = 10_000

// Webhook backoff state per platform
const backoffState = new Map<string, { failures: number; nextRetryAt: number }>()
const BACKOFF_MAX_FAILURES = 5

// Forbidden mention patterns
const FORBIDDEN_PATTERNS = [/@everyone/gi, /@here/gi, /@channel/gi]

// Send queue for spacing out forwarded messages
const sendQueue: Array<() => Promise<void>> = []
let queueProcessing = false

function sanitizeContent(content: string): string {
  let sanitized = content
  for (const pattern of FORBIDDEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[mention removed]')
  }
  return sanitized
}

function truncateForPlatform(content: string, platform: string): string {
  const limit = PLATFORM_LIMITS[platform]
  if (!limit || content.length <= limit) return content
  return content.slice(0, limit - 20) + '\n…(truncated)'
}

async function checkDuplicate(content: string, to: string): Promise<boolean> {
  const hash = createHash('md5').update(`${to}:${content}`).digest('hex')

  const client = await tryGetDb()
  if (client) {
    // DB mode: check if hash exists within window, then insert
    const existing = await client.query(
      `SELECT hash FROM duplicate_hashes WHERE hash = $1 AND created_at > now() - interval '10 seconds'`,
      [hash]
    )
    if (existing.rows.length > 0) return true
    await client.query(
      `INSERT INTO duplicate_hashes (hash) VALUES ($1) ON CONFLICT (hash) DO UPDATE SET created_at = now()`,
      [hash]
    )
    return false
  }
  // In-memory fallback
  const now = Date.now()
  for (const [h, t] of recentHashes) {
    if (now - t > DUPLICATE_WINDOW_MS) recentHashes.delete(h)
  }
  if (recentHashes.has(hash)) return true
  recentHashes.set(hash, now)
  return false
}

function checkBurst(): boolean {
  const now = Date.now()
  if (now - lastSendTime < BURST_MIN_INTERVAL_MS) return false
  lastSendTime = now
  return true
}

function checkBackoff(platform: string): boolean {
  const state = backoffState.get(platform)
  if (!state) return true
  if (state.failures >= BACKOFF_MAX_FAILURES) return false
  if (Date.now() < state.nextRetryAt) return false
  return true
}

function recordSuccess(platform: string) {
  backoffState.delete(platform)
}

function recordFailure(platform: string) {
  const state = backoffState.get(platform) ?? { failures: 0, nextRetryAt: 0 }
  state.failures++
  state.nextRetryAt = Date.now() + Math.min(1000 * Math.pow(2, state.failures), 60_000)
  backoffState.set(platform, state)
}

async function processQueue() {
  if (queueProcessing) return
  queueProcessing = true
  while (sendQueue.length > 0) {
    const task = sendQueue.shift()!
    await task()
    await new Promise(r => setTimeout(r, BURST_MIN_INTERVAL_MS))
  }
  queueProcessing = false
}

function enqueueForward(fn: () => Promise<void>) {
  sendQueue.push(fn)
  processQueue()
}

// --- State (in-memory fallback) ---
const loopCounters = new Map<string, { count: number; since: number }>()
const rateCounts = new Map<string, { count: number; since: number }>()

// --- DB (with auto-reconnect) ---
let db: Client | null = null
let dbAvailable = false
const DB_MAX_RETRIES = 3

// Phase C: DB abstraction layer (sqlite/postgres)
// New code should use getDbAdapter(). Legacy code continues using getDb()/tryGetDb().
let dbAdapter: NewDbAdapter | null = null
const DB_TYPE = process.env.AGENT_COM_DB || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')

function getDbAdapter(): NewDbAdapter {
  if (!dbAdapter) {
    dbAdapter = createDbAdapter()
  }
  return dbAdapter
}

async function getDb(): Promise<Client> {
  if (db) {
    // Test connection health
    try {
      await db.query('SELECT 1')
      return db
    } catch {
      process.stderr.write('agent-comms: DB connection lost, reconnecting...\n')
      try { await db.end() } catch {}
      db = null
      dbAvailable = false
    }
  }

  // Retry with exponential backoff
  for (let attempt = 0; attempt < DB_MAX_RETRIES; attempt++) {
    try {
      const client = new Client({ connectionString: config.database_url })
      await client.connect()
      db = client
      dbAvailable = true
      if (attempt > 0) process.stderr.write(`agent-comms: DB reconnected after ${attempt + 1} attempts\n`)
      return client
    } catch (err) {
      if (attempt < DB_MAX_RETRIES - 1) {
        const delay = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
        process.stderr.write(`agent-comms: DB connect attempt ${attempt + 1} failed, retrying in ${delay}ms...\n`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw new Error('DB connection failed after retries')
}

async function tryGetDb(): Promise<Client | null> {
  try {
    return await getDb()
  } catch {
    dbAvailable = false
    process.stderr.write('agent-comms: DB unavailable, falling back to in-memory mode\n')
    return null
  }
}

// FEAT-005: adapter modules need a DB accessor + the process AGENT_ID.
// Injected here to avoid an import cycle with server.ts (which owns
// the `pg` Client and loads config).
setDiscordClientDbGetter(tryGetDb)
setOutboundConsumerDbGetter(tryGetDb, AGENT_ID)
// inbound-receiver wiring is deferred until later in the file where
// its dependencies (saveMessage, validateIncomingAuth, buildQuoteBlock,
// updateActiveThread, hashCode, mcp.notification, coreDbAdapter,
// processedIds) are all defined. See `setInboundReceiverDeps()` below.

// PR-A helper: build a `DbAdapter` for core/ helpers from the lazy `tryGetDb()`.
// Phase C: use new adapter when DB_TYPE != postgres (SQLite mode).
// Returns null when the DB is unavailable, matching the existing fallback semantics.
async function coreDbAdapter(): Promise<DbAdapter | null> {
  if (DB_TYPE !== 'postgres') {
    return toLegacy(getDbAdapter())
  }
  const client = await tryGetDb()
  if (!client) return null
  return {
    query: <T = any>(sql: string, params?: any[]) => client.query<T>(sql, params),
  }
}

async function saveMessage(msg: {
  channel_id: string; author_id: string; content: string
  message_type?: string; reply_to?: string
  metadata?: Record<string, unknown>; depth?: number
  // ADR-026: unified schema fields
  source?: string; thread_id?: string; direction?: string; role?: string
  session_id?: string; project?: string
}): Promise<string> {
  const id = randomUUID()
  const client = await tryGetDb()
  if (!client) {
    // DBなしモード: IDだけ返す（プラットフォーム履歴に委ねる）
    process.stderr.write(`agent-comms: DB unavailable, message not persisted (id: ${id})\n`)
    return id
  }

  // PR-B.2 §H2: extract discord_message_id from metadata for the dedup column.
  // For inbound rows where the platform is Discord, metadata['discord_message_id'] is
  // already populated by handleInboundMessage. Lifting it to a dedicated column lets
  // the partial unique index dedup mixed-mode race inserts.
  const discordMessageId = (msg.metadata as Record<string, unknown> | undefined)?.discord_message_id as string | undefined ?? null

  // Path A — outbound or no-discord-id row: plain INSERT (no dedup column).
  if (!discordMessageId) {
    await client.query(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, reply_to, metadata, depth, source, thread_id, direction, role, session_id, project)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, msg.channel_id, msg.author_id, msg.content, msg.message_type ?? 'chat',
       msg.reply_to ?? null, msg.metadata ? JSON.stringify(msg.metadata) : null, msg.depth ?? 0,
       msg.source ?? 'agent-comms', msg.thread_id ?? null, msg.direction ?? 'inbound',
       msg.role ?? 'agent', msg.session_id ?? null, msg.project ?? null]
    )
    return id
  }

  // Path B — inbound Discord row with discord_message_id: INSERT ON CONFLICT for §H2 dedup.
  // NOTE: ON CONFLICT must REPEAT the partial-index predicate so the planner matches
  //       uq_agent_messages_discord_id (Spike 2 finding, code 42P10 otherwise).
  const insertResult = await client.query(
    `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, reply_to, metadata, depth, source, thread_id, direction, role, session_id, project, discord_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (discord_message_id) WHERE discord_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [id, msg.channel_id, msg.author_id, msg.content, msg.message_type ?? 'chat',
     msg.reply_to ?? null, msg.metadata ? JSON.stringify(msg.metadata) : null, msg.depth ?? 0,
     msg.source ?? 'agent-comms', msg.thread_id ?? null, msg.direction ?? 'inbound',
     msg.role ?? 'agent', msg.session_id ?? null, msg.project ?? null, discordMessageId]
  )

  if (insertResult.rows.length > 0) {
    // We won the race (or there was no race) — return our generated id.
    return insertResult.rows[0].id
  }

  // Lost the race: another inbound writer already INSERTed this discord_message_id.
  // SELECT the surviving row's id so the caller can continue with downstream work
  // (metadata.to UPDATE, push, etc.) against the same row.
  const selectResult = await client.query(
    `SELECT id FROM agent_messages WHERE discord_message_id = $1`,
    [discordMessageId]
  )
  if (selectResult.rows.length > 0) {
    process.stderr.write(`agent-comms: saveMessage dedup — discord_message_id=${discordMessageId} existed, using id=${selectResult.rows[0].id}\n`)
    return selectResult.rows[0].id
  }

  // §H2 exceptional path: INSERT no-op + SELECT empty. Fall back to the generated id
  // and let the caller log / handle. In practice this should not happen because
  // ON CONFLICT only fires when a matching row exists.
  process.stderr.write(`agent-comms: saveMessage dedup ERROR — INSERT no-op but SELECT empty for discord_message_id=${discordMessageId}\n`)
  return id
}

async function fetchMessages(channel_id: string, limit: number, since?: string): Promise<any[]> {
  const client = await tryGetDb()
  if (!client) return [] // DBなしモード: 空配列（プラットフォーム履歴に委ねる）
  if (since) {
    const r = await client.query(
      `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
       FROM agent_messages WHERE channel_id = $1 AND created_at > $2 ORDER BY created_at ASC LIMIT $3`,
      [channel_id, since, limit])
    return r.rows
  }
  const r = await client.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
     FROM agent_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [channel_id, limit])
  return r.rows.reverse()
}

// Cursor-based read tracking for the `inbox` MCP tool (SSOT
// docs/agent-com-message-queue-spec.md §4.8.1). Composite
// (created_at, id) cursor — see core/inbox-cursor.ts docstring for
// the rationale (Issue #179: UUID-lex cursor dropped new rows whose
// v4 UUID sorted before the stored max). Precision is µs: the SELECT
// returns `created_at::text AS created_at_text` so the cursor value
// preserves µs (PG timestamptz) and the next WHERE compares µs-precisely.
// The id UUID tiebreaker covers µs-tied bursts.
let inboxCursor: InboxCursor | null = null

async function fetchNewMessages(forAgent: string, limit: number): Promise<any[]> {
  const client = await tryGetDb()
  if (!client) return [] // DBなしモード: 空配列
  const { rows, nextCursor } = await fetchNewMessagesCore(
    forAgent,
    limit,
    inboxCursor,
    { query: (sql, params) => client.query(sql, params) as any },
  )
  inboxCursor = nextCursor
  return rows
}

// --- Rate Limiting (DB-persistent with in-memory fallback) ---
async function checkRateLimit(agentId: string): Promise<{ allowed: boolean; remaining: number }> {
  const client = await tryGetDb()
  if (client) {
    // DB mode: UPSERT into rate_limits, truncated to 1-minute window
    const windowStart = new Date()
    windowStart.setSeconds(0, 0) // truncate to minute
    const r = await client.query(
      `INSERT INTO rate_limits (agent_id, window_start, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (agent_id, window_start) DO UPDATE SET message_count = rate_limits.message_count + 1
       RETURNING message_count`,
      [agentId, windowStart.toISOString()]
    )
    const count = r.rows[0].message_count
    const remaining = Math.max(0, config.rate_limit.max_per_minute - count)
    return { allowed: count <= config.rate_limit.max_per_minute, remaining }
  }
  // In-memory fallback
  const now = Date.now()
  const r = rateCounts.get(agentId) ?? { count: 0, since: now }
  if (now - r.since > 60_000) { r.count = 0; r.since = now }
  r.count++
  rateCounts.set(agentId, r)
  const remaining = Math.max(0, config.rate_limit.max_per_minute - r.count)
  return { allowed: r.count <= config.rate_limit.max_per_minute, remaining }
}

// --- Loop Detection (DB-persistent with in-memory fallback) ---
async function checkLoop(from: string, to: string, depth: number): Promise<{ blocked: boolean; reason?: string }> {
  if (depth > config.loop_detection.max_depth) {
    return { blocked: true, reason: `depth ${depth} > ${config.loop_detection.max_depth}` }
  }
  const key = [from, to].sort().join(':')

  const client = await tryGetDb()
  if (client) {
    // DB mode: UPSERT into loop_counters with window
    const windowStart = new Date()
    const windowMs = config.loop_detection.window_seconds * 1000
    windowStart.setTime(Math.floor(windowStart.getTime() / windowMs) * windowMs)
    const r = await client.query(
      `INSERT INTO loop_counters (agent_pair, window_start, exchange_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (agent_pair, window_start) DO UPDATE SET exchange_count = loop_counters.exchange_count + 1
       RETURNING exchange_count`,
      [key, windowStart.toISOString()]
    )
    const count = r.rows[0].exchange_count
    if (count > config.loop_detection.max_count) {
      return { blocked: true, reason: `${count} exchanges in ${config.loop_detection.window_seconds}s` }
    }
    return { blocked: false }
  }
  // In-memory fallback
  const now = Date.now()
  const c = loopCounters.get(key) ?? { count: 0, since: now }
  if (now - c.since > LOOP_WINDOW_MS) { c.count = 0; c.since = now }
  c.count++
  loopCounters.set(key, c)
  if (c.count > config.loop_detection.max_count) {
    return { blocked: true, reason: `${c.count} exchanges in ${config.loop_detection.window_seconds}s` }
  }
  return { blocked: false }
}

// --- HMAC Auth (§13) ---
function loadSecret(): string | null {
  // Environment variable takes precedence
  const envSecret = process.env.AGENT_COMMS_SECRET
  if (envSecret) return envSecret
  // Then secret file
  try {
    const secretPath = config.auth.secret_file.replace(/^~/, homedir())
    return readFileSync(secretPath, 'utf-8').trim()
  } catch {
    return null
  }
}

const authSecret = loadSecret()

function generateSignature(agentId: string, timestamp: number, channel: string, contentHash: string): string {
  if (!authSecret) return ''
  const payload = `${agentId}:${timestamp}:${channel}:${contentHash}`
  return createHmac('sha256', authSecret).update(payload).digest('hex')
}

function verifySignature(agentId: string, timestamp: number, channel: string, contentHash: string, signature: string): boolean {
  if (!authSecret) return false
  // Check replay window
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > config.auth.replay_window_seconds) return false
  const expected = generateSignature(agentId, timestamp, channel, contentHash)
  return expected === signature
}

function createAuthMetadata(channel: string, content: string): Record<string, unknown> | undefined {
  if (config.auth.mode === 'off' || !authSecret) return undefined
  const timestamp = Math.floor(Date.now() / 1000)
  const contentHash = createHash('sha256').update(content).digest('hex')
  const signature = generateSignature(AGENT_ID, timestamp, channel, contentHash)
  return { auth: { signature, timestamp } }
}

function validateIncomingAuth(metadata: Record<string, any> | null, authorId: string, channel: string, content: string): { valid: boolean; tag?: string } {
  if (config.auth.mode === 'off') return { valid: true }
  if (!metadata?.auth) {
    if (config.auth.mode === 'enforce') return { valid: false, tag: '[UNVERIFIED]' }
    return { valid: true, tag: '[UNVERIFIED]' }
  }
  const { signature, timestamp } = metadata.auth
  const contentHash = createHash('sha256').update(content).digest('hex')
  const ok = verifySignature(authorId, timestamp, channel, contentHash, signature)
  if (!ok) {
    if (config.auth.mode === 'enforce') return { valid: false, tag: '[UNVERIFIED]' }
    return { valid: true, tag: '[UNVERIFIED]' }
  }
  return { valid: true }
}

// --- Agent Registration (§12) ---
let heartbeatInterval: ReturnType<typeof setInterval> | null = null

async function registerAgent(): Promise<void> {
  const client = await tryGetDb()
  if (!client) return

  // Check for duplicate online agent
  const existing = await client.query(
    `SELECT status, last_seen_at FROM agents WHERE agent_id = $1`,
    [AGENT_ID]
  )
  if (existing.rows.length > 0 && existing.rows[0].status === 'online') {
    process.stderr.write(`agent-comms: WARNING — agent '${AGENT_ID}' is already online (last seen: ${existing.rows[0].last_seen_at})\n`)
  }

  // UPSERT — merge metadata instead of overwriting so DB-only keys
  // (e.g. discord_id self-registered by D1) survive process restarts.
  // jsonb || does a shallow merge: $5's keys override existing ones, but
  // existing keys not in $5 are preserved. This is what protects discord_id
  // when a bot's local config does not include it.
  await client.query(
    `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at, metadata)
     VALUES ($1, $2, $3, $4, 'online', now(), COALESCE($5::jsonb, '{}'::jsonb))
     ON CONFLICT (agent_id) DO UPDATE SET
       display_name = $2, agent_type = $3, runtime = $4,
       status = 'online', last_seen_at = now(),
       metadata = COALESCE(agents.metadata, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb)`,
    [AGENT_ID, config.agent.display_name, config.agent.agent_type, config.agent.runtime,
     config.agent.metadata ? JSON.stringify(config.agent.metadata) : null]
  )
  process.stderr.write(`agent-comms: agent '${AGENT_ID}' registered as online\n`)

  // pg_notify: agent.online + audit_log
  await pgNotify(client, 'agent_events', JSON.stringify({ event: 'agent.online', agent_id: AGENT_ID, org_id: 'default' }))
  await writeAuditLog('agent.online', AGENT_ID, AGENT_ID, { runtime: config.agent.runtime })

  // Heartbeat every 5 minutes
  heartbeatInterval = setInterval(async () => {
    const c = await tryGetDb()
    if (c) {
      await c.query(`UPDATE agents SET last_seen_at = now() WHERE agent_id = $1`, [AGENT_ID]).catch(() => {})
    }
  }, 5 * 60 * 1000)

  // FEAT-005 CP-5: outbound consumer bootstrap moved out.
  // Only entrypoints/daemon.ts starts the consumer — one process,
  // one consumer loop, never 19 parallel (see docs/plans/
  // outbound-forwarder-unification.md v5 §3.2). stdio / MCP-plugin
  // processes registering an agent do not need to drain the queue.

  // v1.0.2 §6.5: start the PollingDriver so pending messages are pre-fetched
  // into a buffer. The MCP `next` tool returns from the buffer instantly
  // instead of hitting the DB on every call.
  // spec §13.5.1: also emit a standard MCP notification so LLM clients
  // can trigger `next` immediately instead of waiting for the poll loop.
  // Count-only — message body is still pulled via `next` (spec §4.1).
  pollingDriver.start(AGENT_ID, {
    notifyPending: (waiting) => mcp.notification({
      method: 'notifications/message/pending',
      params: { waiting },
    }),
  })

  // NOTE: outbound consumer bootstrap is NOT here. It would race the
  // Discord adapter: registerAgent() returns before discord.connect()
  // resolves and before `discordClients.set(AGENT_ID, discord)` runs,
  // so the first consumer tick (1s later) would find an empty map and
  // flip every claimed row to `status='failed'` with
  // `last_error='no_discord_client_for_agent'` (outbound-consumer.ts
  // §3.6 fallback-removed branch). The consumer is instead started
  // inside postConnect() (below) after the client is registered.
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.0.2 §6.5 — PollingDriver (MCP server built-in)
// ─────────────────────────────────────────────────────────────────────────────
//
// Pre-fetches pending message_queue rows into an in-memory buffer on a
// configurable interval (AGENT_COM_POLL_INTERVAL_MS, default 3000ms).
// The MCP `next` tool returns from the buffer instantly instead of running
// a transactional DB query on every call. If the buffer is empty at `next`
// time, falls back to a direct DB query (same as the Phase 4 implementation).
//
// Also sends heartbeat (agents.last_seen_at UPDATE) every 30 seconds so the
// watchdog and polling-driver clients know the bot is alive.
//
// Lifecycle:
//   - pollingDriver.start(agentId) is called from registerAgent()
//   - pollingDriver.stop() is called from unregisterAgent()

// FEAT-005: PollingDriver + outbound consumer extracted to adapters/outbound-consumer.ts

async function unregisterAgent(): Promise<void> {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  pollingDriver.stop()
  stopOutboundConsumer()
  const client = await tryGetDb()
  if (client) {
    await client.query(`UPDATE agents SET status = 'offline' WHERE agent_id = $1`, [AGENT_ID]).catch(() => {})
    // pg_notify: agent.offline + audit_log
    await pgNotify(client, 'agent_events', JSON.stringify({ event: 'agent.offline', agent_id: AGENT_ID, org_id: 'default' }))
    await writeAuditLog('agent.offline', AGENT_ID, AGENT_ID, {})
  }
}

async function listAgents(status?: string, agentType?: string): Promise<any[]> {
  const client = await tryGetDb()
  if (!client) return []
  let query = 'SELECT agent_id, display_name, agent_type, runtime, status, last_seen_at, registered_at, metadata FROM agents WHERE 1=1'
  const params: any[] = []
  if (status && status !== 'all') {
    params.push(status)
    query += ` AND status = $${params.length}`
  }
  if (agentType) {
    params.push(agentType)
    query += ` AND agent_type = $${params.length}`
  }
  query += ' ORDER BY last_seen_at DESC NULLS LAST'
  const r = await client.query(query, params)
  return r.rows
}

const processedIds = new Map<string, number>()  // id -> timestamp
// FEAT-005: polling + pg_notify listener extracted to adapters/inbound-receiver.ts

// ============================================================
// Core Router (v0.1.0 — SSOT-3/5 compliant)
// ============================================================

const CORE_CONTENT_LIMIT = 50_000

interface ResolvedDestination {
  type: 'channel' | 'dm' | 'thread'
  channelId: string       // core channel ID (for membership check)
  threadId?: string       // thread ID if type=thread
  members: string[]       // channel members
}

async function resolveDestination(to: string, senderId: string): Promise<ResolvedDestination | { error: string; code: string }> {
  const match = /^(channel|agent|thread):(.+)$/.exec(to)
  if (!match) return { error: `invalid destination format. Use channel:/agent:/thread:`, code: 'INVALID_DESTINATION' }
  const [, prefix, id] = match
  if (!id) return { error: `${prefix} ID required`, code: 'INVALID_DESTINATION' }

  const client = await tryGetDb()
  if (!client) return { error: 'database connection failed', code: 'DB_UNAVAILABLE' }

  if (prefix === 'channel') {
    const r = await client.query('SELECT id, members, type FROM channels WHERE id = $1', [id])
    if (r.rows.length > 0) {
      return { type: r.rows[0].type === 'dm' ? 'dm' : 'channel', channelId: id, members: r.rows[0].members ?? [] }
    }
    // Fallback: check if this Discord ID is a thread and auto-register it
    const threadInfo = await discord.fetchThreadInfo(id)
    if (threadInfo) {
      const parentR = await client.query('SELECT id, members FROM channels WHERE id = $1', [threadInfo.parentId])
      if (parentR.rows.length > 0) {
        const threadId = id // use Discord thread ID as core thread ID
        await client.query(
          `INSERT INTO threads (id, channel_id, title, status, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, 'open', $4, now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [threadId, threadInfo.parentId, threadInfo.name, senderId]
        )
        await client.query(
          `INSERT INTO thread_adapters (thread_id, platform, external_id)
           VALUES ($1, 'discord', $2)
           ON CONFLICT (thread_id, platform) DO NOTHING`,
          [threadId, id]
        )
        process.stderr.write(`agent-comms: auto-registered Discord thread ${id} (parent: ${threadInfo.parentId})\n`)
        return { type: 'thread', channelId: threadInfo.parentId, threadId, members: parentR.rows[0].members ?? [] }
      }
    }
    return { error: `channel '${id}' not found`, code: 'CHANNEL_NOT_FOUND' }
  }

  if (prefix === 'agent') {
    if (id === senderId) return { error: `cannot send DM to yourself`, code: 'SELF_SEND' }
    // Check agent exists
    const agentR = await client.query('SELECT agent_id FROM agents WHERE agent_id = $1', [id])
    if (agentR.rows.length === 0) return { error: `agent '${id}' not found`, code: 'AGENT_NOT_FOUND' }
    // Resolve DM channel (sorted pair)
    const pair = [senderId, id].sort()
    const dmId = `dm:${pair[0]}-${pair[1]}`
    const chR = await client.query('SELECT id, members FROM channels WHERE id = $1', [dmId])
    if (chR.rows.length > 0) {
      return { type: 'dm', channelId: dmId, members: chR.rows[0].members ?? [] }
    }
    // Auto-create DM channel
    const members = pair
    await client.query(
      `INSERT INTO channels (id, org_id, type, name, members, created_by, created_at, updated_at)
       VALUES ($1, 'default', 'dm', NULL, $2, $3, now(), now())`,
      [dmId, members, senderId]
    )
    return { type: 'dm', channelId: dmId, members }
  }

  if (prefix === 'thread') {
    const r = await client.query('SELECT id, channel_id FROM threads WHERE id = $1', [id])
    if (r.rows.length === 0) return { error: `thread '${id}' not found`, code: 'THREAD_NOT_FOUND' }
    const parentChannelId = r.rows[0].channel_id
    const chR = await client.query('SELECT members FROM channels WHERE id = $1', [parentChannelId])
    if (chR.rows.length === 0) return { error: `parent channel '${parentChannelId}' not found`, code: 'CHANNEL_NOT_FOUND' }
    return { type: 'thread', channelId: parentChannelId, threadId: id, members: chR.rows[0].members ?? [] }
  }

  return { error: `invalid destination format. Use channel:/agent:/thread:`, code: 'INVALID_DESTINATION' }
}

// PR-A: isEmergencyMessage / isHumanAgent / resolveAgentFromDiscordId /
// resolveInboundChannel moved to core/route-message{,-db}.ts.
// extractDiscordMentions stays here because it composes those helpers
// and is a server-side concern; it now goes through coreDbAdapter().
async function extractDiscordMentions(content: string, rawDiscordUserIds?: string[]): Promise<string[]> {
  const db = await coreDbAdapter()
  const agentIds: string[] = []

  // 1. Parse <@discord_id> from content text
  const contentMentions = content.match(/<@!?(\d+)>/g)
  if (contentMentions) {
    for (const mention of contentMentions) {
      const discordId = mention.replace(/<@!?(\d+)>/, '$1')
      const agentId = await resolveAgentFromDiscordId(db, discordId)
      if (agentId) agentIds.push(agentId)
    }
  }

  // 2. Include raw Discord mention user IDs, but ONLY those that also appear
  //    as <@...> in content. Discord.js's msg.mentions.users includes the
  //    reply target (auto-mention) even when the author did not type the
  //    mention in the body; accepting those verbatim caused cross-bot push
  //    pollution (bug 1895/1896: CEO's `<@agent-com-dev> テスト` reply to
  //    a lead-ama message was routed to lead-ama as well because lead-ama's
  //    Discord user ID rode in via msg.mentions.users). Restricting to IDs
  //    present in the content text excludes the auto-mention while still
  //    letting this block act as a fallback resolver for IDs the content
  //    regex already matched.
  if (rawDiscordUserIds) {
    const contentIdSet = new Set<string>(
      (content.match(/<@!?(\d+)>/g) ?? []).map(m => m.replace(/<@!?(\d+)>/, '$1')),
    )
    for (const discordId of rawDiscordUserIds) {
      if (!contentIdSet.has(discordId)) continue
      const agentId = await resolveAgentFromDiscordId(db, discordId)
      if (agentId) agentIds.push(agentId)
    }
  }

  // 3. Parse @agent_id style mentions (agent-comms native format)
  const nativeMentions = parseMentions(content)
  return [...new Set([...agentIds, ...nativeMentions])]
}

/** Check if agent has observer_mode enabled (server-only helper, kept here for now) */
async function isObserverMode(agentId: string): Promise<boolean> {
  const client = await tryGetDb()
  if (!client) return false
  const r = await client.query("SELECT observer_mode FROM agents WHERE agent_id = $1", [agentId])
  return r.rows.length > 0 && r.rows[0].observer_mode === true
}

// PR-A: getMessageById / isHumanAgent / resolveSendDestination moved to
// core/route-message-db.ts. Call sites in this file go through `coreDbAdapter()`.

/** Build a quote block from a referenced message (§3.10, max 500 chars) */
async function buildQuoteBlock(messageId: string): Promise<{ quote: string; authorId: string } | null> {
  const client = await tryGetDb()
  if (!client) return null
  const r = await client.query(
    'SELECT author_id, content, created_at FROM agent_messages WHERE id = $1',
    [messageId]
  )
  if (r.rows.length === 0) return null
  const row = r.rows[0]
  const truncated = row.content.length > 500 ? row.content.slice(0, 497) + '...' : row.content
  const ts = new Date(row.created_at).toISOString()
  const quote = `> [${row.author_id} at ${ts}]\n> ${truncated.replace(/\n/g, '\n> ')}\n\n`
  return { quote, authorId: row.author_id }
}

// PR-A: parseMentions / routeInbound / AgentInfo / ChannelInfo / RouteResult
// moved to core/route-message.ts. They are imported at the top of this file.
// resolveDeliveryTargets() was deleted earlier — all push paths now go
// through the single pure routeInbound() in core/route-message.ts.

// FEAT-005: handleInboundMessage + sendHumanWarning extracted to adapters/inbound-receiver.ts

/** Simple string hash for advisory lock keys */
function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0  // Convert to 32bit integer
  }
  return hash
}

async function getNextSequence(channelId: string): Promise<number> {
  const client = await tryGetDb()
  if (!client) return 0
  const r = await client.query(
    'SELECT COALESCE(MAX(sequence), 0) + 1 as next FROM agent_messages WHERE channel_id = $1',
    [channelId]
  )
  return r.rows[0].next
}

async function updateActiveThread(agentId: string, threadId: string | null): Promise<void> {
  const client = await tryGetDb()
  if (!client) return
  await client.query('UPDATE agents SET active_thread = $1 WHERE agent_id = $2', [threadId, agentId])
}

async function getActiveThread(agentId: string): Promise<string | null> {
  const client = await tryGetDb()
  if (!client) return null
  const r = await client.query('SELECT active_thread FROM agents WHERE agent_id = $1', [agentId])
  return r.rows.length > 0 ? r.rows[0].active_thread : null
}

async function writeAuditLog(eventType: string, agentId: string | null, target: string | null, detail: Record<string, unknown>): Promise<void> {
  const client = await tryGetDb()
  if (!client) return
  await client.query(
    'INSERT INTO audit_log (event_type, agent_id, target, detail, org_id) VALUES ($1, $2, $3, $4, $5)',
    [eventType, agentId, target, JSON.stringify(detail), 'default']
  ).catch(err => process.stderr.write(`agent-comms: audit_log write failed: ${err}\n`))
}

// --- Access Control (§4.1 - Communication Bus Layer) ---
// Issue #130 Phase 4: sendInboxSignal (filesystem .signal files) was removed.
// Delivery to recipient bots is now fully queue-based (message_queue table,
// Phase 2). The old .signal directory at STATE_DIR/inbox/{agent}/ is no
// longer written to; cleanup of existing files is left to the operator.

// Issue #130 Phase 4: pushToChannelServer + pushFailureWarned +
// clearPushFailureWarning + countAndClearSignals were all removed.
// Outbound delivery now goes exclusively through outbound_queue (Phase 3).
// agents.channel_port column is soft-deprecated per spec §3.7 (not DROPped).

// ============================================================
// Forwarding (Platform-Friendly)
// ============================================================

async function forwardToDiscord(author: string, channel: string, content: string, type: string) {
  const url = config.forwarding.discord.webhook_url
  if (!url || !checkBackoff('discord')) return
  enqueueForward(async () => {
    try {
      const text = truncateForPlatform(`**[${type}]** #${channel}\n${sanitizeContent(content)}`, 'discord')
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `${author} (agent-comms)`, content: text }),
      })
      if (res.ok) recordSuccess('discord')
      else recordFailure('discord')
    } catch { recordFailure('discord') }
  })
}

async function forwardToTelegram(author: string, channel: string, content: string, type: string) {
  const { bot_token, chat_id } = config.forwarding.telegram
  if (!bot_token || !chat_id || !checkBackoff('telegram')) return
  enqueueForward(async () => {
    try {
      const text = truncateForPlatform(`🤖 *${author}* → #${channel}\n[${type}] ${sanitizeContent(content)}`, 'telegram')
      const res = await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
      })
      if (res.ok) recordSuccess('telegram')
      else recordFailure('telegram')
    } catch { recordFailure('telegram') }
  })
}

async function forwardToSlack(author: string, channel: string, content: string, type: string) {
  const url = config.forwarding.slack.webhook_url
  if (!url || !checkBackoff('slack')) return
  enqueueForward(async () => {
    try {
      const text = truncateForPlatform(`*[${type}]* #${channel} — ${author}\n${sanitizeContent(content)}`, 'slack')
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (res.ok || res.status === 200) recordSuccess('slack')
      else recordFailure('slack')
    } catch { recordFailure('slack') }
  })
}

async function forwardToLINE(author: string, channel: string, content: string, type: string) {
  const { channel_token, user_id } = config.forwarding.line
  if (!channel_token || !user_id || !checkBackoff('line')) return
  enqueueForward(async () => {
    try {
      const text = truncateForPlatform(`[${type}] #${channel}\n${author}: ${sanitizeContent(content)}`, 'line')
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${channel_token}`,
        },
        body: JSON.stringify({
          to: user_id,
          messages: [{ type: 'text', text }],
        }),
      })
      if (res.ok) recordSuccess('line')
      else recordFailure('line')
    } catch { recordFailure('line') }
  })
}

function forwardAll(author: string, channel: string, content: string, type: string) {
  forwardToDiscord(author, channel, content, type)
  forwardToTelegram(author, channel, content, type)
  forwardToSlack(author, channel, content, type)
  forwardToLINE(author, channel, content, type)
}

// --- Periodic GC ---
function gc() {
  const now = Date.now()
  const channelsDir = join(homedir(), '.claude', 'channels')
  try {
    for (const dir of readdirSync(channelsDir).filter(d => d.startsWith('agent-comms-'))) {
      const inboxDir = join(channelsDir, dir, 'inbox')
      try {
        for (const f of readdirSync(inboxDir).filter(f => f.endsWith('.signal'))) {
          try {
            if (now - statSync(join(inboxDir, f)).mtimeMs > INBOX_SIGNAL_TTL_MS) unlinkSync(join(inboxDir, f))
          } catch {}
        }
      } catch {}
    }
  } catch {}
  for (const [k, v] of loopCounters) if (now - v.since > LOOP_WINDOW_MS) loopCounters.delete(k)
  for (const [k, v] of rateCounts) if (now - v.since > 60_000) rateCounts.delete(k)
  for (const [h, t] of recentHashes) if (now - t > DUPLICATE_WINDOW_MS) recentHashes.delete(h)
}
setInterval(gc, GC_INTERVAL_MS)

// --- MCP Server ---
// Spec v5 §1.4 instructions — verbatim system-prompt addition for bots
// that connect via claude/channel. Wording is a merge gate; drift is
// caught by the test_handoff_b_communication_invariant test.
const CLAUDE_CHANNEL_INSTRUCTIONS = [
  'agent-comms channel events arrive as <channel source="agent-comms" channel_id="..." message_id="..." author_id="..." [thread_id="..."] [message_type="..."]>content</channel>.',
  '',
  'To reply: invoke mcp__agent-comms__send (use mcp__agent-comms__notify for self-originated). Pass the channel_id from the inbound tag.',
  '',
  'CRITICAL — NEVER use the built-in SendMessage tool. It routes to a different system (Claude Code teams/teammates) and your reply will NOT reach agent-comms peers.',
  '',
  'CRITICAL — NEVER reply only via stdout. Every reply MUST go through mcp__agent-comms__send (or notify). This is enforced by a Stop hook; replies without the tool call will be blocked and re-prompted.',
].join('\n')

function createMcpServer(): Server {
  return new Server(
    { name: 'agent-comms', version: '1.2.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          // Permission-relay opt-in: repliers authenticated via
          // discord-adapter's access control (allowFrom gate).
          'claude/channel/permission': {},
        },
      },
      instructions: CLAUDE_CHANNEL_INSTRUCTIONS,
    }
  )
}

const mcp = createMcpServer()

// FEAT-005: wire inbound-receiver deps at module scope. All helpers
// the receiver needs (saveMessage / validateIncomingAuth /
// buildQuoteBlock / updateActiveThread / hashCode / coreDbAdapter /
// processedIds / mcp) are defined above; both the stdio and daemon
// transport branches below rely on these being wired before any
// startListener() / handleInboundMessage() call.
// spec §13.5.1 primary — MessageBus (UnixSignalBus). Inbound commits wake
// the receiver's bot runner via SIGUSR1 instead of paying the full polling
// interval. Missing PID files fall through to polling fallback.
const messageBus: MessageBus = createMessageBus()

setInboundReceiverDeps({
  agentId: AGENT_ID,
  authMode: config.auth.mode,
  databaseUrl: config.database_url,
  receiverPipelineBots: RECEIVER_PIPELINE_BOTS,
  processedIds,
  tryGetDb,
  coreDbAdapter,
  saveMessage,
  validateIncomingAuth,
  buildQuoteBlock,
  updateActiveThread,
  hashCode,
  bus: messageBus,
  // Spec v5 §1.2 / §2.1 — claude/channel push. Thin wrapper so the
  // receiver doesn't need a direct handle on the MCP Server instance
  // (keeps the server.ts ↔ inbound-receiver dependency DAG cycle-free).
  // A `notification()` reject here is contained inside
  // `pushClaudeChannelAndPromote` and triggers the wake-daemon fallback
  // path instead of propagating up the listener.
  mcpPush: async (params) => {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params,
    })
  },
})

// --- Tool Registration (extracted for Per-Bot Server Factory) ---
function registerTools(server: Server, agentId: string) {

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Issue #118 PR-B ②: inject current agent_id list into description via cache
  const knownAgents = await refreshAgentCache()
  const agentListStr = knownAgents.length > 0 ? ` Known agents: [${knownAgents.join(', ')}].` : ''
  return { tools: [
    {
      // Issue #130 Phase 4: MCP next tool (message-queue-spec §4.1).
      // Pops the oldest pending message_queue row for the calling agent.
      // Used by bots to receive messages via the MCP tool interface instead
      // of polling the CLI. The internal flow mirrors cli/index.ts nextMessage.
      name: 'next',
      description: 'Pop the next pending message from the queue. Returns the message content, channel, and sender info. Call send to reply.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'send',
      description: `Send a message. Destination is determined by reply_to (original message location). You cannot choose the destination. To reply to a message, set reply_to to the original message UUID. mentions must contain agent_id strings (e.g. "ceo", "cto"), NOT Discord snowflake IDs.${agentListStr}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Message content (max 50,000 chars)' },
          mentions: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to push-notify. Required (empty array is rejected).' },
          reply_to: { type: 'string', description: 'Reply-to message UUID. Required. Determines send destination.' },
          message_type: { type: 'string', enum: ['instruction', 'report', 'approval', 'chat', 'emergency'], description: 'Default: chat' },
          metadata: { type: 'object', description: 'Custom metadata (JSONB)' },
        },
        required: ['content', 'mentions', 'reply_to'],
      },
    },
    {
      // spec §4.3 — self-originated post (watchdog / startup / periodic reports).
      // reply_to is intentionally absent: notify does not mark any
      // message_queue row 'replied' and does not touch agents.current_message_id.
      name: 'notify',
      description: `Post a self-originated message to a channel without replying to anything. Use for watchdog alerts, startup notifications, and periodic reports. mentions must contain agent_id strings.${agentListStr}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel id (or name) to post into. Required.' },
          thread_id: { type: 'string', description: 'Optional thread id to post into (instead of the parent channel).' },
          content: { type: 'string', description: 'Message content (max 50,000 chars)' },
          mentions: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to push-notify. Required (empty array is rejected).' },
          message_type: { type: 'string', enum: ['instruction', 'report', 'approval', 'chat', 'emergency'], description: 'Default: chat' },
          metadata: { type: 'object', description: 'Custom metadata (JSONB)' },
        },
        required: ['channel', 'mentions', 'content'],
      },
    },
    // focus/unfocus removed — reply_to is required (agent-com-message-queue-spec §4 routing, 旧 channel-thread-control-spec から統合)
    {
      name: 'unfocus',
      description: 'DEPRECATED — no longer needed. Destination is auto-determined.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'quote',
      description: 'Quote a message and post it to a channel with an optional comment. Automatically mentions the target agent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'UUID of the message to quote' },
          to: { type: 'string', description: 'Agent ID to mention (will be @mentioned in the post)' },
          comment: { type: 'string', description: 'Optional comment to add after the quote' },
        },
        required: ['message_id', 'to'],
      },
    },
    {
      name: 'history',
      description: 'Fetch recent messages from a channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel name' },
          limit: { type: 'number', description: 'Max messages (default: 20, max: 100)' },
          since: { type: 'string', description: 'ISO timestamp — messages after this time' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'inbox',
      description: 'Messages are automatically pushed to your session. Use this only to re-check history or filter by channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max messages (default: 20)' },
        },
      },
    },
    {
      name: 'fetch_discord_history',
      description: 'Fetch message history from a Discord channel via Discord API (not agent-comms DB). Use this to read past Discord conversations.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Discord channel or thread ID' },
          limit: { type: 'number', description: 'Max messages (default: 50, max: 100)' },
          before: { type: 'string', description: 'Fetch messages before this message ID (for pagination)' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'agents',
      description: 'List registered agents. Requires DB.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['online', 'offline', 'all'], description: 'Filter by status (default: all)' },
          agent_type: { type: 'string', description: 'Filter by agent type' },
        },
      },
    },
    {
      name: 'restart_bot',
      description: 'Restart a bot tmux session with correct Claude Code flags. Kills orphan port processes, recreates tmux session, auto-confirms TUI prompt.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session: { type: 'string', description: 'tmux session name from bot-registry.txt (e.g. discord-wbs)' },
        },
        required: ['session'],
      },
    },
    {
      name: 'bot_status',
      description: 'Show status of all registered bots (tmux session, channel plugin mode, port usage).',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'watchdog_check',
      description: 'Run health check on all registered bots. Optionally auto-restart unhealthy ones.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: { type: 'boolean', description: 'If true, report only without restarting (default: false)' },
        },
      },
    },
    {
      name: 'cleanup_ports',
      description: 'Kill orphaned processes on registered bot ports where the corresponding tmux session no longer exists.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    // ───────────────── v2.1.0 (spec §4.1, §11 failed_reason) ─────────────────
    {
      name: 'fail',
      description: 'Mark the in-flight message_queue row as failed (status=\'failed\') with an explicit reason string, and release the agent to idle. Use when the LLM could not reply (LLM_FAILED, SEND_FAILED_AFTER_N_RETRIES, LOOP_DETECTED, OBSOLETE, etc.). Matches `agent-com fail --message-id X --reason Y`.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'message_queue.message_id (agent_messages UUID). Required.' },
          reason: { type: 'string', description: 'Free-form failure reason. Use §11 標準値 (IMPLICIT_ABANDON / LLM_FAILED / SEND_FAILED_AFTER_N_RETRIES / LOOP_DETECTED) when possible.' },
        },
        required: ['message_id', 'reason'],
      },
    },
    {
      name: 'skip',
      description: 'Operator-initiated sibling of fail — marks a message_queue row `skipped` instead of `failed`. Use for manual overrides where no machine error occurred. Matches `agent-com skip --message-id X --reason Y`.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'message_queue.message_id (agent_messages UUID). Required.' },
          reason: { type: 'string', description: 'Free-form skip reason (e.g. OBSOLETE).' },
        },
        required: ['message_id', 'reason'],
      },
    },
    {
      name: 'reclaim',
      description: 'Manual orphan reclaim for a crashed bot. Rolls any status=\'read\' row whose read_at is older than 15 minutes back to pending, and clears agents.current_message_id. Safe to call even when nothing is orphaned (cleanup-only). Matches `agent-com reclaim --agent-id X`.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent whose orphan in-flight row should be reclaimed. Falls back to the caller\'s AGENT_ID.' },
        },
      },
    },
  ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  let { name, arguments: args } = request.params

  // ============================================================
  // Issue #130 Phase 4: MCP next tool (§4.1)
  // ============================================================
  if (name === 'next') {
    const client = await tryGetDb()
    if (!client) {
      return { content: [{ type: 'text', text: 'Error [DB_UNAVAILABLE]: database required for next' }], isError: true }
    }
    try {
      await client.query('BEGIN')
      // Lock agents row + implicit-skip prior current
      const prevRow = await client.query(
        `SELECT current_message_id FROM agents WHERE agent_id = $1 FOR UPDATE`,
        [agentId],
      )
      const priorId: number | null = prevRow.rows[0]?.current_message_id ?? null
      if (priorId !== null) {
        // v2.1.0: implicit abandon is now status='failed' with
        // failed_reason='IMPLICIT_ABANDON' (spec §4.1 step 1, §11 failed_reason).
        // status='skipped' is reserved for operator-initiated `agent-com skip`.
        await client.query(
          `UPDATE message_queue
              SET status = 'failed', failed_reason = 'IMPLICIT_ABANDON'
           WHERE id = $1 AND status = 'read'`,
          [priorId],
        )
      }

      // v1.0.2 §6.5: try the PollingDriver buffer first. The buffer
      // contains a read-only snapshot of pending rows from the last poll
      // tick. If a row is available, we still need to claim it
      // transactionally (UPDATE status='read') — the buffer just tells us
      // WHICH row to claim without a full SELECT ... FOR UPDATE SKIP LOCKED
      // scan. If the buffer is empty or stale, fall back to the direct query.
      const buffered = pollingDriver.shift()
      let row: { id: string | number; message_id: string | null; payload: string; priority: number; created_at: Date | string } | null = null

      if (buffered) {
        // Verify the buffered row is still pending (it may have been
        // claimed by a concurrent next or by the CLI between poll ticks).
        const verify = await client.query(
          `SELECT id, message_id, payload, priority, created_at
           FROM message_queue
           WHERE id = $1 AND status = 'pending'
           FOR UPDATE SKIP LOCKED`,
          [buffered.id],
        )
        if (verify.rows.length > 0) {
          row = verify.rows[0]
        }
        // If stale, fall through to the direct query below.
      }

      if (!row) {
        // Direct query fallback (Phase 4 original path)
        const pop = await client.query(
          `SELECT id, message_id, payload, priority, created_at
           FROM message_queue
           WHERE status = 'pending' AND agent_id = $1
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
          [agentId],
        )
        if (pop.rows.length > 0) row = pop.rows[0]
      }

      if (!row) {
        if (priorId !== null) {
          await client.query(`UPDATE agents SET current_message_id = NULL WHERE agent_id = $1`, [agentId])
        }
        await client.query('COMMIT')
        return { content: [{ type: 'text', text: JSON.stringify({ waiting: 0 }) }] }
      }

      await client.query(
        `UPDATE message_queue SET status = 'read', read_at = now() WHERE id = $1`,
        [row.id],
      )
      // spec §4.1 step 4 — mark agent busy while processing this message.
      // Combined with current_message_id UPDATE so both transitions are atomic.
      await client.query(
        `UPDATE agents SET current_message_id = $1, status = 'busy', status_detail = 'メッセージ処理中', status_updated_at = now() WHERE agent_id = $2`,
        [row.id, agentId],
      )
      await client.query('COMMIT')

      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(row.payload) } catch {}

      const waitingRow = await client.query(
        `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
        [agentId],
      )
      const waiting: number = waitingRow.rows[0]?.n ?? 0

      // §18.1 Reply Chain Context — seed is the current message (spec
      // `$current_message_id`). The CTE returns the seed row plus its
      // ancestors via reply_to, oldest-first. Non-fatal on query failure.
      const currentMessageId: string | null =
        (row.message_id as string | null) ?? (payload.message_id as string | null | undefined) ?? null
      let replyChain: Awaited<ReturnType<typeof fetchReplyChain>> = []
      if (currentMessageId) {
        try {
          replyChain = await fetchReplyChain(currentMessageId, REPLY_CHAIN_DEPTH, getDbAdapter())
        } catch (err) {
          process.stderr.write(`agent-comms: fetchReplyChain failed (non-fatal): ${err}\n`)
        }
      }

      const result = {
        waiting,
        queue_id: row.id,
        message_id: row.message_id ?? payload.message_id ?? null,
        channel_id: payload.channel_id,
        thread_id: payload.thread_id ?? null,
        from: payload.author_id,
        from_name: payload.author_name ?? null,
        content: payload.content,
        message_type: payload.message_type ?? 'chat',
        source: payload.source ?? null,
        created_at: row.created_at,
        reply_chain: replyChain,
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return { content: [{ type: 'text', text: `Error [NEXT_FAILED]: ${err}` }], isError: true }
    }
  }

  // ============================================================
  // v0.1.0 Core Tools: send, focus, unfocus
  // ============================================================

  if (name === 'send') {
    const { content, reply_to, message_type, metadata } = args as any
    // Issue #118 PR-B ③: mentions may be auto-filled below; use let
    let mentions: string[] = Array.isArray(args.mentions) ? args.mentions : (args.mentions ? [args.mentions] : [])

    // Validate content
    if (!content || content.length === 0) {
      return { content: [{ type: 'text', text: 'Error [CONTENT_EMPTY]: content must not be empty' }], isError: true }
    }
    if (content.length > CORE_CONTENT_LIMIT) {
      return { content: [{ type: 'text', text: `Error [CONTENT_TOO_LARGE]: content exceeds core limit (${CORE_CONTENT_LIMIT} chars)` }], isError: true }
    }

    // spec §4.2 step 1 — current_message_id guard, atomic. codex-auditor
    // Layer 2 BLOCKER (PR #214 cycle 2, CTO judgment msg 89216a72): the
    // non-transactional SELECT version left a window where two concurrent
    // MCP `send` calls could both pass the guard before either cleared the
    // row, producing a double Discord post. CTO 2 択 (a): wrap the entire
    // send flow in a single BEGIN/COMMIT, acquire the agents row lock via
    // `SELECT FOR UPDATE`, and clear `current_message_id` at COMMIT. This
    // matches the CLI pattern (cli/index.ts sendMessage — PR#134 ARC
    // follow-up, lead-ama msg 1492283029933133874) so a parallel caller
    // blocks on the row lock, wakes to a NULL `current_message_id`, and
    // exits with NO_CURRENT_MESSAGE instead of double-replying.
    //
    // Transaction flow:
    //   - BEGIN on the singleton client (tryGetDb → pg pool client).
    //   - `SELECT ... FOR UPDATE` holds the row lock for the duration of
    //     the handler. The captured value (`claimedMqId`) is used at step
    //     9 to mark message_queue 'replied' without a second read.
    //   - All existing side effects (agent_messages INSERT, message_queue
    //     INSERT per recipient, outbound_queue INSERT, pg_notify) run
    //     against the same client, so ROLLBACK unwinds everything.
    //   - `try { ... } finally { if (!txCommitted) ROLLBACK }` catches
    //     every early return inside the handler (validation fail, rate
    //     limit, outbound INSERT fail) without requiring each return site
    //     to duplicate the ROLLBACK boilerplate.
    const txClient = await tryGetDb()
    if (!txClient) {
      return { content: [{ type: 'text', text: 'Error [DB_UNAVAILABLE]: database required for send' }], isError: true }
    }
    let claimedMqId: number | string | null = null
    let txCommitted = false
    await txClient.query('BEGIN')
    try {
      const guardRow = await txClient.query(
        `SELECT current_message_id FROM agents WHERE agent_id = $1 FOR UPDATE`,
        [agentId],
      )
      claimedMqId = guardRow.rows[0]?.current_message_id ?? null
      if (!claimedMqId) {
        await txClient.query('ROLLBACK')
        txCommitted = true // prevent double-ROLLBACK in finally
        return { content: [{ type: 'text', text: `Error [NO_CURRENT_MESSAGE]: no in-flight message for ${agentId} — call \`next\` first` }], isError: true }
      }

    // Issue #118 PR-B ③: mentions auto-fill — if empty + reply_to, try to fill from original message author.
    // This avoids NOT_MENTIONED errors when LLM forgets mentions but reply_to context is present.
    if (mentions.length === 0 && reply_to) {
      const orig = await getMessageById(await coreDbAdapter(), reply_to)
      const autoFilled = applyMentionsAutoFill(mentions, reply_to, orig?.author_id)
      if (autoFilled) mentions = autoFilled
    }

    // Validate mentions (required, non-empty)
    // Issue #118 PR-A ①: suggestive error — include original message author + known agent IDs from cache.
    if (mentions.length === 0) {
      let authorId: string | null = null
      const knownAgents = await refreshAgentCache()
      if (reply_to) {
        const orig = await getMessageById(await coreDbAdapter(), reply_to)
        if (orig?.author_id) authorId = orig.author_id
      }
      return { content: [{ type: 'text', text: buildNotMentionedErrorMsg(authorId, knownAgents) }], isError: true }
    }

    // Self-send prevention
    if (mentions.length === 1 && mentions[0] === agentId) {
      return { content: [{ type: 'text', text: 'Error [SELF_SEND]: 自分自身には送信できません' }], isError: true }
    }

    // Resolve destination (§2.2 — bot cannot choose destination)
    const sendDest = await resolveSendDestination(await coreDbAdapter(), agentId, reply_to)
    if ('error' in sendDest) {
      await writeAuditLog('access.denied', agentId, null, { error: sendDest.error, code: sendDest.code })
      return { content: [{ type: 'text', text: `Error [${sendDest.code}]: ${sendDest.error}` }], isError: true }
    }

    // Resolve to legacy format for existing resolveDestination
    const to = sendDest.threadId ? `thread:${sendDest.threadId}` : `channel:${sendDest.channelId}`
    process.stderr.write(`agent-comms: send destination resolved — ${agentId} → ${to} (reply_to: ${reply_to ?? 'none'})\n`)

    // Resolve destination (validates members, etc.)
    const dest = await resolveDestination(to, agentId)
    if ('error' in dest) {
      await writeAuditLog('access.denied', agentId, to, { error: dest.error, code: dest.code })
      return { content: [{ type: 'text', text: `Error [${dest.code}]: ${dest.error}` }], isError: true }
    }

    // Membership validation
    if (!dest.members.includes(agentId)) {
      await writeAuditLog('access.denied', agentId, dest.channelId, { code: 'NOT_A_MEMBER' })
      return { content: [{ type: 'text', text: `Error [NOT_A_MEMBER]: access denied — not a member of channel '${dest.channelId}'` }], isError: true }
    }

    // Mentions validation: existence check + channel in/out classification (§4.3 Step 3)
    // Issue #118 PR-B: use cache instead of direct DB query (PR-A's direct query replaced here)
    const inChannelTargets: string[] = []
    const outChannelTargets: string[] = []
    const client = await tryGetDb()
    const validAgentIds = await refreshAgentCache()
    for (const mention of mentions) {
      const mentionErr = validateMentionOrError(mention, validAgentIds)
      if (mentionErr) {
        return { content: [{ type: 'text', text: mentionErr }], isError: true }
      }
      if (dest.members.includes(mention)) {
        inChannelTargets.push(mention)
      } else if (mention !== 'all' && mention !== 'dev' && mention !== 'org') {
        outChannelTargets.push(mention)
      }
    }

    // Rate limit
    const rate = await checkRateLimit(agentId)
    if (!rate.allowed) {
      await writeAuditLog('message.blocked', agentId, dest.channelId, { code: 'RATE_LIMITED', to })
      return { content: [{ type: 'text', text: `Error [RATE_LIMITED]: rate limit exceeded (${config.rate_limit.max_per_minute}/min)` }], isError: true }
    }

    // Loop detection (for agent: destinations, extract target from DM)
    const msgDepth = 0
    if (dest.type === 'dm') {
      const target = dest.members.find(m => m !== agentId) ?? ''
      const loop = await checkLoop(agentId, target, msgDepth)
      if (loop.blocked) {
        await writeAuditLog('message.blocked', agentId, dest.channelId, { code: 'LOOP_DETECTED', to, reason: loop.reason })
        return { content: [{ type: 'text', text: `Error [LOOP_DETECTED]: ${loop.reason}` }], isError: true }
      }
    }

    // Duplicate check
    if (await checkDuplicate(content, dest.channelId)) {
      await writeAuditLog('message.blocked', agentId, dest.channelId, { code: 'DUPLICATE', to })
      return { content: [{ type: 'text', text: 'Error [DUPLICATE]: same message sent within 10s, skipped' }], isError: true }
    }

    // Burst control
    if (!checkBurst()) {
      await new Promise(r => setTimeout(r, BURST_MIN_INTERVAL_MS))
    }

    // Sanitize
    const safeContent = sanitizeContent(content)

    // CEO-driven (2026-04-08 × 3): enforce platform limits server-side.
    // Split long content into multiple parts, each ≤ platform limit (Discord 1900).
    // The split function is pure and codepoint-safe; each part gets an (N/M) prefix.
    // If the content already fits, this returns [safeContent] unchanged.
    // NOTE: 'discord' is used as the split target because Discord has the tightest
    // limit among our active adapters. Parts that fit Discord also fit everywhere else.
    //
    // CEO directive 2026-04-09 (msg 1491598010574962709) + ARC Option B + lead-ama
    // delegation file ~/Developer/lead-ama/DELEGATE-splitmessage-2026-04-09.md:
    // when a split occurs, every part must carry the original Discord-native
    // mention syntax so the recipient's Discord client fires push notifications
    // on every part, not just Part 1. We resolve the agent_id mentions to
    // `<@DISCORD_ID>` strings via the existing D7 helper (PR#95 commit 56271c9)
    // and pass them to splitMessage. Unknown / unresolved agent_ids are dropped.
    const sendCoreDb = await coreDbAdapter()
    const resolvedMentionStrings = (
      await Promise.all(
        (mentions as string[]).map(async (agentId) => {
          const did = await getAgentDiscordId(sendCoreDb, agentId).catch(() => null)
          return did ? `<@${did}>` : null
        }),
      )
    ).filter((s): s is string => s !== null)
    const parts = splitMessage(safeContent, 'discord', resolvedMentionStrings)

    // Loop variables shared across parts for the response summary.
    const partIds: string[] = []
    let lastDelivery: ReturnType<typeof routeInbound> | null = null
    let dbClient = await tryGetDb()
    const senderIsBot = !(await isHumanAgent(sendCoreDb, agentId))
    const allAgentInfos: AgentInfo[] = []
    for (const member of dest.members) {
      const info = await loadAgentInfo(sendCoreDb, member)
      if (info) allAgentInfos.push(info)
    }

    for (let partIdx = 0; partIdx < parts.length; partIdx++) {
      const partContent = parts[partIdx]

      // Sequence — one per part so thread ordering is preserved.
      const sequence = await getNextSequence(dest.channelId)

      // Build metadata with auth (per-part — auth hash is content-dependent).
      const authMeta = createAuthMetadata(dest.channelId, partContent)
      // Stamp part-of-N metadata on every split piece so downstream consumers
      // can reassemble or recognise the relationship.
      const partMeta = parts.length > 1
        ? { split_part: partIdx + 1, split_total: parts.length }
        : {}
      const fullMetadata = { ...metadata, ...authMeta, ...partMeta }

      // Save to DB
      const id = await saveMessage({
        channel_id: dest.channelId, author_id: agentId, content: partContent,
        message_type: message_type ?? 'chat', reply_to,
        metadata: fullMetadata, depth: msgDepth,
        source: 'agent-comms', thread_id: dest.threadId ?? null,
        direction: 'outbound', role: 'agent',
      })
      partIds.push(id)

      // Update sequence
      if (dbClient) {
        await dbClient.query('UPDATE agent_messages SET sequence = $1 WHERE id = $2', [sequence, id]).catch(() => {})
      }

      // pg_notify (per part) — conditional via pgNotify helper (I2)
      await pgNotify(dbClient, 'agent_inbox', JSON.stringify({ event: 'message.created', to: dest.channelId, message_id: id, channel_id: dest.channelId }))

      // §5.1: Use pure routeInbound() for delivery filter (unified across all push paths)
      // Issue #103 Option A union: merge mentions arg + <@discord_id> tokens in content
      // so push routing is LLM-independent (works even when only one source is provided).
      const sendMentions = await buildSendMentions(
        mentions,
        partContent,
        (did) => resolveAgentFromDiscordId(sendCoreDb, did),
      )
      const delivery = routeInbound(
        { authorAgentId: agentId, authorIsBot: senderIsBot, content: partContent, mentions: sendMentions, messageType: message_type ?? 'chat' },
        { channelId: dest.channelId, threadId: dest.threadId, members: dest.members },
        allAgentInfos,
      )
      lastDelivery = delivery
      // Issue #130 Phase 4: the pushTargets loop now writes only to
      // message_queue (Phase 2). The legacy sendInboxSignal / pushToChannelServer /
      // SSE fallback paths have been removed — delivery to recipient bots is
      // fully queue-based. Outbound to Discord goes through outbound_queue
      // (Phase 3) below.
      const mqPayload = JSON.stringify({
        channel_id: dest.channelId,
        thread_id: dest.threadId ?? null,
        author_id: agentId,
        content: partContent,
        message_id: id,
        message_type: message_type ?? 'chat',
        source: 'agent-comms',
        ts: new Date().toISOString(),
      })
      for (const recipient of delivery.pushTargets) {
        if (dbClient) {
          try {
            // Issue #251 (a) — content-level dedup before INSERT.
            // cycle 2 (CTO `c1c6eb1d`): source is part of the dedup
            // key per Issue §1 verbatim ("hash + source/timestamp
            // window"). Same agent + same source + same content
            // within the window is the same logical message arriving
            // twice on the same path; different source for the same
            // content is a deliberately separate record and is
            // preserved.
            const dedupWindowSec = parseInt(process.env.AGENT_COMMS_DEDUP_WINDOW_SEC ?? '30', 10)
            if (await isQueueContentDup(dbClient, recipient, partContent, 'agent-comms', dedupWindowSec)) {
              process.stderr.write(`agent-comms: queue.dedup.skipped — content already queued for ${recipient} within ${dedupWindowSec}s (source=agent-comms)\n`)
              continue
            }
            const sendIns = await dbClient.query(
              `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
              [recipient, id, mqPayload],
            )
            // Codex audit (PR#140): observability — surface ON CONFLICT hits.
            if (sendIns.rowCount === 0) {
              process.stderr.write(`agent-comms: message_queue dedup — duplicate (agent_id=${recipient}, message_id=${id}) skipped by uq_mq_agent_message\n`)
            }
          } catch (err) {
            process.stderr.write(`agent-comms: message_queue INSERT failed for ${recipient} (non-fatal): ${err}\n`)
          }
        }
      }

      // Also forward via legacy forwarding config
      forwardAll(agentId, dest.channelId, partContent, message_type ?? 'chat')

      // Inter-part delay is skipped here because the outbound_queue INSERTs
      // happen in a second loop (spec §4/§8 Behavioral FAIL B2 — outbound
      // must run after `message_queue` is marked 'replied' so a retry can't
      // double-post on failure). The pacing delay now lives in the outbound
      // loop below.
    }

    // Pick a representative id for the summary response (part 1).
    const id = partIds[0]
    const delivery = lastDelivery!

    // Auto-unfocus on report
    if (message_type === 'report') {
      await updateActiveThread(agentId, null)
      process.stderr.write(`[agent-com] INFO: auto-unfocused after sending report\n`)
    }

    // Derive a single warning code from dropTargets (RouteResult uses pushTargets/dropTargets,
    // not targets/warning — the older shape was never produced by routeInbound).
    const dropReasons = Object.values(delivery.dropTargets)
    const deliveryWarning = delivery.pushTargets.length === 0
      ? (dropReasons.includes('NOT_MENTIONED') ? 'NOT_MENTIONED'
        : dropReasons.includes('THREAD_MISMATCH') ? 'THREAD_MISMATCH'
        : null)
      : null

    // Audit log
    await writeAuditLog('message.send', agentId, dest.channelId, {
      message_id: id, to, message_type: message_type ?? 'chat',
      recipients: delivery.pushTargets.length, warning: deliveryWarning,
    })

    // Part suffix appended to every success response when a split occurred,
    // so callers know their message was divided.
    const partSuffix = parts.length > 1 ? ` — split into ${parts.length} parts, ids: [${partIds.join(', ')}]` : ''

    // spec §4.2 step 7 tail — sender feedback (§8.2). Fire once per unique
    // recipient using the last-part delivery (pushTargets are stable across
    // parts because routing inputs — mentions, dest, members — don't change
    // between parts). Idle targets are no-ops inside the helper, so the
    // common case is cheap. Failures are swallowed inside the helper.
    {
      const feedbackDb = await coreDbAdapter()
      if (feedbackDb) {
        const uniqueRecipients = new Set(delivery.pushTargets)
        for (const recipient of uniqueRecipients) {
          if (recipient === agentId) continue
          await notifySenderAndObserve(feedbackDb, {
            senderId: agentId,
            targetId: recipient,
            messageId: partIds[0] ?? null,
          })
        }
      }
    }

    // spec §4.2 steps 9-11 — finalize in-flight state BEFORE outbound_queue
    // INSERT. Order of operations: message_queue → 'replied' → clear
    // current_message_id + flip agents.status to 'idle' (§8.1), then enqueue
    // outbound. This prevents double-posting on retry: if outbound fails, the
    // guard at the top of the next send rejects with NO_CURRENT_MESSAGE
    // instead of re-enqueuing a duplicate Discord message (Behavioral FAIL
    // B2). The D3 fallback path was removed — the top-of-
    // handler guard now makes current_message_id non-null unconditionally.
    //
    // We use `claimedMqId` captured under the SELECT FOR UPDATE lock at the
    // top of the handler, so there is no second read here and no chance of
    // a concurrent writer slipping in between read and update.
    await txClient.query(
      `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1 WHERE id = $2`,
      [id, claimedMqId],
    )
    // spec §4.2 step 10-11 — clear current_message_id AND flip to idle in
    // a single UPDATE so the two transitions are always atomic.
    await txClient.query(
      `UPDATE agents SET current_message_id = NULL, status = 'idle', status_detail = NULL, status_updated_at = now() WHERE agent_id = $1`,
      [agentId],
    )

    // spec §4.2 step 8 (reordered after 9-11 per Behavioral FAIL B2) — enqueue
    // outbound for each part. Resolution of channel_external_id is per-
    // destination, not per-part, so it's hoisted out of the loop. All queries
    // run against `txClient` so they are part of the outer transaction —
    // outbound INSERT failure rolls back the entire send (including the
    // 'replied' UPDATE), so the caller can retry via `next` → `send`.
    {
      let externalId: string | null = null
      if (dest.threadId) {
        const tr = await txClient.query(
          `SELECT external_id FROM thread_adapters WHERE thread_id = $1 AND platform = 'discord'`,
          [dest.threadId],
        ).catch(() => ({ rows: [] as any[] }))
        if (tr.rows.length > 0) externalId = tr.rows[0].external_id
      }
      if (!externalId) {
        const cr = await txClient.query(
          `SELECT external_id FROM channel_adapters WHERE channel_id = $1 AND platform = 'discord'`,
          [dest.channelId],
        ).catch(() => ({ rows: [] as any[] }))
        if (cr.rows.length > 0) externalId = cr.rows[0].external_id
      }
      if (externalId) {
        for (let partIdx = 0; partIdx < partIds.length; partIdx++) {
          const partMessageId = partIds[partIdx]
          const partContent = parts[partIdx]
          try {
            await txClient.query(
              `INSERT INTO outbound_queue (message_id, agent_id, channel_external_id, content)
               VALUES ($1, $2, $3, $4)`,
              // v2.1.0: clamp outbound content at DISCORD_MAX (1900) chars to
              // match spec §5.3 エラーハンドリング. truncateForPlatform's 2000-char
              // limit is the raw Discord hard cap; truncateForDiscord bakes in
              // 100 chars of headroom for mentions / reply markers / Discord
              // server-side reformat.
              [partMessageId, agentId, externalId, truncateForDiscord(partContent)],
            )
          } catch (err) {
            // ARC codex audit (PR#135): do NOT silently swallow. The
            // outbound_queue is the sole delivery path; a failed INSERT =
            // permanent loss of the Discord reply. Surface as error so the
            // caller knows their message was DB-saved but never queued.
            // Under the outer transaction, the finally block issues ROLLBACK
            // after this return; the message_queue / agent_messages /
            // 'replied' UPDATE all revert together.
            process.stderr.write(`agent-comms: outbound_queue INSERT failed: ${err}\n`)
            await writeAuditLog('outbound.enqueue_failed', agentId, dest.channelId, {
              code: 'OUTBOUND_ENQUEUE_FAILED',
              message_id: partMessageId,
              channel_external_id: externalId,
              error: String(err).slice(0, 500),
            })
            return {
              content: [{
                type: 'text',
                text: `Error [OUTBOUND_ENQUEUE_FAILED]: Discord配信キューへの登録に失敗しました (message_id: ${partMessageId})。トランザクションをロールバックしたので、\`next\` を呼び直せば再送できます。原因: ${String(err).slice(0, 200)}`,
              }],
              isError: true,
            }
          }
          // Inter-part delay paces outbound_queue INSERTs so the consumer
          // doesn't hit Discord's rate limiter in a burst. Skip after last.
          if (partIdx < partIds.length - 1) {
            await new Promise(r => setTimeout(r, 150))
          }
        }
      }
    }

    // COMMIT the transaction. The finally block below issues ROLLBACK when
    // `txCommitted` is still false (any early return inside the try block).
    await txClient.query('COMMIT')
    txCommitted = true

    // Response with delivery feedback
    // Issue #118 ③: include reply_context (original author + channel + content snippet)
    const replyCtxSuffix = buildReplyContextSuffix(
      reply_to ? await getMessageById(sendCoreDb, reply_to) : null,
      dest.channelId,
    )
    if (delivery.pushTargets.length > 0) {
      return { content: [{ type: 'text', text: `sent (id: ${id}) to ${delivery.pushTargets.length} recipient(s)${partSuffix}${replyCtxSuffix}` }] }
    }
    if (deliveryWarning === 'NOT_MENTIONED') {
      return { content: [{ type: 'text', text: `sent (id: ${id}) — DB保存済み。⚠️ 配信先なし: メンション（@agent_id）が必要です。送り直してください${partSuffix}` }] }
    }
    if (deliveryWarning === 'THREAD_MISMATCH') {
      return { content: [{ type: 'text', text: `sent (id: ${id}) — DB保存済み。⚠️ 受信者のactive_threadと不一致のため配信されていません${partSuffix}` }] }
    }
    return { content: [{ type: 'text', text: `sent (id: ${id}) to ${to}${partSuffix}` }] }
    } finally {
      // ROLLBACK any in-flight transaction if we didn't reach COMMIT. Catches
      // every early return inside the try block (content / mentions / rate /
      // duplicate / outbound failures) and the unhappy path where a helper
      // throws an unexpected exception. The COMMIT at the end of the happy
      // path sets `txCommitted = true`, so this is a no-op on success.
      if (!txCommitted) {
        await txClient.query('ROLLBACK').catch(() => {})
      }
    }
  }

  // focus/unfocus removed — destination is derived deterministically from reply_to.
  // last_received_context fallback was also abolished on 2026-04-08 (PR#89) for the same reason.

  // spec §4.3 — `notify` is a self-originated post, no reply context. It has
  // zero overlap with send's spec §4.2 step 1 guard (current_message_id),
  // step 9 (message_queue 'replied'), step 10-11 (clear current / idle).
  // Everything else (mentions validation, membership, routeInbound, split,
  // message_queue INSERT, outbound_queue INSERT, sender feedback) is shared
  // conceptually with send; we replicate the minimum necessary to satisfy
  // the spec flow without pulling in reply_to-dependent paths.
  if (name === 'notify') {
    const { channel, thread_id: threadArg, content, message_type, metadata } = args as any
    const mentions: string[] = Array.isArray(args.mentions) ? args.mentions : (args.mentions ? [args.mentions] : [])

    // spec §4.3 step 1 — --channel / --mentions / --content required.
    if (!channel || typeof channel !== 'string') {
      return { content: [{ type: 'text', text: 'Error [CHANNEL_REQUIRED]: channel is required for notify' }], isError: true }
    }
    if (!content || content.length === 0) {
      return { content: [{ type: 'text', text: 'Error [CONTENT_EMPTY]: content must not be empty' }], isError: true }
    }
    if (content.length > CORE_CONTENT_LIMIT) {
      return { content: [{ type: 'text', text: `Error [CONTENT_TOO_LARGE]: content exceeds core limit (${CORE_CONTENT_LIMIT} chars)` }], isError: true }
    }
    if (mentions.length === 0) {
      return { content: [{ type: 'text', text: 'Error [NOT_MENTIONED]: mentions is required (at least one agent_id)' }], isError: true }
    }
    if (mentions.length === 1 && mentions[0] === agentId) {
      return { content: [{ type: 'text', text: 'Error [SELF_SEND]: 自分自身には送信できません' }], isError: true }
    }

    const client = await tryGetDb()
    if (!client) {
      return { content: [{ type: 'text', text: 'Error [DB_UNAVAILABLE]: database required for notify' }], isError: true }
    }

    // spec §4.3 step 2 — resolve channel by id OR name. threadArg short-
    // circuits channel resolution because thread id uniquely identifies the
    // destination. Falls back to channels.name only if channels.id didn't
    // match. The `channels.name` column is unique per org so a name lookup
    // is deterministic when the caller opts into it.
    let resolvedChannelId: string | null = null
    let resolvedThreadId: string | null = threadArg ?? null
    if (resolvedThreadId) {
      const tr = await client.query(
        `SELECT channel_id FROM threads WHERE id = $1`,
        [resolvedThreadId],
      )
      if (tr.rows.length === 0) {
        return { content: [{ type: 'text', text: `Error [THREAD_NOT_FOUND]: thread '${resolvedThreadId}' not found` }], isError: true }
      }
      resolvedChannelId = tr.rows[0].channel_id
    } else {
      const byId = await client.query(`SELECT id FROM channels WHERE id = $1`, [channel])
      if (byId.rows.length > 0) {
        resolvedChannelId = channel
      } else {
        // codex-auditor PR #214 Layer 2 finding 2 — `channels.name` has no
        // UNIQUE constraint (db/migrate.ts), so blind `LIMIT 1` would silently
        // pick among duplicates on misrouted posts. Be explicit instead: read
        // up to 2 rows and fail-closed when more than one match.
        const byName = await client.query(`SELECT id FROM channels WHERE name = $1 ORDER BY id LIMIT 2`, [channel])
        if (byName.rows.length === 1) {
          resolvedChannelId = byName.rows[0].id
        } else if (byName.rows.length > 1) {
          const ids = byName.rows.map((r: { id: string }) => r.id).join(', ')
          return {
            content: [{
              type: 'text',
              text: `Error [CHANNEL_NAME_AMBIGUOUS]: channel name '${channel}' matches multiple channels (${ids}…). Pass the channel id instead of the name.`,
            }],
            isError: true,
          }
        }
      }
    }
    if (!resolvedChannelId) {
      return { content: [{ type: 'text', text: `Error [CHANNEL_NOT_FOUND]: channel '${channel}' not found` }], isError: true }
    }

    // spec §4.3 step 4 — permission + mentions validation (same as send).
    const dest = await resolveDestination(
      resolvedThreadId ? `thread:${resolvedThreadId}` : `channel:${resolvedChannelId}`,
      agentId,
    )
    if ('error' in dest) {
      await writeAuditLog('access.denied', agentId, null, { error: dest.error, code: dest.code })
      return { content: [{ type: 'text', text: `Error [${dest.code}]: ${dest.error}` }], isError: true }
    }
    if (!dest.members.includes(agentId)) {
      await writeAuditLog('access.denied', agentId, dest.channelId, { code: 'NOT_A_MEMBER' })
      return { content: [{ type: 'text', text: `Error [NOT_A_MEMBER]: access denied — not a member of channel '${dest.channelId}'` }], isError: true }
    }

    // spec §4.3 step 3 — mentions validation (same as send).
    const validAgentIds = await refreshAgentCache()
    for (const mention of mentions) {
      const mentionErr = validateMentionOrError(mention, validAgentIds)
      if (mentionErr) {
        return { content: [{ type: 'text', text: mentionErr }], isError: true }
      }
    }

    // Rate limit + duplicate guards (same posture as send; notify is
    // caller-driven so still bounded).
    const rate = await checkRateLimit(agentId)
    if (!rate.allowed) {
      await writeAuditLog('message.blocked', agentId, dest.channelId, { code: 'RATE_LIMITED' })
      return { content: [{ type: 'text', text: `Error [RATE_LIMITED]: rate limit exceeded (${config.rate_limit.max_per_minute}/min)` }], isError: true }
    }
    if (await checkDuplicate(content, dest.channelId)) {
      await writeAuditLog('message.blocked', agentId, dest.channelId, { code: 'DUPLICATE' })
      return { content: [{ type: 'text', text: 'Error [DUPLICATE]: same message sent within 10s, skipped' }], isError: true }
    }
    if (!checkBurst()) {
      await new Promise(r => setTimeout(r, BURST_MIN_INTERVAL_MS))
    }

    const safeContent = sanitizeContent(content)
    const notifyCoreDb = await coreDbAdapter()
    const resolvedMentionStrings = (
      await Promise.all(
        (mentions as string[]).map(async (aid) => {
          const did = await getAgentDiscordId(notifyCoreDb, aid).catch(() => null)
          return did ? `<@${did}>` : null
        }),
      )
    ).filter((s): s is string => s !== null)
    const parts = splitMessage(safeContent, 'discord', resolvedMentionStrings)

    const senderIsBot = !(await isHumanAgent(notifyCoreDb, agentId))
    const allAgentInfos: AgentInfo[] = []
    for (const member of dest.members) {
      const info = await loadAgentInfo(notifyCoreDb, member)
      if (info) allAgentInfos.push(info)
    }

    const partIds: string[] = []
    let lastDelivery: ReturnType<typeof routeInbound> | null = null

    // spec §4.3 steps 5-6 — per-part agent_messages + message_queue INSERT.
    // Outbound is deferred to a second loop for symmetry with send (the
    // notify flow has no reply-state to finalize between the two).
    for (let partIdx = 0; partIdx < parts.length; partIdx++) {
      const partContent = parts[partIdx]
      const sequence = await getNextSequence(dest.channelId)
      const authMeta = createAuthMetadata(dest.channelId, partContent)
      const partMeta = parts.length > 1 ? { split_part: partIdx + 1, split_total: parts.length } : {}
      const fullMetadata = { ...metadata, ...authMeta, ...partMeta }

      const id = await saveMessage({
        channel_id: dest.channelId, author_id: agentId, content: partContent,
        message_type: message_type ?? 'chat', reply_to: undefined,
        metadata: fullMetadata, depth: 0,
        source: 'agent-comms', thread_id: dest.threadId ?? null,
        direction: 'outbound', role: 'agent',
      })
      partIds.push(id)
      await client.query('UPDATE agent_messages SET sequence = $1 WHERE id = $2', [sequence, id]).catch(() => {})
      await pgNotify(client, 'agent_inbox', JSON.stringify({ event: 'message.created', to: dest.channelId, message_id: id, channel_id: dest.channelId }))

      const sendMentions = await buildSendMentions(
        mentions,
        partContent,
        (did) => resolveAgentFromDiscordId(notifyCoreDb, did),
      )
      const delivery = routeInbound(
        { authorAgentId: agentId, authorIsBot: senderIsBot, content: partContent, mentions: sendMentions, messageType: message_type ?? 'chat' },
        { channelId: dest.channelId, threadId: dest.threadId, members: dest.members },
        allAgentInfos,
      )
      lastDelivery = delivery

      const mqPayload = JSON.stringify({
        channel_id: dest.channelId,
        thread_id: dest.threadId ?? null,
        author_id: agentId,
        content: partContent,
        message_id: id,
        message_type: message_type ?? 'chat',
        source: 'agent-comms',
        ts: new Date().toISOString(),
      })
      for (const recipient of delivery.pushTargets) {
        try {
          // Issue #251 (a) — content-level dedup, cycle 2 source is
          // part of the dedup key per CTO `c1c6eb1d`. Notify path's
          // payload uses `source: 'agent-comms'` (see mqPayload
          // above), matching the send-fanout path; same-source
          // dual-emit collapses to one queue row, while a
          // simultaneous Discord-adapter delivery (source='discord')
          // is preserved as a separate record.
          const dedupWindowSec = parseInt(process.env.AGENT_COMMS_DEDUP_WINDOW_SEC ?? '30', 10)
          if (await isQueueContentDup(client, recipient, partContent, 'agent-comms', dedupWindowSec)) {
            process.stderr.write(`agent-comms: queue.dedup.skipped — notify content already queued for ${recipient} within ${dedupWindowSec}s (source=agent-comms)\n`)
            continue
          }
          await client.query(
            `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
            [recipient, id, mqPayload],
          )
        } catch (err) {
          process.stderr.write(`agent-comms: notify message_queue INSERT failed for ${recipient} (non-fatal): ${err}\n`)
        }
      }
    }

    // spec §4.3 step 6 tail — sender feedback (§8.2). notify shares the
    // §8.2 obligation: idle targets are free, busy/disconnected targets get
    // a system row in the sender's queue so they know delivery deferred.
    if (lastDelivery) {
      const feedbackDb = await coreDbAdapter()
      if (feedbackDb) {
        const uniqueRecipients = new Set(lastDelivery.pushTargets)
        for (const recipient of uniqueRecipients) {
          if (recipient === agentId) continue
          await notifySenderAndObserve(feedbackDb, {
            senderId: agentId,
            targetId: recipient,
            messageId: partIds[0] ?? null,
          })
        }
      }
    }

    // spec §4.3 step 7 — outbound_queue INSERT per part.
    let externalId: string | null = null
    if (dest.threadId) {
      const tr = await client.query(
        `SELECT external_id FROM thread_adapters WHERE thread_id = $1 AND platform = 'discord'`,
        [dest.threadId],
      ).catch(() => ({ rows: [] as any[] }))
      if (tr.rows.length > 0) externalId = tr.rows[0].external_id
    }
    if (!externalId) {
      const cr = await client.query(
        `SELECT external_id FROM channel_adapters WHERE channel_id = $1 AND platform = 'discord'`,
        [dest.channelId],
      ).catch(() => ({ rows: [] as any[] }))
      if (cr.rows.length > 0) externalId = cr.rows[0].external_id
    }
    if (externalId) {
      for (let partIdx = 0; partIdx < partIds.length; partIdx++) {
        const partMessageId = partIds[partIdx]
        const partContent = parts[partIdx]
        try {
          await client.query(
            `INSERT INTO outbound_queue (message_id, agent_id, channel_external_id, content)
             VALUES ($1, $2, $3, $4)`,
            // v2.1.0: clamp at DISCORD_MAX (1900) before enqueue — see send-tool
            // call site above for rationale.
            [partMessageId, agentId, externalId, truncateForDiscord(partContent)],
          )
        } catch (err) {
          process.stderr.write(`agent-comms: notify outbound_queue INSERT failed: ${err}\n`)
          await writeAuditLog('outbound.enqueue_failed', agentId, dest.channelId, {
            code: 'OUTBOUND_ENQUEUE_FAILED',
            message_id: partMessageId,
            channel_external_id: externalId,
            error: String(err).slice(0, 500),
          })
          return {
            content: [{
              type: 'text',
              text: `Error [OUTBOUND_ENQUEUE_FAILED]: Discord配信キューへの登録に失敗しました。message_id: ${partMessageId}。原因: ${String(err).slice(0, 200)}`,
            }],
            isError: true,
          }
        }
        if (partIdx < partIds.length - 1) {
          await new Promise(r => setTimeout(r, 150))
        }
      }
    }

    await writeAuditLog('message.notify', agentId, dest.channelId, {
      message_id: partIds[0],
      recipients: lastDelivery?.pushTargets.length ?? 0,
    })

    const id = partIds[0]
    const partSuffix = parts.length > 1 ? ` — split into ${parts.length} parts, ids: [${partIds.join(', ')}]` : ''
    return { content: [{ type: 'text', text: `notified (id: ${id}) to channel ${dest.channelId}${partSuffix}` }] }
  }

  if (name === 'quote') {
    const { message_id, to: targetAgent, comment } = args as any
    if (!message_id) return { content: [{ type: 'text', text: 'Error: message_id is required' }], isError: true }
    if (!targetAgent) return { content: [{ type: 'text', text: 'Error: to (agent_id) is required' }], isError: true }

    // Fetch the original message
    const quoteData = await buildQuoteBlock(message_id)
    if (!quoteData) {
      return { content: [{ type: 'text', text: `Error: message '${message_id}' not found` }], isError: true }
    }

    // Build content: quote + @mention + optional comment
    const mentionLine = `@${targetAgent}`
    const commentLine = comment ? ` ${comment}` : ''
    const quoteContent = `${quoteData.quote}${mentionLine}${commentLine}`

    // Find the channel of the original message to post in the same channel
    const client = await tryGetDb()
    if (!client) return { content: [{ type: 'text', text: 'Error: database unavailable' }], isError: true }
    const msgR = await client.query('SELECT channel_id FROM agent_messages WHERE id = $1', [message_id])
    if (msgR.rows.length === 0) return { content: [{ type: 'text', text: `Error: message '${message_id}' not found` }], isError: true }
    const channelId = msgR.rows[0].channel_id

    // Send via core Router (reuse send logic by setting name/args)
    name = 'send'
    args = {
      to: `channel:${channelId}`,
      content: quoteContent,
      reply_to: message_id,
    }
    // Fall through to send handler
  }

  // ============================================================
  // Legacy tools (aliases, maintained for backward compatibility)
  // ============================================================

  if (name === 'fetch_messages') {
    process.stderr.write(`[agent-com] WARN: fetch_messages is deprecated, use history instead\n`)
  }
  if (name === 'history' || name === 'fetch_messages') {
    const { channel, limit, since } = args as any
    const rows = await fetchMessages(channel, Math.min(limit ?? 20, 100), since)
    const text = rows.map((r: any) =>
      `[${r.created_at}] ${r.author_id}: ${r.content}  (id: ${r.id})`
    ).join('\n')
    return { content: [{ type: 'text', text: text || '(no messages)' }] }
  }

  if (name === 'check_inbox') {
    process.stderr.write(`[agent-com] WARN: check_inbox is deprecated, use inbox instead\n`)
  }
  if (name === 'inbox' || name === 'check_inbox') {
    const { limit } = (args ?? {}) as any
    // Issue #130 Phase 4: countAndClearSignals removed (filesystem signals abolished).
    const rows = await fetchNewMessages(agentId, Math.min(limit ?? 20, 100))
    if (rows.length === 0) return { content: [{ type: 'text', text: '(no new messages)' }] }
    const text = rows.map((r: any) =>
      `[${r.created_at}] ${r.author_id} → #${r.channel_id}: ${r.content}  (id: ${r.id})`
    ).join('\n\n')
    return { content: [{ type: 'text', text: `${rows.length} message(s):\n\n${text}` }] }
  }

  // reply is handled above via redirect to send (SSOT-3 compliant)

  if (name === 'fetch_discord_history') {
    const { channel_id, limit, before } = args as any
    try {
      const messages = await discord.fetchHistory(channel_id, Math.min(limit ?? 50, 100), before)
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: '(no messages found)' }] }
      }
      const text = messages.map(m =>
        `[${m.timestamp.toISOString()}] ${m.author.name}${m.author.isBot ? ' (bot)' : ''}: ${m.content}  (id: ${m.id})`
      ).join('\n')
      return { content: [{ type: 'text', text: `${messages.length} message(s) from Discord channel ${channel_id}:\n\n${text}` }] }
    } catch (err) {
      // Fallback to HTTP if adapter not connected
      try {
        const params = new URLSearchParams({ channel_id })
        if (limit) params.set('limit', String(Math.min(limit, 100)))
        if (before) params.set('before', before)
        const resp = await fetch(`http://127.0.0.1:${DISCORD_OUTBOUND_PORT}/history?${params}`)
        const result = await resp.json() as any
        if (!resp.ok) {
          return { content: [{ type: 'text', text: `Discord history fetch failed: ${result.error ?? resp.statusText}` }], isError: true }
        }
        const messages = result.messages as any[]
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: '(no messages found)' }] }
        }
        const text = messages.map((m: any) =>
          `[${m.timestamp}] ${m.author}${m.is_bot ? ' (bot)' : ''}: ${m.content}  (id: ${m.message_id})`
        ).join('\n')
        return { content: [{ type: 'text', text: `${messages.length} message(s) from Discord channel ${channel_id}:\n\n${text}` }] }
      } catch (fallbackErr) {
        return { content: [{ type: 'text', text: `Discord history fetch failed: ${err}` }], isError: true }
      }
    }
  }

  if (name === 'list_agents') {
    process.stderr.write(`[agent-com] WARN: list_agents is deprecated, use agents instead\n`)
  }
  if (name === 'agents' || name === 'list_agents') {
    const { status, agent_type } = (args ?? {}) as any
    const agents = await listAgents(status, agent_type)
    if (agents.length === 0) return { content: [{ type: 'text', text: '(no agents found — DB may be unavailable)' }] }
    const text = agents.map((a: any) =>
      `${a.agent_id} (${a.agent_type}/${a.runtime}) — ${a.status} — last seen: ${a.last_seen_at ?? 'never'}`
    ).join('\n')
    return { content: [{ type: 'text', text: `${agents.length} agent(s):\n${text}` }] }
  }

  if (name === 'restart_bot') {
    const { session } = args as any
    const registry = loadBotRegistry()
    const entry = registry.find(e => e.session === session)
    if (!entry) {
      const available = registry.map(e => e.session).join(', ')
      return { content: [{ type: 'text', text: `Session "${session}" not found in bot-registry.txt. Available: ${available}` }], isError: true }
    }
    const log = await restartBotSession(entry)
    return { content: [{ type: 'text', text: `[restart_bot] ${session}:\n${log}` }] }
  }

  if (name === 'bot_status') {
    const registry = loadBotRegistry()
    if (registry.length === 0) {
      return { content: [{ type: 'text', text: 'No bots found in bot-registry.txt' }], isError: true }
    }
    const lines = registry.map(entry => {
      const health = checkBotHealth(entry)
      const icon = health.status === 'healthy' ? '✅' :
                   health.status === 'initializing' ? '🔄' :
                   health.status === 'dead' ? '💀' :
                   health.status === 'crashed' ? '💥' :
                   health.status === 'exited' ? '🚪' :
                   health.status === 'misconfigured' ? '⚠️' : '❓'
      return `${icon} ${entry.session} (${entry.agentId}) port:${entry.port} — ${health.status}: ${health.details}`
    })
    return { content: [{ type: 'text', text: `${registry.length} bot(s):\n${lines.join('\n')}` }] }
  }

  if (name === 'watchdog_check') {
    const { dry_run } = (args ?? {}) as any
    const registry = loadBotRegistry()
    if (registry.length === 0) {
      return { content: [{ type: 'text', text: 'No bots found in bot-registry.txt' }], isError: true }
    }
    const results: string[] = []
    let alive = 0, restarted = 0
    for (const entry of registry) {
      const health = checkBotHealth(entry)
      if (health.status === 'healthy' || health.status === 'initializing') {
        alive++
        results.push(`✅ ${entry.session}: ${health.status} — ${health.details}`)
      } else {
        if (dry_run) {
          results.push(`⚠️ ${entry.session}: ${health.status} — ${health.details} (would restart)`)
        } else {
          const log = await restartBotSession(entry)
          restarted++
          results.push(`🔄 ${entry.session}: restarted (was: ${health.status})\n   ${log.split('\n').join('\n   ')}`)
        }
      }
    }
    const summary = dry_run
      ? `[watchdog dry-run] ${alive}/${registry.length} healthy`
      : `[watchdog] ${alive}/${registry.length} alive, ${restarted} restarted`
    return { content: [{ type: 'text', text: `${summary}\n\n${results.join('\n')}` }] }
  }

  // ─────────────────────────────────────────────────────────────────────
  // v2.1.0 — fail / skip / reclaim (spec §4.1, §11 failed_reason)
  // ─────────────────────────────────────────────────────────────────────
  // Shared with `agent-com fail` / `agent-com skip` / `agent-com reclaim`.
  // Kept inline here (rather than in core/) because the MCP tool handler and
  // the CLI live on opposite sides of the Node/Bun split and the SQL is tiny.
  if (name === 'fail' || name === 'skip') {
    const client = await tryGetDb()
    if (!client) {
      return { content: [{ type: 'text', text: 'Error: DATABASE_URL not configured — fail/skip require PG access.' }], isError: true }
    }
    const messageId = typeof args?.message_id === 'string' ? args.message_id : undefined
    const reason = typeof args?.reason === 'string' ? args.reason : undefined
    if (!messageId || !reason) {
      return { content: [{ type: 'text', text: `Error: ${name} requires both message_id and reason.` }], isError: true }
    }
    const targetStatus = name === 'fail' ? 'failed' : 'skipped'
    try {
      await client.query('BEGIN')
      try {
        const upd = await client.query(
          `UPDATE message_queue
              SET status = $1, failed_reason = $2
            WHERE agent_id = $3 AND message_id = $4 AND status IN ('pending','read')
            RETURNING id`,
          [targetStatus, reason, AGENT_ID, messageId],
        )
        if (upd.rows.length === 0) {
          await client.query('ROLLBACK')
          return {
            content: [{
              type: 'text',
              text: `Error: no in-flight or pending message_queue row for agent_id=${AGENT_ID}, message_id=${messageId} (already replied/failed/skipped?).`,
            }],
            isError: true,
          }
        }
        const queueId = upd.rows[0].id as number
        await client.query(
          `UPDATE agents
              SET current_message_id = NULL,
                  status = 'idle',
                  status_detail = NULL,
                  status_updated_at = now()
            WHERE agent_id = $1 AND current_message_id = $2`,
          [AGENT_ID, queueId],
        )
        await client.query('COMMIT')
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: true, queue_id: queueId, message_id: messageId, status: targetStatus, failed_reason: reason }),
          }],
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${name} failed: ${String(err).slice(0, 500)}` }], isError: true }
    }
  }

  if (name === 'reclaim') {
    const client = await tryGetDb()
    if (!client) {
      return { content: [{ type: 'text', text: 'Error: DATABASE_URL not configured — reclaim requires PG access.' }], isError: true }
    }
    const targetAgent = (typeof args?.agent_id === 'string' && args.agent_id.length > 0) ? args.agent_id : AGENT_ID
    try {
      await client.query('BEGIN')
      try {
        const rollback = await client.query(
          `UPDATE message_queue
              SET status = 'pending', read_at = NULL
            WHERE agent_id = $1
              AND status = 'read'
              AND read_at < now() - INTERVAL '15 minutes'
            RETURNING id`,
          [targetAgent],
        )
        await client.query(
          `UPDATE agents
              SET current_message_id = NULL,
                  status = 'idle',
                  status_detail = NULL,
                  status_updated_at = now()
            WHERE agent_id = $1`,
          [targetAgent],
        )
        await client.query('COMMIT')
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              agent_id: targetAgent,
              reclaimed_count: rollback.rows.length,
              reclaimed_queue_ids: rollback.rows.map((r: any) => r.id),
            }),
          }],
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: reclaim failed: ${String(err).slice(0, 500)}` }], isError: true }
    }
  }

  if (name === 'cleanup_ports') {
    const registry = loadBotRegistry()
    if (registry.length === 0) {
      return { content: [{ type: 'text', text: 'No bots found in bot-registry.txt' }], isError: true }
    }
    const results: string[] = []
    let cleaned = 0
    for (const entry of registry) {
      const sessionExists = tmuxHasSession(entry.session)
      const pids = getProcessOnPort(entry.port)
      if (!sessionExists && pids.length > 0) {
        const killed = killPidsOnPort(entry.port, false)
        cleaned += killed
        results.push(`🧹 port ${entry.port} (${entry.session}): killed ${killed} orphan process(es) — PID: ${pids.join(',')}`)
      } else if (sessionExists && pids.length > 0) {
        results.push(`✅ port ${entry.port} (${entry.session}): in use by active session`)
      } else if (!sessionExists && pids.length === 0) {
        results.push(`⬚ port ${entry.port} (${entry.session}): free (session not running)`)
      } else {
        results.push(`✅ port ${entry.port} (${entry.session}): clean`)
      }
    }
    return { content: [{ type: 'text', text: `[cleanup_ports] ${cleaned} orphan process(es) killed\n\n${results.join('\n')}` }] }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
})

// --- Permission relay: CC → server → Discord DM (Phase 5: integrated) ---
server.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params
    try {
      await discord.sendPermissionRequest({ request_id, tool_name, description, input_preview })
    } catch (err) {
      // Fallback to HTTP if adapter not connected
      try {
        const resp = await fetch(`http://127.0.0.1:${DISCORD_OUTBOUND_PORT}/permission`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id, tool_name, description, input_preview }),
        })
        if (!resp.ok) {
          const text = await resp.text().catch(() => '(no body)')
          process.stderr.write(`agent-comms: permission forward failed (HTTP ${resp.status}): ${text}\n`)
        }
      } catch (fallbackErr) {
        process.stderr.write(`agent-comms: permission forward failed: ${err}\n`)
      }
    }
  },
)

} // end registerTools()

// Register tools on the global MCP server (stdio/sse modes)
registerTools(mcp, AGENT_ID)

// --- Per-Bot Server Factory (SSE Daemon mode, Phase 3b) ---
interface BotContext {
  botId: string
  server: Server
  transport: SSEServerTransport | null
  connectedAt: string
  lastActivity: string
}

// Active bot contexts (multi-bot SSE)
const botContexts = new Map<string, BotContext>()

function createBotServer(botId: string): BotContext {
  const server = createMcpServer()
  registerTools(server, botId)
  const ctx: BotContext = {
    botId,
    server,
    transport: null,
    connectedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  }
  return ctx
}

// --- Bot Registry (lifecycle management) ---
interface BotEntry {
  session: string
  projectDir: string
  agentId: string
  port: number
  command: string
}

const BOT_REGISTRY_PATH = process.env.BOT_REGISTRY
  ?? join(dirname(new URL(import.meta.url).pathname), 'scripts', 'bot-registry.txt')
const DEFAULT_CLAUDE_CMD = 'claude --mcp-config .mcp.json --dangerously-skip-permissions'

function loadBotRegistry(): BotEntry[] {
  try {
    const content = readFileSync(BOT_REGISTRY_PATH, 'utf-8')
    return content.split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .map(line => {
        const parts = line.split('|').map(s => s.trim())
        const [session, projectDir, agentId, portStr, ...cmdParts] = parts
        const command = cmdParts.join('|').trim() || DEFAULT_CLAUDE_CMD
        return { session, projectDir, agentId, port: parseInt(portStr, 10), command }
      })
      .filter(e => e.session && !isNaN(e.port))
  } catch {
    return []
  }
}

function tmuxExec(args: string[]): { stdout: string; ok: boolean } {
  const result = Bun.spawnSync(['tmux', ...args])
  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    ok: result.exitCode === 0,
  }
}

function tmuxCapture(session: string, lines: number = 30): string {
  const { stdout, ok } = tmuxExec(['capture-pane', '-t', session, '-p', '-S', `-${lines}`])
  return ok ? stdout : ''
}

function tmuxHasSession(session: string): boolean {
  return tmuxExec(['has-session', '-t', session]).ok
}

function getProcessOnPort(port: number): string[] {
  try {
    const result = Bun.spawnSync(['lsof', '-i', `:${port}`, '-t'])
    const pids = new TextDecoder().decode(result.stdout).trim()
    return pids ? pids.split('\n').map(p => p.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function killPidsOnPort(port: number, excludeSelf = true): number {
  const pids = getProcessOnPort(port)
  let killed = 0
  for (const pid of pids) {
    if (excludeSelf && pid === String(process.pid)) continue
    try { process.kill(parseInt(pid), 'SIGTERM'); killed++ } catch {}
  }
  if (killed > 0) Bun.sleepSync(500)
  return killed
}

async function restartBotSession(entry: BotEntry): Promise<string> {
  const log: string[] = []
  const expandedDir = entry.projectDir.replace(/^~/, homedir())

  // 1. Kill orphan on port
  const killed = killPidsOnPort(entry.port)
  if (killed > 0) log.push(`Killed ${killed} orphan process(es) on port ${entry.port}`)

  // 2. Kill existing tmux session
  tmuxExec(['kill-session', '-t', entry.session])
  Bun.sleepSync(1000)
  log.push(`Killed old tmux session (if any)`)

  // 3. Create new session and start Claude Code
  tmuxExec(['new-session', '-d', '-s', entry.session, '-c', expandedDir])
  Bun.sleepSync(1000)
  tmuxExec(['send-keys', '-t', entry.session, entry.command, 'Enter'])
  log.push(`Started: ${entry.command}`)

  // 4. Wait for TUI prompt and auto-confirm
  Bun.sleepSync(3000)
  tmuxExec(['send-keys', '-t', entry.session, 'Enter'])
  log.push(`Sent Enter to confirm TUI prompt`)

  // 5. Verify startup — post-PR#172: look for bun server.ts on the
  // expected port instead of the retired "Listening for channel
  // messages" string (emitted by the old channel-server only).
  Bun.sleepSync(5000)
  const pids = getProcessOnPort(entry.port)
  if (pids.length > 0) {
    log.push(`✅ Confirmed: bun server.ts listening on port ${entry.port} (PID: ${pids.join(',')})`)
  } else {
    log.push(`⚠️ Not yet confirmed — port ${entry.port} still free (may still be initializing)`)
  }

  return log.join('\n')
}

// Pure branch logic lives in core/bot-health.ts so unit tests can
// cover all six branches with injected deps. This wrapper binds the
// real tmux / lsof / ps side-effect helpers.
function checkBotHealth(entry: BotEntry): BotHealthResult {
  return checkBotHealthCore(entry, {
    hasSession: tmuxHasSession,
    capture: tmuxCapture,
    getPids: getProcessOnPort,
    psCommand: (pid: string) => {
      const r = Bun.spawnSync(['ps', '-p', pid, '-o', 'command='])
      return new TextDecoder().decode(r.stdout)
    },
  })
}

// --- Port conflict resolution (uses shared helpers above) ---
function killProcessOnPort(port: number): boolean {
  return killPidsOnPort(port) > 0
}

// --- Integrated Bridge: HTTP server for push notifications + permission responses ---
// Pre-check: kill any stale process occupying our port
killProcessOnPort(WEBHOOK_PORT)

const bridgeServer = Bun.serve({
  port: WEBHOOK_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const url = new URL(req.url)

    // Permission response from discord-adapter
    if (url.pathname === '/permission-response') {
      try {
        const body = await req.json() as { request_id: string; behavior: 'allow' | 'deny' }
        if (!body.request_id || !body.behavior) {
          return new Response(JSON.stringify({ error: 'request_id and behavior required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          })
        }
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: body.request_id, behavior: body.behavior },
        })
        process.stderr.write(`agent-comms: permission ${body.behavior} for ${body.request_id}\n`)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        process.stderr.write(`agent-comms: permission-response error: ${err}\n`)
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Message injection (from listener or discord-adapter)
    try {
      const body = await req.json() as {
        content: string
        meta?: {
          chat_id?: string
          message_id?: string
          user?: string
          user_id?: string
          ts?: string
          source?: string
        }
      }

      if (!body.content) {
        return new Response('Missing content', { status: 400 })
      }

      // Dedup: skip if this message_id was already delivered
      const msgId = body.meta?.message_id
      if (msgId && processedIds.has(msgId)) {
        return new Response(JSON.stringify({ ok: true, dedup: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (msgId) processedIds.set(msgId, Date.now())

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: body.content,
          meta: {
            chat_id: body.meta?.chat_id ?? 'agent-comms',
            message_id: body.meta?.message_id ?? '',
            user: body.meta?.user ?? 'unknown',
            user_id: body.meta?.user_id ?? 'unknown',
            ts: body.meta?.ts ?? new Date().toISOString(),
            source: body.meta?.source ?? 'agent-comms',
          },
        },
      })

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      process.stderr.write(`agent-comms: bridge error: ${err}\n`)
      return new Response(JSON.stringify({ ok: false, error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  },
})

process.stderr.write(`agent-comms: bridge listening on http://127.0.0.1:${WEBHOOK_PORT}\n`)

// --- Post-connect setup (Phase C I5: slim — agent registration only) ---
// Polling, listener, and Discord setup moved to the unified startup block below.
let postConnectDone = false
async function postConnect() {
  if (postConnectDone) return
  postConnectDone = true
  // Startup validations
  if (AGENT_ID === 'unknown') {
    process.stderr.write('agent-comms: WARNING — agent_id is "unknown". Set agent_id in config.json or AGENT_ID env var.\n')
  }
  if (config.auth.mode === 'enforce' && !authSecret) {
    process.stderr.write('agent-comms: ERROR — auth.mode is "enforce" but no secret found. Set AGENT_COMMS_SECRET or create secret file via: bun cli/auth-init.ts\n')
  }
  // Register agent (non-fatal on failure)
  try {
    await registerAgent()
  } catch (err) {
    process.stderr.write(`agent-comms: WARNING — agent registration failed (non-fatal): ${err}\n`)
  }
}

// --- SSE Transport: Auth middleware ---
function isLocalhost(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function authenticateRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!AUTH_TOKEN) return true
  if (AUTH_SKIP_LOCALHOST && isLocalhost(req)) return true
  const authHeader = req.headers.authorization ?? ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (provided.length === AUTH_TOKEN.length && provided.length > 0) {
    if (timingSafeEqual(Buffer.from(provided), Buffer.from(AUTH_TOKEN))) return true
  }
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorized' }))
  return false
}

// --- SSE Transport: Health endpoint (Phase C I5: unified — always uses botContexts) ---
function getHealthStatus(): { status: string; uptime: number; connected_bots: Record<string, { connected_at: string; last_activity: string }>; expected_bots: string[] } {
  const uptimeSeconds = Math.floor((Date.now() - sseStartTime) / 1000)
  const bots: Record<string, { connected_at: string; last_activity: string }> = {}

  for (const [botId, ctx] of botContexts) {
    bots[botId] = { connected_at: ctx.connectedAt, last_activity: ctx.lastActivity }
  }

  let status = 'ok'
  if (EXPECTED_BOTS.length > 0) {
    const missing = EXPECTED_BOTS.filter(b => !botContexts.has(b))
    if (missing.length === EXPECTED_BOTS.length) {
      status = 'error'
    } else if (missing.length > 0) {
      status = 'degraded'
    }
  }

  return { status, uptime: uptimeSeconds, connected_bots: bots, expected_bots: EXPECTED_BOTS }
}

// --- Start (Phase C I5: unified flow — no TRANSPORT_MODE branching) ---
// All processes run a single flow:
//   1. Multi-bot SSE HTTP server (conditional: only when EXPECTED_BOTS or AGENT_COMMS_PORT is set)
//   2. Shared startup: polling, pg_notify listener, per-bot Discord clients, shared Discord adapter
//   3. Stdio MCP transport (unconditional)
//   4. Single shutdown handler

// --- 1. Multi-bot SSE HTTP server (conditional) ---
const MULTI_BOT_MODE = EXPECTED_BOTS.length > 0 || !!process.env.AGENT_COMMS_PORT
const daemonTransports = new Map<string, SSEServerTransport>()
let httpServer: ReturnType<typeof createServer> | null = null

if (MULTI_BOT_MODE) {
  httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // OAuth bypass endpoints (Claude Code SSE MCP workaround)
    // Claude Code forces OAuth discovery on SSE connections. These dummy
    // endpoints satisfy the OAuth flow without actual authentication.
    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        issuer: `http://localhost:${SSE_PORT}`,
        authorization_endpoint: `http://localhost:${SSE_PORT}/oauth/authorize`,
        token_endpoint: `http://localhost:${SSE_PORT}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
      }))
      return
    }

    if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const state = url.searchParams.get('state') ?? ''
      res.writeHead(302, { Location: `${redirectUri}?code=local-no-auth&state=${state}` })
      res.end()
      return
    }

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        access_token: 'local-no-auth',
        token_type: 'Bearer',
        expires_in: 999999999,
      }))
      return
    }

    // Health endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      if (!authenticateRequest(req, res)) return
      const health = getHealthStatus()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(health))
      return
    }

    // SSE endpoint — per-bot Server Factory
    if (url.pathname === '/sse' && req.method === 'GET') {
      if (!authenticateRequest(req, res)) return
      const botId = url.searchParams.get('bot_id')
      if (!botId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bot_id query parameter is required' }))
        return
      }

      // Graceful reconnect: close existing connection for same bot_id
      const existingCtx = botContexts.get(botId)
      if (existingCtx && existingCtx.transport) {
        process.stderr.write(`[SSE] bot reconnecting: ${botId} (closing previous)\n`)
        const oldSessionId = existingCtx.transport.sessionId
        daemonTransports.delete(oldSessionId)
        await existingCtx.transport.close().catch(() => {})
        botContexts.delete(botId)
        // Cleanup per-bot Discord client
        const oldClient = discordClients.get(botId)
        if (oldClient) {
          await oldClient.disconnect().catch(() => {})
          discordClients.delete(botId)
        }
      }

      process.stderr.write(`[SSE] bot connected: ${botId} at ${new Date().toISOString()}\n`)

      try {
        // Create per-bot Server + Transport
        const ctx = createBotServer(botId)
        const transport = new SSEServerTransport('/messages', res)
        const sessionId = transport.sessionId
        ctx.transport = transport
        daemonTransports.set(sessionId, transport)
        botContexts.set(botId, ctx)

        res.on('close', () => {
          process.stderr.write(`[SSE] bot disconnected: ${botId}, reason: connection_close\n`)
          daemonTransports.delete(sessionId)
          const current = botContexts.get(botId)
          if (current && current.transport?.sessionId === sessionId) {
            botContexts.delete(botId)
          }
          // Cleanup per-bot Discord client (On-Demand teardown)
          const botClient = discordClients.get(botId)
          if (botClient) {
            botClient.disconnect().catch(() => {})
            discordClients.delete(botId)
            process.stderr.write(`agent-comms: per-bot Discord disconnected for ${botId}\n`)
          }
        })

        await ctx.server.connect(transport)

        // Register agent for this bot
        try {
          const client = await tryGetDb()
          if (client) {
            await client.query(
              `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, last_seen_at, registered_at)
               VALUES ($1, 'default', $1, 'dev', 'claude-code', 'online', now(), now())
               ON CONFLICT (agent_id) DO UPDATE SET status = 'online', last_seen_at = now()`,
              [botId]
            )
            await pgNotify(client, 'agent_events', JSON.stringify({ event: 'agent.online', agent_id: botId, org_id: 'default' }))
          }
        } catch (err) {
          process.stderr.write(`agent-comms: agent registration failed for ${botId} (non-fatal): ${err}\n`)
        }

        // Per-Bot Discord Client (On-Demand)
        // Staggered connect: wait before creating Discord Gateway connection
        const botCount = discordClients.size
        if (botCount > 0) {
          process.stderr.write(`agent-comms: staggered connect — waiting ${STAGGERED_CONNECT_DELAY_MS}ms for ${botId} (${botCount} clients already connected)\n`)
          await new Promise(r => setTimeout(r, STAGGERED_CONNECT_DELAY_MS))
        }
        // Check if startup client is still connected; if not, recreate
        const existingClient = discordClients.get(botId)
        if (existingClient?.isConnected()) {
          process.stderr.write(`agent-comms: skipping per-bot Discord for ${botId} (already connected)\n`)
        } else {
        if (existingClient) {
          await existingClient.disconnect().catch(() => {})
          discordClients.delete(botId)
        }
        const tokenResult = await resolveDiscordToken(botId)
        if (tokenResult) {
          const botDiscord = await connectBotDiscord(botId, tokenResult.token)
          if (botDiscord) {
            discordClients.set(botId, botDiscord)
            // Per-bot Discord client is outbound-only.
            // No onMessage binding; handleInboundMessage is invoked only from
            // the shared adapter below.
          }
        }
        } // end else (skip if already connected)
      } catch (err) {
        process.stderr.write(`[SSE] bot connection error: ${botId}, reason: ${err}\n`)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      }
      return
    }

    // Messages endpoint (POST from SSE clients)
    if (url.pathname === '/messages' && req.method === 'POST') {
      if (!authenticateRequest(req, res)) return
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const transport = daemonTransports.get(sessionId)
      if (!transport) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No transport found for sessionId' }))
        return
      }

      // Update last_activity
      for (const [, ctx] of botContexts) {
        if (ctx.transport === transport) {
          ctx.lastActivity = new Date().toISOString()
          break
        }
      }

      try {
        await transport.handlePostMessage(req, res)
      } catch (err) {
        process.stderr.write(`agent-comms: message handling error: ${err}\n`)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      }
      return
    }

    // 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  httpServer.listen(SSE_PORT, () => {
    process.stderr.write(`agent-comms: SSE server listening on http://127.0.0.1:${SSE_PORT} (Per-Bot Server Factory)\n`)
    process.stderr.write(`agent-comms: endpoints: GET /sse?bot_id=<id>, GET /health, POST /messages\n`)
  })
}

// AGENT_COM_LEGACY_DISCORD_GATEWAY opt-out env (spec v3 §3 / ADR-001, PR #1).
// Startup-once parse with fail-safe fallback to `1` (enabled) for invalid input.
export function parseLegacyGatewayEnv(raw: string | undefined): boolean {
  if (raw === undefined || raw === '1') return true
  if (raw === '0') return false
  process.stderr.write(`agent-comms: WARN invalid AGENT_COM_LEGACY_DISCORD_GATEWAY="${raw}", defaulting to 1 (enabled)\n`)
  return true
}

// --- 2. Shared startup (unconditional) ---
;(async () => {
  // Start pg_notify listener (conditional — disabled when AGENT_COM_PG_NOTIFY=false for SQLite mode).
  // Delivery is pull-based via `next` MCP tool (spec §4.1); legacy push polling + `notifications/claude/channel`
  // were removed per spec §20.
  if (process.env.AGENT_COM_PG_NOTIFY !== 'false') {
    try {
      await startListener()
    } catch (err) {
      process.stderr.write(`agent-comms: WARNING — pg_notify listener start failed (non-fatal): ${err}\n`)
    }
  } else {
    process.stderr.write('agent-comms: pg_notify listener skipped (AGENT_COM_PG_NOTIFY=false, polling-only mode)\n')
  }

  // Issue #251 (c) — install in-process TTL sweeper. Skipped in
  // SQLite / polling-only mode (no PG client), and skipped when
  // explicitly disabled via env var (tests / one-shot CLIs).
  if (process.env.AGENT_COMMS_TTL_SWEEP_DISABLED !== '1') {
    try {
      const ttlDb = await coreDbAdapter()
      if (ttlDb) {
        const intervalMs = parseInt(process.env.AGENT_COMMS_TTL_SWEEP_INTERVAL_MS ?? '300000', 10)
        const ttlHours = parseInt(process.env.AGENT_COMMS_TTL_HOURS ?? '24', 10)
        startQueueTtlSweeper(ttlDb, { intervalMs, ttlHours })
        process.stderr.write(`agent-comms: queue ttl sweeper started (interval=${intervalMs}ms, ttl=${ttlHours}h)\n`)
      }
    } catch (err) {
      process.stderr.write(`agent-comms: WARNING — queue ttl sweeper failed to start (non-fatal): ${err}\n`)
    }
  }

  // Connect Per-Bot Discord Clients for all expected bots at startup
  // This ensures bots (not yet SSE-connected) still have Discord presence
  for (const botId of EXPECTED_BOTS) {
    if (discordClients.has(botId)) continue
    const tokenResult = await resolveDiscordToken(botId)
    if (tokenResult && tokenResult.source === 'per-bot') {
      const botDiscord = await connectBotDiscord(botId, tokenResult.token)
      if (botDiscord) {
        discordClients.set(botId, botDiscord)
        // Per-bot Discord client is outbound-only.
        // No onMessage binding; handleInboundMessage is invoked only from
        // the shared adapter below.
        process.stderr.write(`agent-comms: startup Discord client for ${botId} (${tokenResult.source}, outbound-only)\n`)
      }
    }
    // Staggered connect delay
    if (EXPECTED_BOTS.indexOf(botId) < EXPECTED_BOTS.length - 1) {
      await new Promise(r => setTimeout(r, STAGGERED_CONNECT_DELAY_MS))
    }
  }

  // Phase C I5: single Discord adapter handles FULL inbound routing.
  // onMessage → handleInboundMessage → agent_messages + message_queue.
  // Dedup: processedIds (in-process) + uq_mq_agent_message UNIQUE (DB).
  if (DISCORD_BOT_TOKEN) {
    const legacyGateway = parseLegacyGatewayEnv(process.env.AGENT_COM_LEGACY_DISCORD_GATEWAY)
    if (!legacyGateway) {
      process.stderr.write('agent-comms: AGENT_COM_LEGACY_DISCORD_GATEWAY=0, legacy Discord WebSocket disabled\n')
    } else try {
      discord.onMessage((msg) => {
        if (processedIds.has(msg.id)) return
        processedIds.set(msg.id, Date.now())

        const atts = msg.attachments?.map(a => `${a.name} (${a.contentType}, ${(a.size / 1024).toFixed(0)}KB)`).join('; ')
        const content = msg.content || (atts ? '(attachment)' : '')

        extractDiscordMentions(content, msg.mentionUserIds).then(resolvedMentions => {
          return handleInboundMessage({
            receiverAgentId: AGENT_ID,
            externalChannelId: msg.channel,
            externalMessageId: msg.id,
            authorExternalId: msg.author.id,
            authorName: msg.author.name,
            authorIsBot: msg.author.isBot,
            content,
            attachments: atts,
            timestamp: msg.timestamp,
            platform: 'discord',
            mentions: resolvedMentions,
            replyToMessageId: msg.replyTo,
          })
        }).then(async result => {
          if (!result.delivered) {
            process.stderr.write(`agent-comms: inbound not delivered — ${result.reason} (msg: ${msg.id})\n`)
          }
          if (result.humanWarning) {
            sendHumanWarning(discord, msg.channel, msg.id)
          }
        }).catch(err => {
          process.stderr.write(`agent-comms: inbound routing error: ${err}\n`)
        })
      })

      discord.onPermissionResponse(async (params) => {
        try {
          await mcp.notification({
            method: 'notifications/claude/channel/permission',
            params: { request_id: params.request_id, behavior: params.behavior },
          })
        } catch (err) {
          process.stderr.write(`agent-comms: permission notification failed: ${err}\n`)
        }
      })

      // Inject DB query function for mention conversion and thread mapping
      discord.setDbQuery(async (sql: string, params?: any[]) => {
        const client = await tryGetDb()
        if (!client) throw new Error('DB unavailable')
        return client.query(sql, params)
      })

      discord.setAgentId(AGENT_ID)

      await discord.connect({
        token: DISCORD_BOT_TOKEN,
      })
      process.stderr.write('agent-comms: Discord adapter connected (inbound + outbound)\n')
      // Register this bot's Discord adapter in the per-bot client map so
      // outbound delivery can resolve it via discordClients.get(AGENT_ID).
      discordClients.set(AGENT_ID, discord)

      // Start the outbound consumer AFTER discordClients.set so the first
      // consumer tick can resolve the client for this agent.
      startOutboundConsumer()
    } catch (err) {
      process.stderr.write(`agent-comms: WARNING — Discord adapter failed (non-fatal): ${err}\n`)
    }
  } else {
    process.stderr.write('agent-comms: DISCORD_BOT_TOKEN not set, Discord adapter disabled\n')
  }
})()

// --- 3. Stdio MCP transport (unconditional) ---
const transport = new StdioServerTransport()
mcp.connect(transport).then(async () => {
  await postConnect()
}).catch(err => {
  process.stderr.write(`agent-comms: startup failed: ${err}\n`)
  process.exit(1)
})

// --- 4. Unified shutdown handler ---
const shutdown = async () => {
  stopListener()
  await discord.disconnect().catch(() => {})
  // Disconnect all per-bot Discord clients
  for (const [botId, client] of discordClients) {
    await client.disconnect().catch(() => {})
    process.stderr.write(`agent-comms: per-bot Discord disconnected for ${botId} (shutdown)\n`)
  }
  discordClients.clear()
  bridgeServer.stop()
  // Close all per-bot transports (multi-bot SSE)
  for (const [, ctx] of botContexts) {
    if (ctx.transport) await ctx.transport.close().catch(() => {})
    const client = await tryGetDb().catch(() => null)
    if (client) {
      await client.query(`UPDATE agents SET status = 'offline' WHERE agent_id = $1`, [ctx.botId]).catch(() => {})
    }
  }
  if (httpServer) httpServer.close()
  await unregisterAgent()
  if (db) await db.end().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
