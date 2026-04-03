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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { Client } from 'pg'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash, createHmac } from 'node:crypto'
import { DiscordAdapter } from './adapters/discord'

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
const DISCORD_OUTBOUND_PORT = parseInt(process.env.DISCORD_OUTBOUND_PORT ?? String(WEBHOOK_PORT + 1000), 10)
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
const DISCORD_STATE_DIR_ENV = process.env.DISCORD_STATE_DIR ?? ''
const LOOP_WINDOW_MS = config.loop_detection.window_seconds * 1000

// --- Discord Adapter (Phase 5: integrated into server.ts) ---
const discord = new DiscordAdapter()
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

  // UPSERT
  await client.query(
    `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at, metadata)
     VALUES ($1, $2, $3, $4, 'online', now(), $5)
     ON CONFLICT (agent_id) DO UPDATE SET
       display_name = $2, agent_type = $3, runtime = $4,
       status = 'online', last_seen_at = now(), metadata = $5`,
    [AGENT_ID, config.agent.display_name, config.agent.agent_type, config.agent.runtime,
     config.agent.metadata ? JSON.stringify(config.agent.metadata) : null]
  )
  process.stderr.write(`agent-comms: agent '${AGENT_ID}' registered as online\n`)

  // Heartbeat every 5 minutes
  heartbeatInterval = setInterval(async () => {
    const c = await tryGetDb()
    if (c) {
      await c.query(`UPDATE agents SET last_seen_at = now() WHERE agent_id = $1`, [AGENT_ID]).catch(() => {})
    }
  }, 5 * 60 * 1000)
}

async function unregisterAgent(): Promise<void> {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  const client = await tryGetDb()
  if (client) {
    await client.query(`UPDATE agents SET status = 'offline' WHERE agent_id = $1`, [AGENT_ID]).catch(() => {})
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

// --- Push Notification Polling (§4.4 Phase 3) ---
const POLL_INTERVAL_MS = 3_000
const POLL_BATCH_SIZE = 10
let lastPolledAt = new Date().toISOString()
const processedIds = new Map<string, number>()  // id -> timestamp
const PROCESSED_ID_TTL_MS = 10 * 60_000  // 10 minutes (must outlive any re-fetch window)
let pollInterval: ReturnType<typeof setInterval> | null = null

async function pollNewMessages(): Promise<void> {
  const client = await tryGetDb()
  if (!client) return

  // GC: remove expired processedIds entries
  const now = Date.now()
  for (const [id, ts] of processedIds) {
    if (now - ts > PROCESSED_ID_TTL_MS) processedIds.delete(id)
  }

  try {
    // Use >= to catch messages at the same timestamp (dedup via processedIds).
    // Previously used > with JS Date (ms precision), which truncated PG's µs
    // timestamps, causing the same message to re-match after processedIds expired.
    const r = await client.query(
      `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
       FROM agent_messages WHERE metadata->>'to' = $1 AND author_id != $1 AND created_at >= $2
       ORDER BY created_at ASC LIMIT $3`,
      [AGENT_ID, lastPolledAt, POLL_BATCH_SIZE]
    )

    for (const msg of r.rows) {
      if (processedIds.has(msg.id)) continue
      processedIds.set(msg.id, Date.now())

      // Auth validation
      const authResult = validateIncomingAuth(
        msg.metadata, msg.author_id, msg.channel_id, msg.content
      )
      if (!authResult.valid) {
        process.stderr.write(`agent-comms: push rejected (auth ${config.auth.mode}): ${msg.id} from ${msg.author_id}\n`)
        continue
      }

      const tag = authResult.tag ? ` ${authResult.tag}` : ''
      const contentText = `[${msg.message_type ?? 'chat'}] ${msg.author_id} → #${msg.channel_id}:${tag} ${msg.content}`

      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: contentText,
          meta: {
            chat_id: msg.channel_id,
            message_id: msg.id,
            user: msg.author_id,
            user_id: msg.author_id,
            ts: new Date(msg.created_at).toISOString(),
            source: 'agent-comms',
          },
        },
      }).catch(err => {
        process.stderr.write(`agent-comms: push notification failed: ${err}\n`)
      })

      // Advance cursor past this message to prevent re-fetch after processedIds TTL expires.
      // Without +1ms, the `>= $2` query re-matches the same timestamp once processedIds
      // expires (10min), causing infinite re-delivery.
      const rawTs = msg.created_at instanceof Date
        ? msg.created_at.toISOString()
        : String(msg.created_at)
      const d = new Date(rawTs)
      d.setTime(d.getTime() + 1)  // +1ms (JS minimum precision)
      lastPolledAt = d.toISOString()
    }
  } catch (err) {
    process.stderr.write(`agent-comms: poll error (will retry): ${err}\n`)
  }
}

function startPolling(): void {
  pollInterval = setInterval(pollNewMessages, POLL_INTERVAL_MS)
  process.stderr.write(`agent-comms: push polling started (${POLL_INTERVAL_MS}ms interval)\n`)
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

// --- pg_notify LISTEN (Phase 5: integrated listener) ---
let listenClient: Client | null = null
let listenReconnectAttempts = 0
let listenReconnecting = false
let listenKeepaliveTimer: ReturnType<typeof setInterval> | null = null
const LISTEN_MAX_RECONNECT_DELAY_MS = 30_000
const LISTEN_KEEPALIVE_INTERVAL_MS = 60_000

async function startListener(): Promise<void> {
  if (!config.database_url) return

  try {
    const client = new Client({ connectionString: config.database_url })

    client.on('error', (err) => {
      process.stderr.write(`agent-comms: listener DB error: ${err.message}\n`)
      scheduleListenerReconnect()
    })

    client.on('end', () => {
      // Only reconnect if this is still the active client (not a stale one being cleaned up)
      if (client === listenClient) {
        process.stderr.write('agent-comms: listener DB connection closed\n')
        scheduleListenerReconnect()
      }
    })

    await client.connect()
    listenClient = client
    listenReconnectAttempts = 0
    listenReconnecting = false

    await client.query('LISTEN agent_inbox')
    process.stderr.write('agent-comms: pg_notify LISTEN started\n')

    // Keepalive: periodic lightweight query to detect stale connections
    stopKeepalive()
    listenKeepaliveTimer = setInterval(async () => {
      if (!listenClient || listenClient !== client) {
        stopKeepalive()
        return
      }
      try {
        await client.query('SELECT 1')
      } catch (err) {
        process.stderr.write(`agent-comms: listener keepalive failed: ${err}\n`)
        scheduleListenerReconnect()
      }
    }, LISTEN_KEEPALIVE_INTERVAL_MS)

    client.on('notification', async (msg) => {
      if (msg.channel !== 'agent_inbox' || !msg.payload) return

      try {
        const payload = JSON.parse(msg.payload) as { to: string; message_id: string }
        // Only process if this message is for us
        if (payload.to !== AGENT_ID) return

        // Dedup via processedIds
        if (processedIds.has(payload.message_id)) return

        // Fetch and deliver the message
        const dbClient = await tryGetDb()
        if (!dbClient) return

        const r = await dbClient.query(
          `SELECT id, channel_id, author_id, content, message_type, metadata, depth, created_at
           FROM agent_messages WHERE id = $1`,
          [payload.message_id]
        )

        if (r.rows.length === 0) return
        const row = r.rows[0]

        processedIds.set(row.id, Date.now())

        // Auth validation
        const authResult = validateIncomingAuth(
          row.metadata, row.author_id, row.channel_id, row.content
        )
        if (!authResult.valid) {
          process.stderr.write(`agent-comms: listener rejected (auth ${config.auth.mode}): ${row.id} from ${row.author_id}\n`)
          return
        }

        const tag = authResult.tag ? ` ${authResult.tag}` : ''
        const contentText = `[${row.message_type ?? 'chat'}] ${row.author_id} → #${row.channel_id}:${tag} ${row.content}`

        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: contentText,
            meta: {
              chat_id: row.channel_id,
              message_id: row.id,
              user: row.author_id,
              user_id: row.author_id,
              ts: new Date(row.created_at).toISOString(),
              source: 'agent-comms',
            },
          },
        }).catch(err => {
          process.stderr.write(`agent-comms: listener notification failed: ${err}\n`)
        })
      } catch (err) {
        process.stderr.write(`agent-comms: listener notification error: ${err}\n`)
      }
    })
  } catch (err) {
    process.stderr.write(`agent-comms: listener start failed: ${err}\n`)
    scheduleListenerReconnect()
  }
}

function stopKeepalive(): void {
  if (listenKeepaliveTimer) {
    clearInterval(listenKeepaliveTimer)
    listenKeepaliveTimer = null
  }
}

function scheduleListenerReconnect(): void {
  // Guard: prevent duplicate reconnection attempts from error+end firing together
  if (listenReconnecting) return
  listenReconnecting = true

  stopKeepalive()

  const delay = Math.min(1000 * Math.pow(2, listenReconnectAttempts), LISTEN_MAX_RECONNECT_DELAY_MS)
  listenReconnectAttempts++
  process.stderr.write(`agent-comms: listener reconnecting in ${delay}ms (attempt ${listenReconnectAttempts})\n`)
  setTimeout(async () => {
    try {
      // Detach old client before end() to prevent 'end' event from re-triggering reconnect
      const oldClient = listenClient
      listenClient = null
      if (oldClient) {
        await oldClient.end().catch(() => {})
      }
      await startListener()
    } catch (err) {
      process.stderr.write(`agent-comms: listener reconnect failed: ${err}\n`)
      listenReconnecting = false
      scheduleListenerReconnect()
    }
  }, delay)
}

function stopListener(): void {
  stopKeepalive()
  listenReconnecting = true // prevent reconnect on intentional stop
  const oldClient = listenClient
  listenClient = null
  if (oldClient) {
    oldClient.end().catch(() => {})
  }
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

// --- Inbox Signals ---
function sendInboxSignal(targetAgent: string, messageId: string, from: string, channel: string) {
  const dir = join(STATE_DIR, 'inbox', targetAgent)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `${Date.now()}-${messageId.slice(0, 8)}.signal`),
      JSON.stringify({ id: messageId, from, channel }))
  } catch (e) {
    process.stderr.write(`agent-comms: signal failed for ${targetAgent}: ${e}\n`)
  }
}

function countAndClearSignals(): number {
  const dir = join(STATE_DIR, 'inbox', AGENT_ID)
  let count = 0
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.signal'))
    count = files.length
    for (const f of files) unlinkSync(join(dir, f))
  } catch {}
  return count
}

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
const mcp = new Server(
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

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to another agent. Stored in DB, signal sent to target, optionally forwarded to Discord/Telegram/Slack/LINE.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string', description: 'Target agent ID' },
          channel: { type: 'string', description: 'Logical channel name' },
          content: { type: 'string', description: 'Message content' },
          message_type: { type: 'string', enum: ['instruction', 'report', 'approval', 'chat'], description: 'Default: chat' },
          reply_to: { type: 'string', description: 'Message ID to reply to' },
          depth: { type: 'number', description: 'Conversation depth (loop detection)' },
          metadata: { type: 'object', description: 'Additional metadata' },
        },
        required: ['to', 'channel', 'content'],
      },
    },
    {
      name: 'fetch_messages',
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
      name: 'check_inbox',
      description: 'Messages are automatically pushed to your session. Use this only to re-check history or filter by channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max messages (default: 20)' },
        },
      },
    },
    {
      name: 'reply',
      description: 'Reply to a Discord channel via agent-com Discord adapter. Use this to post messages to Discord.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'Discord channel or thread ID' },
          text: { type: 'string', description: 'Message text' },
          reply_to: { type: 'string', description: 'Discord message ID to reply to (optional)' },
        },
        required: ['chat_id', 'text'],
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
      name: 'list_agents',
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
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'send_message') {
    const { to, channel, content, message_type, reply_to, depth, metadata } = args as any

    // Access control: check if this agent is allowed to send to the channel
    const access = checkAccess(AGENT_ID, channel, content)
    if (!access.allowed) {
      return { content: [{ type: 'text', text: `ACCESS DENIED: ${access.reason}` }], isError: true }
    }

    // Rate limit
    const rate = await checkRateLimit(AGENT_ID)
    if (!rate.allowed) {
      return { content: [{ type: 'text', text: `RATE LIMITED: ${config.rate_limit.max_per_minute}/min exceeded` }], isError: true }
    }

    // Loop detection
    const msgDepth = depth ?? 0
    const loop = await checkLoop(AGENT_ID, to, msgDepth)
    if (loop.blocked) {
      return { content: [{ type: 'text', text: `LOOP BLOCKED: ${loop.reason}` }], isError: true }
    }

    // Duplicate check
    if (await checkDuplicate(content, to)) {
      return { content: [{ type: 'text', text: 'DUPLICATE: same message sent within 10s, skipped' }], isError: true }
    }

    // Burst control
    if (!checkBurst()) {
      await new Promise(r => setTimeout(r, BURST_MIN_INTERVAL_MS))
    }

    // Sanitize
    const safeContent = sanitizeContent(content)

    // Build metadata with HMAC auth signature
    const authMeta = createAuthMetadata(channel, safeContent)
    const fullMetadata = { ...metadata, to, ...authMeta }

    // Save to DB
    const id = await saveMessage({
      channel_id: channel, author_id: AGENT_ID, content: safeContent,
      message_type: message_type ?? 'chat', reply_to,
      metadata: fullMetadata, depth: msgDepth,
      source: 'agent-comms', direction: 'outbound', role: 'agent',
    })

    // pg_notify for Webhook channel push (Phase 4)
    try {
      const client = await tryGetDb()
      if (client) {
        await client.query(
          `SELECT pg_notify('agent_inbox', $1)`,
          [JSON.stringify({ to, message_id: id })]
        )
      }
    } catch (err) {
      process.stderr.write(`agent-comms: pg_notify failed (non-fatal): ${err}\n`)
    }

    // Signal + forward
    sendInboxSignal(to, id, AGENT_ID, channel)
    forwardAll(AGENT_ID, channel, safeContent, message_type ?? 'chat')

    return { content: [{ type: 'text', text: `sent (id: ${id}) to ${to} in #${channel}` }] }
  }

  if (name === 'fetch_messages') {
    const { channel, limit, since } = args as any
    const rows = await fetchMessages(channel, Math.min(limit ?? 20, 100), since)
    const text = rows.map((r: any) =>
      `[${r.created_at}] ${r.author_id}: ${r.content}  (id: ${r.id})`
    ).join('\n')
    return { content: [{ type: 'text', text: text || '(no messages)' }] }
  }

  if (name === 'check_inbox') {
    const { limit } = (args ?? {}) as any
    const signals = countAndClearSignals()
    const rows = await fetchNewMessages(AGENT_ID, Math.min(limit ?? 20, 100))
    if (rows.length === 0) return { content: [{ type: 'text', text: '(no new messages)' }] }
    const text = rows.map((r: any) =>
      `[${r.created_at}] ${r.author_id} → #${r.channel_id}: ${r.content}  (id: ${r.id})`
    ).join('\n\n')
    return { content: [{ type: 'text', text: `${rows.length} message(s):\n\n${text}` }] }
  }

  if (name === 'reply') {
    const { chat_id, text, reply_to } = args as any

    try {
      const result = await discord.sendMessage(chat_id, sanitizeContent(text), reply_to ? { replyTo: reply_to } : undefined)
      return { content: [{ type: 'text', text: `Sent to Discord (message_id: ${result.messageId})` }] }
    } catch (err) {
      // Fallback to HTTP if adapter not connected
      try {
        const resp = await fetch(`http://127.0.0.1:${DISCORD_OUTBOUND_PORT}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id, text: sanitizeContent(text), reply_to }),
        })
        const result = await resp.json() as any
        if (!resp.ok) {
          return { content: [{ type: 'text', text: `Discord reply failed: ${result.error ?? resp.statusText}` }], isError: true }
        }
        return { content: [{ type: 'text', text: `Sent to Discord (message_id: ${result.message_id})` }] }
      } catch (fallbackErr) {
        return { content: [{ type: 'text', text: `Discord reply failed: ${err}` }], isError: true }
      }
    }
  }

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
mcp.setNotificationHandler(
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
const DEFAULT_CLAUDE_CMD = 'claude --dangerously-load-development-channels server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions'

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

// --- Start ---
const transport = new StdioServerTransport()
mcp.connect(transport).then(async () => {
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

  // Phase 5: Connect Discord adapter (if token provided)
  if (DISCORD_BOT_TOKEN) {
    try {
      discord.onMessage((msg) => {
        // Dedup via processedIds
        if (processedIds.has(msg.id)) return
        processedIds.set(msg.id, Date.now())

        const atts = msg.attachments?.map(a => `${a.name} (${a.contentType}, ${(a.size / 1024).toFixed(0)}KB)`).join('; ')
        const content = msg.content || (atts ? '(attachment)' : '')

        // Persist to DB (non-fatal: INSERT failure does not block notification)
        saveMessage({
          channel_id: msg.channel,
          author_id: msg.author.id,
          content,
          message_type: 'chat',
          source: 'discord',
          direction: 'inbound',
          role: msg.author.isBot ? 'agent' : 'user',
          metadata: {
            discord_message_id: msg.id,
            discord_channel_id: msg.channel,
            author_name: msg.author.name,
            to: AGENT_ID,
            ...(atts ? { attachments: atts } : {}),
          },
        }).catch(err => {
          process.stderr.write(`agent-comms: discord message DB persist failed (non-fatal): ${err}\n`)
        })

        mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content,
            meta: {
              chat_id: msg.channel,
              message_id: msg.id,
              user: msg.author.name,
              user_id: msg.author.id,
              ts: msg.timestamp.toISOString(),
              source: 'discord',
              ...(atts ? { attachments: atts } : {}),
            },
          },
        }).catch(err => {
          process.stderr.write(`agent-comms: discord message injection failed: ${err}\n`)
        })
      })

      discord.onPermissionResponse(async (params) => {
        try {
          await mcp.notification({
            method: 'notifications/claude/channel/permission',
            params: { request_id: params.request_id, behavior: params.behavior },
          })
          process.stderr.write(`agent-comms: permission ${params.behavior} for ${params.request_id}\n`)
        } catch (err) {
          process.stderr.write(`agent-comms: permission notification failed: ${err}\n`)
        }
      })

      await discord.connect({
        token: DISCORD_BOT_TOKEN,
        stateDir: DISCORD_STATE_DIR_ENV || undefined,
      })
      process.stderr.write('agent-comms: Discord adapter connected (integrated)\n')
    } catch (err) {
      process.stderr.write(`agent-comms: WARNING — Discord adapter failed (non-fatal): ${err}\n`)
    }
  } else {
    process.stderr.write('agent-comms: DISCORD_BOT_TOKEN not set, Discord adapter disabled\n')
  }
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
