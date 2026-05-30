/**
 * Discord client wrapper (bot 1:1 binding)
 *
 * Extracted from server.ts during the FEAT-005 adapter rewrite so the
 * outbound consumer and inbound receiver can share a single source of
 * truth for Discord.js Client lifecycle.
 *
 * Design invariants (see docs/plans/outbound-forwarder-unification.md v5):
 *   - 1 bot = 1 Discord.js Client. The per-bot Map (`discordClients`) is
 *     the authoritative lookup; the shared adapter (`discord`) is only
 *     used in stdio-mode processes, where startup code registers it
 *     under its own AGENT_ID so that `getDiscordClient(AGENT_ID)` hits.
 *   - `getDiscordClient(botId)` MUST NOT fall back to the shared
 *     adapter for unknown botIds. Silent fallback was the root cause of
 *     the 2026-04-12 identity-misattribution incident: the outbound
 *     claim SQL raced, and `getDiscordClient(row.agent_id) ?? discord`
 *     posted the row under whichever bot happened to own the shared
 *     adapter.
 *
 * Dependency injection: the module needs a DB accessor for agent cache
 * refresh + adapter DB-query wiring. To avoid an import cycle with
 * server.ts (which owns the `pg` Client), callers must invoke
 * `setDbGetter()` once at startup.
 */
import { DiscordAdapter } from './discord'
import {
  refreshAgentCacheWith,
  type AgentCacheEntry,
} from '../core/agent-cache'
import { resolveDbDiscordBotToken } from '../core/discord-token-resolution'

// ---- Dependency injection -------------------------------------------------

type DbLike = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
}
type DbGetter = () => Promise<DbLike | null>

let getDb: DbGetter | null = null

/** Install the `pg` client getter. Call once at process startup. */
export function setDbGetter(fn: DbGetter): void {
  getDb = fn
}

// ---- Shared adapter + per-bot Map -----------------------------------------

/**
 * Shared Discord adapter — the single client used by stdio-mode
 * processes. Daemon mode populates `discordClients` with per-bot
 * instances and does not use this one directly.
 *
 * stdio startup code MUST call
 *   `discordClients.set(AGENT_ID, discord)`
 * after connecting so that `getDiscordClient(AGENT_ID)` resolves.
 */
export const discord = new DiscordAdapter()

/** Per-bot Discord clients (daemon mode + stdio self-registration). */
export const discordClients = new Map<string, DiscordAdapter>()

// ---- Constants ------------------------------------------------------------

const DISCORD_BACKOFF_MAX_MS = 30_000
const AGENT_CACHE_TTL_MS = 60_000
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || ''

// ---- Agent cache ----------------------------------------------------------

let agentCacheEntry: AgentCacheEntry | null = null

export async function refreshAgentCache(): Promise<string[]> {
  const db = getDb ? await getDb() : null
  const queryFn = db
    ? async () => {
        const r = await db.query(
          "SELECT agent_id FROM agents WHERE status != 'disabled' ORDER BY agent_id",
        ).catch(() => ({ rows: [] as any[] }))
        return r.rows.map((row: any) => row.agent_id as string)
      }
    : null
  const { updated, ids } = await refreshAgentCacheWith(agentCacheEntry, AGENT_CACHE_TTL_MS, queryFn)
  if (updated) agentCacheEntry = updated
  return ids
}

// ---- Token resolution -----------------------------------------------------

/** Resolve Discord Bot Token for a specific bot (Phase 3c). */
export async function resolveDiscordToken(botId: string): Promise<{ token: string; source: 'per-bot' | 'fallback' } | null> {
  // 1. Runtime login follows the same registered/active credential contract as
  // delivery eligibility. Legacy agent provider_token_source_ref remains a DB
  // fallback inside resolveDbDiscordBotToken.
  const db = getDb ? await getDb() : null
  if (db) {
    try {
      const dbToken = await resolveDbDiscordBotToken(db, botId)
      if (dbToken) {
        process.stderr.write(`agent-comms: resolveDiscordToken(${botId}) — DB ${dbToken.source} accepted (${dbToken.tokenSource})\n`)
        return { token: dbToken.token, source: 'per-bot' }
      }
    } catch (err) {
      process.stderr.write(`agent-comms: resolveDiscordToken(${botId}) — DB token resolution failed: ${err}\n`)
    }
  }

  // 2. Check per-bot env var: DISCORD_TOKEN_{AGENT_ID} (uppercase, hyphens → underscores)
  const envKey = `DISCORD_TOKEN_${botId.toUpperCase().replace(/-/g, '_')}`
  const perBotToken = process.env[envKey]
  if (perBotToken) {
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${perBotToken}` },
      })
      if (res.ok) {
        process.stderr.write(`agent-comms: resolveDiscordToken(${botId}) — per-bot token valid (${envKey})\n`)
        return { token: perBotToken, source: 'per-bot' }
      }
      process.stderr.write(
        `agent-comms: resolveDiscordToken(${botId}) — per-bot token invalid (${envKey}, status: ${res.status})\n`,
      )
    } catch (err) {
      process.stderr.write(`agent-comms: resolveDiscordToken(${botId}) — per-bot token check failed: ${err}\n`)
    }
  }

  // 3. Fallback to shared DISCORD_BOT_TOKEN
  if (DISCORD_BOT_TOKEN) {
    process.stderr.write(`agent-comms: resolveDiscordToken(${botId}) — fallback to shared DISCORD_BOT_TOKEN\n`)
    return { token: DISCORD_BOT_TOKEN, source: 'fallback' }
  }

  process.stderr.write(`agent-comms: resolveDiscordToken(${botId}) — no token available\n`)
  return null
}

// ---- Per-bot connect ------------------------------------------------------

/** Connect a per-bot Discord client with exponential backoff (max 5 attempts). */
export async function connectBotDiscord(botId: string, token: string): Promise<DiscordAdapter | null> {
  let delay = 1000
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const adapter = new DiscordAdapter()
      adapter.setDbQuery(async (sql: string, params?: any[]) => {
        const client = getDb ? await getDb() : null
        if (!client) throw new Error('DB unavailable')
        return client.query(sql, params)
      })
      adapter.setAgentId(botId)
      await adapter.connect({ token })
      process.stderr.write(
        `agent-comms: per-bot Discord connected for ${botId} (attempt ${attempt}; routing handled by routeInbound)\n`,
      )
      return adapter
    } catch (err) {
      process.stderr.write(
        `agent-comms: per-bot Discord connect failed for ${botId} (attempt ${attempt}/${5}): ${err}\n`,
      )
      if (attempt < 5) {
        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 2, DISCORD_BACKOFF_MAX_MS)
      }
    }
  }
  process.stderr.write(`agent-comms: ALERT — per-bot Discord connect failed for ${botId} after 5 attempts\n`)
  return null
}

// ---- Client lookup (no shared fallback) -----------------------------------

/**
 * Return the Discord client for a specific bot.
 *
 * Unknown botId → null + stderr log. Callers must treat null as a
 * no-op (log + skip/requeue), NEVER sub in the shared adapter. Silent
 * shared-fallback substitution caused the 2026-04-12 incident.
 */
export function getDiscordClient(botId: string): DiscordAdapter | null {
  const client = discordClients.get(botId)
  if (!client) {
    console.error(`agent-comms: getDiscordClient(${botId}) — no per-bot client registered`)
    return null
  }
  return client
}
