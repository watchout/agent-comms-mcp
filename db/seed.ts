#!/usr/bin/env bun
/**
 * Seed script for core layer channels + channel_adapters.
 *
 * Fetches real Discord guild data via discord.js API, uses
 * channel.permissionOverwrites to determine per-bot ViewChannel access,
 * then seeds:
 *   - channels table (id = Discord channel ID, members from permissions)
 *   - channel_adapters table (Discord channel ID mappings)
 *
 * All channels include ceo + arc as members (CEO approved).
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=xxx DATABASE_URL=xxx bun db/seed.ts
 *
 * Idempotent: drops existing channels/channel_adapters and re-inserts.
 */

import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { Client as PgClient } from 'pg'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
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

// --- Build Discord user ID → agent_id mapping ---
const CEO_DISCORD_ID = '1227059781265653783'
const CEO_AGENT_ID = 'ceo'
const ARC_AGENT_ID = 'arc'

function buildDiscordIdMap(registry: BotEntry[]): Map<string, string> {
  const map = new Map<string, string>()

  // CEO (human user)
  map.set(CEO_DISCORD_ID, CEO_AGENT_ID)

  // Build session → agentId lookup from registry
  const sessionToAgent = new Map<string, string>()
  for (const bot of registry) {
    sessionToAgent.set(bot.session, bot.agentId)
  }

  // Scan ALL discord-* directories in channels/ (not just registry entries)
  // This catches bots removed from registry but still having Discord permissions
  if (existsSync(channelsDir)) {
    const dirs = readdirSync(channelsDir).filter(d => d.startsWith('discord-'))
    for (const dir of dirs) {
      const access = loadBotAccess(dir)
      if (!access.mentionPatterns) continue
      const discordId = access.mentionPatterns.find(p => /^\d{17,}$/.test(p))
      if (!discordId) continue

      // Resolve agent_id: prefer registry, fall back to derived name
      let agentId = sessionToAgent.get(dir)
      if (!agentId) {
        // Derive from directory name: discord-hotel → hotel-dev, discord-arc → arc
        const baseName = dir.replace('discord-', '')
        // Check common patterns
        const knownDirectAgents = ['arc', 'vice', 'auditor', 'secretary', 'cto']
        agentId = knownDirectAgents.includes(baseName) ? baseName : `${baseName}-dev`
      }
      map.set(discordId, agentId)
    }
  }

  return map
}

// --- Main ---
async function seed() {
  const registry = loadBotRegistry()
  console.log(`Loaded ${registry.length} bots from bot-registry.txt`)

  // Build Discord user ID → agent_id mapping
  const discordIdMap = buildDiscordIdMap(registry)
  console.log(`Built Discord ID mapping for ${discordIdMap.size} users:`)
  for (const [did, aid] of discordIdMap) {
    console.log(`  ${did} → ${aid}`)
  }

  // All known agent IDs (for public channels)
  const allAgentIds = new Set([CEO_AGENT_ID, ...registry.map(b => b.agentId)])

  // Connect to Discord and fetch guild channels
  console.log('Connecting to Discord...')
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  })

  await client.login(discordToken)
  await new Promise<void>(resolve => client.once('ready', () => resolve()))
  console.log(`Connected as ${client.user?.tag}`)

  // Fetch all guilds and their channels
  interface SeedChannel {
    discordId: string
    name: string
    guildId: string
    guildName: string
    members: string[]
  }

  const seedChannels: SeedChannel[] = []

  for (const [, guild] of client.guilds.cache) {
    const channels = await guild.channels.fetch()

    for (const [, channel] of channels) {
      if (!channel) continue
      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildForum &&
        channel.type !== ChannelType.GuildAnnouncement
      ) continue

      // Determine members from permissionOverwrites
      const members = new Set<string>([CEO_AGENT_ID, ARC_AGENT_ID])
      const overwrites = channel.permissionOverwrites.cache

      // Check if @everyone has ViewChannel denied (private channel)
      const everyoneOverwrite = overwrites.get(guild.id)
      const isPrivate = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel) ?? false

      if (!isPrivate) {
        // Public channel: all agents are members
        for (const agentId of allAgentIds) {
          members.add(agentId)
        }
      }

      // Process member-specific overwrites (type = 1)
      for (const [id, overwrite] of overwrites) {
        if (overwrite.type !== OverwriteType.Member) continue

        const agentId = discordIdMap.get(id)
        if (!agentId) {
          // Unknown Discord user ID - log and skip
          console.log(`  [WARN] Channel #${channel.name}: unknown Discord user ${id} in permissionOverwrites (skipped)`)
          continue
        }

        if (overwrite.allow.has(PermissionFlagsBits.ViewChannel)) {
          members.add(agentId)
        }
        if (overwrite.deny.has(PermissionFlagsBits.ViewChannel)) {
          members.delete(agentId)
        }
      }

      seedChannels.push({
        discordId: channel.id,
        name: channel.name,
        guildId: guild.id,
        guildName: guild.name,
        members: [...members],
      })
    }
  }

  console.log(`Found ${seedChannels.length} text channels across ${client.guilds.cache.size} guild(s)`)
  client.destroy()

  // Connect to DB and seed
  console.log('Connecting to PostgreSQL...')
  const db = new PgClient({ connectionString: databaseUrl })
  await db.connect()

  // Second-pass: supplement mapping from agents table (existing discord_id metadata)
  const existingAgents = await db.query(
    "SELECT agent_id, metadata->>'discord_id' as discord_id FROM agents WHERE metadata->>'discord_id' IS NOT NULL"
  )
  for (const row of existingAgents.rows) {
    if (!discordIdMap.has(row.discord_id)) {
      discordIdMap.set(row.discord_id, row.agent_id)
      console.log(`  [DB] ${row.discord_id} → ${row.agent_id} (from agents metadata)`)
    }
  }

  // Drop existing channels/channel_adapters and re-seed (preserve DM channels)
  console.log('Clearing existing channel data (preserving DM channels)...')
  await db.query('DELETE FROM channel_adapters WHERE channel_id IN (SELECT id FROM channels WHERE type != $1)', ['dm'])
  await db.query("DELETE FROM channels WHERE type != $1", ['dm'])

  let channelCount = 0
  let adapterCount = 0

  for (const ch of seedChannels) {
    // Insert channel with Discord ID as primary key
    await db.query(
      `INSERT INTO channels (id, org_id, type, name, members, created_by, created_at, updated_at)
       VALUES ($1, 'default', 'channel', $2, $3, 'seed', now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         members = EXCLUDED.members,
         updated_at = now()`,
      [ch.discordId, ch.name, ch.members]
    )
    channelCount++

    // Insert channel_adapter (channel_id = external_id for Discord)
    await db.query(
      `INSERT INTO channel_adapters (channel_id, platform, external_id, metadata)
       VALUES ($1, 'discord', $2, $3)
       ON CONFLICT (channel_id, platform) DO UPDATE SET
         external_id = EXCLUDED.external_id,
         metadata = EXCLUDED.metadata`,
      [ch.discordId, ch.discordId, JSON.stringify({ guild: ch.guildName, name: ch.name })]
    )
    adapterCount++
  }

  // Also register/update all agents with discord_id in metadata
  for (const bot of registry) {
    const access = loadBotAccess(bot.session)
    const discordId = access.mentionPatterns?.find(p => /^\d{17,}$/.test(p))
    const metadata = discordId ? { discord_id: discordId } : null

    await db.query(
      `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, metadata, registered_at)
       VALUES ($1, 'default', $2, 'dev', 'claude-code', 'offline', $3, now())
       ON CONFLICT (agent_id) DO UPDATE SET
         org_id = 'default',
         display_name = EXCLUDED.display_name,
         metadata = COALESCE(
           jsonb_strip_nulls(COALESCE(agents.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)),
           agents.metadata
         )`,
      [bot.agentId, bot.agentId, metadata ? JSON.stringify(metadata) : null]
    )
  }

  // Register CEO with discord_id
  await db.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, metadata, registered_at)
     VALUES ('ceo', 'default', 'CEO', 'human', 'discord', 'online', $1, now())
     ON CONFLICT (agent_id) DO UPDATE SET
       org_id = 'default',
       metadata = COALESCE(
         jsonb_strip_nulls(COALESCE(agents.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)),
         agents.metadata
       )`,
    [JSON.stringify({ discord_id: CEO_DISCORD_ID })]
  )

  // Audit log entry
  await db.query(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ('channel.seed', 'seed', 'all', $1, 'default')`,
    [JSON.stringify({ channels: channelCount, adapters: adapterCount, agents: registry.length + 1, id_scheme: 'discord_id' })]
  )

  // Print summary
  console.log(`\nSeed complete:`)
  console.log(`  ${channelCount} channels (id = Discord channel ID)`)
  console.log(`  ${adapterCount} channel_adapters`)
  console.log(`  ${registry.length + 1} agents (with discord_id metadata)`)
  console.log(`\nChannel details:`)
  for (const ch of seedChannels) {
    console.log(`  ${ch.discordId} (#${ch.name}): [${ch.members.join(', ')}]`)
  }

  await db.end()
}

seed().catch(e => { console.error(e); process.exit(1) })
