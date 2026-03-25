#!/usr/bin/env bun
/**
 * Agent Communications MCP Plugin
 *
 * Bot-to-bot communication without Discord's msg.author.bot restriction.
 * Messages are stored in local PostgreSQL and optionally forwarded to
 * Discord/Telegram for human visibility.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Client } from 'pg'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// --- Config ---
const AGENT_ID = process.env.AGENT_ID ?? 'unknown'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const STATE_DIR = process.env.AGENT_COMMS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'agent-comms')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Loop detection
const LOOP_WINDOW_MS = 5 * 60 * 1000  // 5 minutes
const LOOP_MAX_COUNT = 20              // max exchanges per pair per window
const LOOP_MAX_DEPTH = 10
const loopCounters = new Map<string, { count: number; since: number }>()

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

async function fetchMessages(channel_id: string, limit: number = 20): Promise<unknown[]> {
  const client = await getDb()
  const result = await client.query(
    `SELECT id, channel_id, author_id, content, message_type, reply_to, metadata, depth, created_at
     FROM agent_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [channel_id, limit]
  )
  return result.rows.reverse()
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
    return { blocked: true, reason: `rate exceeded (${c.count} exchanges in ${LOOP_WINDOW_MS / 1000}s window)` }
  }
  return { blocked: false }
}

// --- Inbox (file-based delivery) ---
function deliverToInbox(targetAgent: string, message: {
  id: string
  from: string
  channel_id: string
  content: string
  message_type: string
  depth: number
  created_at: string
}) {
  const targetInbox = join(homedir(), '.claude', 'channels', `agent-comms-${targetAgent}`, 'inbox')
  try {
    mkdirSync(targetInbox, { recursive: true, mode: 0o700 })
    const filename = `${Date.now()}-${message.id.slice(0, 8)}.json`
    writeFileSync(join(targetInbox, filename), JSON.stringify(message, null, 2))
  } catch (e) {
    process.stderr.write(`agent-comms: failed to deliver to ${targetAgent}: ${e}\n`)
  }
}

function pollInbox(): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  try {
    mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })
    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json')).sort()
    for (const file of files) {
      try {
        const content = readFileSync(join(INBOX_DIR, file), 'utf-8')
        messages.push(JSON.parse(content))
        unlinkSync(join(INBOX_DIR, file))
      } catch {}
    }
  } catch {}
  return messages
}

// --- MCP Server ---
const server = new Server(
  { name: 'agent-comms', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to another agent. The message is stored in the database and delivered to the target agent\'s inbox.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string', description: 'Target agent ID (e.g., "haishin-dev", "cto", "wbs-dev")' },
          channel: { type: 'string', description: 'Logical channel name (e.g., "hotel-kanri", "wbs", "approvals")' },
          content: { type: 'string', description: 'Message content' },
          message_type: { type: 'string', enum: ['instruction', 'report', 'approval', 'chat'], description: 'Message type (default: chat)' },
          reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
          depth: { type: 'number', description: 'Conversation depth for loop detection (default: 0)' },
          metadata: { type: 'object', description: 'Additional metadata (ADR refs, task IDs, etc.)' },
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
          channel: { type: 'string', description: 'Channel name to fetch from' },
          limit: { type: 'number', description: 'Max messages to return (default: 20, max: 100)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'check_inbox',
      description: 'Check for new incoming messages in this agent\'s inbox.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
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

    const msgDepth = depth ?? 0
    const loop = checkLoop(AGENT_ID, to, msgDepth)
    if (loop.blocked) {
      return {
        content: [{ type: 'text', text: `BLOCKED: Loop detected — ${loop.reason}. Message not sent.` }],
        isError: true,
      }
    }

    const id = await saveMessage({
      channel_id: channel,
      author_id: AGENT_ID,
      content,
      message_type: message_type ?? 'chat',
      reply_to,
      metadata: { ...metadata, to },
      depth: msgDepth,
    })

    deliverToInbox(to, {
      id,
      from: AGENT_ID,
      channel_id: channel,
      content,
      message_type: message_type ?? 'chat',
      depth: msgDepth,
      created_at: new Date().toISOString(),
    })

    return {
      content: [{ type: 'text', text: `sent (id: ${id}) to ${to} in #${channel}` }],
    }
  }

  if (name === 'fetch_messages') {
    const { channel, limit } = args as { channel: string; limit?: number }
    const rows = await fetchMessages(channel, Math.min(limit ?? 20, 100))
    const formatted = rows.map((r: any) =>
      `[${r.created_at}] ${r.author_id}: ${r.content}  (id: ${r.id})`
    ).join('\n')
    return {
      content: [{ type: 'text', text: formatted || '(no messages)' }],
    }
  }

  if (name === 'check_inbox') {
    const messages = pollInbox()
    if (messages.length === 0) {
      return { content: [{ type: 'text', text: '(no new messages)' }] }
    }
    const formatted = messages.map((m: any) =>
      `[${m.created_at}] ${m.from} → #${m.channel_id}: ${m.content}`
    ).join('\n\n')
    return {
      content: [{ type: 'text', text: `${messages.length} new message(s):\n\n${formatted}` }],
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

// Cleanup
process.on('SIGINT', async () => {
  if (db) await db.end().catch(() => {})
  process.exit(0)
})
process.on('SIGTERM', async () => {
  if (db) await db.end().catch(() => {})
  process.exit(0)
})
