#!/usr/bin/env bun
/**
 * API Auditor — Listens for [報告] messages and generates LLM review comments.
 *
 * Listens to pg_notify 'agent_inbox' for new messages, filters for [報告] tags,
 * sends them to an LLM for review, and posts the review back to Discord.
 *
 * Environment variables:
 *   DATABASE_URL          — PostgreSQL connection string
 *   DISCORD_BOT_TOKEN     — Discord bot token for posting reviews
 *   DISCORD_AUDIT_CHANNEL — Discord channel ID for audit log
 *   LLM_PROVIDER          — 'anthropic' | 'openai' (default: anthropic)
 *   ANTHROPIC_API_KEY     — Required if LLM_PROVIDER=anthropic
 *   OPENAI_API_KEY        — Required if LLM_PROVIDER=openai
 *   LLM_MODEL             — Optional model override
 *   AUDITOR_AGENT_ID      — Agent ID for this auditor (default: api-auditor)
 */
import pg from 'pg'
import { createLLMAdapterFromEnv } from '../adapters/llm/index.js'
import type { LLMMessage } from '../adapters/llm/types.js'

const { Client: PgClient } = pg

// --- Config ---
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[api-auditor] DATABASE_URL is required')
  process.exit(1)
}

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const DISCORD_AUDIT_CHANNEL = process.env.DISCORD_AUDIT_CHANNEL
const AUDITOR_AGENT_ID = process.env.AUDITOR_AGENT_ID || 'api-auditor'

// --- Report detection pattern ---
const REPORT_PATTERN = /\[報告[:：]?(完了|失敗|進捗|ブロック)?\]/

// --- Degradation signals (ADR-018 §10) ---
const DEGRADATION_SIGNALS = {
  emptyResponse: (content: string) => content.trim().length < 10,
  repeatedContent: new Map<string, { content: string; count: number; lastSeen: number }>(),
  shortMessages: new Map<string, number[]>(), // agent_id -> timestamps of short messages
}

// --- System prompt (ADR-018 §10 intervention rules embedded) ---
const SYSTEM_PROMPT = `You are the API Auditor for the IYASAKA development team. Your role is to review [報告] (report) messages from Dev Bots and provide brief quality feedback.

## Review Criteria
1. **Completeness**: Does the report include what was done, what changed, and what's next?
2. **SSOT Compliance**: Does the work appear to follow the project's SSOT (Single Source of Truth)?
3. **Quality Signals**: Look for signs of degradation:
   - Vague or incomplete reports
   - Reports that don't mention specific files or changes
   - Repeated identical content across reports
   - Reports that contradict previous decisions

## Response Format
- Keep reviews under 200 characters
- Use Japanese
- Start with an emoji: ✅ (good), ⚠️ (concern), ❌ (problem)
- If the report looks good, just confirm briefly
- If there's a concern, state it clearly and concisely

## Important
- You are NOT the CTO. Do not give instructions or make decisions.
- Only flag concerns for the CTO to review.
- Do not intervene on coding style or preferences.`

// --- Discord REST API (minimal, no full client needed) ---
async function postToDiscord(channelId: string, content: string, replyTo?: string): Promise<void> {
  if (!DISCORD_BOT_TOKEN) {
    console.error(`[api-auditor] Would post to ${channelId}: ${content}`)
    return
  }

  const body: Record<string, unknown> = {
    content,
    allowed_mentions: { parse: ['users', 'roles'] },
  }
  if (replyTo) {
    body.message_reference = { message_id: replyTo }
  }

  const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    console.error(`[api-auditor] Discord post failed: ${resp.status} ${text}`)
  }
}

// --- Main listener ---
async function main() {
  const llm = createLLMAdapterFromEnv()
  console.error(`[api-auditor] Using LLM provider: ${llm.provider}`)

  // DB client for queries
  const queryClient = new PgClient({ connectionString: DATABASE_URL })
  await queryClient.connect()

  // Listener client for pg_notify
  const listenClient = new PgClient({ connectionString: DATABASE_URL })
  await listenClient.connect()

  listenClient.on('error', (err) => {
    console.error(`[api-auditor] Listener error: ${err.message}`)
  })

  await listenClient.query('LISTEN agent_inbox')
  console.error('[api-auditor] Listening for agent_inbox notifications...')

  listenClient.on('notification', async (msg) => {
    if (msg.channel !== 'agent_inbox' || !msg.payload) return

    try {
      const payload = JSON.parse(msg.payload) as { to: string; message_id: string }

      // Fetch the message
      const r = await queryClient.query(
        `SELECT id, channel_id, author_id, content, message_type, metadata, created_at
         FROM agent_messages WHERE id = $1`,
        [payload.message_id],
      )
      if (r.rows.length === 0) return

      const row = r.rows[0]
      const content = row.content as string
      const authorId = row.author_id as string
      const metadata = row.metadata as Record<string, unknown> | null

      // Skip own messages
      if (authorId === AUDITOR_AGENT_ID) return

      // Check for [報告] pattern
      if (!REPORT_PATTERN.test(content)) return

      console.error(`[api-auditor] Report detected from ${authorId}: ${content.slice(0, 80)}...`)

      // Get Discord message info for reply
      const discordMessageId = metadata?.discord_message_id as string | undefined
      const discordChannelId = metadata?.discord_channel_id as string | undefined

      // Send to LLM for review
      const messages: LLMMessage[] = [
        { role: 'user', content: `以下のDev Botからの報告をレビューしてください:\n\n送信者: ${authorId}\n内容: ${content}` },
      ]

      const review = await llm.chat(SYSTEM_PROMPT, messages)

      if (review) {
        // Post review to Discord
        const targetChannel = discordChannelId || DISCORD_AUDIT_CHANNEL
        if (targetChannel) {
          await postToDiscord(targetChannel, review, discordMessageId)
          console.error(`[api-auditor] Review posted to ${targetChannel}`)
        } else {
          console.error(`[api-auditor] Review (no channel to post): ${review}`)
        }
      }
    } catch (err) {
      console.error(`[api-auditor] Error processing notification: ${err}`)
    }
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.error('[api-auditor] Shutting down...')
    await listenClient.end()
    await queryClient.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep alive
  console.error('[api-auditor] API Auditor running. Press Ctrl+C to stop.')
}

main().catch((err) => {
  console.error(`[api-auditor] Fatal error: ${err}`)
  process.exit(1)
})
