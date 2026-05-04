/**
 * Phase 5 §1.7 Port A — InboundResolver.
 *
 * Responsibility: take raw send/notify input and resolve it into the canonical
 * recipient list (queue-bound `enqueue` + body-bound `cc` + warnings).
 *
 * Contract:
 *   - `mention?: AgentId` (1 主 recipient、§1.1)
 *   - `cc?: AgentId[]` (queue 投入なし、body 注入対象、§1.5)
 *
 * Note (ADR-041 amendment 2026-05-05, CEO directive 5e2d9235):
 *   The legacy `mentions?: AgentId[]` field with auto-convert
 *   (`mentions[0]` → mention, rest → cc) was removed. Callers must supply
 *   `mention` (1 primary, required at MCP schema layer) + optional `cc[]`.
 *
 * Validation (§1.6):
 *   - mention: empty string → INVALID_MENTION; unknown agent_id → UNKNOWN_AGENT
 *   - cc: each entry validated; unknown agents are stripped + warning (§4.5)
 *
 * Dedup (§2.1): `Array.from(new Set([mention, ...cc]))`.
 */
import type { AgentId } from '../../channel-policy'
import type { PrimaryFallback } from './primary-fallback'

export type InboundResolveError = 'INVALID_MENTION' | 'UNKNOWN_AGENT'

export interface InboundResolveInput {
  channel_id: string
  mention?: AgentId
  cc?: AgentId[]
}

export interface InboundResolveOk {
  ok: true
  enqueue: AgentId[]
  cc: AgentId[]
  warnings: string[]
}

export interface InboundResolveErr {
  ok: false
  error: InboundResolveError
  agent_id?: AgentId
}

export type InboundResolveResult = InboundResolveOk | InboundResolveErr

export interface InboundResolver {
  resolve(input: InboundResolveInput): InboundResolveResult
}

export interface InboundResolverDeps {
  /** § 1.6 — UNKNOWN_AGENT validation. Returns true when `agent_id` is registered. */
  isKnownAgent: (agent_id: AgentId) => boolean
  /** § 2.3 — primary fallback when no mention is supplied. */
  primaryFallback: PrimaryFallback
}

export function createInboundResolver(deps: InboundResolverDeps): InboundResolver {
  return {
    resolve(input: InboundResolveInput): InboundResolveResult {
      const warnings: string[] = []
      let mention = input.mention?.trim()
      const cc = (input.cc ?? []).map((id) => id.trim()).filter((id) => id.length > 0)

      // ADR-041 amendment 2026-05-05 — legacy `mentions[]` auto-convert removed.
      // Callers must use `mention` (required) + `cc[]`.

      // §1.6 — mention validation
      if (mention !== undefined) {
        if (mention.length === 0) {
          return { ok: false, error: 'INVALID_MENTION' }
        }
        if (!deps.isKnownAgent(mention)) {
          return { ok: false, error: 'UNKNOWN_AGENT', agent_id: mention }
        }
      }

      // §1.6 NEW — cc validation: unknown agents are stripped + warning
      const ccValid: AgentId[] = []
      for (const id of cc) {
        if (id.length === 0) continue // INVALID_MENTION-equivalent for cc → drop silently
        if (!deps.isKnownAgent(id)) {
          warnings.push(`cc agent "${id}" unknown; stripped`)
          continue
        }
        ccValid.push(id)
      }

      // §2.3 — primary fallback when no mention
      if (!mention) {
        const primary = deps.primaryFallback.lookup(input.channel_id)
        if (primary) {
          mention = primary
        } else {
          warnings.push(`no mention and no channel.primary; recipient skipped`)
          // §2.1 — dedup: empty enqueue, cc still injected if present
          return {
            ok: true,
            enqueue: Array.from(new Set(ccValid)),
            cc: ccValid,
            warnings,
          }
        }
      }

      // §2.1 — dedup
      const enqueue = Array.from(new Set([mention, ...ccValid]))

      return { ok: true, enqueue, cc: ccValid, warnings }
    },
  }
}
