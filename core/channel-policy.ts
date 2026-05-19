/**
 * Phase 5 §1.8 — common channel-policy source.
 *
 * Single source of truth for both server (`routeInbound`, `send/notify` validate)
 * and client (`send/notify` tool input validation, best-effort warning). The
 * file `<repo>/config/bot-routing.json` is cached and revalidated on access
 * using file metadata. This keeps long-lived MCP processes from holding stale
 * ACLs after an operator updates the routing file.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type AgentId = string

export interface ChannelPolicyEntry {
  /** §1.3 / §2.3 — inbound default recipient when no `mention` is present. */
  primary: AgentId | null
  /** #410 — chat adapter process that owns projection for this channel. */
  adapterOwner: AgentId | null
  /** #417 — sender-specific native role projection owner overrides. */
  nativeRoleOutboundOwners: Record<AgentId, AgentId>
  /** §1.3 / §2.4 — outbound ACL allowlist. `null` = entry absent (legacy: all senders permitted). */
  outboundAllowlist: AgentId[] | null
}

interface RoutingConfig {
  version: number
  channels: Record<string, {
    primary?: AgentId | null
    adapterOwner?: AgentId | null
    nativeRoleOutboundOwners?: Record<AgentId, AgentId>
    outboundAllowlist?: AgentId[]
  }>
}

let cachedConfig: RoutingConfig | null = null
let configLoadAttempted = false
let cachedConfigPath: string | null = null
let cachedConfigMtimeMs: number | null = null
let cachedConfigSize: number | null = null

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
 * Load + cache routing config. Long-lived MCP processes revalidate file
 * metadata on each policy lookup so operator ACL updates are picked up without
 * a process restart. Tests that need to reset the cache should call
 * {@link resetChannelPolicyCache}.
 *
 * §4.5 / §3.4 ARC: file absent / parse error / schema invalid all
 * fall through to a permissive empty config (`channels: {}`). This is
 * "fail-closed for outbound ACL" because an unknown channel returns
 * `outboundAllowlist: null` = legacy "all permitted" — the only gate is
 * the explicit allowlist entry. The conservative trade-off is not adding
 * surprise rejections when ops have not yet authored a routing entry.
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
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.channels !== 'object') {
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
  const config = loadConfig()
  const entry = config.channels[channel_id]
  if (!entry) return { primary: null, adapterOwner: null, nativeRoleOutboundOwners: {}, outboundAllowlist: null }
  const nativeRoleOutboundOwners =
    entry.nativeRoleOutboundOwners && typeof entry.nativeRoleOutboundOwners === 'object'
      ? Object.fromEntries(
        Object.entries(entry.nativeRoleOutboundOwners)
          .filter((kv): kv is [string, string] => typeof kv[1] === 'string' && kv[1].trim().length > 0)
          .map(([sender, owner]) => [sender, owner.trim()]),
      )
      : {}
  return {
    primary: entry.primary ?? null,
    adapterOwner: entry.adapterOwner ?? null,
    nativeRoleOutboundOwners,
    outboundAllowlist: Array.isArray(entry.outboundAllowlist) ? entry.outboundAllowlist : null,
  }
}

/** Test helper — clears the cached config so a different file can be loaded. */
export function resetChannelPolicyCache(): void {
  cachedConfig = null
  configLoadAttempted = false
  cachedConfigPath = null
  cachedConfigMtimeMs = null
  cachedConfigSize = null
}
