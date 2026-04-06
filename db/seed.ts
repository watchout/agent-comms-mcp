#!/usr/bin/env bun
/**
 * Seed script for core layer channels + channel_adapters.
 *
 * Fetches real Discord guild data via discord.js API, then cross-references
 * with bot-registry.txt and access.json configs to build:
 *   - channels table (with members derived from access configs)
 *   - channel_adapters table (Discord channel ID mappings)
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=xxx DATABASE_URL=xxx bun db/seed.ts
 *
 * Safe to run multiple times (ON CONFLICT DO UPDATE).
 */

import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import { Client as PgClient } from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// --- Config ---
const rootDir = join(dirname(new URL(import.meta.url).pathname), '..')
const configPath = join(rootDir, 'config.json')
const registryPath = join(rootDir, 'scripts', 'bot-registry.txt')
const channelsDir = join(homedir(), '.claude', 'channels')

let databaseUrl = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    databaseUrl = config.database_url ?? databaseUrl
  } catch {}
}

const discordToken = process.env.DISCORD_BOT_TOKEN
if (!discordToken) {
  console.error('DISCORD_BOT_TOKEN is required')
  process.exit(1)
}

// --- Parse bot-registry.txt ---
interface BotEntry {
  session: string
  projectDir: string
  agentId: string
  port: number
}

function loadBotRegistry(): BotEntry[] {
  if (!existsSync(registryPath)) return []
  return readFileSync(registryPath, 'utf-8')
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const [session, projectDir, agentId, port] = line.split('|')
      return { session, projectDir, agentId, port: parseInt(port) }
    })
}

// --- Load access.json for each bot ---
interface AccessConfig {
  allowChannels?: string[]
  mentionPatterns?: string[]
  allowFrom?: string[]
}

function loadBotAccess(session: string): AccessConfig {
  const accessPath = join(channelsDir, session, 'access.json')
  if (!existsSync(accessPath)) return {}
  try {
    return JSON.parse(readFileSync(accessPath, 'utf-8'))
  } catch {
    return {}
  }
}

// --- Main ---
async function seed() {
  const registry = loadBotRegistry()
  console.log(`Loaded ${registry.length} bots from bot-registry.txt`)

  // Collect bot access configs
  const botAccess = new Map<string, AccessConfig>()
  for (const bot of registry) {
    const access = loadBotAccess(bot.session)
    botAccess.set(bot.agentId, access)
  }

  // Connect to Discord and fetch guild channels
  console.log('Connecting to Discord...')
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  })

  await client.login(discordToken)
  await new Promise<void>(resolve => client.once('ready', () => resolve()))
  console.log(`Connected as ${client.user?.tag}`)

  // Fetch all guilds and their channels
  interface DiscordChannel {
    id: string
    name: string
    type: ChannelType
    parentId: string | null
    guildId: string
    guildName: string
  }

  const discordChannels: DiscordChannel[] = []
  for (const [, guild] of client.guilds.cache) {
    const channels = await guild.channels.fetch()
    for (const [, channel] of channels) {
      if (!channel) continue
      if (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildForum ||
        channel.type === ChannelType.GuildAnnouncement
      ) {
        discordChannels.push({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parentId: channel.parentId,
          guildId: guild.id,
          guildName: guild.name,
        })
      }
    }
  }

  console.log(`Found ${discordChannels.length} text channels across ${client.guilds.cache.size} guild(s)`)
  client.destroy()

  // Build channel → members mapping
  // A bot is a "member" of a channel if:
  // 1. allowChannels includes the Discord channel ID (main-lead)
  // 2. The bot has mentionPatterns (can be mentioned in any channel)
  // For v0.1.0, we include all bots as members of all channels (conservative),
  // but mark allowChannels bots as primary members.

  // Also add human users: CEO (snsmaster369)
  const CEO_AGENT_ID = 'ceo'

  // Build core channel records
  interface CoreChannel {
    id: string
    name: string
    members: string[]
    discordId: string
  }

  const coreChannels: CoreChannel[] = []

  for (const dc of discordChannels) {
    // Determine members: bots whose allowChannels includes this channel,
    // plus bots that have no allowChannels (they listen to all channels)
    const members: string[] = [CEO_AGENT_ID]

    for (const bot of registry) {
      const access = botAccess.get(bot.agentId)
      if (!access) {
        members.push(bot.agentId)
        continue
      }

      if (!access.allowChannels || access.allowChannels.length === 0) {
        // No allowChannels restriction = member of all channels
        members.push(bot.agentId)
      } else if (access.allowChannels.includes(dc.id)) {
        // Explicitly allowed in this channel
        members.push(bot.agentId)
      } else if (access.mentionPatterns && access.mentionPatterns.length > 0) {
        // Has mentionPatterns = can be mentioned in any channel
        members.push(bot.agentId)
      }
    }

    // Use Discord channel name as core channel ID (sanitized)
    const coreId = dc.name.replace(/[^a-z0-9-]/g, '-')

    coreChannels.push({
      id: coreId,
      name: dc.name,
      members: [...new Set(members)],
      discordId: dc.id,
    })
  }

  // Connect to DB and seed
  console.log('Connecting to PostgreSQL...')
  const db = new PgClient({ connectionString: databaseUrl })
  await db.connect()

  let channelCount = 0
  let adapterCount = 0

  for (const ch of coreChannels) {
    // Upsert channel
    await db.query(
      `INSERT INTO channels (id, org_id, type, name, members, created_by, created_at, updated_at)
       VALUES ($1, 'default', 'channel', $2, $3, 'seed', now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         members = EXCLUDED.members,
         updated_at = now()`,
      [ch.id, ch.name, ch.members]
    )
    channelCount++

    // Upsert channel_adapter
    await db.query(
      `INSERT INTO channel_adapters (channel_id, platform, external_id, metadata)
       VALUES ($1, 'discord', $2, $3)
       ON CONFLICT (channel_id, platform) DO UPDATE SET
         external_id = EXCLUDED.external_id,
         metadata = EXCLUDED.metadata`,
      [ch.id, ch.discordId, JSON.stringify({ guild: ch.name })]
    )
    adapterCount++
  }

  // Also register all agents
  for (const bot of registry) {
    await db.query(
      `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, registered_at)
       VALUES ($1, 'default', $2, 'dev', 'claude-code', 'offline', now())
       ON CONFLICT (agent_id) DO UPDATE SET
         org_id = 'default',
         display_name = EXCLUDED.display_name`,
      [bot.agentId, bot.agentId]
    )
  }

  // Register CEO
  await db.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, registered_at)
     VALUES ('ceo', 'default', 'CEO', 'human', 'discord', 'online', now())
     ON CONFLICT (agent_id) DO UPDATE SET org_id = 'default'`
  )

  // Audit log entry
  await db.query(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ('channel.seed', 'seed', 'all', $1, 'default')`,
    [JSON.stringify({ channels: channelCount, adapters: adapterCount, agents: registry.length + 1 })]
  )

  console.log(`Seeded ${channelCount} channels, ${adapterCount} adapters, ${registry.length + 1} agents`)
  console.log('Seed complete.')

  await db.end()
}

seed().catch(e => { console.error(e); process.exit(1) })
