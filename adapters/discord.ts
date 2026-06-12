/**
 * Discord UI Adapter (SSOT §3.2)
 *
 * Implements UIAdapter for Discord via discord.js.
 * Handles Gateway connection, typing indicators, message send/receive,
 * and history fetching. Access control (mentions / channel membership /
 * human auto-warn) runs in `core/route-message.ts`'s `routeInbound()`
 * against `channels.members` in the DB — this adapter does no routing
 * gate of its own (spec §20 廃止要素の項)。
 *
 * Origin note: the pre-v2 file-based access path was derived from the
 * Anthropic Claude Code Discord plugin (Apache 2.0,
 * https://github.com/anthropics/claude-plugins-official). That dependency
 * was removed when the project went OSS / LLM-agnostic.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type Interaction,
} from 'discord.js'
import type { UIAdapter, Adapter, AdapterConfig, UnifiedMessage, InboundMessage, PlatformCapabilities, SendOptions } from './types'
import { getAgentDiscordUiId, resolveAgentFromDiscordUiId } from '../core/ui-bindings'

// --- Permission operators (DM / button gate for MCP permission prompts) ---
//
// Replaces the legacy per-bot allowlist file. Set
// `AGENT_COM_PERMISSION_OPERATORS` to a comma-separated list of Discord user
// IDs. When unset, permission DMs are skipped and button clicks from arbitrary
// users are NOT authorized — the `/permission` feature effectively no-ops,
// which is safer than the pre-v2 behaviour where a missing file quietly
// demoted to an empty allowlist.
function permissionOperators(): string[] {
  const raw = process.env.AGENT_COM_PERMISSION_OPERATORS ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// --- Mention detection ---
function checkMentioned(msg: Message, botUserId: string): boolean {
  return msg.mentions.users.has(botUserId)
}

export function shouldIgnoreDiscordInboundMessage(
  msg: { author: { id: string; bot?: boolean } },
  ownUserId: string | null | undefined,
): boolean {
  if (msg.author.bot === true) return true
  return Boolean(ownUserId && msg.author.id === ownUserId)
}

// --- Typing indicator management ---
const typingIntervals = new Map<string, NodeJS.Timeout>()
const TYPING_INTERVAL_MS = 8_000
const TYPING_TIMEOUT_MS = 5 * 60_000

function startTypingInternal(channel: { sendTyping: () => Promise<void>; id: string }): void {
  stopTypingInternal(channel.id)
  channel.sendTyping().catch(() => {})
  const interval = setInterval(() => {
    channel.sendTyping().catch(() => {})
  }, TYPING_INTERVAL_MS)
  const timeout = setTimeout(() => {
    stopTypingInternal(channel.id)
  }, TYPING_TIMEOUT_MS)
  typingIntervals.set(channel.id, interval)
  typingIntervals.set(`${channel.id}:timeout`, timeout as unknown as NodeJS.Timeout)
}

function stopTypingInternal(channelId: string): void {
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

// --- Permission relay ---
const PERMISSION_REPLY_RE = /^(yes|no)\s+([a-z]{5})$/i
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// --- Discord Adapter ---
export class DiscordAdapter implements UIAdapter, Adapter {
  platform = 'discord' as const

  capabilities: PlatformCapabilities = {
    maxMessageLength: 2000,
    supportsThreads: true,
    supportsReactions: true,
    supportsAttachments: true,
    supportsEdit: true,
  }

  private client: Client | null = null
  private messageCallback: ((msg: UnifiedMessage) => void) | null = null
  private adapterMessageCallback: ((msg: InboundMessage) => void) | null = null
  private permissionRequestCallback: ((params: { request_id: string; behavior: 'allow' | 'deny' }) => void) | null = null

  // --- v0.1.0: Adapter interface helpers ---

  /** DB query function — injected by server.ts to avoid circular imports */
  private dbQuery: ((sql: string, params?: any[]) => Promise<{ rows: any[] }>) | null = null

  /** Owning agent_id — used by D1 self-registration in the ready handler */
  private agentId: string | null = null

  /** Set DB query function for mention conversion and thread mapping */
  setDbQuery(fn: (sql: string, params?: any[]) => Promise<{ rows: any[] }>): void {
    this.dbQuery = fn
  }

  /** Identify which agent_id this adapter belongs to (D1 self-register) */
  setAgentId(agentId: string): void {
    this.agentId = agentId
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady()
  }

  /** Convert core @agent_id mentions to Discord <@discord_id> via agent_ui_bindings first. */
  async convertMentionsToDiscord(content: string): Promise<string> {
    if (!this.dbQuery) return content
    const mentions = content.match(/@([\w][\w-]*)/g)
    if (!mentions) return content
    let result = content
    for (const mention of mentions) {
      const agentId = mention.slice(1) // remove @
      try {
        const discordId = await getAgentDiscordUiId({ query: this.dbQuery }, agentId)
        if (discordId) {
          result = result.replace(mention, `<@${discordId}>`)
        }
      } catch {}
    }
    return result
  }

  /** Convert Discord <@discord_id> mentions to core @agent_id via agent_ui_bindings first. */
  async convertMentionsFromDiscord(content: string): Promise<string> {
    if (!this.dbQuery) return content
    const mentions = content.match(/<@!?(\d+)>/g)
    if (!mentions) return content
    let result = content
    for (const mention of mentions) {
      const discordId = mention.replace(/<@!?(\d+)>/, '$1')
      try {
        const agentId = await resolveAgentFromDiscordUiId({ query: this.dbQuery }, discordId)
        if (agentId) {
          result = result.replace(mention, `@${agentId}`)
        }
      } catch {}
    }
    return result
  }

  /** Resolve Discord thread ID → core thread ID via thread_adapters */
  async resolveThreadFromDiscord(discordThreadId: string): Promise<string | undefined> {
    if (!this.dbQuery) return undefined
    try {
      const r = await this.dbQuery(
        "SELECT thread_id FROM thread_adapters WHERE platform = 'discord' AND external_id = $1",
        [discordThreadId]
      )
      return r.rows.length > 0 ? r.rows[0].thread_id : undefined
    } catch { return undefined }
  }

  /** Fetch thread info from Discord API — returns parent channel ID if the given ID is a thread */
  async fetchThreadInfo(discordId: string): Promise<{ parentId: string; name: string } | null> {
    if (!this.client) return null
    try {
      const ch = await this.client.channels.fetch(discordId)
      if (!ch || !ch.isThread()) return null
      const parentId = ch.parentId
      if (!parentId) return null
      return { parentId, name: ch.name ?? '' }
    } catch { return null }
  }

  /** Resolve core thread ID → Discord thread ID via thread_adapters */
  async resolveThreadToDiscord(coreThreadId: string): Promise<string | undefined> {
    if (!this.dbQuery) return undefined
    try {
      const r = await this.dbQuery(
        "SELECT external_id FROM thread_adapters WHERE platform = 'discord' AND thread_id = $1",
        [coreThreadId]
      )
      return r.rows.length > 0 ? r.rows[0].external_id : undefined
    } catch { return undefined }
  }

  async connect(config: AdapterConfig): Promise<void> {
    const token = config.token as string

    if (!token) {
      process.stderr.write('discord-adapter: DISCORD_BOT_TOKEN is required\n')
      return
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    })

    this.client.on('messageCreate', (msg) => {
      if (shouldIgnoreDiscordInboundMessage(msg, this.client?.user?.id)) return
      this.handleInbound(msg).catch((e) =>
        process.stderr.write(`discord-adapter: handleInbound error: ${e}\n`),
      )
    })

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (!interaction.isButton()) return
      const m = /^perm_(allow|deny)_(.+)$/.exec(interaction.customId)
      if (!m) return

      const [, action, request_id] = m
      const behavior = action === 'allow' ? 'allow' : 'deny'

      const operators = permissionOperators()
      if (operators.length === 0 || !operators.includes(interaction.user.id)) {
        await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
        return
      }

      pendingPermissions.delete(request_id)
      const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'

      if (this.permissionRequestCallback) {
        this.permissionRequestCallback({ request_id, behavior: behavior as 'allow' | 'deny' })
      }

      await interaction
        .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
        .catch(() => {})
    })

    this.client.once('ready', async (c) => {
      process.stderr.write(`discord-adapter: connected as ${c.user.tag}\n`)

      // ADR-040 D1: self-register Discord identity into agents.metadata.discord_id
      // so the mention resolver can map <@discord_user_id> back to this agent_id.
      // Without this, every restart leaves the bot invisible to humans (D8 was the
      // interim fix that prevented registerAgent from wiping the column; D1 is the
      // robust fix that always re-asserts the right value at connection time).
      if (this.agentId && this.dbQuery) {
        try {
          const conflicts = await this.dbQuery(
            `SELECT agent_id
               FROM agents
              WHERE metadata->>'discord_id' = $1
                AND agent_id <> $2
                AND COALESCE(profile_enabled, true) = true
                AND disabled_at IS NULL
                AND COALESCE(status, '') <> 'disabled'
              ORDER BY agent_id`,
            [c.user.id, this.agentId],
          )
          if (conflicts.rows.length > 0) {
            const conflictingAgents = conflicts.rows.map((row) => String(row.agent_id)).join(',')
            process.stderr.write(
              `discord-adapter: D1 duplicate discord identity blocked discord_id=${c.user.id} agent=${this.agentId} conflicts=${conflictingAgents}\n`,
            )
            this.client?.destroy()
            this.client = null
            return
          }

          await this.dbQuery(
            `UPDATE agents
                SET metadata = COALESCE(metadata, '{}'::jsonb)
                             || jsonb_build_object('discord_id', $1::text)
              WHERE agent_id = $2
                AND COALESCE(metadata->>'discord_id', '') <> $1::text`,
            [c.user.id, this.agentId],
          )
          process.stderr.write(
            `discord-adapter: D1 self-registered discord_id=${c.user.id} for agent=${this.agentId}\n`,
          )
        } catch (err) {
          process.stderr.write(
            `discord-adapter: D1 self-register failed closed for agent=${this.agentId}: ${err}\n`,
          )
          this.client?.destroy()
          this.client = null
        }
      }
    })

    // Connection state logging (discord.js has built-in auto-reconnect)
    this.client.on('error', (err) => {
      process.stderr.write(`discord-adapter: error: ${err.message}\n`)
    })
    this.client.on('warn', (info) => {
      process.stderr.write(`discord-adapter: warn: ${info}\n`)
    })
    this.client.on('shardDisconnect', (event, shardId) => {
      process.stderr.write(`discord-adapter: shard ${shardId} disconnected (code=${event.code})\n`)
    })
    this.client.on('shardReconnecting', (shardId) => {
      process.stderr.write(`discord-adapter: shard ${shardId} reconnecting...\n`)
    })
    this.client.on('shardResume', (shardId, replayedEvents) => {
      process.stderr.write(`discord-adapter: shard ${shardId} resumed (replayed=${replayedEvents})\n`)
    })

    await this.client.login(token)
  }

  onMessage(callback: (msg: UnifiedMessage) => void): void {
    this.messageCallback = callback
  }

  /** Register handler for permission responses from Discord buttons/text */
  onPermissionResponse(callback: (params: { request_id: string; behavior: 'allow' | 'deny' }) => void): void {
    this.permissionRequestCallback = callback
  }

  async sendMessage(channel: string, text: string, options?: SendOptions): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Discord client not connected')

    let textChannel: TextChannel | ThreadChannel

    // If replyTo is specified, resolve the correct channel from the reference message
    // This ensures replies land in the same thread as the original message
    if (options?.replyTo) {
      try {
        // Try to find the message in the specified channel first
        const ch = await this.client.channels.fetch(channel)
        if (ch && 'messages' in ch) {
          const refMsg = await (ch as TextChannel | ThreadChannel).messages.fetch(options.replyTo)
          // Use the channel where the message actually lives (could be a thread)
          textChannel = refMsg.channel as TextChannel | ThreadChannel
        } else {
          throw new Error('channel not text-based')
        }
      } catch {
        // Fallback: search across guild channels for the message
        try {
          // The message might be in a thread under the specified channel
          const ch = await this.client.channels.fetch(channel)
          if (ch && 'threads' in ch) {
            const parentChannel = ch as TextChannel
            const activeThreads = await parentChannel.threads.fetchActive()
            for (const [, thread] of activeThreads.threads) {
              try {
                const refMsg = await thread.messages.fetch(options.replyTo)
                textChannel = refMsg.channel as ThreadChannel
                break
              } catch { /* not in this thread */ }
            }
          }
        } catch { /* ignore */ }
        // If still not resolved, use the specified channel
        if (!textChannel!) {
          const ch = await this.client.channels.fetch(channel)
          if (!ch || !('send' in ch)) throw new Error(`Channel ${channel} not found or not text-based`)
          textChannel = ch as TextChannel | ThreadChannel
        }
      }
    } else {
      const ch = await this.client.channels.fetch(channel)
      if (!ch || !('send' in ch)) throw new Error(`Channel ${channel} not found or not text-based`)
      textChannel = ch as TextChannel | ThreadChannel
    }

    // Start typing while preparing
    startTypingInternal(textChannel as { sendTyping: () => Promise<void>; id: string })

    // Truncate to 2000 chars (code-point safe)
    const codePoints = Array.from(text)
    const truncated = codePoints.length > 2000
      ? codePoints.slice(0, 1990).join('') + '…(truncated)'
      : text

    // Stop typing before sending
    stopTypingInternal(textChannel.id)

    // Auto-reply: if no replyTo specified, reply to the latest message in the channel
    // This ensures Bot messages always appear as replies, which is required for
    // mentionPatterns filter to deliver them to other Bots
    let effectiveReplyTo = options?.replyTo
    if (!effectiveReplyTo) {
      try {
        const recent = await textChannel.messages.fetch({ limit: 1 })
        const lastMsg = recent.first()
        if (lastMsg) {
          effectiveReplyTo = lastMsg.id
        }
      } catch {
        // If fetching fails, fall back to plain send
      }
    }

    // Phase C Step 1 PR-A (B): idempotency nonce. Discord dedups
    // messages with the same nonce+enforceNonce within ~5 minutes on the
    // same channel, catching the race where our HTTP request succeeded but
    // the response was lost so our retry fires a second send. `nonce` must
    // be a string <= 25 chars per Discord's API; callers feed outbound row
    // id (e.g. "out-123") which fits that ceiling. cycle 4: `enforceNonce`
    // is honoured from options (SSOT-5 §1 contract); default when only
    // `nonce` is supplied is `true` so consumers that simply pass a nonce
    // get the dedup guarantee without having to know the platform flag.
    const nonceOpts = options?.nonce
      ? { nonce: options.nonce, enforceNonce: options.enforceNonce ?? true }
      : {}

    let sentMsg
    if (effectiveReplyTo) {
      try {
        const refMsg = await textChannel.messages.fetch(effectiveReplyTo)
        sentMsg = await refMsg.reply({ content: truncated, allowedMentions: { parse: ['users', 'roles'] }, ...nonceOpts })
      } catch {
        sentMsg = await textChannel.send({ content: truncated, allowedMentions: { parse: ['users', 'roles'] }, ...nonceOpts })
      }
    } else {
      sentMsg = await textChannel.send({ content: truncated, allowedMentions: { parse: ['users', 'roles'] }, ...nonceOpts })
    }

    return { messageId: sentMsg.id }
  }

  async fetchHistory(channel: string, limit = 50, before?: string): Promise<UnifiedMessage[]> {
    if (!this.client) throw new Error('Discord client not connected')

    const ch = await this.client.channels.fetch(channel)
    if (!ch || !('messages' in ch)) throw new Error(`Channel ${channel} not found or not text-based`)

    const textChannel = ch as TextChannel | ThreadChannel
    const fetchOptions: { limit: number; before?: string } = { limit: Math.min(limit, 100) }
    if (before) fetchOptions.before = before

    const messages = await textChannel.messages.fetch(fetchOptions)
    return messages.map(m => ({
      id: m.id,
      channel: m.channelId,
      author: {
        id: m.author.id,
        name: m.author.username,
        isBot: m.author.bot,
      },
      content: m.content,
      replyTo: m.reference?.messageId ?? undefined,
      timestamp: m.createdAt,
      platform: 'discord',
      raw: m,
    })).reverse()
  }

  startTyping(channel: string): void {
    if (!this.client) return
    this.client.channels.fetch(channel).then(ch => {
      if (ch && 'sendTyping' in ch) {
        startTypingInternal(ch as { sendTyping: () => Promise<void>; id: string })
      }
    }).catch(() => {})
  }

  stopTyping(channel: string): void {
    stopTypingInternal(channel)
  }

  /** Send a permission request to allowFrom users via DM */
  async sendPermissionRequest(params: {
    request_id: string
    tool_name: string
    description: string
    input_preview: string
  }): Promise<void> {
    if (!this.client) return

    const { request_id, tool_name, description, input_preview } = params
    pendingPermissions.set(request_id, { tool_name, description, input_preview })

    const operators = permissionOperators()
    if (operators.length === 0) {
      process.stderr.write(
        `discord-adapter: permission DM skipped — AGENT_COM_PERMISSION_OPERATORS unset (request_id=${request_id})\n`,
      )
      return
    }

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

    for (const userId of operators) {
      try {
        const user = await this.client.users.fetch(userId)
        await user.send({ content: text, components: [row] })
      } catch (e) {
        process.stderr.write(`discord-adapter: permission DM to ${userId} failed: ${e}\n`)
      }
    }
  }

  // --- v0.1.0: Adapter interface methods ---

  /** Adapter.sendMessage — core-layer style with mention conversion and thread mapping */
  async sendAdapterMessage(params: {
    external_channel_id: string
    content: string
    reply_to_external_id?: string
    thread_external_id?: string
    /** Phase C Step 1 PR-A (B): idempotency nonce forwarded to platform. */
    nonce?: string
    /** Phase C Step 1 PR-A cycle 4: opt-in rejection of duplicate nonces (SSOT-5 §1). */
    enforceNonce?: boolean
  }): Promise<{ external_message_id: string }> {
    // Convert @agent_id mentions to Discord <@id>
    const convertedContent = await this.convertMentionsToDiscord(params.content)

    // Resolve thread: if thread_external_id is a core thread ID, map to Discord thread ID
    let targetChannel = params.external_channel_id
    if (params.thread_external_id) {
      const discordThreadId = await this.resolveThreadToDiscord(params.thread_external_id)
      if (discordThreadId) {
        targetChannel = discordThreadId
      }
    }

    const opts: { replyTo?: string; nonce?: string; enforceNonce?: boolean } = {}
    if (params.reply_to_external_id) opts.replyTo = params.reply_to_external_id
    if (params.nonce) opts.nonce = params.nonce
    if (params.enforceNonce !== undefined) opts.enforceNonce = params.enforceNonce

    const result = await this.sendMessage(
      targetChannel,
      convertedContent,
      Object.keys(opts).length > 0 ? opts : undefined
    )
    return { external_message_id: result.messageId }
  }

  /** Register Adapter-style inbound message callback */
  onAdapterMessage(callback: (msg: InboundMessage) => void): void {
    this.adapterMessageCallback = callback
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals
    for (const [key] of typingIntervals) {
      if (!key.includes(':timeout')) {
        stopTypingInternal(key)
      }
    }
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
  }

  // --- Internal: handle inbound message ---
  //
  // No access-control gate here: routing + mention / membership enforcement run
  // in `routeInbound()` (core/route-message.ts) against `channels.members` in
  // the DB. The adapter's job is to normalise the platform event and forward it
  // to the server layer; drop decisions happen downstream.
  private async handleInbound(msg: Message): Promise<void> {
    // Resolve parent channel for threads (fetch partial if needed)
    let parentChannelId: string | null = null
    if (msg.channel.isThread()) {
      parentChannelId = msg.channel.parentId
    } else if (msg.channel.partial) {
      try {
        const fetched = await msg.channel.fetch()
        if (fetched.isThread()) {
          parentChannelId = fetched.parentId
        }
      } catch {}
    }

    // Permission-reply intercept — gated on AGENT_COM_PERMISSION_OPERATORS so
    // arbitrary users cannot approve/deny requests by typing "yes XXXXX".
    const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
    if (permMatch) {
      const operators = permissionOperators()
      if (operators.length === 0 || !operators.includes(msg.author.id)) {
        // Silently ignore — same as pre-v2 behaviour when author wasn't in allowFrom.
        return
      }
      const request_id = permMatch[2]!.toLowerCase()
      const behavior = permMatch[1]!.toLowerCase() === 'yes' ? 'allow' : 'deny'
      if (this.permissionRequestCallback) {
        this.permissionRequestCallback({ request_id, behavior: behavior as 'allow' | 'deny' })
      }
      const emoji = behavior === 'allow' ? '✅' : '❌'
      await msg.react(emoji).catch(() => {})
      pendingPermissions.delete(request_id)
      return
    }

    // Show typing indicator
    startTypingInternal(msg.channel as { sendTyping: () => Promise<void>; id: string })

    // Build attachments info
    const atts: { name: string; contentType: string; size: number }[] = []
    for (const att of msg.attachments.values()) {
      atts.push({
        name: att.name ?? 'file',
        contentType: att.contentType ?? 'unknown',
        size: att.size,
      })
    }

    // Deliver via callback
    if (this.messageCallback) {
      const unified: UnifiedMessage = {
        id: msg.id,
        channel: parentChannelId ?? msg.channelId,
        thread: msg.channel.isThread() ? msg.channelId : undefined,
        author: {
          id: msg.author.id,
          name: msg.author.username,
          isBot: msg.author.bot,
        },
        content: msg.content || (atts.length > 0 ? '(attachment)' : ''),
        replyTo: msg.reference?.messageId ?? undefined,
        mentionUserIds: msg.mentions.users.map(u => u.id),
        attachments: atts.length > 0 ? atts : undefined,
        timestamp: msg.createdAt,
        platform: 'discord',
        raw: msg,
      }
      this.messageCallback(unified)
    }

    // v0.1.0: Adapter-style callback with mention conversion + thread mapping
    if (this.adapterMessageCallback) {
      const convertedContent = await this.convertMentionsFromDiscord(
        msg.content || (atts.length > 0 ? '(attachment)' : '')
      )
      const threadExternalId = msg.channel.isThread() ? msg.channelId : undefined
      const coreThreadId = threadExternalId ? await this.resolveThreadFromDiscord(threadExternalId) : undefined

      const inbound: InboundMessage = {
        external_message_id: msg.id,
        external_channel_id: parentChannelId ?? msg.channelId,
        external_thread_id: threadExternalId,
        author_external_id: msg.author.id,
        author_name: msg.author.username,
        author_is_bot: msg.author.bot,
        content: convertedContent,
        reply_to_external_id: msg.reference?.messageId ?? undefined,
        attachments: atts.length > 0 ? atts : undefined,
        timestamp: msg.createdAt,
        platform: 'discord',
        raw: msg,
      }
      this.adapterMessageCallback(inbound)
    }
  }
}
