#!/usr/bin/env bun
/**
 * API Auditor / Advisor — Listens for messages and generates LLM responses.
 *
 * Modes:
 *   auditor — Monitors [報告] messages, generates quality reviews
 *   advisor — Monitors @mentions, participates in design discussions
 *
 * Environment variables:
 *   DATABASE_URL          — PostgreSQL connection string
 *   DISCORD_BOT_TOKEN     — Discord bot token for posting
 *   DISCORD_AUDIT_CHANNEL — Discord channel ID for audit log (default: 1486097726784540813)
 *   LLM_PROVIDER          — 'anthropic' | 'openai' | 'google' (default: anthropic)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY
 *   LLM_MODEL             — Optional model override
 *   AUDITOR_AGENT_ID      — Agent ID (default: api-auditor / api-advisor)
 *   AGENT_MODE            — 'auditor' | 'advisor' (default: auditor)
 */
import pg from 'pg'
import { createLLMAdapterFromEnv } from '../adapters/llm/index.js'
import type { LLMMessage } from '../adapters/llm/types.js'

const { Client: PgClient } = pg

// --- Config ---
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[api-agent] DATABASE_URL is required')
  process.exit(1)
}

const AGENT_MODE = (process.env.AGENT_MODE || 'auditor') as 'auditor' | 'advisor'
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const DISCORD_AUDIT_CHANNEL = process.env.DISCORD_AUDIT_CHANNEL || '1486097726784540813'
const AUDITOR_AGENT_ID = process.env.AUDITOR_AGENT_ID || (AGENT_MODE === 'advisor' ? 'api-advisor' : 'api-auditor')

const LOG_TAG = `[api-${AGENT_MODE}]`

// --- Detection patterns ---
const REPORT_PATTERN = /\[報告[:：]?(完了|失敗|進捗|ブロック)?\]/
const MENTION_PATTERNS = [/advisor/i, /アドバイザー/, /設計者/]

// --- System prompts ---
const AUDITOR_PROMPT = `You are the API Auditor for the IYASAKA development team. Your role is to review [報告] (report) messages from Dev Bots and provide brief quality feedback.

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

const ADVISOR_PROMPT = `You are a Design Advisor for the IYASAKA development team. You participate in architectural and design discussions, offering insights from a broad technical perspective.

## Role
- Provide technical analysis and alternative approaches
- Reference established decisions and patterns
- Flag potential risks or trade-offs
- Support decision-making with reasoning, not directives

## Response Format
- Use Japanese
- Keep responses concise (under 500 characters)
- Structure: 観点 → 分析 → 提案
- Be direct and specific, avoid vague generalities

## Important
- You are an advisor, not a decision-maker. The CTO and CEO make final decisions.
- Reference past decisions when relevant (they will be provided in context).
- Do not repeat what others have already said.`

// --- Fetch active decisions from agent-memory ---
async function fetchActiveDecisions(client: pg.Client): Promise<string> {
  try {
    const r = await client.query(
      `SELECT decision, context, tags FROM decisions
       WHERE status = 'active' ORDER BY created_at DESC LIMIT 10`
    )
    if (r.rows.length === 0) return ''

    const lines = r.rows.map((row: { decision: string; context?: string; tags?: string[] }) => {
      let line = `• ${row.decision}`
      if (row.context) line += ` (${row.context})`
      if (row.tags?.length) line += ` [${row.tags.join(', ')}]`
      return line
    })
    return `\n\n## Active Decisions (from agent-memory)\n${lines.join('\n')}`
  } catch {
    // decisions table may not exist if agent-memory not set up
    return ''
  }
}

// --- Build system prompt with decisions ---
async function buildSystemPrompt(client: pg.Client): Promise<string> {
  const basePrompt = AGENT_MODE === 'advisor' ? ADVISOR_PROMPT : AUDITOR_PROMPT
  const decisions = await fetchActiveDecisions(client)
  return basePrompt + decisions
}

// --- Discord REST API ---
async function postToDiscord(channelId: string, content: string, replyTo?: string): Promise<void> {
  if (!DISCORD_BOT_TOKEN) {
    console.error(`${LOG_TAG} Would post to ${channelId}: ${content}`)
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
    console.error(`${LOG_TAG} Discord post failed: ${resp.status} ${text}`)
  }
}

// --- Check if message should be processed ---
function shouldProcess(content: string, authorId: string): boolean {
  if (authorId === AUDITOR_AGENT_ID) return false
  if (authorId === 'api-auditor' || authorId === 'api-advisor' || authorId === 'codex-auditor') return false

  if (AGENT_MODE === 'auditor') {
    return REPORT_PATTERN.test(content)
  }
  // Advisor mode: respond to mentions
  return MENTION_PATTERNS.some((p) => p.test(content))
}

// --- Main listener ---
async function main() {
  const llm = createLLMAdapterFromEnv()
  console.error(`${LOG_TAG} Mode: ${AGENT_MODE}, LLM: ${llm.provider}`)

  const queryClient = new PgClient({ connectionString: DATABASE_URL })
  await queryClient.connect()

  const listenClient = new PgClient({ connectionString: DATABASE_URL })
  await listenClient.connect()

  listenClient.on('error', (err) => {
    console.error(`${LOG_TAG} Listener error: ${err.message}`)
  })

  await listenClient.query('LISTEN agent_inbox')
  console.error(`${LOG_TAG} Listening for agent_inbox notifications...`)

  // Pre-fetch system prompt with decisions
  let systemPrompt = await buildSystemPrompt(queryClient)
  // Refresh decisions every 5 minutes
  setInterval(async () => {
    systemPrompt = await buildSystemPrompt(queryClient)
  }, 5 * 60 * 1000)

  listenClient.on('notification', async (msg) => {
    if (msg.channel !== 'agent_inbox' || !msg.payload) return

    try {
      const payload = JSON.parse(msg.payload) as { to: string; message_id: string }

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

      if (!shouldProcess(content, authorId)) return

      console.error(`${LOG_TAG} Processing message from ${authorId}: ${content.slice(0, 80)}...`)

      const discordMessageId = metadata?.discord_message_id as string | undefined
      const discordChannelId = metadata?.discord_channel_id as string | undefined

      // Build LLM messages
      const userContent = AGENT_MODE === 'auditor'
        ? `以下のDev Botからの報告をレビューしてください:\n\n送信者: ${authorId}\n内容: ${content}`
        : `以下のメッセージに設計アドバイザーとして回答してください:\n\n送信者: ${authorId}\n内容: ${content}`

      const messages: LLMMessage[] = [{ role: 'user', content: userContent }]
      const review = await llm.chat(systemPrompt, messages)

      if (review) {
        const targetChannel = discordChannelId || DISCORD_AUDIT_CHANNEL
        if (targetChannel) {
          // Post to source channel
          await postToDiscord(targetChannel, review, discordMessageId)
          console.error(`${LOG_TAG} Response posted to ${targetChannel}`)

          // Also log to audit channel (if different from target)
          if (AGENT_MODE === 'auditor' && targetChannel !== DISCORD_AUDIT_CHANNEL) {
            const auditLog = `[${AGENT_MODE}] ${authorId}の報告レビュー:\n${review}`
            await postToDiscord(DISCORD_AUDIT_CHANNEL, auditLog.slice(0, 2000))
          }
        } else {
          console.error(`${LOG_TAG} Response (no channel): ${review}`)
        }
      }
    } catch (err) {
      console.error(`${LOG_TAG} Error processing notification: ${err}`)
    }
  })

  const shutdown = async () => {
    console.error(`${LOG_TAG} Shutting down...`)
    await listenClient.end()
    await queryClient.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.error(`${LOG_TAG} Running. Press Ctrl+C to stop.`)
}

main().catch((err) => {
  console.error(`${LOG_TAG} Fatal error: ${err}`)
  process.exit(1)
})
