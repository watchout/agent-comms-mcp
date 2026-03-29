#!/usr/bin/env bun
/**
 * agent-comms LISTEN/NOTIFY listener
 *
 * Single process that monitors PostgreSQL NOTIFY on 'agent_inbox' channel
 * and delivers messages to each bot's Webhook MCP server (agent-com-bridge).
 *
 * Usage:
 *   AGENT_PORTS='{"cto":8789,"hotel":8790}' DATABASE_URL=postgresql://localhost/agent_comms bun scripts/listener.ts
 *
 * Env:
 *   DATABASE_URL  — PostgreSQL connection string
 *   AGENT_PORTS   — JSON object mapping agent_id → webhook port
 *                   Default ports per SSOT §4.4:
 *                   cto=8789, hotel=8790, haishin=8791, wbs=8792,
 *                   nyusatsu=8793, adf=8794, agent-com=8795, vice=8796, auditor=8797
 */

import { Client } from 'pg'

// --- Port mapping ---
const DEFAULT_PORTS: Record<string, number> = {
  cto: 8789,
  hotel: 8790,
  haishin: 8791,
  wbs: 8792,
  nyusatsu: 8793,
  adf: 8794,
  'agent-com': 8795,
  vice: 8796,
  auditor: 8797,
}

const agentPorts: Record<string, number> = process.env.AGENT_PORTS
  ? JSON.parse(process.env.AGENT_PORTS)
  : DEFAULT_PORTS

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'

// --- Agent ID normalization ---
export function normalizeAgentId(id: string, ports: Record<string, number>): string {
  if (ports[id]) return id
  // prefix match: "agent-com-dev" → "agent-com"
  for (const key of Object.keys(ports)) {
    if (id.startsWith(key)) return key
  }
  return id
}

// --- DB connection with reconnect ---
let client: Client | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_DELAY_MS = 30_000

async function connect(): Promise<void> {
  client = new Client({ connectionString: DATABASE_URL })

  client.on('error', (err) => {
    process.stderr.write(`listener: DB connection error: ${err.message}\n`)
    scheduleReconnect()
  })

  client.on('end', () => {
    process.stderr.write('listener: DB connection closed\n')
    scheduleReconnect()
  })

  await client.connect()
  reconnectAttempts = 0

  // Listen for notifications
  await client.query('LISTEN agent_inbox')
  process.stderr.write(`listener: LISTEN agent_inbox (monitoring ${Object.keys(agentPorts).length} agents)\n`)

  // Catch up on messages missed during disconnection (last 5 minutes)
  try {
    const recent = await client.query(
      `SELECT metadata->>'to' as target, id FROM agent_messages
       WHERE created_at > now() - INTERVAL '5 minutes'
       ORDER BY created_at ASC`
    )
    if (recent.rows.length > 0) {
      process.stderr.write(`listener: catching up ${recent.rows.length} recent messages\n`)
      for (const row of recent.rows) {
        if (row.target) {
          const normalized = normalizeAgentId(row.target, agentPorts)
          if (agentPorts[normalized]) {
            await deliverToBot(normalized, row.id)
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`listener: catch-up query failed (non-fatal): ${err}\n`)
  }

  // Handle notifications
  client.on('notification', async (msg) => {
    if (msg.channel !== 'agent_inbox' || !msg.payload) return

    try {
      const payload = JSON.parse(msg.payload) as { to: string; message_id: string }
      const normalized = normalizeAgentId(payload.to, agentPorts)
      await deliverToBot(normalized, payload.message_id)
    } catch (err) {
      process.stderr.write(`listener: error processing notification: ${err}\n`)
    }
  })
}

function scheduleReconnect(): void {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS)
  reconnectAttempts++
  process.stderr.write(`listener: reconnecting in ${delay}ms (attempt ${reconnectAttempts})\n`)
  setTimeout(async () => {
    try {
      await connect()
    } catch (err) {
      process.stderr.write(`listener: reconnect failed: ${err}\n`)
      scheduleReconnect()
    }
  }, delay)
}

// --- Deliver message to bot's webhook ---
async function deliverToBot(targetAgent: string, messageId: string): Promise<void> {
  const port = agentPorts[targetAgent]
  if (!port) {
    process.stderr.write(`listener: unknown agent "${targetAgent}", no port mapping\n`)
    return
  }

  // Fetch message from DB
  if (!client) return
  const r = await client.query(
    `SELECT id, channel_id, author_id, content, message_type, metadata, created_at
     FROM agent_messages WHERE id = $1`,
    [messageId]
  )

  if (r.rows.length === 0) {
    process.stderr.write(`listener: message ${messageId} not found in DB\n`)
    return
  }

  const msg = r.rows[0]
  const contentText = `[${msg.message_type ?? 'chat'}] ${msg.author_id} → #${msg.channel_id}: ${msg.content}`

  try {
    const resp = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: contentText,
        meta: {
          chat_id: msg.channel_id,
          message_id: msg.id,
          user: msg.author_id,
          user_id: msg.author_id,
          ts: new Date(msg.created_at).toISOString(),
          source: 'agent-comms',
        },
      }),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '(no body)')
      process.stderr.write(`listener: delivery to ${targetAgent}:${port} failed (HTTP ${resp.status}): ${body}\n`)
    } else {
      process.stderr.write(`listener: delivered ${messageId} → ${targetAgent}:${port}\n`)
    }
  } catch (err) {
    process.stderr.write(`listener: delivery to ${targetAgent}:${port} failed: ${err}\n`)
  }
}

// --- Start ---
process.stderr.write(`listener: starting (DB: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')})\n`)
process.stderr.write(`listener: agent ports: ${JSON.stringify(agentPorts)}\n`)

connect().catch(err => {
  process.stderr.write(`listener: initial connection failed: ${err}\n`)
  scheduleReconnect()
})

const shutdown = () => {
  process.stderr.write('listener: shutting down\n')
  if (client) client.end().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
