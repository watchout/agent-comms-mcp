#!/usr/bin/env bun
/**
 * Agent Communications MCP Plugin
 *
 * Bot-to-bot messaging for Claude Code sessions.
 * Design inspired by Discord (DB as truth, Gateway-style signals)
 * and Telegram (per-channel retention, auto-delete).
 *
 * All configuration lives in config.json (see config.example.json).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Client } from 'pg'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// --- Load Config ---
interface Config {
  agent_id: string
  database_url: string
  channels: Record<string, { retention_days: number | null; description?: string }>
  rate_limit: { max_per_minute: number }
  loop_detection: { max_depth: number; max_count: number; window_seconds: number }
  auth: { token: string | null }
  forwarding: {
    discord: { webhook_url: string | null }
    telegram: { bot_token: string | null; chat_id: string | null }
  }
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
    auth: { token: process.env.AGENT_COMMS_TOKEN ?? raw.auth?.token ?? null },
    forwarding: {
      discord: { webhook_url: process.env.DISCORD_WEBHOOK_URL ?? raw.forwarding?.discord?.webhook_url ?? null },
      telegram: {
        bot_token: process.env.TELEGRAM_BOT_TOKEN ?? raw.forwarding?.telegram?.bot_token ?? null,
        chat_id: process.env.TELEGRAM_CHAT_ID ?? raw.forwarding?.telegram?.chat_id ?? null,
      },
    },
  }
}

const config = loadConfig()
const AGENT_ID = config.agent_id
const LOOP_WINDOW_MS = config.loop_detection.window_seconds * 1000
const INBOX_SIGNAL_TTL_MS = 5 * 60 * 1000
const GC_INTERVAL_MS = 5 * 60 * 1000

// --- State ---
const loopCounters = new Map<string, { count: number; since: number }>()
const rateCounts = new Map<string, { count: number; since: number }>()

// --- DB ---
let db: Client | null = null

async function getDb(): Promise<Client> {
  if (!db) {
    db = new Client({ connectionString: config.database_url })
    await db.connect()
  }
  return db
}

async function saveMessage(msg: {
  channel_id: string; author_id: string; content: string
  message_type?: string; reply_to?: string
  metadata?: Record<string, unknown>; depth?: number
}): Promise<string> {
  const client = await getDb()
  const id = randomUUID()
  await client.query(
    `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, reply_to, metadata, depth)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, msg.channel_id, msg.author_id, msg.content, msg.message_type ?? 'chat',
     msg.reply_to ?? null, msg.metadata ? JSON.stringify(msg.metadata) : null, msg.depth ?? 0]
  )
  return id
}

async function fetchMessages(channel_id: string, limit: number, since?: string): Promise<any[]> {
  const client = await getDb()
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

async function fetchNewMessages(forAgent: string, limit: number): Promise<any[]> {
  const client = await getDb()
  const r = await client.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
     FROM agent_messages WHERE metadata->>'to' = $1 AND author_id != $1
     ORDER BY created_at DESC LIMIT $2`,
    [forAgent, limit])
  return r.rows.reverse()
}

// --- Rate Limiting ---
function checkRateLimit(agentId: string): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const r = rateCounts.get(agentId) ?? { count: 0, since: now }
  if (now - r.since > 60_000) { r.count = 0; r.since = now }
  r.count++
  rateCounts.set(agentId, r)
  const remaining = Math.max(0, config.rate_limit.max_per_minute - r.count)
  return { allowed: r.count <= config.rate_limit.max_per_minute, remaining }
}

// --- Loop Detection ---
function checkLoop(from: string, to: string, depth: number): { blocked: boolean; reason?: string } {
  if (depth > config.loop_detection.max_depth) {
    return { blocked: true, reason: `depth ${depth} > ${config.loop_detection.max_depth}` }
  }
  const key = [from, to].sort().join(':')
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

// --- Auth ---
function validateAuth(token?: string): boolean {
  if (!config.auth.token) return true  // no token configured = open (local-only mode)
  return token === config.auth.token
}

// --- Inbox Signals ---
function sendInboxSignal(targetAgent: string, messageId: string, from: string, channel: string) {
  const dir = join(homedir(), '.claude', 'channels', `agent-comms-${targetAgent}`, 'inbox')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `${Date.now()}-${messageId.slice(0, 8)}.signal`),
      JSON.stringify({ id: messageId, from, channel }))
  } catch (e) {
    process.stderr.write(`agent-comms: signal failed for ${targetAgent}: ${e}\n`)
  }
}

function countAndClearSignals(): number {
  const dir = join(homedir(), '.claude', 'channels', `agent-comms-${AGENT_ID}`, 'inbox')
  let count = 0
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.signal'))
    count = files.length
    for (const f of files) unlinkSync(join(dir, f))
  } catch {}
  return count
}

// --- Forwarding ---
async function forwardToDiscord(author: string, channel: string, content: string, type: string) {
  const url = config.forwarding.discord.webhook_url
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `${author} (agent-comms)`,
        content: `**[${type}]** #${channel}\n${content}`.slice(0, 2000),
      }),
    })
  } catch (e) {
    process.stderr.write(`agent-comms: discord forward failed: ${e}\n`)
  }
}

async function forwardToTelegram(author: string, channel: string, content: string, type: string) {
  const { bot_token, chat_id } = config.forwarding.telegram
  if (!bot_token || !chat_id) return
  try {
    const text = `🤖 *${author}* → #${channel}\n[${type}] ${content}`.slice(0, 4096)
    await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
    })
  } catch (e) {
    process.stderr.write(`agent-comms: telegram forward failed: ${e}\n`)
  }
}

// --- Periodic GC ---
function gc() {
  const now = Date.now()
  // Stale signals
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
  // Expired counters
  for (const [k, v] of loopCounters) if (now - v.since > LOOP_WINDOW_MS) loopCounters.delete(k)
  for (const [k, v] of rateCounts) if (now - v.since > 60_000) rateCounts.delete(k)
}
setInterval(gc, GC_INTERVAL_MS)

// --- MCP Server ---
const mcp = new Server(
  { name: 'agent-comms', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to another agent. Stored in DB, signal sent to target inbox, optionally forwarded to Discord/Telegram.',
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
          auth_token: { type: 'string', description: 'Auth token (required if auth is configured)' },
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
      description: 'Check for new messages addressed to this agent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max messages (default: 20)' },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'send_message') {
    const { to, channel, content, message_type, reply_to, depth, metadata, auth_token } = args as any

    if (!validateAuth(auth_token)) {
      return { content: [{ type: 'text', text: 'AUTH FAILED: invalid or missing token' }], isError: true }
    }

    const rate = checkRateLimit(AGENT_ID)
    if (!rate.allowed) {
      return { content: [{ type: 'text', text: `RATE LIMITED: ${config.rate_limit.max_per_minute}/min exceeded` }], isError: true }
    }

    const msgDepth = depth ?? 0
    const loop = checkLoop(AGENT_ID, to, msgDepth)
    if (loop.blocked) {
      return { content: [{ type: 'text', text: `LOOP BLOCKED: ${loop.reason}` }], isError: true }
    }

    const id = await saveMessage({
      channel_id: channel, author_id: AGENT_ID, content,
      message_type: message_type ?? 'chat', reply_to,
      metadata: { ...metadata, to }, depth: msgDepth,
    })

    sendInboxSignal(to, id, AGENT_ID, channel)

    // Forward to external services (fire-and-forget)
    const type = message_type ?? 'chat'
    forwardToDiscord(AGENT_ID, channel, content, type)
    forwardToTelegram(AGENT_ID, channel, content, type)

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

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
})

// --- Start ---
const transport = new StdioServerTransport()
mcp.connect(transport).catch(err => {
  process.stderr.write(`agent-comms: startup failed: ${err}\n`)
  process.exit(1)
})

const shutdown = async () => { if (db) await db.end().catch(() => {}); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
