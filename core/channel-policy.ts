/**
 * Phase 5 §1.8 — common channel-policy source.
 *
 * Single source of truth for both server (`routeInbound`, `send/notify` validate)
 * and client (`send/notify` tool input validation, best-effort warning). The
 * file `<repo>/config/bot-routing.json` is read once at process start and
 * cached; reload is restart-only (§3.7 file watch reload anti-pattern, §1.8).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type AgentId = string

export interface ChannelPolicyEntry {
  /** §1.3 / §2.3 — inbound default recipient when no `mention` is present. */
  primary: AgentId | null
  /** §1.3 / §2.4 — outbound ACL allowlist. `null` = entry absent (legacy: all senders permitted). */
  outboundAllowlist: AgentId[] | null
}

interface RoutingConfig {
  version: number
  channels: Record<string, {
    primary?: AgentId | null
    outboundAllowlist?: AgentId[]
  }>
}

let cachedConfig: RoutingConfig | null = null
let configLoadAttempted = false

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
 * Load + cache routing config. §3.7 / §1.8: restart-only reload — once the
 * cache is warm, file mutations do not propagate. Tests that need to reset
 * the cache should call {@link resetChannelPolicyCache}.
 *
 * §4.5 / §3.4 ARC: file absent / parse error / schema invalid all
 * fall through to a permissive empty config (`channels: {}`). This is
 * "fail-closed for outbound ACL" because an unknown channel returns
 * `outboundAllowlist: null` = legacy "all permitted" — the only gate is
 * the explicit allowlist entry. The conservative trade-off is not adding
 * surprise rejections when ops have not yet authored a routing entry.
 */
function loadConfig(): RoutingConfig {
  if (cachedConfig !== null) return cachedConfig
  if (configLoadAttempted && cachedConfig === null) return { version: 1, channels: {} }
  configLoadAttempted = true
  try {
    const path = locateRoutingConfig()
    if (!existsSync(path)) {
      cachedConfig = { version: 1, channels: {} }
      return cachedConfig
    }
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as RoutingConfig
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.channels !== 'object') {
      cachedConfig = { version: 1, channels: {} }
      return cachedConfig
    }
    cachedConfig = parsed
    return cachedConfig
  } catch {
    cachedConfig = { version: 1, channels: {} }
    return cachedConfig
  }
}

export function getChannelPolicy(channel_id: string): ChannelPolicyEntry {
  const config = loadConfig()
  const entry = config.channels[channel_id]
  if (!entry) return { primary: null, outboundAllowlist: null }
  return {
    primary: entry.primary ?? null,
    outboundAllowlist: Array.isArray(entry.outboundAllowlist) ? entry.outboundAllowlist : null,
  }
}

/** Test helper — clears the cached config so a different file can be loaded. */
export function resetChannelPolicyCache(): void {
  cachedConfig = null
  configLoadAttempted = false
}
