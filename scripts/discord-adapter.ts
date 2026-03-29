#!/usr/bin/env bun
/**
 * Discord Adapter for agent-com
 *
 * Connects to Discord Gateway, receives messages, applies access control,
 * and delivers to the webhook bridge for session injection.
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
  type Message,
} from 'discord.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// --- Config ---
const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write('discord-adapter: DISCORD_BOT_TOKEN is required\n')
  process.exit(1)
}

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? ''
const ACCESS_FILE = STATE_DIR ? join(STATE_DIR, 'access.json') : ''
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '8789', 10)

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

// --- Discord client ---
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

  handleInbound(msg).catch((e) =>
    process.stderr.write(`discord-adapter: handleInbound error: ${e}\n`),
  )
})

async function handleInbound(msg: Message): Promise<void> {
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

  if (result.action === 'drop') return

  await deliverToBridge(msg)
}

client.once('ready', (c) => {
  process.stderr.write(`discord-adapter: connected as ${c.user.tag}\n`)
  process.stderr.write(`discord-adapter: delivering to bridge on port ${WEBHOOK_PORT}\n`)
})

// --- Start ---
process.stderr.write(`discord-adapter: starting (bridge port: ${WEBHOOK_PORT})\n`)

client.login(TOKEN).catch((err) => {
  process.stderr.write(`discord-adapter: login failed: ${err}\n`)
  process.exit(1)
})

const shutdown = () => {
  process.stderr.write('discord-adapter: shutting down\n')
  client.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
