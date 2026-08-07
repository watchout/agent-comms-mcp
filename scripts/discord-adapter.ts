#!/usr/bin/env bun
/**
 * Discord Adapter for agent-com
 *
 * Connects to Discord Gateway, receives messages, applies access control,
 * and delivers to the webhook bridge for session injection.
 *
 * Access control sources (Phase 2 G, v2.1.0):
 *   - channels.members (DB) — per-channel allowlist (agent_id → discord_user_id)
 *   - agents.metadata.discord_id (DB) — DM allowlist (any registered agent)
 *
 * Pre-v2.1.0 read these from `access.json`. That file is now ignored; the DB
 * is the single source of truth (spec §20 廃止: access.json / plugin:discord).
 *
 * Env:
 *   DISCORD_BOT_TOKEN — Discord bot token (required)
 *   DATABASE_URL      — PostgreSQL URL (required for access lookup)
 *   AUN_WEBHOOK_PORT  — Preferred override (Issue #248 cycle 1).
 *   WEBHOOK_PORT      — Legacy override. The pre-cycle-1 fixed default of
 *                        8789 is removed (CTO bot collision cause). New contract:
 *                        AUN_WEBHOOK_PORT > WEBHOOK_PORT > free-port detection
 *                        (8801-8900); 8800 reserved for SSE_PORT default. If
 *                        none of the three sources resolves a port, startup
 *                        throws with a hint to set AUN_WEBHOOK_PORT.
 *   DISCORD_OUTBOUND_PORT — Optional override; default = WEBHOOK_PORT + 1000
 *                        (so implicit launches dynamic-resolve outbound port
 *                        in lockstep with webhook port, e.g. 9801-9900).
 */

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type Interaction,
} from 'discord.js'
import { Client as PgClient } from 'pg'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

// --- Config ---
const TOKEN = process.env.DISCORD_BOT_TOKEN
const IS_MAIN = typeof Bun !== 'undefined' && Bun.main === import.meta.path

if (IS_MAIN && !TOKEN) {
  process.stderr.write('discord-adapter: DISCORD_BOT_TOKEN is required\n')
  process.exit(1)
}

const DATABASE_URL = process.env.DATABASE_URL ?? ''
// Issue #248 cycle 6 — port resolution must match server.ts canonical contract.
// AUN_WEBHOOK_PORT > WEBHOOK_PORT > error (no implicit 8789). discord-adapter
// is a standalone helper that doesn't run the bind-probe range scan; an
// operator is expected to point it at the same port the bridge bound, so we
// require an explicit env. The pre-cycle-1 implicit 8789 default was the
// cascade-disconnect mechanism — removing it here is part of the same fix.
function resolveWebhookPort(): number {
  const raw = process.env.AUN_WEBHOOK_PORT ?? process.env.WEBHOOK_PORT
  if (!raw) {
    throw new Error(
      'discord-adapter: neither AUN_WEBHOOK_PORT nor WEBHOOK_PORT is set. ' +
      'Set one of them to the port the agent-comms bridge is listening on ' +
      '(see server.ts free-port detection in 8801-8900).'
    )
  }
  const port = parseInt(raw, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`discord-adapter: invalid port env value "${raw}"`)
  }
  return port
}
const WEBHOOK_PORT = IS_MAIN ? resolveWebhookPort() : parseInt(process.env.AUN_WEBHOOK_PORT ?? process.env.WEBHOOK_PORT ?? '0', 10)
const OUTBOUND_PORT = parseInt(process.env.DISCORD_OUTBOUND_PORT ?? String(WEBHOOK_PORT + 1000), 10)

// --- Access control types (backed by DB in v2.1.0) ---
interface GroupPolicy {
  requireMention: boolean
  allowFrom: string[]
}

export interface Access {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, unknown>
}

function defaultAccess(): Access {
  return {
    dmPolicy: 'allowlist',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

// --- DB-backed Access lookup (Phase 2 G) ---
// The adapter opens one long-lived pg.Client shared across all access
// refreshes so we do not pay a reconnect on every message. A short-lived
// per-query client would also work but churns through PG connection slots.
let accessPgClient: PgClient | null = null
async function getAccessPgClient(): Promise<PgClient | null> {
  if (!DATABASE_URL) return null
  if (accessPgClient) return accessPgClient
  const c = new PgClient({ connectionString: DATABASE_URL })
  try {
    await c.connect()
    accessPgClient = c
    return c
  } catch (err) {
    process.stderr.write(`discord-adapter: DB connect failed: ${err}\n`)
    return null
  }
}

/**
 * Build the Access struct from DB rows (spec §20 廃止: access.json → DB).
 *
 * Discord user id mapping: `agents.metadata->>'discord_id'` (JSONB text
 * extraction). ADR-040 D1 self-registers the Discord id at bot connect
 * time (`adapters/discord.ts:259`), so every online bot has a value here.
 * An earlier cut of this function queried a non-existent `discord_user_id`
 * column (SQLite migrate-sqlite.ts had it, PG migrate.ts never did) and
 * silently fell through to `defaultAccess()` on PG — fail-closed but
 * functionally broken (Phase C H SQLite E2E G-live finding).
 *
 *   - dmPolicy: `'allowlist'` (any agent with `metadata.discord_id`)
 *   - allowFrom: every registered Discord id
 *   - groups[channel_id]: `{ requireMention: true, allowFrom: <members as discord ids> }`
 *
 * `requireMention: true` is the pre-v2.1.0 default — this preserves the
 * pattern where bots only receive messages they are @mentioned in. An empty
 * or unresolved member projection denies every guild sender; it never means
 * "accept all".
 *
 * Note: the SQLite adapter's `adaptSql()` rewrites `metadata->>'discord_id'`
 * into `json_extract(metadata, '$.discord_id')` at query time, so the exact
 * same query string runs against both PG and SQLite without branching.
 */
export async function loadAccess(): Promise<Access> {
  const db = await getAccessPgClient()
  if (!db) return defaultAccess()
  try {
    const agentsRes = await db.query<{ agent_id: string; discord_user_id: string }>(
      `SELECT agent_id, metadata->>'discord_id' AS discord_user_id FROM agents WHERE metadata->>'discord_id' IS NOT NULL`,
    )
    const channelsRes = await db.query<{ id: string; members: string[] | null }>(
      `SELECT id, members FROM channels`,
    )
    const discordByAgent: Record<string, string> = {}
    for (const a of agentsRes.rows) discordByAgent[a.agent_id] = a.discord_user_id
    const allowFrom = agentsRes.rows.map((a) => a.discord_user_id)
    const groups: Record<string, GroupPolicy> = {}
    for (const ch of channelsRes.rows) {
      const memberAgentIds = Array.isArray(ch.members) ? ch.members : []
      const memberDiscordIds = memberAgentIds
        .map((aid) => discordByAgent[aid])
        .filter((v): v is string => Boolean(v))
      groups[ch.id] = { requireMention: true, allowFrom: memberDiscordIds }
    }
    return { dmPolicy: 'allowlist', allowFrom, groups, pending: {} }
  } catch (err) {
    process.stderr.write(`discord-adapter: loadAccess DB error (using defaults): ${err}\n`)
    return defaultAccess()
  }
}

// --- Gate logic (mirrors Discord plugin's gate function) ---
export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop'; reason: string }

export function gate(
  access: Access,
  senderId: string,
  channelId: string,
  parentChannelId: string | null,
  isDM: boolean,
  isMentioned: boolean,
): GateResult {
  if (access.dmPolicy === 'disabled') return { action: 'drop', reason: 'dmPolicy disabled' }

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver' }
    return { action: 'drop', reason: 'DM not in allowFrom' }
  }

  // Guild messages: look up channel policy (threads inherit parent)
  const lookupId = parentChannelId ?? channelId
  const policy = access.groups[lookupId]
  if (!policy) return { action: 'drop', reason: `channel ${lookupId} not in groups` }

  const groupAllowFrom = policy.allowFrom ?? []
  if (!groupAllowFrom.includes(senderId)) {
    return { action: 'drop', reason: 'not in channel allowFrom' }
  }

  if (policy.requireMention && !isMentioned) {
    return { action: 'drop', reason: 'mention required but not found' }
  }

  return { action: 'deliver' }
}

// --- Mention detection ---
// Discord's native @mention is the single source of truth. The former
// `mentionPatterns` regex list (from access.json) was dropped in v2.1.0 —
// agents opt into receiving messages by becoming a member of the channel
// (channels.members), and only messages that @mention the bot are gated in.
function checkMentioned(msg: Message, botUserId: string): boolean {
  return msg.mentions.users.has(botUserId)
}

// --- Deliver to webhook bridge ---
async function deliverToBridge(msg: Message): Promise<void> {
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${att.name ?? 'file'} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  const body = {
    content,
    meta: {
      chat_id: msg.channelId,
      message_id: msg.id,
      user: msg.author.username,
      user_id: msg.author.id,
      ts: msg.createdAt.toISOString(),
      source: 'discord',
      ...(atts.length > 0
        ? { attachment_count: String(atts.length), attachments: atts.join('; ') }
        : {}),
    },
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${WEBHOOK_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '(no body)')
      process.stderr.write(`discord-adapter: bridge POST failed (HTTP ${resp.status}): ${text}\n`)
    }
  } catch (err) {
    process.stderr.write(`discord-adapter: bridge POST failed: ${err}\n`)
  }
}

// --- Permission relay ---
// Matches "yes xxxxx" or "no xxxxx" (5-char request_id)
const PERMISSION_REPLY_RE = /^(yes|no)\s+([a-z]{5})$/i

// Stores pending permission requests: request_id → { tool_name }
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// --- Typing indicator management ---
// Tracks active typing intervals per channel so they can be cleared on outbound send
const typingIntervals = new Map<string, NodeJS.Timeout>()
const TYPING_INTERVAL_MS = 8_000  // Re-send typing every 8s (Discord shows for 10s)
const TYPING_TIMEOUT_MS = 5 * 60_000  // Safety: auto-stop after 5 minutes

function startTyping(channel: { sendTyping: () => Promise<void>; id: string }): void {
  // Clear any existing interval for this channel
  stopTyping(channel.id)

  // Send immediately
  channel.sendTyping().catch(() => {})

  // Re-send every 8 seconds
  const interval = setInterval(() => {
    channel.sendTyping().catch(() => {})
  }, TYPING_INTERVAL_MS)

  // Safety timeout: stop after 5 minutes
  const timeout = setTimeout(() => {
    stopTyping(channel.id)
  }, TYPING_TIMEOUT_MS)

  // Store interval (attach timeout to clear later)
  typingIntervals.set(channel.id, interval)
  // Store timeout separately using a convention
  typingIntervals.set(`${channel.id}:timeout`, timeout as unknown as NodeJS.Timeout)
}

function stopTyping(channelId: string): void {
  const interval = typingIntervals.get(channelId)
  if (interval) {
    clearInterval(interval)
    typingIntervals.delete(channelId)
  }
  const timeout = typingIntervals.get(`${channelId}:timeout`)
  if (timeout) {
    clearTimeout(timeout)
    typingIntervals.delete(`${channelId}:timeout`)
  }
}

// --- Runtime (only when executed directly, not imported for tests) ---
if (IS_MAIN && TOKEN) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  })

  client.on('messageCreate', (msg) => {
    // Ignore own messages
    if (msg.author.id === client.user?.id) return

    handleInbound(msg, client).catch((e) =>
      process.stderr.write(`discord-adapter: handleInbound error: ${e}\n`),
    )
  })

  // --- Button-click handler for permission requests ---
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return
    const m = /^perm_(allow|deny)_(.+)$/.exec(interaction.customId)
    if (!m) return

    const [, action, request_id] = m
    const behavior = action === 'allow' ? 'allow' : 'deny'

    // Verify sender is in allowFrom
    const access = await loadAccess()
    if (!access.allowFrom.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
      return
    }

    try {
      await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/permission-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id, behavior }),
      })
      pendingPermissions.delete(request_id)
      const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
      await interaction
        .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
        .catch(() => {})
    } catch (err) {
      process.stderr.write(`discord-adapter: permission button error: ${err}\n`)
      await interaction.reply({ content: `Error: ${err}`, ephemeral: true }).catch(() => {})
    }
  })

  client.once('ready', (c) => {
    process.stderr.write(`discord-adapter: connected as ${c.user.tag}\n`)
    process.stderr.write(`discord-adapter: delivering to bridge on port ${WEBHOOK_PORT}\n`)
    process.stderr.write(`discord-adapter: outbound endpoint on port ${OUTBOUND_PORT}\n`)
  })

  // --- Outbound HTTP server (POST /send) ---
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      req.on('error', reject)
    })
  }

  const outboundServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // --- GET /history?channel_id=...&limit=50&before=... ---
    if (req.url?.startsWith('/history') && req.method === 'GET') {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${OUTBOUND_PORT}`)
        const channelId = url.searchParams.get('channel_id')
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100)
        const before = url.searchParams.get('before') ?? undefined

        if (!channelId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'channel_id is required' }))
          return
        }

        const channel = await client.channels.fetch(channelId)
        if (!channel || !('messages' in channel)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Channel ${channelId} not found or not text-based` }))
          return
        }

        const textChannel = channel as TextChannel | ThreadChannel
        const fetchOptions: { limit: number; before?: string } = { limit }
        if (before) fetchOptions.before = before

        const messages = await textChannel.messages.fetch(fetchOptions)
        const result = messages.map(m => ({
          message_id: m.id,
          author: m.author.username,
          author_id: m.author.id,
          is_bot: m.author.bot,
          content: m.content,
          timestamp: m.createdAt.toISOString(),
          reply_to: m.reference?.messageId ?? null,
        })).reverse()

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, channel_id: channelId, messages: result }))
      } catch (err) {
        process.stderr.write(`discord-adapter: history error: ${err}\n`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    // --- POST /permission: receive permission request from bridge, DM to allowFrom users ---
    if (req.url === '/permission') {
      try {
        const body = JSON.parse(await readBody(req))
        const { request_id, tool_name, description, input_preview } = body as {
          request_id: string; tool_name: string; description: string; input_preview: string
        }

        if (!request_id || !tool_name) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request_id and tool_name are required' }))
          return
        }

        pendingPermissions.set(request_id, { tool_name, description, input_preview })

        const access = await loadAccess()
        let prettyInput: string
        try {
          prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
        } catch {
          prettyInput = input_preview
        }
        const text =
          `🔐 **Permission Request**\n` +
          `**Tool:** ${tool_name}\n` +
          `**Description:** ${description}\n` +
          `**Input:**\n\`\`\`\n${prettyInput}\n\`\`\`\n\n` +
          `Reply **yes ${request_id}** to allow, **no ${request_id}** to deny.`

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`perm_allow_${request_id}`)
            .setLabel('Allow')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`perm_deny_${request_id}`)
            .setLabel('Deny')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger),
        )

        let sent = 0
        for (const userId of access.allowFrom) {
          void (async () => {
            try {
              const user = await client.users.fetch(userId)
              await user.send({ content: text, components: [row] })
              sent++
            } catch (e) {
              process.stderr.write(`discord-adapter: permission DM to ${userId} failed: ${e}\n`)
            }
          })()
        }

        process.stderr.write(`discord-adapter: permission request ${request_id} (${tool_name}) sent to ${access.allowFrom.length} user(s)\n`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, request_id }))
      } catch (err) {
        process.stderr.write(`discord-adapter: permission endpoint error: ${err}\n`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
      return
    }

    // --- POST /send: send message to a channel ---
    if (req.url === '/send') {
      try {
        const body = JSON.parse(await readBody(req))
        const { chat_id, text, reply_to } = body as { chat_id: string; text: string; reply_to?: string }

        if (!chat_id || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'chat_id and text are required' }))
          return
        }

        const channel = await client.channels.fetch(chat_id)
        if (!channel || !('send' in channel)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Channel ${chat_id} not found or not text-based` }))
          return
        }

        const textChannel = channel as TextChannel | ThreadChannel

        // Start typing indicator while preparing the message
        startTyping(textChannel as { sendTyping: () => Promise<void>; id: string })

        // Truncate to Discord's 2000 char limit (code-point safe)
        const codePoints = Array.from(text)
        const truncated = codePoints.length > 2000
          ? codePoints.slice(0, 1990).join('') + '…(truncated)'
          : text

        // Stop typing indicator (bot is about to send)
        stopTyping(chat_id)

        let sentMsg
        if (reply_to) {
          try {
            const refMsg = await textChannel.messages.fetch(reply_to)
            sentMsg = await refMsg.reply(truncated)
          } catch {
            // If reply target not found, send as normal message
            sentMsg = await textChannel.send(truncated)
          }
        } else {
          sentMsg = await textChannel.send(truncated)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message_id: sentMsg.id }))
      } catch (err) {
        process.stderr.write(`discord-adapter: outbound error: ${err}\n`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. Use POST /send, POST /permission, or GET /history' }))
  })

  outboundServer.listen(OUTBOUND_PORT, '127.0.0.1', () => {
    process.stderr.write(`discord-adapter: outbound server listening on 127.0.0.1:${OUTBOUND_PORT}\n`)
  })

  // --- Start ---
  process.stderr.write(`discord-adapter: starting (bridge port: ${WEBHOOK_PORT}, outbound port: ${OUTBOUND_PORT})\n`)

  client.login(TOKEN).catch((err) => {
    process.stderr.write(`discord-adapter: login failed: ${err}\n`)
    process.exit(1)
  })

  const shutdown = () => {
    process.stderr.write('discord-adapter: shutting down\n')
    outboundServer.close()
    client.destroy()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// --- Extracted for testability ---
async function handleInbound(msg: Message, client: Client): Promise<void> {
  const access = await loadAccess()
  const isDM = msg.channel.type === ChannelType.DM
  const parentChannelId = msg.channel.isThread()
    ? msg.channel.parentId
    : null
  const isMentioned = client.user
    ? checkMentioned(msg, client.user.id)
    : false

  const result = gate(
    access,
    msg.author.id,
    msg.channelId,
    parentChannelId,
    isDM,
    isMentioned,
  )

  if (result.action === 'drop') {
    process.stderr.write(`discord-adapter: dropped msg from ${msg.author.username} in ${msg.channelId} (${result.reason})\n`)
    return
  }

  // Permission-reply intercept: "yes xxxxx" or "no xxxxx" in DMs
  // from allowlisted users triggers permission response instead of
  // relaying as a regular chat message.
  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase() === 'yes' ? 'allow' : 'deny'
    try {
      await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/permission-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id, behavior }),
      })
      const emoji = behavior === 'allow' ? '✅' : '❌'
      await msg.react(emoji).catch(() => {})
      pendingPermissions.delete(request_id)
    } catch (err) {
      process.stderr.write(`discord-adapter: permission response failed: ${err}\n`)
    }
    return
  }

  // Show "Bot is typing..." indicator, re-sent every 8s until outbound reply
  startTyping(msg.channel as { sendTyping: () => Promise<void>; id: string })

  await deliverToBridge(msg)
}
