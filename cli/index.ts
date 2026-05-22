#!/usr/bin/env bun
/**
 * agent-com CLI — Channel, agent, and status management + message I/O.
 *
 * Usage:
 *   agent-com channel create <id> --name "Name" --members cto,dev-a
 *   agent-com channel add-member <channel_id> <agent_id>
 *   agent-com channel remove-member <channel_id> <agent_id>
 *   agent-com channel members <channel_id>
 *   agent-com agent register <agent_id> --display-name "Dev A" --type dev --runtime claude-code
 *   agent-com status
 *
 * Issue #132 — message-queue-spec §4-6 CLI commands (MVP):
 *   agent-com next                                          — fetch one unread message (oldest first)
 *   agent-com send --content "..." --mentions cto,ceo       — reply to last next-fetched message
 *   agent-com agents                                        — list registered agents (JSON)
 *
 * `next` and `send` track the in-flight reply target via a per-agent state file
 * at `/tmp/agent-com-{AGENT_ID}.current`. AGENT_ID env var is required for both.
 */

import type { Client } from 'pg'
import { truncateForDiscord } from '../core/truncate'
import { createDbAdapter, type DbAdapter } from '../core/db'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash, createHmac } from 'node:crypto'
import { fetchReplyChain, parseReplyChainDepth } from '../core/reply-chain'
import { fanoutToRecipients } from '../core/send-fanout'
import { resolveOutboundProjectionDecision } from '../core/outbound-projection'
import { decorateProjectedContent } from '../core/projection-text-decorator'
import { diagnoseInboundQueueRow, diagnoseOutboundQueueRow } from '../core/delivery-diagnostics'
import { buildQueueDoctorReport, formatQueueDoctorText } from '../core/queue-doctor'
import { buildQueueNormalizationReport, formatQueueNormalizationText } from '../core/queue-normalization'
import { buildDirectoryReport, formatDirectoryText } from '../core/directory'
import { buildRuntimeInventoryReport, formatRuntimeInventoryText } from '../core/runtime-inventory'
import { closeObsoletePendingQueueRows, reassignPendingQueueRows, reclaimExpiredQueueClaims } from '../core/queue-repair'
import { refreshChannelPolicyDbSnapshot } from '../core/channel-policy'
import { createOutboundPolicyValidator } from '../core/routing'
import {
  acquireControlPlaneLease,
  heartbeatControlPlaneLease,
  releaseControlPlaneLease,
  verifyControlPlaneFence,
  type LeasePurpose,
  type LeaseScopeType,
} from '../core/control-plane-leases'
import { syncChannelPolicyConnectors, type BindingRole, type OrderingScope } from '../core/channel-connector-sync'

// --- DB connection ---
// `getDatabaseUrl()` is retained for callers that still need the raw PG URL
// (e.g. passed into `persistInboundDelivery` which opens its own pg.Client for
// the atomic 7b+7d transaction). The CLI itself no longer instantiates a
// pg.Client directly — it goes through `createDbAdapter()` so SQLite mode
// (`AGENT_COM_DB=sqlite`) works without pg being reachable.
function getDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv) return fromEnv
  const configPath = join(dirname(new URL(import.meta.url).pathname), '..', 'config.json')
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (config.database_url) return config.database_url
    } catch {}
  }
  return 'postgresql://localhost/agent_comms'
}

/**
 * Phase C v2.1.0 "F": detect SQLite mode so pg-only helpers (pg_notify,
 * pg_try_advisory_lock) silently no-op instead of throwing "no such function"
 * when the CLI runs against SQLite. Mirrors `createDbAdapter()`'s detection.
 */
function isSqliteMode(): boolean {
  const explicit = process.env.AGENT_COM_DB
  if (explicit === 'sqlite') return true
  if (explicit === 'postgres' || explicit === 'postgresql') return false
  // No explicit AGENT_COM_DB: default to sqlite unless DATABASE_URL is set.
  return !process.env.DATABASE_URL
}

/**
 * Phase C v2.1.0 "F": return a `pg.Client`-shaped shim backed by the unified
 * `DbAdapter`. All existing CLI call sites use `.query(sql, params)` and
 * `.end()`, which we re-expose with matching shapes so the migration is a
 * single swap at this boundary. For SQLite mode the backing adapter is
 * `SqliteAdapter` (bun:sqlite, `AGENT_COM_SQLITE_PATH`); for postgres it is
 * `PgAdapter` (pg.Client, `DATABASE_URL`). pg-only queries (pg_notify /
 * pg_try_advisory_lock) will throw in SQLite mode — callers either gate on
 * `isSqliteMode()` or wrap in try/catch, which is how the existing CLI was
 * already written.
 */
async function getDb(): Promise<Client> {
  const adapter = createDbAdapter()
  const shim = {
    query: async (sql: string, params?: any[]) => {
      const rows = await adapter.query(sql, params)
      return { rows, rowCount: rows.length }
    },
    end: async (): Promise<void> => {
      await adapter.close()
    },
    // Raw adapter exposed for callers that need execute()/transaction() semantics.
    __adapter: adapter,
  } as unknown as Client & { __adapter: DbAdapter }
  return shim
}

// --- Helpers ---
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(argv[i])
    }
  }
  return { positional, flags }
}

function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

function hasFlag(flags: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key)
}

function parsePositiveIntFlag(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Error: --${name} must be a positive integer`)
    process.exit(2)
  }
  return parsed
}

function parseCsvFlag(value: string | undefined): string[] | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === 'none' || trimmed === 'null') return []
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function parsePolicyArray(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === 'none' || trimmed === 'null') return null
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
  } catch {}
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseRepairDryRun(flags: Record<string, string>): boolean {
  const execute = flagEnabled(flags.execute)
  const dryRun = flagEnabled(flags['dry-run'])
  if (execute && dryRun) {
    console.error('Error: use either --execute or --dry-run, not both')
    process.exit(2)
  }
  if (hasFlag(flags, 'execute') && !execute) return true
  return !execute
}

async function auditLog(db: Client, eventType: string, agentId: string | null, target: string | null, detail: Record<string, unknown>) {
  await db.query(
    'INSERT INTO audit_log (event_type, agent_id, target, detail, org_id) VALUES ($1, $2, $3, $4, $5)',
    [eventType, agentId, target, JSON.stringify(detail), 'default']
  )
}

async function pgNotify(db: Client, channel: string, payload: Record<string, unknown>) {
  if (process.env.AGENT_COM_PG_NOTIFY === 'false') return
  if (isSqliteMode()) return  // SQLite has no pg_notify — silently skip
  try {
    await db.query(`SELECT pg_notify($1, $2)`, [channel, JSON.stringify(payload)])
  } catch (err) {
    process.stderr.write(`agent-com: pg_notify failed (non-fatal): ${err}\n`)
  }
}

async function validateCliOutboundPolicy(
  db: Client,
  sender: string,
  channelId: string,
  recipients: string[],
): Promise<{ ok: true } | { ok: false; violations: string[] }> {
  await refreshChannelPolicyDbSnapshot(db as any)
  return createOutboundPolicyValidator().validate(sender, channelId, recipients)
}

// --- Commands ---

async function channelCreate(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const id = positional[0]
  if (!id) { console.error('Usage: agent-com channel create <id> [--name "Name"] [--members cto,dev-a]'); process.exit(1) }

  const name = flags.name ?? id
  const members = flags.members ? flags.members.split(',').map(m => m.trim()) : []

  const db = await getDb()
  await db.query(
    `INSERT INTO channels (id, org_id, type, name, members, created_by, created_at, updated_at)
     VALUES ($1, 'default', 'channel', $2, $3, 'cli', now(), now())
     ON CONFLICT (id) DO UPDATE SET name = $2, members = $3, updated_at = now()`,
    [id, name, members]
  )
  await auditLog(db, 'channel.create', 'cli', id, { name, members })
  await pgNotify(db, 'agent_events', { event: 'channel.created', channel_id: id, created_by: 'cli' })
  console.log(`Channel '${id}' created (members: ${members.join(', ') || 'none'})`)
  await db.end()
}

async function channelAddMember(args: string[]) {
  const [channelId, agentId] = args
  if (!channelId || !agentId) { console.error('Usage: agent-com channel add-member <channel_id> <agent_id>'); process.exit(1) }

  const db = await getDb()
  const r = await db.query('SELECT members FROM channels WHERE id = $1', [channelId])
  if (r.rows.length === 0) { console.error(`Channel '${channelId}' not found`); await db.end(); process.exit(1) }

  const members: string[] = r.rows[0].members ?? []
  if (members.includes(agentId)) { console.log(`'${agentId}' is already a member of '${channelId}'`); await db.end(); return }

  members.push(agentId)
  await db.query('UPDATE channels SET members = $1, updated_at = now() WHERE id = $2', [members, channelId])
  await auditLog(db, 'channel.member_add', 'cli', channelId, { agent_id: agentId })
  await pgNotify(db, 'agent_events', { event: 'channel.member_add', channel_id: channelId, agent_id: agentId })
  console.log(`Added '${agentId}' to '${channelId}' (${members.length} members)`)
  await db.end()
}

async function channelRemoveMember(args: string[]) {
  const [channelId, agentId] = args
  if (!channelId || !agentId) { console.error('Usage: agent-com channel remove-member <channel_id> <agent_id>'); process.exit(1) }

  const db = await getDb()
  const r = await db.query('SELECT members FROM channels WHERE id = $1', [channelId])
  if (r.rows.length === 0) { console.error(`Channel '${channelId}' not found`); await db.end(); process.exit(1) }

  const members: string[] = (r.rows[0].members ?? []).filter((m: string) => m !== agentId)
  await db.query('UPDATE channels SET members = $1, updated_at = now() WHERE id = $2', [members, channelId])
  await auditLog(db, 'channel.member_remove', 'cli', channelId, { agent_id: agentId })
  await pgNotify(db, 'agent_events', { event: 'channel.member_remove', channel_id: channelId, agent_id: agentId })
  console.log(`Removed '${agentId}' from '${channelId}' (${members.length} members)`)
  await db.end()
}

async function channelMembers(args: string[]) {
  const [channelId] = args
  if (!channelId) { console.error('Usage: agent-com channel members <channel_id>'); process.exit(1) }

  const db = await getDb()
  const r = await db.query('SELECT id, name, members FROM channels WHERE id = $1', [channelId])
  if (r.rows.length === 0) { console.error(`Channel '${channelId}' not found`); await db.end(); process.exit(1) }

  const ch = r.rows[0]
  const members: string[] = ch.members ?? []
  console.log(`Channel: ${ch.id} (${ch.name ?? 'unnamed'})`)
  console.log(`Members (${members.length}):`)
  for (const m of members) console.log(`  - ${m}`)
  await db.end()
}

function botRoutingConfigPath(): string {
  if (process.env.AGENT_COM_BOT_ROUTING_PATH) return process.env.AGENT_COM_BOT_ROUTING_PATH
  const repoRoot = new URL('..', import.meta.url).pathname
  return join(repoRoot, 'config', 'bot-routing.json')
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseDbStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean)
  }
  const parsed = parsePolicyArray(trimmed)
  return parsed ?? []
}

type BootstrapAgent = {
  agent_id: string
  agent_type: string
  runtime: string
  status: string
  metadata: Record<string, unknown>
}

function isReadyProjectionOwner(agent: BootstrapAgent | undefined): boolean {
  if (!agent || agent.agent_type === 'human') return false
  if (!['idle', 'online', 'busy'].includes(agent.status)) return false
  const discordId = agent.metadata.discord_id
  return typeof discordId === 'string' && discordId.trim().length > 0
}

function ownerFromAdapterMetadata(raw: unknown): string | null {
  const metadata = parseJsonObject(raw)
  const value = metadata.consumer_agent_id
    ?? metadata.adapter_owner
    ?? metadata.adapterOwner
    ?? metadata.owner_agent_id
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isMissingColumnError(err: unknown, column: string): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return new RegExp(column, 'i').test(message) && /(no such column|column .* does not exist|does not exist)/i.test(message)
}

function chooseBootstrapOwner(row: any, members: string[], agents: Map<string, BootstrapAgent>): string | null {
  const metadataOwner = ownerFromAdapterMetadata(row.adapter_metadata)
  if (metadataOwner && isReadyProjectionOwner(agents.get(metadataOwner))) return metadataOwner

  const channelName = String(row.name ?? '').toLowerCase()
  const preferredByChannel = [
    [/audit|approval/, 'auditor'],
    [/ceo-vice|executive/, 'vice'],
  ] as Array<[RegExp, string]>
  for (const [pattern, agentId] of preferredByChannel) {
    if (pattern.test(channelName) && members.includes(agentId) && isReadyProjectionOwner(agents.get(agentId))) {
      return agentId
    }
  }

  const candidates = members
    .map((agentId, index) => ({ agentId, index, agent: agents.get(agentId) }))
    .filter((item) => isReadyProjectionOwner(item.agent))
    .map((item) => {
      let score = 0
      if (item.agentId.endsWith('-dev')) score += 50
      if (item.agentId.includes('lead')) score += 45
      if (item.agent?.runtime === 'TUI') score += 10
      if (item.agentId.startsWith('codex-')) score -= 20
      if (item.agentId === 'auditor') score += 5
      return { ...item, score }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)

  return candidates[0]?.agentId ?? null
}

async function buildDirectoryBootstrapPolicies(db: Client, flags: Record<string, string>) {
  const includeDm = flagEnabled(flags['include-dm'])
  const overwrite = flagEnabled(flags.overwrite)
  const extraAllowlist = parseCsvFlag(flags['extra-allowlist']) ?? []
  let agentRows
  try {
    agentRows = await db.query(
      `SELECT agent_id, agent_type, runtime, status, metadata
         FROM agents
        ORDER BY agent_id`,
    )
  } catch (err) {
    if (!isMissingColumnError(err, 'runtime')) throw err
    agentRows = await db.query(
      `SELECT agent_id, agent_type, cli_type AS runtime, status, metadata
         FROM agents
        ORDER BY agent_id`,
    )
  }
  const agents = new Map<string, BootstrapAgent>(
    agentRows.rows.map((row: any) => [
      String(row.agent_id),
      {
        agent_id: String(row.agent_id),
        agent_type: String(row.agent_type ?? ''),
        runtime: String(row.runtime ?? ''),
        status: String(row.status ?? ''),
        metadata: parseJsonObject(row.metadata),
      },
    ]),
  )
  const existing = await db.query(`SELECT channel_id FROM channel_routing_policy`)
  const existingPolicyChannels = new Set(existing.rows.map((row: any) => String(row.channel_id)))
  const channelRows = await db.query(
    `SELECT c.id, c.name, c.type, c.members, ca.metadata AS adapter_metadata
       FROM channels c
       JOIN channel_adapters ca
         ON ca.channel_id = c.id
        AND ca.platform = 'discord'
      ORDER BY c.name, c.id`,
  )

  const policies: Array<{
    channel_id: string
    channel_name: string | null
    primary_agent_id: string
    adapter_owner_agent_id: string
    outbound_allowlist: string[]
    native_role_outbound_owners: Record<string, unknown>
    native_projection_identities: Record<string, unknown>
    policy_source: string
  }> = []
  const skipped: Array<{ channel_id: string; channel_name: string | null; reason: string }> = []

  for (const row of channelRows.rows) {
    const channelId = String(row.id)
    const channelName = row.name ? String(row.name) : null
    if (!includeDm && String(row.type ?? '') === 'dm') {
      skipped.push({ channel_id: channelId, channel_name: channelName, reason: 'dm_skipped' })
      continue
    }
    if (!overwrite && existingPolicyChannels.has(channelId)) {
      skipped.push({ channel_id: channelId, channel_name: channelName, reason: 'policy_exists' })
      continue
    }
    const members = parseDbStringArray(row.members)
    const owner = chooseBootstrapOwner(row, members, agents)
    if (!owner) {
      skipped.push({ channel_id: channelId, channel_name: channelName, reason: 'no_ready_discord_bot_member' })
      continue
    }
    const outboundAllowlist = [...new Set([...members, ...extraAllowlist].filter(Boolean))]
    policies.push({
      channel_id: channelId,
      channel_name: channelName,
      primary_agent_id: owner,
      adapter_owner_agent_id: owner,
      outbound_allowlist: outboundAllowlist,
      native_role_outbound_owners: {},
      native_projection_identities: {},
      policy_source: 'directory_bootstrap',
    })
  }

  return { policies, skipped, overwrite, include_dm: includeDm, extra_allowlist: extraAllowlist }
}

async function assertPolicyAgentsExist(db: Client, agentIds: string[]) {
  const ids = [...new Set(agentIds.filter(Boolean))]
  if (ids.length === 0) return
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.query(`SELECT agent_id FROM agents WHERE agent_id IN (${placeholders})`, ids)
  const found = new Set(rows.rows.map((row: any) => String(row.agent_id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new Error(`unknown policy agent_id(s): ${missing.join(', ')}`)
  }
}

async function assertPolicyChannelsExist(db: Client, channelIds: string[]) {
  const ids = [...new Set(channelIds.filter(Boolean))]
  if (ids.length === 0) return
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.query(`SELECT id FROM channels WHERE id IN (${placeholders})`, ids)
  const found = new Set(rows.rows.map((row: any) => String(row.id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new Error(`unknown policy channel_id(s): ${missing.join(', ')}`)
  }
}

function normalizePolicyRowForOutput(row: any) {
  return {
    channel_id: row.channel_id,
    primary_agent_id: row.primary_agent_id ?? null,
    adapter_owner_agent_id: row.adapter_owner_agent_id ?? null,
    outbound_allowlist: parsePolicyArray(row.outbound_allowlist),
    native_role_outbound_owners: parseJsonObject(row.native_role_outbound_owners),
    native_projection_identities: parseJsonObject(row.native_projection_identities),
    policy_source: row.policy_source,
    updated_at: row.updated_at,
  }
}

async function upsertChannelPolicy(db: Client, policy: {
  channel_id: string
  primary_agent_id: string | null
  adapter_owner_agent_id: string | null
  outbound_allowlist: string[] | null
  native_role_outbound_owners: Record<string, unknown>
  native_projection_identities: Record<string, unknown>
  policy_source: string
}) {
  await db.query(
    `INSERT INTO channel_routing_policy (
       channel_id,
       primary_agent_id,
       adapter_owner_agent_id,
       outbound_allowlist,
       native_role_outbound_owners,
       native_projection_identities,
       policy_source,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (channel_id) DO UPDATE SET
       primary_agent_id = EXCLUDED.primary_agent_id,
       adapter_owner_agent_id = EXCLUDED.adapter_owner_agent_id,
       outbound_allowlist = EXCLUDED.outbound_allowlist,
       native_role_outbound_owners = EXCLUDED.native_role_outbound_owners,
       native_projection_identities = EXCLUDED.native_projection_identities,
       policy_source = EXCLUDED.policy_source,
       updated_at = now()`,
    [
      policy.channel_id,
      policy.primary_agent_id,
      policy.adapter_owner_agent_id,
      policy.outbound_allowlist === null ? null : JSON.stringify(policy.outbound_allowlist),
      JSON.stringify(policy.native_role_outbound_owners),
      JSON.stringify(policy.native_projection_identities),
      policy.policy_source,
    ],
  )
}

async function channelPolicy(args: string[]) {
  const [action, ...rest] = args
  const { positional, flags } = parseArgs(rest)
  const format = flags.format ?? 'text'
  const db = await getDb()
  try {
    if (action === 'list') {
      const rows = await db.query(
        `SELECT channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist,
                native_role_outbound_owners, native_projection_identities, policy_source, updated_at
           FROM channel_routing_policy
          ORDER BY channel_id`,
      )
      const policies = rows.rows.map(normalizePolicyRowForOutput)
      if (format === 'json') {
        process.stdout.write(`${JSON.stringify({ ok: true, policies }, null, 2)}\n`)
        return
      }
      console.log(`Channel policies (${policies.length}):`)
      for (const row of policies) {
        console.log(`  ${row.channel_id}: primary=${row.primary_agent_id ?? '-'} adapter=${row.adapter_owner_agent_id ?? '-'} allowlist=${JSON.stringify(row.outbound_allowlist ?? null)} source=${row.policy_source}`)
      }
      return
    }

    if (action === 'import-json') {
      const dryRun = parseRepairDryRun(flags)
      const path = flags.path ?? botRoutingConfigPath()
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        channels?: Record<string, {
          primary?: string | null
          adapterOwner?: string | null
          outboundAllowlist?: string[]
          nativeRoleOutboundOwners?: Record<string, unknown>
          nativeProjectionIdentities?: Record<string, unknown>
        }>
      }
      const policies = Object.entries(parsed.channels ?? {}).map(([channelId, entry]) => ({
        channel_id: channelId,
        primary_agent_id: entry.primary ?? null,
        adapter_owner_agent_id: entry.adapterOwner ?? null,
        outbound_allowlist: Array.isArray(entry.outboundAllowlist) ? entry.outboundAllowlist : null,
        native_role_outbound_owners: parseJsonObject(entry.nativeRoleOutboundOwners),
          native_projection_identities: parseJsonObject(entry.nativeProjectionIdentities),
          policy_source: 'json_import',
        }))
      await assertPolicyChannelsExist(db, policies.map((policy) => policy.channel_id))
      for (const policy of policies) {
        await assertPolicyAgentsExist(db, [
          policy.primary_agent_id ?? '',
          policy.adapter_owner_agent_id ?? '',
          ...(policy.outbound_allowlist ?? []),
          ...Object.values(policy.native_role_outbound_owners).filter((v): v is string => typeof v === 'string'),
          ...Object.values(policy.native_projection_identities).filter((v): v is string => typeof v === 'string'),
        ])
      }
      if (!dryRun) {
        for (const policy of policies) await upsertChannelPolicy(db, policy)
        await auditLog(db, 'channel.policy_import_json', 'cli', null, { path, count: policies.length })
        await refreshChannelPolicyDbSnapshot(db as any)
      }
      process.stdout.write(`${JSON.stringify({ ok: true, dry_run: dryRun, count: policies.length, policies }, null, 2)}\n`)
      return
    }

    if (action === 'bootstrap') {
      const dryRun = parseRepairDryRun(flags)
      const bootstrap = await buildDirectoryBootstrapPolicies(db, flags)
      await assertPolicyChannelsExist(db, bootstrap.policies.map((policy) => policy.channel_id))
      for (const policy of bootstrap.policies) {
        await assertPolicyAgentsExist(db, [
          policy.primary_agent_id,
          policy.adapter_owner_agent_id,
          ...policy.outbound_allowlist,
        ])
      }
      if (!dryRun) {
        for (const policy of bootstrap.policies) {
          await upsertChannelPolicy(db, {
            channel_id: policy.channel_id,
            primary_agent_id: policy.primary_agent_id,
            adapter_owner_agent_id: policy.adapter_owner_agent_id,
            outbound_allowlist: policy.outbound_allowlist,
            native_role_outbound_owners: policy.native_role_outbound_owners,
            native_projection_identities: policy.native_projection_identities,
            policy_source: policy.policy_source,
          })
        }
        await auditLog(db, 'channel.policy_bootstrap_directory', 'cli', null, {
          count: bootstrap.policies.length,
          skipped_count: bootstrap.skipped.length,
          overwrite: bootstrap.overwrite,
          include_dm: bootstrap.include_dm,
          extra_allowlist: bootstrap.extra_allowlist,
        })
        await refreshChannelPolicyDbSnapshot(db as any)
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        dry_run: dryRun,
        count: bootstrap.policies.length,
        skipped_count: bootstrap.skipped.length,
        policies: bootstrap.policies,
        skipped: bootstrap.skipped,
      }, null, 2)}\n`)
      return
    }

    if (action === 'sync-connectors') {
      const dryRun = parseRepairDryRun(flags)
      const maxConcurrency = parsePositiveIntFlag(flags['max-concurrency'], 1, 'max-concurrency')
      const report = await syncChannelPolicyConnectors((db as any).__adapter, {
        dryRun,
        channel: flags.channel ?? null,
        provider: flags.provider ?? 'discord',
        bindingRole: (flags['binding-role'] ?? 'outbound') as BindingRole,
        orderingScope: (flags['ordering-scope'] ?? 'thread') as OrderingScope,
        maxConcurrency,
      })
      if (!dryRun) {
        await auditLog(db, 'channel.policy_sync_connectors', 'cli', flags.channel ?? null, {
          provider: report.provider,
          binding_role: report.binding_role,
          planned_count: report.planned.length,
          skipped_count: report.skipped.length,
          created_connectors: report.created_connectors,
          created_bindings: report.created_bindings,
        })
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    if (action === 'set') {
      const channelId = positional[0]
      if (!channelId) {
        console.error('Usage: agent-com channel policy set <channel_id> [--primary <agent|none>] [--adapter-owner <agent|none>] [--allowlist <a,b|none>] [--execute|--dry-run]')
        process.exit(1)
      }
      const dryRun = parseRepairDryRun(flags)
      const existing = await db.query(
        `SELECT channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist,
                native_role_outbound_owners, native_projection_identities
           FROM channel_routing_policy
          WHERE channel_id = $1`,
        [channelId],
      )
      const current = existing.rows[0] ?? {}
      const allowlistFlag = parseCsvFlag(flags.allowlist)
      const policy = {
        channel_id: channelId,
        primary_agent_id: flags.primary === undefined ? current.primary_agent_id ?? null : (flags.primary === 'none' ? null : flags.primary),
        adapter_owner_agent_id: flags['adapter-owner'] === undefined ? current.adapter_owner_agent_id ?? null : (flags['adapter-owner'] === 'none' ? null : flags['adapter-owner']),
        outbound_allowlist: flags.allowlist === undefined
          ? parsePolicyArray(current.outbound_allowlist)
          : (allowlistFlag && allowlistFlag.length > 0 ? allowlistFlag : null),
        native_role_outbound_owners: parseJsonObject(current.native_role_outbound_owners),
        native_projection_identities: parseJsonObject(current.native_projection_identities),
        policy_source: 'cli',
      }
      await assertPolicyChannelsExist(db, [channelId])
      await assertPolicyAgentsExist(db, [
        policy.primary_agent_id ?? '',
        policy.adapter_owner_agent_id ?? '',
        ...(policy.outbound_allowlist ?? []),
      ])
      if (!dryRun) {
        await upsertChannelPolicy(db, policy)
        await auditLog(db, 'channel.policy_set', 'cli', channelId, policy)
        await refreshChannelPolicyDbSnapshot(db as any)
      }
      process.stdout.write(`${JSON.stringify({ ok: true, dry_run: dryRun, policy }, null, 2)}\n`)
      return
    }

    console.error('Usage: agent-com channel policy <list|import-json|bootstrap|sync-connectors|set> ...')
    process.exit(1)
  } finally {
    await db.end()
  }
}

async function agentRegister(args: string[]) {
  const { positional, flags } = parseArgs(args)
  const agentId = positional[0]
  if (!agentId) { console.error('Usage: agent-com agent register <agent_id> [--display-name "Name"] [--type dev] [--runtime claude-code]'); process.exit(1) }

  const displayName = flags['display-name'] ?? agentId
  const agentType = flags.type ?? 'dev'
  const runtime = flags.runtime ?? 'claude-code'

  const db = await getDb()
  await db.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, registered_at)
     VALUES ($1, 'default', $2, $3, $4, 'offline', now())
     ON CONFLICT (agent_id) DO UPDATE SET display_name = $2, agent_type = $3, runtime = $4`,
    [agentId, displayName, agentType, runtime]
  )
  await auditLog(db, 'agent.register', 'cli', agentId, { display_name: displayName, agent_type: agentType, runtime })
  await pgNotify(db, 'agent_events', { event: 'agent.register', agent_id: agentId })
  console.log(`Agent '${agentId}' registered (${displayName}, ${agentType}/${runtime})`)
  await db.end()
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #132 — message-queue-spec §4-6 commands (MVP: next / send / agents)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve agent_id from --agent-id flag (if present in args) or AGENT_ID env.
 * ARC codex audit (PR#139): spec contracts use `--agent-id <id>` on the CLI,
 * so both sources must be checked.
 */
function resolveAgentId(args: string[], command: string): string {
  const idx = args.indexOf('--agent-id')
  if (idx !== -1 && args[idx + 1]) return assertExpectedAgentId(args[idx + 1], command)
  return requireAgentId(command)
}

/**
 * Resolve the runtime AGENT_ID from env var only. Use resolveAgentId() when
 * the command also accepts --agent-id flags.
 */
function requireAgentId(command: string): string {
  const id = process.env.AGENT_ID
  if (!id) {
    console.error(`Error: AGENT_ID env var or --agent-id flag is required for 'agent-com ${command}'`)
    process.exit(2)
  }
  return assertExpectedAgentId(id, command)
}

function assertExpectedAgentId(id: string, command: string): string {
  const expected = process.env.AGENT_COM_EXPECTED_AGENT_ID
  if (expected && id !== expected) {
    console.error(
      `Error [AGENT_ID_MISMATCH]: agent-com ${command} resolved agent_id=${id}, expected ${expected}. ` +
        `Set AGENT_ID=${expected} or remove AGENT_COM_EXPECTED_AGENT_ID for this process.`,
    )
    process.exit(2)
  }
  return id
}

// Issue #130 Phase 4: inboxDir, listSignals, currentStatePath (filesystem
// signal helpers) were removed. Delivery is fully queue-based — `nextMessage`
// reads from message_queue, `sendMessage` reads agents.current_message_id.
// The legacy /tmp/agent-com-$AGENT_ID.current state file and the
// $AGENT_COMMS_STATE_DIR/inbox/{agent}/*.signal files are no longer used.

// ─────────────────────────────────────────────────────────────────────────────
// HMAC auth metadata (mirrors server.ts:createAuthMetadata L665-671)
// ─────────────────────────────────────────────────────────────────────────────
//
// ARC codex audit (2026-04-10): the CLI INSERT must carry the same
// metadata.auth shape as the MCP send tool, otherwise downstream verifiers
// (validateIncomingAuth) will tag CLI-originated rows as [UNVERIFIED] and
// receivers in `enforce` mode will drop them.
//
// We avoid pulling in the whole config loader: the secret resolution mirrors
// server.ts:loadSecret L635-646 (env var → secret_file fallback), and we read
// the auth mode from $AGENT_COMMS_AUTH_MODE / $AGENT_COMMS_SECRET. If neither
// is set, the helper returns undefined and the INSERT proceeds without auth
// metadata (matching server.ts behavior when config.auth.mode === 'off').
function loadAuthSecret(): string | null {
  const envSecret = process.env.AGENT_COMMS_SECRET
  if (envSecret) return envSecret
  const secretFile = process.env.AGENT_COMMS_SECRET_FILE
  if (secretFile) {
    try {
      return readFileSync(secretFile.replace(/^~/, homedir()), 'utf-8').trim()
    } catch {
      return null
    }
  }
  return null
}

function buildAuthMetadata(agentId: string, channel: string, content: string): Record<string, unknown> | undefined {
  const mode = process.env.AGENT_COMMS_AUTH_MODE ?? 'off'
  if (mode === 'off') return undefined
  const secret = loadAuthSecret()
  if (!secret) return undefined
  const timestamp = Math.floor(Date.now() / 1000)
  const contentHash = createHash('sha256').update(content).digest('hex')
  const payload = `${agentId}:${timestamp}:${channel}:${contentHash}`
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return { auth: { signature, timestamp } }
}

// Issue #129 Phase 3: deliverToDiscord (Phase 1.5 direct REST helper) was
// removed. Outbound delivery is now an outbound_queue INSERT inside
// sendMessage, with the receiver-side consumer
// (server.ts:startOutboundConsumer) doing the actual Discord post on a
// 1-second tick.

/**
 * `agent-com next` — pop one pending message_queue row and stamp it as the
 * agent's current_message_id (Issue #128 Phase 2 / message-queue-spec §4.1).
 *
 * Internal flow (spec §4.1 step list, mapped to this implementation):
 *   1. If agents.current_message_id is set → implicit-skip the prior row
 *      (UPDATE message_queue SET status='skipped' WHERE id=current
 *       AND status='received'). Legacy implicit-skip handling is retained
 *       only for old callers; the normal receive vocabulary is
 *       pending -> received -> replied/done.
 *   2. SELECT the oldest pending row (priority DESC, created_at ASC).
 *   3. UPDATE status='received', read_at=NOW(), agents.current_message_id=row.id.
 *   4. Hydrate channel/content from message_queue.payload (the receiver
 *      already enriched it on INSERT) — no second query into agent_messages
 *      is required for the canonical fields.
 *   5. Emit JSON with §4.1 shape (waiting count, content, channel_id, ...).
 *
 * Output (stdout, single JSON object):
 *   { waiting: 0 }                                                — empty
 *   { waiting: <N>, queue_id, message_id, channel_id, thread_id, from,
 *     content, message_type, source, mode: 'queue' | 'signal' }
 */
async function nextMessage() {
  const agentId = requireAgentId('next')
  const db = await getDb()
  try {
    // Issue #278 (A) segment 3d — per-row claim path. Mirrors the MCP
    // server next handler post-segment-3c: orphan recovery is structural
    // via the claim-TTL sweeper (core/claim-ttl.ts), so the legacy
    // priorId / agents.current_message_id read+lock is gone. Two
    // concurrent `agent-com next` calls now both succeed in parallel,
    // each grabbing a distinct message_queue row via FOR UPDATE SKIP
    // LOCKED — the §A multi in-flight contract.
    let row: { id: string | number; message_id: string | null; payload: string; priority: number; created_at: Date } | null = null
    await db.query('BEGIN')
    try {
      // Step 1: pop the oldest pending row with an exclusive lock so a
      // concurrent next() never picks the same row.
      const pop = await db.query(
        `SELECT id, message_id, payload, priority, created_at
         FROM message_queue
         WHERE status = 'pending' AND agent_id = $1
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [agentId],
      )

      if (pop.rows.length === 0) {
        await db.query('COMMIT')
      } else {
        // Step 2: mark the popped row 'received' + stamp the per-row claim
        // (claimed_by / claimed_at / claim_expires_at) inside the same
        // txn. The TTL window (default 30s, env AGENT_COMMS_CLAIM_TTL_SEC)
        // bounds how long an orphaned claim can linger before the
        // sweeper flips it to IMPLICIT_ABANDON.
        const popped = pop.rows[0]
        const claimTtlSec = parseInt(process.env.AGENT_COMMS_CLAIM_TTL_SEC ?? '30', 10)
        // claim_expires_at is computed in JS rather than via
        // `now() + ($N || ' seconds')::interval` so this UPDATE works
        // identically in PG and SQLite modes (the latter is exercised
        // by the CLI test suite). Both backends accept an ISO-8601
        // timestamp parameter.
        const claimExpiresAt = new Date(Date.now() + claimTtlSec * 1000).toISOString()
        await db.query(
          `UPDATE message_queue
              SET status = 'received',
                  read_at = now(),
                  claimed_by = $1,
                  claimed_at = now(),
                  claim_expires_at = $2
            WHERE id = $3`,
          [agentId, claimExpiresAt, popped.id],
        )
        // spec §4.1 step 4 — mark agent busy. Issue #278 cycle 1
        // (auditor BLOCK 1): EXISTS-derive over the open-claim set so
        // multi in-flight stays visible on agents.status.
        await db.query(
          `UPDATE agents SET
             status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
             status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
             status_updated_at = now()
           WHERE agent_id = $1`,
          [agentId],
        )
        await db.query('COMMIT')
        row = popped
      }
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }

    if (row === null) {
      // Issue #130 Phase 4: Mixed Mode signal fallback removed. The queue
      // is the sole source. If it's empty, report waiting: 0.
      process.stdout.write(JSON.stringify({ waiting: 0 }) + '\n')
      return
    }

    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(row.payload)
    } catch (err) {
      console.error(`Error: failed to parse message_queue payload for id=${row.id}: ${err}`)
      process.exit(1)
    }

    // Remaining count for the response.
    const waitingRow = await db.query(
      `SELECT count(*)::int AS n FROM message_queue
       WHERE agent_id = $1 AND status = 'pending'`,
      [agentId],
    )
    const waiting: number = waitingRow.rows[0]?.n ?? 0

    // §18.1 Reply Chain Context — seed is the current message
    // (spec `$current_message_id`). Non-fatal on query failure.
    const currentMessageId = (row.message_id as string | null) ?? (payload.message_id as string | null | undefined) ?? null
    let replyChain: Awaited<ReturnType<typeof fetchReplyChain>> = []
    // Issue #257 — light by default. CLI opt-back is via env var only
    // (`AGENT_COM_REPLY_CHAIN_MODE=full`) for legacy shell scripts; MCP path
    // uses `next({full: true})` arg. The asymmetry is intentional.
    const replyChainMode: 'light' | 'full' =
      (process.env.AGENT_COM_REPLY_CHAIN_MODE === 'full') ? 'full' : 'light'
    if (currentMessageId) {
      const depth = parseReplyChainDepth(process.env.AGENT_COM_REPLY_CHAIN_DEPTH)
      try {
        replyChain = await fetchReplyChain(currentMessageId, depth, {
          async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
            const r = await db.query(sql, params)
            return r.rows as T[]
          },
        } as any, replyChainMode)
      } catch (err) {
        process.stderr.write(`agent-com: fetchReplyChain failed (non-fatal): ${err}\n`)
      }
    }

    // Spec §4.1 output shape — channel_id / content / etc come from the
    // payload the receiver enriched on INSERT.
    process.stdout.write(JSON.stringify({
      waiting,
      mode: 'queue',
      queue_id: row.id,
      message_id: row.message_id ?? payload.message_id ?? null,
      channel_id: payload.channel_id,
      thread_id: payload.thread_id ?? null,
      from: payload.author_id,
      from_name: payload.author_name ?? null,
      content: payload.content,
      message_type: payload.message_type ?? 'chat',
      source: payload.source ?? null,
      created_at: row.created_at,
      reply_chain: replyChain,
    }) + '\n')
  } finally {
    await db.end()
  }
}

// Issue #130 Phase 4: nextMessageFromSignal (Mixed-Mode legacy fallback) was
// removed. The queue (message_queue table) is the sole message source.

/**
 * `agent-com send` — reply to the message captured by the most recent `next`
 * (Issue #128 Phase 2 / message-queue-spec §4.2).
 *
 * Internal flow (spec §4.2):
 *   1. Resolve in-flight target. Prefer agents.current_message_id (the new
 *      Phase 2 path). Fall back to /tmp state file (legacy / Mixed Mode §21).
 *   2. Validate mentions, channel membership.
 *   3. INSERT reply into agent_messages with reply_to = original message_id,
 *      thread_id from the queue payload.
 *   4. pg_notify per recipient (per PR#133 fan-out fix).
 *   5. UPDATE message_queue: status='replied', replied_at=NOW(),
 *      replied_with=<new id>. Clear agents.current_message_id.
 *   6. Outbound Discord delivery (per PR#133 ARC fix).
 *   7. On Discord failure, leave the queue row in 'replied' but report
 *      ok:false + db_saved:true so the operator can retry the outbound side.
 *
 * Flags:
 *   --content "<text>"        required
 *   --mentions a,b,c          required (comma-separated agent IDs)
 *   --message-type chat|...   default: chat
 *   --queue-id <id>           optional durable close target
 *   --message-id <uuid>       optional cross-check for --queue-id
 *   --no-close                ACK/progress reply: do not terminal-close work
 *   --close                   explicit final close intent (default-compatible)
 *
 * MVP scope (Phase 2): this is a thin INSERT + pg_notify path. The full
 * server.ts send handler (rate limit / dup check / message split / channel-
 * server push / SSE fallback) is intentionally NOT duplicated here — the
 * receiver picks up the row via pg_notify + message_queue and runs its own
 * routing. Phase 3 will extract a shared core module that both paths import.
 */
async function sendMessage(args: string[]) {
  const agentId = requireAgentId('send')
  const { flags } = parseArgs(args)
  const content = flags.content
  const mentionsRaw = flags.mentions
  const messageType = flags['message-type'] ?? 'chat'
  const queueIdRaw = flags['queue-id']
  const messageIdRaw = flags['message-id']
  const noClose = flagEnabled(flags['no-close'])
  const closeRequested = flagEnabled(flags.close)

  if (!content) {
    console.error('Error: --content is required')
    process.exit(2)
  }
  if (noClose && closeRequested) {
    console.error('Error: --no-close and --close are mutually exclusive')
    process.exit(2)
  }
  if (!mentionsRaw) {
    console.error('Error: --mentions is required (comma-separated agent IDs)')
    process.exit(2)
  }
  const mentions = mentionsRaw.split(',').map(m => m.trim()).filter(Boolean)
  if (mentions.length === 0) {
    console.error('Error: --mentions must contain at least one agent ID')
    process.exit(2)
  }

  // Phase 5 — best-effort client-side warning (server is canonical, §1.4).
  try {
    const { resolvePhase5 } = await import('../core/routing/server-integration')
    const phase5Warn = resolvePhase5({
      sender: agentId,
      channel_id: '',
      mentions,
      content,
      isKnownAgent: () => true,
    })
    if (phase5Warn && phase5Warn.ok) {
      for (const w of phase5Warn.warnings) {
        process.stderr.write(`agent-com: phase5 warning: ${w}\n`)
      }
    }
  } catch {}

  // ARC codex audit follow-up (PR#134) + Issue #278 (A) segment 3d:
  // wrap the entire DB-touching flow in BEGIN/COMMIT. The lock has
  // moved from the agents row to the per-row claim row on
  // message_queue, so independent claims (multi in-flight) proceed in
  // parallel; concurrent `agent-com send` calls targeting the SAME
  // claim still serialise on the message_queue row lock — the second
  // caller blocks, wakes to status='replied', misses the predicate,
  // and exits with INVALID_REPLY_TO instead of double-replying.
  //
  // Side effects to note:
  //   - The Discord HTTP call happens INSIDE the transaction (lead-ama's
  //     prescribed shape). The lock is held for the duration of the HTTP
  //     request. This is a deliberate trade-off for the simpler concurrency
  //     model; Phase 3 (outbound_queue) will move outbound delivery off the
  //     critical path.
  //   - process.exit() bypasses `finally` blocks, so the inner code MUST
  //     throw `CliSendExit` instead of calling process.exit() directly.
  //     The outer wrapper catches the exit class, runs ROLLBACK if needed,
  //     closes the db handle, and only then calls process.exit().
  class CliSendExit extends Error {
    constructor(public code: number) {
      super('cli send exit')
    }
  }

  function writeFailureJson(
    code: string,
    detail: string,
    extra: Record<string, unknown> = {},
    exitCode = 1,
  ): never {
    process.stdout.write(JSON.stringify({ ok: false, code, detail, ...extra }) + '\n')
    process.stderr.write(`Error [${code}]: ${detail}\n`)
    throw new CliSendExit(exitCode)
  }

  const db = await getDb()
  let exitCode = 0
  let committed = false
  try {
    await db.query('BEGIN')
    try {
      // ─────────────────────────────────────────────────────────────────
      // Step 1: resolve the in-flight target via the per-row claim
      // ─────────────────────────────────────────────────────────────────
      // FOR UPDATE on the message_queue claim row blocks any other
      // session that wakes for the same claim. The first caller wins;
      // the second blocks here until the first commits, then sees the
      // row in status='replied' and exits with INVALID_REPLY_TO.
      // Independent claims (multi in-flight) are unaffected — this
      // lock is per-row, not on the agents row.
      // Issue #130 Phase 4: target resolution is queue-only. The Mixed-Mode
      // signal fallback (Phase 2-3) has been removed.
      type Target = {
        reply_to: string         // agent_messages.id of the original
        channel_id: string
        thread_id: string | null
        queue_id: number         // message_queue.id
      }
      let target: Target | null = null
      const explicitClose = !!queueIdRaw || !!messageIdRaw

      if (explicitClose) {
        let qres
        if (queueIdRaw) {
          const queueId = Number(queueIdRaw)
          if (!Number.isInteger(queueId) || queueId < 1) {
            writeFailureJson('QUEUE_NOT_FOUND', `invalid queue_id: ${queueIdRaw}`, { queue_id: queueIdRaw })
          }
          qres = await db.query(
            `SELECT id, agent_id, message_id, payload, status, claimed_by, claim_expires_at, replied_with
               FROM message_queue
              WHERE id = $1
              FOR UPDATE`,
            [queueId],
          )
        } else {
          qres = await db.query(
            `SELECT id, agent_id, message_id, payload, status, claimed_by, claim_expires_at, replied_with
               FROM message_queue
              WHERE agent_id = $1 AND message_id = $2
              ORDER BY created_at DESC
              LIMIT 1
              FOR UPDATE`,
            [agentId, messageIdRaw],
          )
        }

        if (qres.rows.length === 0) {
          writeFailureJson('QUEUE_NOT_FOUND', 'no message_queue row matches the explicit reply target', {
            queue_id: queueIdRaw ?? null,
            message_id: messageIdRaw ?? null,
          })
        }

        const qrow = qres.rows[0]
        if (messageIdRaw && qrow.message_id !== messageIdRaw) {
          writeFailureJson('QUEUE_MESSAGE_MISMATCH', 'queue_id and message_id identify different messages', {
            queue_id: qrow.id,
            expected_message_id: qrow.message_id,
            supplied_message_id: messageIdRaw,
          })
        }
        if (qrow.agent_id !== agentId) {
          writeFailureJson('NOT_MENTIONED', `queue row is addressed to ${qrow.agent_id}, not ${agentId}`, {
            queue_id: qrow.id,
            message_id: qrow.message_id,
          })
        }
        if (['replied', 'skipped', 'failed'].includes(qrow.status)) {
          writeFailureJson('ALREADY_CLOSED', `queue row is already terminal (${qrow.status})`, {
            queue_id: qrow.id,
            message_id: qrow.message_id,
            replied_with: qrow.replied_with ?? null,
          })
        }
        if (qrow.status === 'received' && qrow.claimed_by && qrow.claimed_by !== agentId) {
          writeFailureJson('NOT_CLAIM_OWNER', `queue row is actively claimed by ${qrow.claimed_by}`, {
            queue_id: qrow.id,
            message_id: qrow.message_id,
            claimed_by: qrow.claimed_by,
          })
        }

        let payload: Record<string, any> = {}
        try { payload = JSON.parse(qrow.payload) } catch {}
        const replyTo = qrow.message_id ?? payload.message_id
        const channelId = payload.channel_id
        if (!replyTo || !channelId) {
          writeFailureJson('QUEUE_NOT_FOUND', 'queue row is missing message_id or channel_id metadata', {
            queue_id: qrow.id,
            message_id: qrow.message_id ?? null,
          })
        }
        target = {
          reply_to: replyTo,
          channel_id: channelId,
          thread_id: payload.thread_id ?? null,
          queue_id: qrow.id,
        }
      }

      // Issue #278 (A) segment 3d — per-row claim lookup. Replaces the
      // legacy SELECT current_message_id FROM agents path. The CLI does
      // not take a --reply-to flag, so we resolve "the in-flight message"
      // as the most recent active claim owned by this agent: the row
      // with claimed_by=$agentId AND status='received' ORDER BY claimed_at
      // DESC LIMIT 1. FOR UPDATE on that row serialises any concurrent
      // `agent-com send` for the same claim — the second caller wakes
      // to status='replied' on the locked row, the predicate misses,
      // and it exits with INVALID_REPLY_TO instead of double-replying.
      // Independent claims (multi in-flight) are unaffected because the
      // lock is per-row, not on the agents row.
      if (!explicitClose) {
        const claimRow = await db.query(
          `SELECT id, message_id, payload FROM message_queue
              WHERE claimed_by = $1 AND status = 'received'
              ORDER BY claimed_at DESC NULLS LAST
              LIMIT 1
              FOR UPDATE`,
          [agentId],
        )
        if (claimRow.rows.length > 0) {
          const qrow = claimRow.rows[0]
          let payload: Record<string, any> = {}
          try { payload = JSON.parse(qrow.payload) } catch {}
          target = {
            reply_to: qrow.message_id ?? payload.message_id,
            channel_id: payload.channel_id,
            thread_id: payload.thread_id ?? null,
            queue_id: qrow.id,
          }
        }
      }

      if (target === null) {
        // Issue #278 §1 error taxonomy: NO_CURRENT_MESSAGE retired in
        // favour of INVALID_REPLY_TO. The CLI hits this branch when the
        // agent has no active claim — either `next` was never called,
        // the claim TTL expired and the sweeper flipped it to
        // IMPLICIT_ABANDON, or a concurrent `send` already replied.
        process.stdout.write(JSON.stringify({
          ok: false,
          code: 'RECLAIM_REQUIRED',
          reason: 'CLAIM_EXPIRED',
          legacy_code: 'INVALID_REPLY_TO',
          detail: `no active received claim for ${agentId}; retry with explicit --queue-id/--message-id durable close`,
        }) + '\n')
        console.error(`Error [INVALID_REPLY_TO]: no in-flight claim for ${agentId} — run 'agent-com next' first or the claim may have expired`)
        throw new CliSendExit(1)
      }

      const threadId: string | null = target.thread_id
      const channelId: string = target.channel_id
      const replyTo: string = target.reply_to
      // Membership check — bot can only reply in channels it belongs to.
      const ch = await db.query('SELECT members FROM channels WHERE id = $1', [channelId])
      if (ch.rows.length === 0) {
        if (explicitClose) {
          writeFailureJson('NOT_CHANNEL_MEMBER', `channel ${channelId} not found`, {
            queue_id: target.queue_id,
            message_id: replyTo,
            channel_id: channelId,
          })
        } else {
          console.error(`Error: channel ${channelId} not found`)
          throw new CliSendExit(1)
        }
      }
      const members: string[] = ch.rows[0].members ?? []
      if (!members.includes(agentId)) {
        if (explicitClose) {
          writeFailureJson('NOT_CHANNEL_MEMBER', `${agentId} is not a member of channel ${channelId}`, {
            queue_id: target.queue_id,
            message_id: replyTo,
            channel_id: channelId,
          })
        } else {
          console.error(`Error: ${agentId} is not a member of channel ${channelId}`)
          throw new CliSendExit(1)
        }
      }

      const aclResult = await validateCliOutboundPolicy(db, agentId, channelId, mentions)
      if (!aclResult.ok) {
        const detail = `sender ${agentId} or recipients ${aclResult.violations.join(',')} violate channel.outboundAllowlist`
        if (explicitClose) {
          writeFailureJson('OUTBOUND_ACL_VIOLATION', detail, {
            queue_id: target.queue_id,
            message_id: replyTo,
            channel_id: channelId,
            violations: aclResult.violations,
          })
        } else {
          console.error(`Error [OUTBOUND_ACL_VIOLATION]: ${detail}`)
          throw new CliSendExit(1)
        }
      }

      const id = randomUUID()
      // ARC codex audit (2026-04-10): include HMAC auth metadata so receivers
      // in `enforce` mode don't drop CLI-originated rows as [UNVERIFIED]. The
      // helper returns undefined when AGENT_COMMS_AUTH_MODE === 'off' / no
      // secret, matching server.ts:createAuthMetadata behavior.
      const authMeta = buildAuthMetadata(agentId, channelId, content)
      const metadata: Record<string, unknown> = {
        mentions,
        cli: 'agent-com next/send (MVP)',
        ...(authMeta ?? {}),
      }
      await db.query(
        `INSERT INTO agent_messages
           (id, channel_id, author_id, content, message_type, reply_to, metadata,
            depth, source, thread_id, direction, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'agent-comms', $8, 'outbound', 'agent')`,
        [id, channelId, agentId, content, messageType, replyTo, JSON.stringify(metadata), threadId],
      )

      // Phase 2 F cycle 2 (CTO judgment option (a), msg 1495781874977734814):
      // CLI-initiated send performs message_queue fanout directly instead of
      // delegating to the daemon's agent_inbox LISTEN handler. The old
      // `pg_notify('agent_inbox', …)` path dropped silently in SQLite mode
      // (no LISTEN-er) so recipients never saw the message; this direct call
      // works for both PG and SQLite backends identically.
      //
      // ADR-050 (2026-05-05): wake-daemon (bin/wake-daemon.ts) handles
      // recipient wake-up by polling message_queue + tmux send-keys; the
      // CLI no longer needs an in-process signal bus.
      {
        const fanoutRes = await fanoutToRecipients(
          {
            query: async <T = any>(sql: string, params?: any[]) => {
              const r = await db.query(sql, params)
              return { rows: r.rows as T[] }
            },
          },
          {
            messageId: id,
            channelId,
            threadId,
            authorId: agentId,
            content,
            recipients: mentions,
            messageType,
            source: 'cli-send',
          },
        )
        if (fanoutRes.failed.length > 0) {
          process.stderr.write(
            `agent-com: fanout had ${fanoutRes.failed.length} failure(s): ${fanoutRes.failed.join(', ')}\n`,
          )
        }
      }

      // ─────────────────────────────────────────────────────────────────
      // Issue #129 Phase 3: outbound_queue INSERT (replaces deliverToDiscord)
      // ─────────────────────────────────────────────────────────────────
      // The Phase 1.5 cut called Discord REST API directly inside the
      // transaction, holding the agents row lock for the duration of the
      // HTTP call. Phase 3 replaces that with an outbound_queue row INSERT
      // — the receiver-side consumer (server.ts:startOutboundConsumer)
      // dequeues and posts on its 1-second tick.
      //
      // Benefits:
      //   - Lock holding time drops from ~Discord-RTT to ~1ms (DB only).
      //   - Retries are centralised in the consumer (attempts/max_attempts).
      //   - Outbound failures no longer fail the send tool synchronously.
      //
      // Resolution order for channel_external_id mirrors deliverToDiscord:
      //   1. thread_adapters (when threadId is set, so the post lands in
      //      the thread, not the parent)
      //   2. channel_adapters fallback
      //
      // If no Discord adapter exists for this channel, the row never gets
      // queued. The receiver pipeline still picks up the agent_messages row
      // via pg_notify, so other bots see the message; only the human-facing
      // Discord display is skipped. We surface this in the response.
      const projection = await resolveOutboundProjectionDecision(db as any, {
        channelId,
        threadId,
        senderAgentId: agentId,
        recipientAgentIds: mentions,
      })
      const discordExternalId = projection.channelExternalId

      let outboundQueued = false
      let outboundSkipReason: string | null = null
      if (discordExternalId) {
        try {
          // v2.1.0: clamp outbound content at DISCORD_MAX (1900) chars before
          // enqueue so an over-long LLM reply is truncated once, deterministically,
          // instead of being split across retries inside the Discord adapter.
          await db.query(
            `INSERT INTO outbound_queue (message_id, agent_id, consumer_agent_id, projection_identity_id, intended_projection_identity_id, projection_source, projection_fallback_reason, channel_external_id, content)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              id,
              agentId,
              projection.consumerAgentId,
              projection.projectionIdentityId,
              projection.intendedProjectionIdentityId,
              projection.projectionSource,
              projection.projectionFallbackReason,
              discordExternalId,
              truncateForDiscord(decorateProjectedContent({
                content,
                authorAgentId: agentId,
                consumerAgentId: projection.consumerAgentId,
                recipients: mentions,
              })),
            ],
          )
          outboundQueued = true
        } catch (err) {
          // INSERT into outbound_queue failed — this is a DB error, not a
          // Discord error. Roll back the entire transaction so the caller
          // gets a clean retry path. The throw is caught by the inner finally
          // (which ROLLBACKs because committed=false) and the outer catch
          // (which exits non-zero).
          throw err
        }
      } else {
        outboundSkipReason = 'no discord adapter mapping for this channel'
      }

      const workClosed = !noClose
      if (workClosed) {
        // ─────────────────────────────────────────────────────────────────
        // Finalize in-flight state (§4.2 step 9-11).
        // Issue #130 Phase 4: signal-mode unlink path removed. Queue mode is
        // the only path now. #420 keeps this default path for backward
        // compatibility; ACK/progress callers opt out with --no-close.
        // ─────────────────────────────────────────────────────────────────
        await db.query(
          `UPDATE message_queue
              SET status = 'replied',
                  replied_at = now(),
                  replied_with = $1,
                  claimed_by = NULL,
                  claimed_at = NULL,
                  claim_expires_at = NULL
           WHERE id = $2`,
          [id, target.queue_id],
        )
        // spec §4.2 step 10-11 — flip the agent based on remaining open
        // claims. Issue #278 cycle 1 (auditor BLOCK 1): with multi in-flight
        // the send only closed ONE claim; if other claims are still 'received'
        // the agent must remain busy. EXISTS-derive keeps observability
        // (sender-feedback / heartbeat / bot_status) tracking the truth.
        await db.query(
          `UPDATE agents SET
             status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
             status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
             status_updated_at = now()
           WHERE agent_id = $1`,
          [agentId],
        )
      }
      await db.query('COMMIT')
      committed = true

      process.stdout.write(JSON.stringify({
        ok: true,
        message_id: id,
        channel_id: channelId,
        thread_id: threadId,
        reply_to: replyTo,
        mentions,
        auth_signed: authMeta !== undefined,
        outbound_queued: outboundQueued,
        work_closed: workClosed,
        close_mode: workClosed ? (explicitClose || closeRequested ? 'explicit' : 'active_claim') : 'none',
        queue_id: target.queue_id,
        ...(outboundSkipReason ? { outbound_skip_reason: outboundSkipReason } : {}),
      }) + '\n')
    } finally {
      // If we threw without committing (validation error, INVALID_REPLY_TO,
      // unexpected exception), roll the transaction back. The committed flag
      // is set right after each successful COMMIT above so this is a no-op
      // on the success and queue-failure paths.
      if (!committed) {
        await db.query('ROLLBACK').catch(() => {})
      }
    }
  } catch (err) {
    if (err instanceof CliSendExit) {
      exitCode = err.code
    } else {
      throw err
    }
  } finally {
    await db.end()
  }
  if (exitCode !== 0) process.exit(exitCode)
}

/**
 * `agent-com notify` — self-originated post (spec §4.3). No reply context,
 * no current_message_id touched, no agents.status transition. Intended for
 * watchdog / startup / periodic-report flows where the caller picks the
 * destination explicitly.
 *
 * Flags:
 *   --channel <id|name>       required — destination channel (id or name)
 *   --thread-id <id>          optional — post into a thread instead
 *   --mentions a,b,c          required — comma-separated agent_ids
 *   --content "<text>"        required
 *   --message-type chat|...   default: chat
 */
async function notifyMessage(args: string[]) {
  const agentId = requireAgentId('notify')
  const { flags } = parseArgs(args)
  const channelArg = flags.channel
  const threadArg = flags['thread-id'] ?? null
  const content = flags.content
  const mentionsRaw = flags.mentions
  const messageType = flags['message-type'] ?? 'chat'

  if (!channelArg) {
    console.error('Error: --channel is required')
    process.exit(2)
  }
  if (!content) {
    console.error('Error: --content is required')
    process.exit(2)
  }
  if (!mentionsRaw) {
    console.error('Error: --mentions is required (comma-separated agent IDs)')
    process.exit(2)
  }
  const mentions = mentionsRaw.split(',').map(m => m.trim()).filter(Boolean)
  if (mentions.length === 0) {
    console.error('Error: --mentions must contain at least one agent ID')
    process.exit(2)
  }

  // Phase 5 — best-effort client-side warning (server is canonical, §1.4).
  try {
    const { resolvePhase5 } = await import('../core/routing/server-integration')
    const phase5Warn = resolvePhase5({
      sender: agentId,
      channel_id: '',
      mentions,
      content,
      isKnownAgent: () => true,
    })
    if (phase5Warn && phase5Warn.ok) {
      for (const w of phase5Warn.warnings) {
        process.stderr.write(`agent-com: phase5 warning: ${w}\n`)
      }
    }
  } catch {}

  const db = await getDb()
  try {
    // Resolve channel: thread_id short-circuits; otherwise id-first, name-fallback.
    let resolvedChannelId: string | null = null
    let resolvedThreadId: string | null = threadArg
    if (resolvedThreadId) {
      const tr = await db.query(`SELECT channel_id FROM threads WHERE id = $1`, [resolvedThreadId])
      if (tr.rows.length === 0) {
        console.error(`Error [THREAD_NOT_FOUND]: thread '${resolvedThreadId}' not found`)
        process.exit(1)
      }
      resolvedChannelId = tr.rows[0].channel_id
    } else {
      const byId = await db.query(`SELECT id FROM channels WHERE id = $1`, [channelArg])
      if (byId.rows.length > 0) {
        resolvedChannelId = channelArg
      } else {
        // codex-auditor PR #214 Layer 2 finding 2 — fail-closed on ambiguous
        // channel name lookups (no UNIQUE constraint on channels.name).
        const byName = await db.query(`SELECT id FROM channels WHERE name = $1 ORDER BY id LIMIT 2`, [channelArg])
        if (byName.rows.length === 1) {
          resolvedChannelId = byName.rows[0].id
        } else if (byName.rows.length > 1) {
          const ids = byName.rows.map((r: { id: string }) => r.id).join(', ')
          console.error(`Error [CHANNEL_NAME_AMBIGUOUS]: channel name '${channelArg}' matches multiple channels (${ids}…). Pass the channel id instead of the name.`)
          process.exit(1)
        }
      }
    }
    if (!resolvedChannelId) {
      console.error(`Error [CHANNEL_NOT_FOUND]: channel '${channelArg}' not found`)
      process.exit(1)
    }

    // Membership check.
    const ch = await db.query(`SELECT members FROM channels WHERE id = $1`, [resolvedChannelId])
    if (ch.rows.length === 0) {
      console.error(`Error: channel ${resolvedChannelId} not found`)
      process.exit(1)
    }
    const members: string[] = ch.rows[0].members ?? []
    if (!members.includes(agentId)) {
      console.error(`Error: ${agentId} is not a member of channel ${resolvedChannelId}`)
      process.exit(1)
    }

    const aclResult = await validateCliOutboundPolicy(db, agentId, resolvedChannelId, mentions)
    if (!aclResult.ok) {
      console.error(`Error [OUTBOUND_ACL_VIOLATION]: sender ${agentId} or recipients ${aclResult.violations.join(',')} violate channel.outboundAllowlist`)
      process.exit(1)
    }

    const id = randomUUID()
    const authMeta = buildAuthMetadata(agentId, resolvedChannelId, content)
    const metadata: Record<string, unknown> = {
      mentions,
      cli: 'agent-com notify',
      ...(authMeta ?? {}),
    }
    await db.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, content, message_type, reply_to, metadata,
          depth, source, thread_id, direction, role)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, 0, 'agent-comms', $7, 'outbound', 'agent')`,
      [id, resolvedChannelId, agentId, content, messageType, JSON.stringify(metadata), resolvedThreadId],
    )

    // Phase 2 F cycle 2: same direct fanout as `sendMessage()` — see rationale
    // there. Notify is self-originated (no reply_to) but otherwise the
    // delivery path is identical: per-recipient message_queue INSERT, no
    // pg_notify delegation. ADR-050: wake-daemon handles recipient wake-up.
    {
      const fanoutRes = await fanoutToRecipients(
        {
          query: async <T = any>(sql: string, params?: any[]) => {
            const r = await db.query(sql, params)
            return { rows: r.rows as T[] }
          },
        },
        {
          messageId: id,
          channelId: resolvedChannelId,
          threadId: resolvedThreadId,
          authorId: agentId,
          content,
          recipients: mentions,
          messageType,
          source: 'cli-notify',
        },
      )
      if (fanoutRes.failed.length > 0) {
        process.stderr.write(
          `agent-com: notify fanout had ${fanoutRes.failed.length} failure(s): ${fanoutRes.failed.join(', ')}\n`,
        )
      }
    }

    const projection = await resolveOutboundProjectionDecision(db as any, {
      channelId: resolvedChannelId,
      threadId: resolvedThreadId,
      senderAgentId: agentId,
      recipientAgentIds: mentions,
    })
    const discordExternalId = projection.channelExternalId

    let outboundQueued = false
    let outboundSkipReason: string | null = null
    if (discordExternalId) {
      try {
        // v2.1.0: clamp outbound content at DISCORD_MAX (1900) chars.
        await db.query(
          `INSERT INTO outbound_queue (message_id, agent_id, consumer_agent_id, projection_identity_id, intended_projection_identity_id, projection_source, projection_fallback_reason, channel_external_id, content)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            agentId,
            projection.consumerAgentId,
            projection.projectionIdentityId,
            projection.intendedProjectionIdentityId,
            projection.projectionSource,
            projection.projectionFallbackReason,
            discordExternalId,
            truncateForDiscord(decorateProjectedContent({
              content,
              authorAgentId: agentId,
              consumerAgentId: projection.consumerAgentId,
              recipients: mentions,
            })),
          ],
        )
        outboundQueued = true
      } catch (err) {
        console.error(`Error [OUTBOUND_ENQUEUE_FAILED]: ${String(err).slice(0, 200)}`)
        process.exit(1)
      }
    } else {
      outboundSkipReason = 'no discord adapter mapping for this channel'
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      message_id: id,
      channel_id: resolvedChannelId,
      thread_id: resolvedThreadId,
      mentions,
      auth_signed: authMeta !== undefined,
      outbound_queued: outboundQueued,
      ...(outboundSkipReason ? { outbound_skip_reason: outboundSkipReason } : {}),
    }) + '\n')
  } finally {
    await db.end()
  }
}

/**
 * `agent-com fail` (spec §4.1, §11 failed_reason, v2.1.0) — mark a message_queue
 * row as `failed` with an explicit reason and release the agent to idle.
 *
 * Called by run-bot.sh / LLM integration when the message can't be replied to:
 * LLM_FAILED (empty / non-zero exit), SEND_FAILED_AFTER_N_RETRIES, LOOP_DETECTED,
 * or any other explicit abandon. Prior to v2.1.0 the implicit-skip path in `next`
 * used status='skipped', which collapsed "LLM lost" and "operator muted" into one
 * state and left no reason string. `fail` is the machine-issued counterpart to
 * the operator-issued `skip`.
 *
 * Flags:
 *   --message-id <uuid>  required — message_queue.message_id (agent_messages.id)
 *   --reason <text>      required — free-form reason, typically one of the
 *                                    §11 標準値 (IMPLICIT_ABANDON / LLM_FAILED /
 *                                    SEND_FAILED_AFTER_N_RETRIES / LOOP_DETECTED)
 *
 * Transaction: UPDATE message_queue → UPDATE agents in one BEGIN/COMMIT so a
 * crash cannot leave the queue row 'failed' while agents.current_message_id
 * still points at it.
 */
async function failMessage(args: string[]) {
  return failOrSkipMessage('fail', args)
}

/**
 * `agent-com skip` (spec §4.1, §11, v2.1.0) — operator-issued sibling of `fail`.
 * Marks the message_queue row `skipped` (not `failed`) to signal "manually muted,
 * no machine error occurred". Same transaction shape as fail.
 *
 * Flags:
 *   --message-id <uuid>  required
 *   --reason <text>      required — typically OBSOLETE / "manual override"
 */
async function skipMessage(args: string[]) {
  return failOrSkipMessage('skip', args)
}

/**
 * Shared implementation for fail/skip — they only differ in the target status.
 * Consolidated here to keep the transaction invariants identical.
 */
async function failOrSkipMessage(kind: 'fail' | 'skip', args: string[]) {
  const agentId = requireAgentId(kind)
  const { flags } = parseArgs(args)
  const messageId = flags['message-id']
  const reason = flags.reason

  if (!messageId) {
    console.error(`Error: --message-id is required`)
    process.exit(2)
  }
  if (!reason) {
    console.error(`Error: --reason is required`)
    process.exit(2)
  }

  const targetStatus = kind === 'fail' ? 'failed' : 'skipped'

  const db = await getDb()
  try {
    await db.query('BEGIN')
    try {
      // Match on (agent_id, message_id) — the partial UNIQUE index guarantees
      // this pair is unique when message_id IS NOT NULL, so we need no tie-break.
      const upd = await db.query(
        `UPDATE message_queue
            SET status = $1,
                failed_reason = $2,
                done_at = now(),
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
          WHERE agent_id = $3 AND message_id = $4 AND status IN ('pending','received')
          RETURNING id`,
        [targetStatus, reason, agentId, messageId],
      )
      if (upd.rows.length === 0) {
        await db.query('ROLLBACK')
        console.error(
          `Error: no in-flight or pending message_queue row for agent_id=${agentId}, message_id=${messageId} (already replied/failed/skipped?)`,
        )
        process.exit(1)
      }
      const queueId = upd.rows[0].id

      // Issue #278 cycle 1 (auditor BLOCK 1): EXISTS-derive busy/idle
      // from the remaining open claims. fail/skip closes one claim
      // only; if others are still 'received' the agent stays busy.
      await db.query(
        `UPDATE agents SET
           status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
           status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
           status_updated_at = now()
         WHERE agent_id = $1`,
        [agentId],
      )
      await db.query('COMMIT')

      process.stdout.write(JSON.stringify({
        ok: true,
        queue_id: queueId,
        message_id: messageId,
        status: targetStatus,
        failed_reason: reason,
      }) + '\n')
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await db.end()
  }
}

/**
 * `agent-com reclaim` (spec §4.1, v2.1.0) — manual orphan reclaim. When a bot
 * crashed after receiving a row (status='received' but never transitioned to replied/failed/skipped)
 * and the normal 15-minute daemon heartbeat reclaim has not run yet, an operator
 * can force the release here.
 *
 * The reclaim is intentionally conservative: it only rolls `read` → `pending` for
 * rows whose `read_at` is older than RECLAIM_MIN_AGE (15 minutes), matching the
 * daemon's orphan-reclaim cutoff. It also clears agents.current_message_id so a
 * fresh `next` can pop from the queue cleanly. Both updates run in one
 * BEGIN/COMMIT so a crash mid-flight cannot leave the agent stuck in `busy`.
 *
 * Flags:
 *   --agent-id <id>  required (falls back to AGENT_ID env)
 */
async function reclaimMessages(args: string[]) {
  const { flags } = parseArgs(args)
  const agentId = resolveAgentId(args, 'reclaim')

  const db = await getDb()
  try {
    await db.query('BEGIN')
    try {
      // Roll 'received' rows older than 15 minutes back to 'pending'. read_at is
      // cleared so a follow-up next() doesn't think the row is still in-flight.
      const rollback = await db.query(
        `UPDATE message_queue
            SET status = 'pending',
                read_at = NULL,
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
          WHERE agent_id = $1
            AND status = 'received'
            AND read_at < now() - INTERVAL '15 minutes'
          RETURNING id`,
        [agentId],
      )

      // Issue #278 cycle 1 (auditor BLOCK 1): reclaim respects multi
      // in-flight — after rolling expired 'received' rows back to 'pending',
      // the agent may still hold OTHER active claims that are not
      // orphaned. EXISTS-derive keeps the right state visible.
      await db.query(
        `UPDATE agents SET
           status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
           status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
           status_updated_at = now()
         WHERE agent_id = $1`,
        [agentId],
      )
      await db.query('COMMIT')

      process.stdout.write(JSON.stringify({
        ok: true,
        agent_id: agentId,
        reclaimed_count: rollback.rows.length,
        reclaimed_queue_ids: rollback.rows.map((r: any) => r.id),
      }) + '\n')
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    await db.end()
  }
}

async function diagnoseDelivery(args: string[]) {
  const { flags } = parseArgs(args)
  const queueId = flags['queue-id']
  const messageId = flags['message-id']
  const outboundMessageId = flags['outbound-message-id'] ?? messageId
  const db = await getDb()
  try {
    const report: Record<string, unknown> = { ok: true, inbound: null, outbound: null }

    if (queueId || messageId) {
      const inbound = await db.query(
        `SELECT id, agent_id, message_id, status, claimed_by, claim_expires_at,
                replied_with, failed_reason, done_at
           FROM message_queue
          WHERE ($1::text IS NOT NULL AND id::text = $1)
             OR ($2::text IS NOT NULL AND message_id = $2)
          ORDER BY created_at DESC
          LIMIT 1`,
        [queueId ?? null, messageId ?? null],
      )
      report.inbound = diagnoseInboundQueueRow(inbound.rows[0] ?? null)
    }

    if (outboundMessageId) {
      const outbound = await db.query(
        `SELECT id, message_id, agent_id, consumer_agent_id,
                projection_identity_id, intended_projection_identity_id,
                projection_source, projection_fallback_reason, channel_external_id,
                status, attempts, max_attempts, last_error, sent_at, discord_message_id
           FROM outbound_queue
          WHERE message_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [outboundMessageId],
      )
      const row = outbound.rows[0] ?? null
      const consumerAgentId = row ? (row.consumer_agent_id ?? row.agent_id) : null
      const consumer = consumerAgentId
        ? await db.query(
          `SELECT agent_id, status, metadata
             FROM agents WHERE agent_id = $1`,
          [consumerAgentId],
        ).catch(() => ({ rows: [] as any[] }))
        : { rows: [] as any[] }
      const consumerRow = consumer.rows[0]
      if (consumerRow) {
        let metadata: Record<string, unknown> = {}
        if (consumerRow.metadata && typeof consumerRow.metadata === 'object') {
          metadata = consumerRow.metadata
        } else if (typeof consumerRow.metadata === 'string') {
          try { metadata = JSON.parse(consumerRow.metadata) } catch {}
        }
        consumerRow.has_discord_id = typeof metadata.discord_id === 'string' && metadata.discord_id.length > 0
      }
      const projectionIdentityId = row?.projection_identity_id ?? null
      const projection = projectionIdentityId
        ? await db.query(
          `SELECT agent_id, status, metadata
             FROM agents WHERE agent_id = $1`,
          [projectionIdentityId],
        ).catch(() => ({ rows: [] as any[] }))
        : { rows: [] as any[] }
      const projectionRow = projection.rows[0]
      if (projectionRow) {
        let metadata: Record<string, unknown> = {}
        if (projectionRow.metadata && typeof projectionRow.metadata === 'object') {
          metadata = projectionRow.metadata
        } else if (typeof projectionRow.metadata === 'string') {
          try { metadata = JSON.parse(projectionRow.metadata) } catch {}
        }
        projectionRow.has_discord_id = typeof metadata.discord_id === 'string' && metadata.discord_id.length > 0
      }
      report.outbound = diagnoseOutboundQueueRow(row, consumerRow ?? null, projectionRow ?? null)
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await db.end()
  }
}

async function diagnoseProjection(args: string[]) {
  const { flags } = parseArgs(args)
  const channelId = flags.channel ?? flags['channel-id']
  const threadId = flags['thread-id'] ?? null
  const fromAgentId = flags.from ?? flags['from-agent-id'] ?? process.env.AGENT_ID ?? null
  const toAgentIds = (flags.to ?? flags['to-agent-id'] ?? flags.mentions ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const format = flags.format ?? 'text'

  if (!channelId || !fromAgentId || toAgentIds.length === 0) {
    console.error('Usage: agent-com diagnose-projection --channel <id> --from <agent_id> --to <agent_id>[,<agent_id>] [--thread-id <id>] [--format json]')
    process.exit(1)
  }

  const db = await getDb()
  try {
    const projection = await resolveOutboundProjectionDecision(db as any, {
      channelId,
      threadId,
      senderAgentId: fromAgentId,
      recipientAgentIds: toAgentIds,
    })
    const consumerAgentId = projection.consumerAgentId
    const consumer = consumerAgentId
      ? await db.query(
        `SELECT agent_id, status, runtime, metadata
           FROM agents WHERE agent_id = $1`,
        [consumerAgentId],
      ).catch(() => ({ rows: [] as any[] }))
      : { rows: [] as any[] }
    const consumerRow = consumer.rows[0] ?? null
    const metadata = (() => {
      if (!consumerRow?.metadata) return {}
      if (typeof consumerRow.metadata === 'object') return consumerRow.metadata
      try { return JSON.parse(consumerRow.metadata) } catch { return {} }
    })() as Record<string, unknown>
    const hasDiscordIdentity = typeof metadata.discord_id === 'string' && metadata.discord_id.trim().length > 0
    const projectionIdentityId = projection.projectionIdentityId
    const projectionAgent = projectionIdentityId
      ? await db.query(
        `SELECT agent_id, status, runtime, metadata
           FROM agents WHERE agent_id = $1`,
        [projectionIdentityId],
      ).catch(() => ({ rows: [] as any[] }))
      : { rows: [] as any[] }
    const projectionRow = projectionAgent.rows[0] ?? null
    const projectionMetadata = (() => {
      if (!projectionRow?.metadata) return {}
      if (typeof projectionRow.metadata === 'object') return projectionRow.metadata
      try { return JSON.parse(projectionRow.metadata) } catch { return {} }
    })() as Record<string, unknown>
    const projectionHasDiscordIdentity =
      typeof projectionMetadata.discord_id === 'string' && projectionMetadata.discord_id.trim().length > 0
    const delegated = consumerAgentId !== null && consumerAgentId !== fromAgentId
    const report = {
      ok: true,
      surface: {
        provider: projection.platform,
        channel_id: channelId,
        thread_id: threadId,
        external_id: projection.channelExternalId,
      },
      message: {
        from_agent_id: fromAgentId,
        to_agent_ids: toAgentIds,
      },
      resolved: {
        consumer_agent_id: consumerAgentId,
        consumer_source: projection.consumerSource,
        projection_identity_id: projection.projectionIdentityId,
        intended_projection_identity_id: projection.intendedProjectionIdentityId,
        projection_source: projection.projectionSource,
        projection_fallback_reason: projection.projectionFallbackReason,
        delegated,
        consumer_discord_identity_present: hasDiscordIdentity,
        projection_discord_identity_present: projectionHasDiscordIdentity,
        consumer_status: consumerRow?.status ?? null,
        consumer_runtime: consumerRow?.runtime ?? null,
        projection_status: projectionRow?.status ?? null,
        projection_runtime: projectionRow?.runtime ?? null,
      },
      preview: consumerAgentId
        ? delegated
          ? `[${fromAgentId} -> ${toAgentIds.join(',')}]\n本文...`
          : '本文...'
        : null,
    }

    if (format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    const lines = [
      'Projection Preview',
      '',
      `Surface:  ${projection.platform} channel=${channelId}${threadId ? ` thread=${threadId}` : ''}`,
      `External: ${projection.channelExternalId ?? '(none)'}`,
      '',
      `From:     ${fromAgentId}`,
      `To:       ${toAgentIds.join(', ')}`,
      '',
      `Consumer: ${consumerAgentId ?? '(none)'}`,
      `Identity: ${projection.projectionIdentityId ?? '(none)'}`,
      `Intended: ${projection.intendedProjectionIdentityId ?? '(none)'}`,
      `Consumer source:   ${projection.consumerSource}`,
      `Projection source: ${projection.projectionSource}`,
      `Fallback reason:   ${projection.projectionFallbackReason ?? '(none)'}`,
      `Consumer Discord:  ${hasDiscordIdentity ? 'token identity present' : 'no token identity detected'}`,
      `Projection Discord: ${projectionHasDiscordIdentity ? 'token identity present' : 'no token identity detected'}`,
      `Consumer status:   ${consumerRow?.status ?? '(unknown)'}${consumerRow?.runtime ? ` / ${consumerRow.runtime}` : ''}`,
      `Projection status: ${projectionRow?.status ?? '(unknown)'}${projectionRow?.runtime ? ` / ${projectionRow.runtime}` : ''}`,
      '',
      'Discord will show:',
      report.preview ?? '(not projected)',
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  } finally {
    await db.end()
  }
}

async function diagnoseQueue(args: string[]) {
  const { flags } = parseArgs(args)
  const agentId = flags['agent-id'] ?? null
  const staleMinutes = Number.parseInt(flags['stale-minutes'] ?? '15', 10)
  const staleSeconds = Number.isFinite(staleMinutes) && staleMinutes >= 0 ? staleMinutes * 60 : 15 * 60
  const format = flags.format ?? 'json'
  const db = await getDb()

  try {
    const report = await buildQueueDoctorReport(db as any, { agentId, staleSeconds })

    if (format === 'text') {
      process.stdout.write(formatQueueDoctorText(report))
      return
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await db.end()
  }
}

async function repairQueue(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  if (subcommand === 'normalize' && hasFlag(flags, 'execute')) {
    console.error('Error: queue normalize is read-only; run the reported repair command with --execute after review')
    process.exit(2)
  }
  const dryRun = parseRepairDryRun(flags)
  const db = await getDb()

  try {
    if (subcommand === 'normalize') {
      const agentId = flags['agent-id'] ?? null
      const staleMinutes = Number.parseInt(flags['stale-minutes'] ?? '15', 10)
      const staleSeconds = Number.isFinite(staleMinutes) && staleMinutes >= 0 ? staleMinutes * 60 : 15 * 60
      const format = flags.format ?? 'json'
      const report = await buildQueueNormalizationReport(db as any, { agentId, staleSeconds })
      if (format === 'text') {
        process.stdout.write(formatQueueNormalizationText(report))
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      }
      return
    }

    if (subcommand === 'reassign') {
      const fromAgentId = flags.from
      const toAgentId = flags.to
      if (!fromAgentId || !toAgentId) {
        console.error('Usage: agent-com queue reassign --from <agent> --to <agent> [--execute|--dry-run]')
        process.exit(2)
      }
      const report = await reassignPendingQueueRows(db as any, { fromAgentId, toAgentId, dryRun })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    if (subcommand === 'close-obsolete') {
      const agentId = flags['agent-id']
      const reason = flags.reason
      if (!agentId || !reason) {
        console.error('Usage: agent-com queue close-obsolete --agent-id <agent> --reason <text> [--queue-id <id>] [--include-active] [--execute|--dry-run]')
        process.exit(2)
      }
      const report = await closeObsoletePendingQueueRows(db as any, {
        agentId,
        reason,
        queueId: flags['queue-id'] ?? null,
        includeActive: flagEnabled(flags['include-active']),
        dryRun,
      })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    if (subcommand === 'reclaim-expired') {
      const report = await reclaimExpiredQueueClaims(db as any, { agentId: flags['agent-id'] ?? null, dryRun })
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }

    console.error('Usage: agent-com queue <doctor|normalize|reassign|close-obsolete|reclaim-expired> ...')
    process.exit(2)
  } finally {
    await db.end()
  }
}

/**
 * `agent-com agents` — list registered agents as JSON.
 * MVP: no filters; reads the agents table verbatim.
 */
async function listAgents() {
  const db = await getDb()
  try {
    const r = await db.query(
      `SELECT agent_id, display_name, agent_type, runtime, status, channel_port, registered_at
       FROM agents
       ORDER BY agent_id`,
    )
    process.stdout.write(JSON.stringify(r.rows, null, 2) + '\n')
  } finally {
    await db.end()
  }
}

async function directory(args: string[]) {
  const { flags } = parseArgs(args)
  const format = flags.format ?? 'json'
  const db = await getDb()
  try {
    const report = await buildDirectoryReport(db as any)
    if (format === 'text') {
      process.stdout.write(formatDirectoryText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    await db.end()
  }
}

async function runtimeCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  if (subcommand !== 'inventory') {
    console.error('Usage: agent-com runtime inventory [--format json|text] [--stale-minutes 15] [--expected-commit <sha>] [--provider discord]')
    process.exit(2)
  }
  const format = flags.format ?? 'json'
  const staleMinutes = parsePositiveIntFlag(flags['stale-minutes'], 15, 'stale-minutes')
  const db = await getDb()
  try {
    const report = await buildRuntimeInventoryReport((db as any).__adapter, {
      staleMinutes,
      expectedCommit: flags['expected-commit'] ?? null,
      provider: flags.provider ?? 'discord',
    })
    if (format === 'text') {
      process.stdout.write(formatRuntimeInventoryText(report))
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    await db.end()
  }
}

/**
 * `agent-com status` — system or per-agent status (v1.0.2 §6.5).
 *
 * When AGENT_ID is set: per-agent mode → `{ agent_id, pending, status, last_seen_at }`
 * When no AGENT_ID: system-wide → channels / agents / messages summary
 * `--format json` → single-line JSON (for polling-driver / scripting)
 */
async function status(args: string[]) {
  const { flags } = parseArgs(args)
  const format = flags.format ?? 'text'
  // --agent-id or AGENT_ID gives per-agent status and must pass the runtime
  // identity lock. Omitting both is the only system-wide status path.
  const agentId = (flags['agent-id'] || process.env.AGENT_ID)
    ? resolveAgentId(args, 'status')
    : null

  const db = await getDb()
  try {
    if (agentId) {
      const pending = await db.query(
        `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
        [agentId],
      )
      const agent = await db.query(
        `SELECT status, last_seen_at FROM agents WHERE agent_id = $1`,
        [agentId],
      )
      // Issue #278 (A) segment 3d — agents.current_message_id is gone.
      // The "in-flight claim" view is now the most-recent active per-row
      // claim from message_queue.
      const claim = await db.query(
        `SELECT id::text AS id FROM message_queue
            WHERE claimed_by = $1 AND status = 'received'
            ORDER BY claimed_at DESC NULLS LAST
            LIMIT 1`,
        [agentId],
      )
      const row = agent.rows[0]
      const result = {
        agent_id: agentId,
        pending: pending.rows[0]?.n ?? 0,
        status: row?.status ?? 'unknown',
        last_seen_at: row?.last_seen_at ?? null,
        current_message_id: claim.rows[0]?.id ?? null,
      }
      if (format === 'json') {
        process.stdout.write(JSON.stringify(result) + '\n')
      } else {
        console.log(`Agent: ${agentId}`)
        console.log(`Status: ${result.status}`)
        console.log(`Pending: ${result.pending}`)
        console.log(`Last seen: ${result.last_seen_at ?? 'never'}`)
        console.log(`Current message: ${result.current_message_id ?? 'none'}`)
      }
    } else {
      const chCount = await db.query('SELECT COUNT(*) as cnt FROM channels')
      const agOnline = await db.query("SELECT COUNT(*) as cnt FROM agents WHERE status = 'online'")
      const agTotal = await db.query('SELECT COUNT(*) as cnt FROM agents')
      const msgRecent = await db.query("SELECT COUNT(*) as cnt FROM agent_messages WHERE created_at > now() - interval '1 hour'")
      if (format === 'json') {
        process.stdout.write(JSON.stringify({
          channels: parseInt(chCount.rows[0].cnt),
          agents_online: parseInt(agOnline.rows[0].cnt),
          agents_total: parseInt(agTotal.rows[0].cnt),
          messages_1h: parseInt(msgRecent.rows[0].cnt),
        }) + '\n')
      } else {
        console.log('=== agent-com status ===')
        console.log(`DB: connected`)
        console.log(`Channels: ${chCount.rows[0].cnt}`)
        console.log(`Agents: ${agOnline.rows[0].cnt} online / ${agTotal.rows[0].cnt} total`)
        console.log(`Messages (1h): ${msgRecent.rows[0].cnt}`)
      }
    }
  } finally {
    await db.end()
  }
}

/**
 * `agent-com heartbeat [--agent-id <id>]` — update agents.last_seen_at + disconnected→idle (v1.0.2 §4.5 / §6.5).
 */
async function heartbeat(args: string[]) {
  const agentId = resolveAgentId(args, 'heartbeat')
  const db = await getDb()
  try {
    // ARC codex audit (PR#139): spec requires disconnected→idle recovery on heartbeat.
    await db.query(
      `UPDATE agents SET last_seen_at = now(),
       status = CASE WHEN status = 'disconnected' THEN 'idle' ELSE status END
       WHERE agent_id = $1`,
      [agentId],
    )
    process.stdout.write(JSON.stringify({ ok: true, agent_id: agentId, last_seen_at: new Date().toISOString() }) + '\n')
  } finally {
    await db.end()
  }
}

/**
 * `agent-com daemon` — long-running polling driver for MCP-unsupported envs
 * (v1.0.2 §6.5). Runs heartbeat + poll loop, prints pending messages to
 * stdout when they arrive. Designed for tmux sessions where the operator
 * reads stdout and manually calls `next`.
 *
 * Usage: agent-com daemon --agent-id <id> [--poll-interval 3000]
 */
async function daemon(args: string[]) {
  const agentId = resolveAgentId(args, 'daemon')
  const { flags } = parseArgs(args)
  const pollInterval = parseInt(flags['poll-interval'] ?? '3000', 10)
  const heartbeatInterval = 30_000

  console.error(`[daemon] Started for ${agentId}, poll=${pollInterval}ms, heartbeat=${heartbeatInterval}ms`)
  console.error(`[daemon] Press Ctrl+C to stop`)

  // Heartbeat timer
  setInterval(async () => {
    const db = await getDb()
    try {
      await db.query(
        `UPDATE agents SET last_seen_at = now(),
         status = CASE WHEN status = 'disconnected' THEN 'idle' ELSE status END
         WHERE agent_id = $1`,
        [agentId],
      )
    } catch (err) {
      console.error(`[daemon] heartbeat error: ${err}`)
    } finally {
      await db.end()
    }
  }, heartbeatInterval)

  // Poll timer
  const poll = async () => {
    const db = await getDb()
    try {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
        [agentId],
      )
      const pending: number = r.rows[0]?.n ?? 0
      if (pending > 0) {
        // Output a notification line so tmux watchers / piped consumers can act.
        process.stdout.write(JSON.stringify({
          event: 'pending',
          agent_id: agentId,
          pending,
          ts: new Date().toISOString(),
          hint: `Run 'AGENT_ID=${agentId} agent-com next' to process`,
        }) + '\n')
      }
    } catch (err) {
      console.error(`[daemon] poll error: ${err}`)
    } finally {
      await db.end()
    }
  }

  // Initial poll + start interval
  await poll()
  setInterval(poll, pollInterval)

  // Keep the process alive
  await new Promise(() => {})
}

function resolveLeaseHolderAgentId(args: string[], flags: Record<string, string>, required: boolean): string | undefined {
  if (flags['holder-agent-id']) return assertExpectedAgentId(flags['holder-agent-id'], 'lease')
  if (flags['agent-id'] || process.env.AGENT_ID) return resolveAgentId(args, 'lease')
  if (required) {
    console.error('Error: --holder-agent-id, --agent-id, or AGENT_ID is required for lease mutation')
    process.exit(2)
  }
  return undefined
}

function parseLeaseTtlMs(flags: Record<string, string>): number {
  if (flags['ttl-ms']) return parsePositiveIntFlag(flags['ttl-ms'], 30_000, 'ttl-ms')
  return parsePositiveIntFlag(flags['ttl-sec'], 30, 'ttl-sec') * 1000
}

function parseLeaseMetadata(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  console.error('Error: --metadata must be a JSON object')
  process.exit(2)
}

function requireLeaseFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]
  if (!value) {
    console.error(`Error: --${name} is required`)
    process.exit(2)
  }
  return value
}

const LEASE_SCOPE_TYPES = new Set(['connector_instance', 'channel_binding', 'queue_partition', 'runtime_instance'])
const LEASE_PURPOSES = new Set(['inbound', 'outbound', 'worker', 'leader', 'presence', 'maintenance'])

function parseLeaseScopeType(flags: Record<string, string>): LeaseScopeType {
  const value = requireLeaseFlag(flags, 'scope-type')
  if (!LEASE_SCOPE_TYPES.has(value)) {
    console.error(`Error: --scope-type must be one of ${Array.from(LEASE_SCOPE_TYPES).join(', ')}`)
    process.exit(2)
  }
  return value as LeaseScopeType
}

function parseLeasePurpose(flags: Record<string, string>): LeasePurpose {
  const value = flags.purpose ?? 'worker'
  if (!LEASE_PURPOSES.has(value)) {
    console.error(`Error: --purpose must be one of ${Array.from(LEASE_PURPOSES).join(', ')}`)
    process.exit(2)
  }
  return value as LeasePurpose
}

function parseFencingToken(flags: Record<string, string>): number {
  const raw = requireLeaseFlag(flags, 'fencing-token')
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error('Error: --fencing-token must be a positive integer')
    process.exit(2)
  }
  return parsed
}

async function leaseCommand(subcommand: string | undefined, args: string[]) {
  const { flags } = parseArgs(args)
  const db = await getDb()
  const adapter = (db as any).__adapter as DbAdapter
  try {
    if (subcommand === 'acquire') {
      const result = await acquireControlPlaneLease(adapter, {
        scopeType: parseLeaseScopeType(flags),
        scopeId: requireLeaseFlag(flags, 'scope-id'),
        purpose: parseLeasePurpose(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, true),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
        ttlMs: parseLeaseTtlMs(flags),
        metadata: parseLeaseMetadata(flags.metadata),
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    if (subcommand === 'heartbeat') {
      const result = await heartbeatControlPlaneLease(adapter, {
        leaseId: requireLeaseFlag(flags, 'lease-id'),
        fencingToken: parseFencingToken(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, false),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
        ttlMs: parseLeaseTtlMs(flags),
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    if (subcommand === 'release') {
      const result = await releaseControlPlaneLease(adapter, {
        leaseId: requireLeaseFlag(flags, 'lease-id'),
        fencingToken: parseFencingToken(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, false),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    if (subcommand === 'verify') {
      const result = await verifyControlPlaneFence(adapter, {
        leaseId: requireLeaseFlag(flags, 'lease-id'),
        fencingToken: parseFencingToken(flags),
        holderAgentId: resolveLeaseHolderAgentId(args, flags, false),
        holderRuntimeInstanceId: flags['holder-runtime-instance-id'],
        holderConnectorInstanceId: flags['holder-connector-instance-id'],
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }

    console.error('Usage: agent-com lease <acquire|heartbeat|release|verify> ...')
    process.exit(2)
  } finally {
    await db.end()
  }
}

// --- Main ---
const [, , command, subcommand, ...rest] = process.argv

if (command === 'channel') {
  if (subcommand === 'create') await channelCreate(rest)
  else if (subcommand === 'add-member') await channelAddMember(rest)
  else if (subcommand === 'remove-member') await channelRemoveMember(rest)
  else if (subcommand === 'members') await channelMembers(rest)
  else if (subcommand === 'policy') await channelPolicy(rest)
  else {
    console.error('Usage: agent-com channel <create|add-member|remove-member|members|policy> ...')
    process.exit(1)
  }
} else if (command === 'agent') {
  if (subcommand === 'register') await agentRegister(rest)
  else {
    console.error('Usage: agent-com agent <register> ...')
    process.exit(1)
  }
} else if (command === 'status') {
  await status([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'heartbeat') {
  await heartbeat([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'daemon') {
  await daemon([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'lease') {
  await leaseCommand(subcommand, rest)
} else if (command === 'next') {
  await nextMessage()
} else if (command === 'send') {
  // Issue #132: rest of argv is flag-style (--content / --mentions / ...).
  // subcommand here is the first positional after `send`, which doesn't apply.
  await sendMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'notify') {
  // spec §4.3: self-originated post, no reply context.
  await notifyMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'fail') {
  // spec §4.1, §11 (v2.1.0): explicit abandon with failed_reason.
  await failMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'skip') {
  // spec §4.1, §11 (v2.1.0): operator-initiated skip with failed_reason.
  await skipMessage([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'reclaim') {
  // spec §4.1 (v2.1.0): manual orphan reclaim for crashed bots.
  await reclaimMessages([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'diagnose-delivery') {
  await diagnoseDelivery([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'diagnose-projection') {
  await diagnoseProjection([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'diagnose-queue') {
  await diagnoseQueue([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'queue' && subcommand === 'doctor') {
  await diagnoseQueue(rest)
} else if (command === 'queue') {
  await repairQueue(subcommand, rest)
} else if (command === 'directory') {
  await directory([subcommand, ...rest].filter((s): s is string => typeof s === 'string'))
} else if (command === 'runtime') {
  await runtimeCommand(subcommand, rest)
} else if (command === 'agents') {
  await listAgents()
} else {
  console.error(`agent-com CLI v0.2.0

Commands:
  channel create <id> [--name "Name"] [--members cto,dev-a]
  channel add-member <channel_id> <agent_id>
  channel remove-member <channel_id> <agent_id>
  channel members <channel_id>
  channel policy list [--format json|text]
  channel policy import-json [--execute|--dry-run] [--path <file>]
  channel policy bootstrap [--execute|--dry-run] [--extra-allowlist <a,b>] [--overwrite]
  channel policy sync-connectors [--channel <id|name>] [--provider discord] [--execute|--dry-run]
  channel policy set <channel_id> [--primary <agent|none>] [--adapter-owner <agent|none>] [--allowlist <a,b|none>] [--execute|--dry-run]
  agent register <agent_id> [--display-name "Name"] [--type dev] [--runtime claude-code]
  status

Message I/O (requires AGENT_ID env var):
  next                                                — fetch one unread message (oldest first)
  send --content "..." --mentions cto,ceo [--message-type chat] [--no-close|--close]
  notify --channel <id|name> [--thread-id <id>] --mentions cto --content "..." [--message-type chat]
  fail --message-id <uuid> --reason <text>            — mark in-flight message failed (v2.1.0, §4.1)
  skip --message-id <uuid> --reason <text>            — operator-initiated skip (v2.1.0, §4.1)
  reclaim [--agent-id <id>]                           — manual orphan reclaim (v2.1.0, §4.1)
  diagnose-delivery [--queue-id <id>] [--message-id <uuid>] [--outbound-message-id <uuid>]
                                                       — JSON explanation for next/projection gaps
  diagnose-projection --channel <id> --from <agent> --to <agent>[,<agent>]
                                                       — terminal preview of surface/projection routing
  diagnose-queue [--agent-id <id>] [--stale-minutes 15] [--format json|text]
  queue doctor [--agent-id <id>] [--stale-minutes 15] [--format json|text]
                                                       — queue health blockers and stale-work diagnostics
  queue normalize [--agent-id <id>] [--stale-minutes 15] [--format json|text]
                                                       — dry-run normalization plan with scoped repair commands
  queue reassign --from <agent> --to <agent> [--execute|--dry-run]
                                                       — dry-run by default; reassign pending rows to a replacement identity
  queue close-obsolete --agent-id <agent> --reason <text> [--queue-id <id>] [--include-active] [--execute|--dry-run]
                                                       — dry-run by default; close obsolete pending rows, or one explicit active row
  queue reclaim-expired [--agent-id <agent>] [--execute|--dry-run]
                                                       — dry-run by default; roll expired received/in_progress claims back to pending
  directory [--format json|text]                       — bot/channel directory and sendability report
  runtime inventory [--format json|text] [--stale-minutes 15] [--expected-commit <sha>]
                                                       — read-only runtime/connector/binding freshness report
  agents                                              — list registered agents (JSON)
  status [--format json] [--agent-id <id>]            — system or per-agent status
  heartbeat                                           — update last_seen_at
  lease acquire --scope-type <type> --scope-id <id> [--purpose outbound] --holder-agent-id <agent> [--ttl-sec 30]
                                                       — acquire a control-plane lease and fencing token
  lease heartbeat --lease-id <id> --fencing-token <n> [--holder-agent-id <agent>] [--ttl-sec 30]
                                                       — extend an active lease if the fence still matches
  lease verify --lease-id <id> --fencing-token <n> [--holder-agent-id <agent>]
                                                       — fail closed unless the active fence still matches
  lease release --lease-id <id> --fencing-token <n> [--holder-agent-id <agent>]
                                                       — release an active lease
  daemon [--poll-interval 3000]                       — long-running poll driver (non-MCP envs)`)
  if (command) process.exit(1)
}
