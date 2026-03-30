#!/usr/bin/env bun
/**
 * Discord Adapter for agent-com
 *
 * Connects to Discord Gateway, receives messages, applies access control,
 * and delivers to the webhook bridge for session injection.
 *
 * Access control logic derived from Anthropic's Claude Code Discord plugin
 * Copyright Anthropic, PBC. Licensed under Apache 2.0
 * https://github.com/anthropics/claude-plugins-official
 *
 * Env:
 *   DISCORD_BOT_TOKEN  — Discord bot token (required)
 *   DISCORD_STATE_DIR  — Directory containing access.json
 *   WEBHOOK_PORT       — Webhook bridge port (default: 8789)
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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

// --- Config ---
const TOKEN = process.env.DISCORD_BOT_TOKEN
const IS_MAIN = typeof Bun !== 'undefined' && Bun.main === import.meta.path

if (IS_MAIN && !TOKEN) {
  process.stderr.write('discord-adapter: DISCORD_BOT_TOKEN is required\n')
  process.exit(1)
}

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? ''
const ACCESS_FILE = STATE_DIR ? join(STATE_DIR, 'access.json') : ''
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '8789', 10)
const OUTBOUND_PORT = WEBHOOK_PORT + 1000  // e.g. 8795 → 9795

// --- Access control types (compatible with Discord plugin's access.json) ---
interface GroupPolicy {
  requireMention: boolean
  allowFrom: string[]
}

export interface Access {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, unknown>
  mentionPatterns?: string[]
}

function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

export function loadAccess(filePath: string): Access {
  if (!filePath) return defaultAccess()
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    process.stderr.write(`discord-adapter: access.json parse error, using defaults\n`)
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
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop', reason: 'not in channel allowFrom' }
  }

  if (policy.requireMention && !isMentioned) {
    return { action: 'drop', reason: 'mention required but not found' }
  }

  return { action: 'deliver' }
}

// --- Mention detection ---
function checkMentioned(
  msg: Message,
  botUserId: string,
  extraPatterns?: string[],
): boolean {
  // Direct @mention
  if (msg.mentions.users.has(botUserId)) return true

  // Extra patterns from access.json
  if (extraPatterns) {
    for (const pat of extraPatterns) {
      try {
        if (new RegExp(pat, 'i').test(msg.content)) return true
      } catch {}
    }
  }

  return false
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
    const access = loadAccess(ACCESS_FILE)
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

        const access = loadAccess(ACCESS_FILE)
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
  const access = loadAccess(ACCESS_FILE)
  const isDM = msg.channel.type === ChannelType.DM
  const parentChannelId = msg.channel.isThread()
    ? msg.channel.parentId
    : null
  const isMentioned = client.user
    ? checkMentioned(msg, client.user.id, access.mentionPatterns)
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
