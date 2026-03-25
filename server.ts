#!/usr/bin/env bun
/**
 * Agent Communications MCP Plugin
 *
 * Design inspired by Discord and Telegram:
 * - DB is the single source of truth (like Discord's Cassandra/PostgreSQL)
 * - Inbox files are lightweight notification signals only (like Discord Gateway push)
 * - Messages retrieved via DB polling (like Discord REST API)
 * - Rate limiting per agent (like Discord/Telegram rate limits)
 * - Channel-level retention policies (like Telegram auto-delete timers)
 * - Loop detection for bot safety
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Client } from 'pg'
import { writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// --- Config ---
const AGENT_ID = process.env.AGENT_ID ?? 'unknown'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'

// Rate limiting: max messages per agent per minute
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX = 30
const rateCounts = new Map<string, { count: number; since: number }>()

// Loop detection
const LOOP_WINDOW_MS = 5 * 60 * 1000
const LOOP_MAX_COUNT = 20
const LOOP_MAX_DEPTH = 10
const loopCounters = new Map<string, { count: number; since: number }>()

// Inbox signal TTL (5 minutes)
const INBOX_SIGNAL_TTL_MS = 5 * 60 * 1000

// Periodic cleanup interval (5 minutes)
const GC_INTERVAL_MS = 5 * 60 * 1000

// --- DB ---
let db: Client | null = null

async function getDb(): Promise<Client> {
  if (!db) {
    db = new Client({ connectionString: DATABASE_URL })
    await db.connect()
  }
  return db
}

async function saveMessage(msg: {
  channel_id: string
  author_id: string
  content: string
  message_type?: string
  reply_to?: string
  metadata?: Record<string, unknown>
  depth?: number
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

async function fetchMessages(channel_id: string, limit: number = 20, since?: string): Promise<unknown[]> {
  const client = await getDb()
  if (since) {
    const result = await client.query(
      `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
       FROM agent_messages WHERE channel_id = $1 AND created_at > $2 ORDER BY created_at ASC LIMIT $3`,
      [channel_id, since, limit]
    )
    return result.rows
  }
  const result = await client.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
     FROM agent_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [channel_id, limit]
  )
  return result.rows.reverse()
}

async function fetchNewMessages(forAgent: string, limit: number = 20): Promise<unknown[]> {
  const client = await getDb()
  const result = await client.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
     FROM agent_messages
     WHERE metadata->>'to' = $1 AND author_id != $1
     ORDER BY created_at DESC LIMIT $2`,
    [forAgent, limit]
  )
  return result.rows.reverse()
}

// --- Rate Limiting ---
function checkRateLimit(agentId: string): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const r = rateCounts.get(agentId) ?? { count: 0, since: now }
  if (now - r.since > RATE_LIMIT_WINDOW_MS) {
    r.count = 0
    r.since = now
  }
  r.count++
  rateCounts.set(agentId, r)
  const remaining = Math.max(0, RATE_LIMIT_MAX - r.count)
  return { allowed: r.count <= RATE_LIMIT_MAX, remaining }
}

// --- Loop Detection ---
function checkLoop(from: string, to: string, depth: number): { blocked: boolean; reason?: string } {
  if (depth > LOOP_MAX_DEPTH) {
    return { blocked: true, reason: `depth exceeded (${depth} > ${LOOP_MAX_DEPTH})` }
  }
  const key = [from, to].sort().join(':')
  const now = Date.now()
  const c = loopCounters.get(key) ?? { count: 0, since: now }
  if (now - c.since > LOOP_WINDOW_MS) {
    c.count = 0
    c.since = now
  }
  c.count++
  loopCounters.set(key, c)
  if (c.count > LOOP_MAX_COUNT) {
    return { blocked: true, reason: `rate exceeded (${c.count} in ${LOOP_WINDOW_MS / 1000}s)` }
  }
  return { blocked: false }
}

// --- Inbox Signals (lightweight notification, not message storage) ---
function sendInboxSignal(targetAgent: string, messageId: string, from: string, channel: string) {
  const targetInbox = join(homedir(), '.claude', 'channels', `agent-comms-${targetAgent}`, 'inbox')
  try {
    mkdirSync(targetInbox, { recursive: true, mode: 0o700 })
    const filename = `${Date.now()}-${messageId.slice(0, 8)}.signal`
    writeFileSync(join(targetInbox, filename), JSON.stringify({ id: messageId, from, channel }))
  } catch (e) {
    process.stderr.write(`agent-comms: signal delivery failed for ${targetAgent}: ${e}\n`)
  }
}

function countInboxSignals(): number {
  const inboxDir = join(homedir(), '.claude', 'channels', `agent-comms-${AGENT_ID}`, 'inbox')
  try {
    return readdirSync(inboxDir).filter(f => f.endsWith('.signal')).length
  } catch { return 0 }
}

function clearInboxSignals() {
  const inboxDir = join(homedir(), '.claude', 'channels', `agent-comms-${AGENT_ID}`, 'inbox')
  try {
    for (const f of readdirSync(inboxDir).filter(f => f.endsWith('.signal'))) {
      unlinkSync(join(inboxDir, f))
    }
  } catch {}
}

// --- Periodic GC: clean stale signals + expired Map entries ---
function gc() {
  const now = Date.now()

  // Clean stale inbox signals (any agent's inbox we can access)
  const channelsDir = join(homedir(), '.claude', 'channels')
  try {
    for (const dir of readdirSync(channelsDir).filter(d => d.startsWith('agent-comms-'))) {
      const inboxDir = join(channelsDir, dir, 'inbox')
      try {
        for (const f of readdirSync(inboxDir).filter(f => f.endsWith('.signal'))) {
          const filepath = join(inboxDir, f)
          try {
            const stat = statSync(filepath)
            if (now - stat.mtimeMs > INBOX_SIGNAL_TTL_MS) unlinkSync(filepath)
          } catch {}
        }
      } catch {}
    }
  } catch {}

  // Clean expired loop counters
  for (const [key, val] of loopCounters) {
    if (now - val.since > LOOP_WINDOW_MS) loopCounters.delete(key)
  }

  // Clean expired rate counters
  for (const [key, val] of rateCounts) {
    if (now - val.since > RATE_LIMIT_WINDOW_MS) rateCounts.delete(key)
  }
}

setInterval(gc, GC_INTERVAL_MS)

// --- MCP Server ---
const server = new Server(
  { name: 'agent-comms', version: '0.2.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to another agent. Stored in PostgreSQL, lightweight signal delivered to target inbox.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string', description: 'Target agent ID (e.g., "haishin-dev", "cto")' },
          channel: { type: 'string', description: 'Logical channel (e.g., "hotel-kanri", "approvals")' },
          content: { type: 'string', description: 'Message content' },
          message_type: { type: 'string', enum: ['instruction', 'report', 'approval', 'chat'], description: 'Default: chat' },
          reply_to: { type: 'string', description: 'Message ID to reply to' },
          depth: { type: 'number', description: 'Conversation depth for loop detection (default: 0)' },
          metadata: { type: 'object', description: 'Additional metadata' },
        },
        required: ['to', 'channel', 'content'],
      },
    },
    {
      name: 'fetch_messages',
      description: 'Fetch recent messages from a channel (DB is the source of truth).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel name' },
          limit: { type: 'number', description: 'Max messages (default: 20, max: 100)' },
          since: { type: 'string', description: 'ISO timestamp — fetch messages after this time' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'check_inbox',
      description: 'Check for new message signals and fetch them from DB.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max messages to return (default: 20)' },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'send_message') {
    const { to, channel, content, message_type, reply_to, depth, metadata } = args as {
      to: string; channel: string; content: string; message_type?: string
      reply_to?: string; depth?: number; metadata?: Record<string, unknown>
    }

    // Rate limit
    const rate = checkRateLimit(AGENT_ID)
    if (!rate.allowed) {
      return {
        content: [{ type: 'text', text: `RATE LIMITED: ${RATE_LIMIT_MAX} msgs/min exceeded. Wait and retry.` }],
        isError: true,
      }
    }

    // Loop detection
    const msgDepth = depth ?? 0
    const loop = checkLoop(AGENT_ID, to, msgDepth)
    if (loop.blocked) {
      return {
        content: [{ type: 'text', text: `BLOCKED: Loop detected — ${loop.reason}. Message not sent.` }],
        isError: true,
      }
    }

    // Save to DB (source of truth)
    const id = await saveMessage({
      channel_id: channel,
      author_id: AGENT_ID,
      content,
      message_type: message_type ?? 'chat',
      reply_to,
      metadata: { ...metadata, to },
      depth: msgDepth,
    })

    // Send lightweight signal to target's inbox
    sendInboxSignal(to, id, AGENT_ID, channel)

    return {
      content: [{ type: 'text', text: `sent (id: ${id}) to ${to} in #${channel} [rate: ${rate.remaining} remaining]` }],
    }
  }

  if (name === 'fetch_messages') {
    const { channel, limit, since } = args as { channel: string; limit?: number; since?: string }
    const rows = await fetchMessages(channel, Math.min(limit ?? 20, 100), since)
    const formatted = (rows as any[]).map(r =>
      `[${r.created_at}] ${r.author_id}: ${r.content}  (id: ${r.id})`
    ).join('\n')
    return {
      content: [{ type: 'text', text: formatted || '(no messages)' }],
    }
  }

  if (name === 'check_inbox') {
    const { limit } = (args ?? {}) as { limit?: number }
    const signalCount = countInboxSignals()

    // Fetch recent messages addressed to this agent from DB
    const rows = await fetchNewMessages(AGENT_ID, Math.min(limit ?? 20, 100))
    clearInboxSignals()

    if ((rows as any[]).length === 0) {
      return { content: [{ type: 'text', text: '(no new messages)' }] }
    }
    const formatted = (rows as any[]).map((r: any) =>
      `[${r.created_at}] ${r.author_id} → #${r.channel_id}: ${r.content}  (id: ${r.id})`
    ).join('\n\n')
    return {
      content: [{ type: 'text', text: `${(rows as any[]).length} message(s) (${signalCount} signals cleared):\n\n${formatted}` }],
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
})

// --- Startup ---
const transport = new StdioServerTransport()
server.connect(transport).catch(err => {
  process.stderr.write(`agent-comms: failed to start: ${err}\n`)
  process.exit(1)
})

// Cleanup on exit
const shutdown = async () => {
  if (db) await db.end().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
