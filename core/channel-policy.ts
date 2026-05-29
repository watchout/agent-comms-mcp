/**
 * Phase 5 §1.8 — common channel-policy source.
 *
 * Single source of truth for both server (`routeInbound`, `send/notify` validate)
 * and client (`send/notify` tool input validation, best-effort warning).
 *
 * Production reads the DB policy snapshot only. `config/bot-routing.json` is a
 * compatibility seed/test source and is read only when explicitly enabled.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type AgentId = string

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

export interface ChannelPolicyEntry {
  /** §1.3 / §2.3 — inbound default recipient when no `mention` is present. */
  primary: AgentId | null
  /** #410 — chat adapter process that owns projection for this channel. */
  adapterOwner: AgentId | null
  /** #417 — sender-specific native role projection owner overrides. */
  nativeRoleOutboundOwners: Record<AgentId, AgentId>
  /** ADR-060 — sender-specific native projection identity intent, not delivery ownership. */
  nativeProjectionIdentities: Record<AgentId, AgentId>
  /** §1.3 / §2.4 — outbound ACL allowlist. `null` = entry absent (legacy: all senders permitted). */
  outboundAllowlist: AgentId[] | null
  /** Evidence source for operator/audit diagnostics. */
  policySource: string
}

interface RoutingConfig {
  version: number
  channels: Record<string, {
    primary?: AgentId | null
    adapterOwner?: AgentId | null
    nativeRoleOutboundOwners?: Record<AgentId, AgentId>
    nativeProjectionIdentities?: Record<AgentId, AgentId>
    outboundAllowlist?: AgentId[]
    policySource?: string
  }>
}

let cachedConfig: RoutingConfig | null = null
let configLoadAttempted = false
let cachedConfigPath: string | null = null
let cachedConfigMtimeMs: number | null = null
let cachedConfigSize: number | null = null
let dbPolicySnapshot: RoutingConfig | null = null

function parseStringArray(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {}
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseStringMap(raw: unknown): Record<string, string> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
        .map(([key, value]) => [key, value.trim()]),
    )
  }
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return parseStringMap(parsed)
  } catch {
    return undefined
  }
}

function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function channelPolicyFileFallbackEnabled(): boolean {
  return Boolean(process.env.AGENT_COM_BOT_ROUTING_PATH) ||
    truthyEnv(process.env.AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK)
}

function normalizePolicyEntry(
  entry: RoutingConfig['channels'][string] | undefined,
  fallbackPolicySource: string,
): ChannelPolicyEntry {
  if (!entry) {
    return {
      primary: null,
      adapterOwner: null,
      nativeRoleOutboundOwners: {},
      nativeProjectionIdentities: {},
      outboundAllowlist: fallbackPolicySource === 'none' ? [] : null,
      policySource: fallbackPolicySource,
    }
  }
  const nativeRoleOutboundOwners =
    entry.nativeRoleOutboundOwners && typeof entry.nativeRoleOutboundOwners === 'object'
      ? Object.fromEntries(
        Object.entries(entry.nativeRoleOutboundOwners)
          .filter((kv): kv is [string, string] => typeof kv[1] === 'string' && kv[1].trim().length > 0)
          .map(([sender, owner]) => [sender, owner.trim()]),
      )
      : {}
  const nativeProjectionIdentities =
    entry.nativeProjectionIdentities && typeof entry.nativeProjectionIdentities === 'object'
      ? Object.fromEntries(
        Object.entries(entry.nativeProjectionIdentities)
          .filter((kv): kv is [string, string] => typeof kv[1] === 'string' && kv[1].trim().length > 0)
          .map(([sender, identity]) => [sender, identity.trim()]),
      )
      : {}
  return {
    primary: entry.primary ?? null,
    adapterOwner: entry.adapterOwner ?? null,
    nativeRoleOutboundOwners,
    nativeProjectionIdentities,
    outboundAllowlist: Array.isArray(entry.outboundAllowlist) ? entry.outboundAllowlist : null,
    policySource: entry.policySource ?? fallbackPolicySource,
  }
}

/**
 * Locate `config/bot-routing.json`. Independent of CWD so MCP server +
 * CLI + tests resolve the same file. Override via env for hermetic tests.
 */
function locateRoutingConfig(): string {
  if (process.env.AGENT_COM_BOT_ROUTING_PATH) {
    return process.env.AGENT_COM_BOT_ROUTING_PATH
  }
  const repoRoot = new URL('..', import.meta.url).pathname
  return join(repoRoot, 'config', 'bot-routing.json')
}

/**
 * Load + cache routing config for explicit compatibility/seed/test callers.
 * Long-lived compatibility callers revalidate file metadata on each policy
 * lookup; file fallback is still revalidated on access so ACL fixture updates
 * are picked up without a process restart.
 * Tests that need to reset the cache should call {@link resetChannelPolicyCache}.
 *
 * Production DB-SSOT callers do not reach this function unless file fallback
 * has been explicitly enabled.
 */
function loadConfig(): RoutingConfig {
  const path = locateRoutingConfig()
  let currentMtimeMs: number | null = null
  let currentSize: number | null = null

  try {
    if (existsSync(path)) {
      const stat = statSync(path)
      currentMtimeMs = stat.mtimeMs
      currentSize = stat.size
    }
  } catch {
    currentMtimeMs = null
    currentSize = null
  }

  if (
    cachedConfig !== null &&
    cachedConfigPath === path &&
    cachedConfigMtimeMs === currentMtimeMs &&
    cachedConfigSize === currentSize
  ) {
    return cachedConfig
  }

  if (
    configLoadAttempted &&
    cachedConfig === null &&
    cachedConfigPath === path &&
    currentMtimeMs === null
  ) {
    return { version: 1, channels: {} }
  }

  configLoadAttempted = true
  try {
    if (!existsSync(path)) {
      if (cachedConfig !== null) return cachedConfig
      cachedConfig = { version: 1, channels: {} }
      cachedConfigPath = path
      cachedConfigMtimeMs = null
      cachedConfigSize = null
      return cachedConfig
    }
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as RoutingConfig
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.channels !== 'object' ||
      parsed.channels === null ||
      Array.isArray(parsed.channels)
    ) {
      if (cachedConfig !== null) return cachedConfig
      cachedConfig = { version: 1, channels: {} }
      cachedConfigPath = path
      cachedConfigMtimeMs = currentMtimeMs
      cachedConfigSize = currentSize
      return cachedConfig
    }
    cachedConfig = parsed
    cachedConfigPath = path
    cachedConfigMtimeMs = currentMtimeMs
    cachedConfigSize = currentSize
    return cachedConfig
  } catch {
    if (cachedConfig !== null) return cachedConfig
    cachedConfig = { version: 1, channels: {} }
    cachedConfigPath = path
    cachedConfigMtimeMs = currentMtimeMs
    cachedConfigSize = currentSize
    return cachedConfig
  }
}

export function getChannelPolicy(channel_id: string): ChannelPolicyEntry {
  const dbEntry = dbPolicySnapshot?.channels[channel_id]
  if (dbEntry) return normalizePolicyEntry(dbEntry, 'db')

  if (channelPolicyFileFallbackEnabled()) {
    const config = loadConfig()
    const entry = config.channels[channel_id]
    return normalizePolicyEntry(entry, 'config/bot-routing.json')
  }

  return normalizePolicyEntry(undefined, 'none')
}

export async function refreshChannelPolicyDbSnapshot(db: Queryable): Promise<{ loaded: boolean; count: number }> {
  try {
    const result = await db.query(
      `SELECT channel_id,
              primary_agent_id,
              adapter_owner_agent_id,
              outbound_allowlist,
              native_role_outbound_owners,
              native_projection_identities,
              policy_source
         FROM channel_routing_policy
        ORDER BY channel_id`,
    )
    const channels: RoutingConfig['channels'] = {}
    for (const row of result.rows) {
      const channelId = typeof row.channel_id === 'string' ? row.channel_id.trim() : ''
      if (!channelId) continue
      channels[channelId] = {
        primary: typeof row.primary_agent_id === 'string' && row.primary_agent_id.trim() ? row.primary_agent_id.trim() : null,
        adapterOwner: typeof row.adapter_owner_agent_id === 'string' && row.adapter_owner_agent_id.trim() ? row.adapter_owner_agent_id.trim() : null,
        outboundAllowlist: parseStringArray(row.outbound_allowlist),
        nativeRoleOutboundOwners: parseStringMap(row.native_role_outbound_owners),
        nativeProjectionIdentities: parseStringMap(row.native_projection_identities),
        policySource: typeof row.policy_source === 'string' && row.policy_source.trim() ? row.policy_source.trim() : 'db',
      }
    }
    dbPolicySnapshot = { version: 1, channels }
    return { loaded: true, count: Object.keys(channels).length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/channel_routing_policy/i.test(message) && /(does not exist|no such table|no such column)/i.test(message)) {
      dbPolicySnapshot = null
      return { loaded: false, count: 0 }
    }
    throw err
  }
}

/** Test helper — clears the cached config so a different file can be loaded. */
export function resetChannelPolicyCache(): void {
  cachedConfig = null
  configLoadAttempted = false
  cachedConfigPath = null
  cachedConfigMtimeMs = null
  cachedConfigSize = null
  dbPolicySnapshot = null
}
