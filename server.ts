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
  isDaemonRuntime,
  setDbGetter as setOutboundConsumerDbGetter,
  type BufferedQueueRow,
} from './adapters/outbound-consumer'
import {
  startListener,
  stopListener,
  startPolling,
  stopPolling,
  pollNewMessages,
  handleInboundMessage,
  sendHumanWarning,
  setInboundReceiverDeps,
  type InboundRouteResult,
} from './adapters/inbound-receiver'
import { signPayload } from './shared/hmac'
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

  if (!existsSync(configPath)) {
    process.stderr.write(`agent-comms: config not found at ${configPath}\n`)
    process.stderr.write(`  Copy config.example.json to config.json and edit it.\n`)
    process.exit(1)
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
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
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
const DISCORD_STATE_DIR_ENV = process.env.DISCORD_STATE_DIR ?? ''
const LOOP_WINDOW_MS = config.loop_detection.window_seconds * 1000

// --- SSE Transport (Phase 3) ---
const TRANSPORT_MODE = process.env.TRANSPORT_MODE ?? 'stdio'
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
const connectedBots = new Map<string, { transport: SSEServerTransport; connected_at: string; last_activity: string }>()

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
// Returns null when the DB is unavailable, matching the existing fallback semantics.
async function coreDbAdapter(): Promise<DbAdapter | null> {
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

// Cursor-based read tracking for check_inbox (SSOT §9.4)
let lastReadId: string | null = null

async function fetchNewMessages(forAgent: string, limit: number): Promise<any[]> {
  const client = await tryGetDb()
  if (!client) return [] // DBなしモード: 空配列
  const params: any[] = [forAgent, limit]
  let whereClause = `metadata->>'to' = $1 AND author_id != $1`
  if (lastReadId) {
    whereClause += ` AND id > $3`
    params.push(lastReadId)
  }
  const r = await client.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
     FROM agent_messages WHERE ${whereClause}
     ORDER BY created_at ASC LIMIT $2`,
    params)
  // Update cursor to the max id returned
  if (r.rows.length > 0) {
    lastReadId = r.rows[r.rows.length - 1].id
  }
  return r.rows
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
  await client.query(
    `SELECT pg_notify('agent_events', $1)`,
    [JSON.stringify({ event: 'agent.online', agent_id: AGENT_ID, org_id: 'default' })]
  ).catch(() => {})
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
  pollingDriver.start(AGENT_ID)

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
    await client.query(
      `SELECT pg_notify('agent_events', $1)`,
      [JSON.stringify({ event: 'agent.offline', agent_id: AGENT_ID, org_id: 'default' })]
    ).catch(() => {})
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
interface AccessConfig {
  dmPolicy: 'open' | 'pairing'
  allowFrom: string[]
  channels: Record<string, {
    requireMention: boolean
    allowFrom: string[]
  }>
  mentionPatterns: string[]
  pending: Record<string, { user_id: string; requested_at: string }>
}

function loadAccessConfig(): AccessConfig {
  const accessPath = join(STATE_DIR, 'access.json')
  try {
    return JSON.parse(readFileSync(accessPath, 'utf-8'))
  } catch {
    return { dmPolicy: 'open', allowFrom: [], channels: {}, mentionPatterns: [], pending: {} }
  }
}

function checkAccess(authorId: string, channelId: string, content: string): { allowed: boolean; reason?: string } {
  const access = loadAccessConfig()

  // Global allowFrom
  if (access.allowFrom.length > 0 && !access.allowFrom.includes(authorId)) {
    return { allowed: false, reason: 'not in global allowFrom list' }
  }

  // Channel-specific rules
  const channelRules = access.channels[channelId]
  if (channelRules) {
    if (channelRules.allowFrom.length > 0 && !channelRules.allowFrom.includes(authorId)) {
      return { allowed: false, reason: `not in allowFrom for channel ${channelId}` }
    }
    if (channelRules.requireMention) {
      const mentioned = access.mentionPatterns.some(p => content.includes(p))
      if (!mentioned) {
        return { allowed: false, reason: 'mention required but not found' }
      }
    }
  }

  return { allowed: true }
}

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
setInboundReceiverDeps({
  agentId: AGENT_ID,
  authMode: config.auth.mode,
  databaseUrl: config.database_url,
  receiverPipelineBots: RECEIVER_PIPELINE_BOTS,
  processedIds,
  tryGetDb,
  coreDbAdapter,
  saveMessage,
  mcpNotification: (m) => mcp.notification(m as any),
  validateIncomingAuth,
  buildQuoteBlock,
  updateActiveThread,
  hashCode,
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
    // focus/unfocus removed — reply_to is required (channel-thread-control-spec §4.2)
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
        await client.query(
          `UPDATE message_queue SET status = 'skipped' WHERE id = $1 AND status = 'read'`,
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
      await client.query(
        `UPDATE agents SET current_message_id = $1 WHERE agent_id = $2`,
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

      // pg_notify (per part)
      try {
        if (dbClient) {
          await dbClient.query(
            `SELECT pg_notify('agent_inbox', $1)`,
            [JSON.stringify({ event: 'message.created', to: dest.channelId, message_id: id, channel_id: dest.channelId })]
          )
        }
      } catch (err) {
        process.stderr.write(`agent-comms: pg_notify failed (non-fatal): ${err}\n`)
      }

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

      // Issue #129 Phase 3: outbound_queue INSERT (replaces direct
      // sendAdapterMessage call). The receiver-side outbound consumer
      // (startOutboundConsumer / consumeOneOutboundRow above) picks the row
      // up on its 1-second tick and posts to Discord. This decouples the
      // send-tool from the (potentially slow) outbound HTTP call so the
      // tool returns as soon as the DB is durable.
      //
      // Resolution order for channel_external_id:
      //   1. If dest.threadId is set, prefer thread_adapters so the post
      //      lands in the same thread (threads are channels in Discord's API).
      //   2. Otherwise fall back to channel_adapters for the parent channel.
      if (client) {
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
          // ARC codex audit (PR#135, lead-ama msg 1492293367835660500): the
          // outbound_queue INSERT must NOT be silently swallowed. Phase 3
          // makes the queue the sole outbound delivery path, so a failed
          // INSERT means the Discord reply is permanently lost (the
          // consumer never sees the row). The CLI rolls back its
          // transaction on the same failure; the send tool must mirror
          // that durability contract by surfacing the failure as an error
          // result so the caller knows their message was DB-saved but
          // never queued for delivery.
          try {
            await client.query(
              `INSERT INTO outbound_queue (message_id, agent_id, channel_external_id, content)
               VALUES ($1, $2, $3, $4)`,
              [id, agentId, externalId, truncateForPlatform(partContent, 'discord')],
            )
          } catch (err) {
            process.stderr.write(`agent-comms: outbound_queue INSERT failed: ${err}\n`)
            await writeAuditLog('outbound.enqueue_failed', agentId, dest.channelId, {
              code: 'OUTBOUND_ENQUEUE_FAILED',
              message_id: id,
              channel_external_id: externalId,
              error: String(err).slice(0, 500),
            })
            return {
              content: [{
                type: 'text',
                text: `Error [OUTBOUND_ENQUEUE_FAILED]: Discord配信キューへの登録に失敗しました。メッセージはDB保存済み (message_id: ${id}) ですが、Discordには配信されません。原因: ${String(err).slice(0, 200)}`,
              }],
              isError: true,
            }
          }
        }
      }

      // Also forward via legacy forwarding config
      forwardAll(agentId, dest.channelId, partContent, message_type ?? 'chat')

      // Inter-part delay: keep the Discord client from burst-hitting the
      // outbound rate limit and preserve the visual ordering in the UI.
      // Skip after the last part.
      if (partIdx < parts.length - 1) {
        await new Promise(r => setTimeout(r, 150))
      }
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

    // Issue #130 Phase 4: finalize message_queue state after successful send.
    // Primary path: if the bot used MCP `next`, agents.current_message_id points
    // at the claimed row. Mark it 'replied' and clear current_message_id.
    //
    // ADR-048 Phase 0 D3 fallback: bots that receive via channel-plugin session
    // injection never call `next`, so current_message_id stays NULL and the
    // queue row would stagnate at 'pending'. When reply_to is provided, look up
    // the matching message_queue row by (agent_id, message_id=reply_to) — the
    // partial UNIQUE uq_mq_agent_message (v1.0.3 §3.2) guarantees uniqueness so
    // this is a single-row UPDATE with no ambiguity. Status filter restricts to
    // ('pending','read') so an already-replied row isn't overwritten.
    if (dbClient) {
      const agentRow = await dbClient.query(
        `SELECT current_message_id FROM agents WHERE agent_id = $1`,
        [agentId],
      )
      const currentMqId = agentRow.rows[0]?.current_message_id
      if (currentMqId) {
        await dbClient.query(
          `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1 WHERE id = $2`,
          [id, currentMqId],
        )
        await dbClient.query(
          `UPDATE agents SET current_message_id = NULL WHERE agent_id = $1`,
          [agentId],
        )
      } else if (reply_to) {
        try {
          const res = await dbClient.query(
            `UPDATE message_queue SET status = 'replied', replied_at = now(), replied_with = $1
             WHERE agent_id = $2 AND message_id = $3 AND status IN ('pending', 'read')`,
            [id, agentId, reply_to],
          )
          process.stderr.write(JSON.stringify({
            event: 'd3_fallback_replied',
            agent_id: agentId, reply_to, replied_with: id,
            row_count: res.rowCount ?? 0,
          }) + '\n')
          if ((res.rowCount ?? 0) === 0) {
            await writeAuditLog('d3.fallback.miss', agentId, null, { reply_to, replied_with: id })
          }
        } catch (err) {
          const failureReason = err instanceof Error ? err.message : String(err)
          process.stderr.write(JSON.stringify({
            event: 'd3_fallback_error',
            agent_id: agentId, reply_to, replied_with: id,
            failure_reason: failureReason,
          }) + '\n')
          await writeAuditLog('d3.fallback.error', agentId, null, {
            reply_to, replied_with: id, failure_reason: failureReason,
          }).catch(() => {})
        }
      }
    }

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
  }

  // focus/unfocus removed — destination is derived deterministically from reply_to.
  // last_received_context fallback was also abolished on 2026-04-08 (PR#89) for the same reason.

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

// Active bot contexts (daemon mode)
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
const DEFAULT_CLAUDE_CMD = 'AGENT_COM_RUNTIME=daemon claude server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions'

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

  // 5. Verify startup
  Bun.sleepSync(5000)
  const output = tmuxCapture(entry.session, 10)
  if (output.includes('Listening for channel messages')) {
    log.push(`✅ Confirmed: Listening for channel messages`)
  } else {
    log.push(`⚠️ Not yet confirmed — may still be initializing`)
  }

  return log.join('\n')
}

function checkBotHealth(entry: BotEntry): { status: string; details: string } {
  // Check 1: tmux session
  if (!tmuxHasSession(entry.session)) {
    return { status: 'dead', details: 'tmux session not found' }
  }

  const output = tmuxCapture(entry.session, 30)

  // Check 2: crash patterns
  if (/panic|fatal|SIGKILL|segmentation fault|killed|out of memory/i.test(output)) {
    return { status: 'crashed', details: 'crash pattern detected' }
  }

  // Check 3: channel plugin mode
  if (output.includes('❯') && !output.includes('Listening for channel messages')) {
    if (!output.includes('dangerously-load-development-channels')) {
      return { status: 'misconfigured', details: 'not in channel plugin mode (bare claude)' }
    }
  }

  // Check 4: shell prompt (Claude exited)
  const lastLine = output.split('\n').filter(l => l.trim()).pop() ?? ''
  if (/^\S+@\S+ .+ % $|^\$ $/.test(lastLine)) {
    return { status: 'exited', details: 'Claude Code exited to shell prompt' }
  }

  // Check 5: port status
  const pids = getProcessOnPort(entry.port)
  const portInfo = pids.length > 0 ? `port ${entry.port} in use (PID: ${pids.join(',')})` : `port ${entry.port} free`

  if (output.includes('Listening for channel messages')) {
    return { status: 'healthy', details: `listening + ${portInfo}` }
  }

  return { status: 'initializing', details: `session exists, ${portInfo}` }
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

// --- Post-connect setup (shared by both stdio and SSE modes) ---
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
  // Start push notification polling (Phase 3)
  startPolling()

  // Phase 5: Start integrated pg_notify listener
  try {
    await startListener()
  } catch (err) {
    process.stderr.write(`agent-comms: WARNING — pg_notify listener start failed (non-fatal): ${err}\n`)
  }

  // Phase 5: Connect Discord adapter (if token provided, stdio/channel-plugin mode)
  // ADR-041 S2-B: this stdio-mode `discord.onMessage` is the SOLE callsite of
  // `handleInboundMessage` (i.e. sole inbound routing / message_queue INSERT
  // source). daemon mode per-bot Discord clients MUST NOT bind onMessage at
  // all; daemon shared Discord client binds a MINIMAL onMessage that ONLY
  // emits `sendHumanWarning` (no handleInboundMessage, no message_queue).
  // See: docs/agent-com-message-queue-spec.md §2 原則 #2 (受信は1プロセス).
  if (DISCORD_BOT_TOKEN && TRANSPORT_MODE !== 'daemon') {
    try {
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
          if (result.delivered && result.pushMeta) {
            await mcp.notification({
              method: 'notifications/claude/channel',
              params: { content, meta: result.pushMeta },
            })
          } else if (!result.delivered) {
            process.stderr.write(`agent-comms: inbound not delivered — ${result.reason} (msg: ${msg.id})\n`)
          }
          // §2.2 Pattern A: human warning (no mentions)
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

      // ADR-040 D1: stdio/sse mode owns one adapter for AGENT_ID, so the ready
      // handler can self-register discord_id for this agent on every connect.
      discord.setAgentId(AGENT_ID)

      await discord.connect({
        token: DISCORD_BOT_TOKEN,
        stateDir: DISCORD_STATE_DIR_ENV || undefined,
      })
      process.stderr.write('agent-comms: Discord adapter connected (channel plugin mode)\n')
      // Hotfix (post-#164): outbound consumer gates on isDaemonRuntime()
      // (AGENT_COM_RUNTIME=daemon) while per-bot `discordClients` population
      // is gated on TRANSPORT_MODE === 'daemon'. Fleet bots set the former
      // but not the latter (default 'stdio'), so consumeOneOutboundRow()
      // found an empty Map and failed every row with
      // 'no_discord_client_for_agent'. In stdio/channel-plugin mode each
      // process is a single-bot daemon: the shared `discord` adapter is
      // connected with this bot's own DISCORD_BOT_TOKEN, so registering it
      // under AGENT_ID restores per-bot outbound delivery without
      // re-introducing cross-identity fallback.
      discordClients.set(AGENT_ID, discord)

      // 2026-04-14 phasing revival (CEO directive Task 1, post-PR-#172
      // cycle 2): current production launch path is
      // `claude server:agent-comms` → server.ts (stdio MCP) with
      // AGENT_COM_RUNTIME=daemon set in the shell. entrypoints/daemon.ts
      // has no supervise wrapper yet, so until it ships, server.ts must
      // also start the outbound consumer when it sees the daemon flag
      // — otherwise no process drains outbound_queue.
      //
      // The bootstrap sits AFTER `discordClients.set(AGENT_ID, discord)`
      // so the first consumer tick can resolve the client for this
      // agent. Placing it inside registerAgent() (the obvious spot) was
      // tried in cycle 1 and lost the race: the 1s tick fired before
      // discord.connect() resolved, and every claimed row was flipped
      // to `status='failed', last_error='no_discord_client_for_agent'`
      // (outbound-consumer.ts §3.6 fallback-removed branch).
      //
      // The consumer's own isDaemonRuntime() gate stays in place so a
      // pure stdio MCP server (no daemon flag) still skips. When the
      // supervise base for daemon.ts is shipped, remove this call and
      // restore the daemon-only invariant.
      if (isDaemonRuntime()) {
        startOutboundConsumer()
      }
    } catch (err) {
      process.stderr.write(`agent-comms: WARNING — Discord adapter failed (non-fatal): ${err}\n`)
    }
  } else if (!DISCORD_BOT_TOKEN) {
    process.stderr.write('agent-comms: DISCORD_BOT_TOKEN not set, Discord adapter disabled\n')
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

// --- SSE Transport: Health endpoint ---
function getHealthStatus(): { status: string; uptime: number; connected_bots: Record<string, { connected_at: string; last_activity: string }>; expected_bots: string[] } {
  const uptimeSeconds = Math.floor((Date.now() - sseStartTime) / 1000)
  const bots: Record<string, { connected_at: string; last_activity: string }> = {}

  // Support both legacy connectedBots (sse mode) and botContexts (daemon / receiver mode).
  // ADR-041 PR-B: receiver mode shares the daemon's per-bot MCP factory, so the health
  // check enumerates the same `botContexts` map for both.
  const daemonLike = TRANSPORT_MODE === 'daemon' || TRANSPORT_MODE === 'receiver'
  if (daemonLike) {
    for (const [botId, ctx] of botContexts) {
      bots[botId] = { connected_at: ctx.connectedAt, last_activity: ctx.lastActivity }
    }
  } else {
    for (const [botId, info] of connectedBots) {
      bots[botId] = { connected_at: info.connected_at, last_activity: info.last_activity }
    }
  }

  let status = 'ok'
  if (EXPECTED_BOTS.length > 0) {
    const activeBots = daemonLike ? botContexts : connectedBots
    const missing = EXPECTED_BOTS.filter(b => !activeBots.has(b))
    if (missing.length === EXPECTED_BOTS.length) {
      status = 'error'
    } else if (missing.length > 0) {
      status = 'degraded'
    }
  }

  return { status, uptime: uptimeSeconds, connected_bots: bots, expected_bots: EXPECTED_BOTS }
}

// --- Start ---
// ADR-041 PR-B: `receiver` is a new transport mode that shares every piece
// of daemon setup (httpServer, per-bot MCP factories, per-bot Discord
// clients). It does NOT open a second Gateway connection for the already-
// connected auditor token — reusing the existing connection is the
// explicit safety constraint in ADR-041 rev4 after today's twin-connection
// cascade (see ADR-040 G1).
//
// For PR-B the behavioural delta from `daemon` is intentionally small:
// receiver mode logs an explicit activation line and exposes a helper so
// downstream code can branch on `IS_RECEIVER_MODE`. The actual single-
// Discord-connection fanout (i.e. shutting off other bots' per-bot
// Gateway clients and letting auditor's onMessage do the pg_notify
// fan-out for everyone) is a follow-up PR-B.2 — the retreat path (a)
// pull-on-notify semantics stay on the existing 3-second polling
// (`POLL_INTERVAL_MS`), which is already in production.
//
// Ref: ADR-041 rev4 PoC token strategy — auditor bot is the interim
// receiver, Phase B introduces a dedicated `agent-com-receiver` bot.
const IS_RECEIVER_MODE = TRANSPORT_MODE === 'receiver'
if (IS_RECEIVER_MODE) {
  process.stderr.write(
    `agent-comms: TRANSPORT_MODE='receiver' active — reusing daemon setup, auditor bot owns inbound fanout (ADR-041 rev4)\n`,
  )
}

if (TRANSPORT_MODE === 'daemon' || IS_RECEIVER_MODE) {
  // Daemon mode: Per-Bot Server Factory (Phase 3b)
  // Each bot_id gets its own MCP Server instance with bot-specific AGENT_ID
  const daemonTransports = new Map<string, SSEServerTransport>()

  const httpServer = createServer(async (req, res) => {
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
      // Issue #130 Phase 4: clearPushFailureWarning(botId) removed.

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
            await client.query(
              `SELECT pg_notify('agent_events', $1)`,
              [JSON.stringify({ event: 'agent.online', agent_id: botId, org_id: 'default' })]
            ).catch(() => {})
          }
        } catch (err) {
          process.stderr.write(`agent-comms: daemon agent registration failed for ${botId} (non-fatal): ${err}\n`)
        }

        // Phase 3c: Per-Bot Discord Client (On-Demand)
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
            // ADR-041 S2-B: daemon per-bot Discord client is outbound-only.
            // No onMessage binding; handleInboundMessage is invoked only from
            // the stdio-mode adapter.
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
        process.stderr.write(`agent-comms: daemon message handling error: ${err}\n`)
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

  // Daemon-specific postConnect: shared resources only (Discord, listener, polling)
  ;(async () => {
    // Start push notification polling
    startPolling()

    // Start pg_notify listener
    try {
      await startListener()
    } catch (err) {
      process.stderr.write(`agent-comms: WARNING — pg_notify listener start failed (non-fatal): ${err}\n`)
    }

    // Connect Per-Bot Discord Clients for all expected bots at startup
    // This ensures bots in stdio mode (not SSE-connected) still have Discord presence
    for (const botId of EXPECTED_BOTS) {
      if (discordClients.has(botId)) continue
      const tokenResult = await resolveDiscordToken(botId)
      if (tokenResult && tokenResult.source === 'per-bot') {
        const botDiscord = await connectBotDiscord(botId, tokenResult.token)
        if (botDiscord) {
          discordClients.set(botId, botDiscord)
          // ADR-041 S2-B: startup daemon per-bot Discord client is outbound-only.
          // No onMessage binding; handleInboundMessage is invoked only from
          // the stdio-mode adapter.
          process.stderr.write(`agent-comms: startup Discord client for ${botId} (${tokenResult.source}, outbound-only)\n`)
        }
      }
      // Staggered connect delay
      if (EXPECTED_BOTS.indexOf(botId) < EXPECTED_BOTS.length - 1) {
        await new Promise(r => setTimeout(r, STAGGERED_CONNECT_DELAY_MS))
      }
    }

    // Connect Discord shared adapter (outbound / admin fallback for bots
    // without a per-bot token). ADR-041 S2-B: the stdio-mode adapter owns
    // inbound (handleInboundMessage / message_queue INSERT); daemon MUST NOT
    // bind onMessage for inbound routing. The connection itself is retained
    // so outbound REST + admin paths keep working for shared-token
    // deployments.
    //
    // §2.2 Pattern A human-warning path: daemon retains a minimal onMessage
    // binding that *only* emits sendHumanWarning (no handleInboundMessage,
    // no message_queue INSERT). This preserves the human-warning UX in
    // shared-token configurations where the author posts without mentions.
    // sendHumanWarning uses pg_try_advisory_lock for cross-process dedup,
    // so firing from both stdio and daemon is safe.
    if (DISCORD_BOT_TOKEN) {
      try {
        discord.onMessage((msg) => {
          // §2.2 Pattern A only — no inbound routing, no DB writes.
          const isHuman = !msg.author.isBot
          const noMentions = !msg.mentionUserIds || msg.mentionUserIds.length === 0
          const noReply = !msg.replyTo
          if (isHuman && noMentions && noReply) {
            sendHumanWarning(discord, msg.channel, msg.id)
          }
        })
        // No stateDir for daemon shared client — outbound/admin only
        await discord.connect({ token: DISCORD_BOT_TOKEN })
        process.stderr.write(`agent-comms: daemon Discord adapter connected (outbound/admin + human-warning only)\n`)
      } catch (err) {
        process.stderr.write(`agent-comms: WARNING — daemon Discord connection failed (non-fatal): ${err}\n`)
      }
    }

    // ADR-041 S2-B advisory notice: daemon alone does NOT invoke
    // handleInboundMessage. If no stdio-mode adapter is running (separate
    // process), inbound Discord messages will not be routed to message_queue.
    // Operators must ensure a stdio receiver is co-deployed. This is an
    // advisory log only — NOT a fail-fast guard. See
    // docs/agent-com-message-queue-spec.md §2 原則 #2.
    process.stderr.write(`agent-comms: [S2-B advisory] daemon mode is outbound-only for Discord inbound routing. Ensure a stdio-mode receiver is co-deployed, or inbound messages will not be processed. See spec §2 / ADR-041.\n`)
  })()

  httpServer.listen(SSE_PORT, () => {
    process.stderr.write(`agent-comms: daemon listening on http://127.0.0.1:${SSE_PORT} (Per-Bot Server Factory)\n`)
    process.stderr.write(`agent-comms: endpoints: GET /sse?bot_id=<id>, GET /health, POST /messages\n`)
  })

  const shutdown = async () => {
    stopPolling()
    stopListener()
    await discord.disconnect().catch(() => {})
    // Disconnect all per-bot Discord clients
    for (const [botId, client] of discordClients) {
      await client.disconnect().catch(() => {})
      process.stderr.write(`agent-comms: per-bot Discord disconnected for ${botId} (shutdown)\n`)
    }
    discordClients.clear()
    bridgeServer.stop()
    // Close all per-bot transports
    for (const [, ctx] of botContexts) {
      if (ctx.transport) await ctx.transport.close().catch(() => {})
      // Mark bot offline
      const client = await tryGetDb().catch(() => null)
      if (client) {
        await client.query(`UPDATE agents SET status = 'offline' WHERE agent_id = $1`, [ctx.botId]).catch(() => {})
      }
    }
    httpServer.close()
    if (db) await db.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

} else if (TRANSPORT_MODE === 'sse') {
  // SSE HTTP server mode
  const sseTransports = new Map<string, SSEServerTransport>()
  let httpServer: ReturnType<typeof createServer>

  httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Health endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      if (!authenticateRequest(req, res)) return
      const health = getHealthStatus()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(health))
      return
    }

    // SSE endpoint — per-bot connection (graceful reconnect)
    if (url.pathname === '/sse' && req.method === 'GET') {
      if (!authenticateRequest(req, res)) return
      const botId = url.searchParams.get('bot_id') ?? AGENT_ID

      // Graceful reconnect: if same bot_id reconnects, close old transport first
      const existing = connectedBots.get(botId)
      if (existing) {
        process.stderr.write(`agent-comms: SSE replacing existing connection for bot_id=${botId}\n`)
        sseTransports.delete(existing.transport.sessionId)
        await existing.transport.close().catch(() => {})
        connectedBots.delete(botId)
      }

      process.stderr.write(`agent-comms: SSE connection from bot_id=${botId}\n`)

      try {
        const transport = new SSEServerTransport('/messages', res)
        const sessionId = transport.sessionId
        sseTransports.set(sessionId, transport)
        connectedBots.set(botId, {
          transport,
          connected_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
        })

        res.on('close', () => {
          process.stderr.write(`agent-comms: SSE disconnected bot_id=${botId} session=${sessionId}\n`)
          sseTransports.delete(sessionId)
          // Only delete if this is still the current entry (not replaced by reconnect)
          const current = connectedBots.get(botId)
          if (current && current.transport.sessionId === sessionId) {
            connectedBots.delete(botId)
          }
        })

        await mcp.connect(transport)
        await postConnect()
      } catch (err) {
        process.stderr.write(`agent-comms: SSE connection error: ${err}\n`)
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
      const transport = sseTransports.get(sessionId)
      if (!transport) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No transport found for sessionId' }))
        return
      }

      // Update last_activity for the bot using this transport
      for (const [botId, info] of connectedBots) {
        if (info.transport === transport) {
          info.last_activity = new Date().toISOString()
          break
        }
      }

      try {
        await transport.handlePostMessage(req, res)
      } catch (err) {
        process.stderr.write(`agent-comms: SSE message handling error: ${err}\n`)
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
    process.stderr.write(`agent-comms: SSE server listening on http://127.0.0.1:${SSE_PORT}\n`)
    process.stderr.write(`agent-comms: endpoints: GET /sse, GET /health, POST /messages\n`)
  })

  const shutdown = async () => {
    stopPolling()
    stopListener()
    await discord.disconnect().catch(() => {})
    bridgeServer.stop()
    // Close all SSE transports
    for (const [, transport] of sseTransports) {
      await transport.close().catch(() => {})
    }
    httpServer.close()
    await unregisterAgent()
    if (db) await db.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

} else {
  // Stdio mode (default, unchanged)
  const transport = new StdioServerTransport()
  mcp.connect(transport).then(async () => {
    await postConnect()
  }).catch(err => {
    process.stderr.write(`agent-comms: startup failed: ${err}\n`)
    process.exit(1)
  })

  const shutdown = async () => {
    stopPolling()
    stopListener()
    await discord.disconnect().catch(() => {})
    bridgeServer.stop()
    await unregisterAgent()
    if (db) await db.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
