/**
 * Phase 5 §1.7 Port A — InboundResolver.
 *
 * Responsibility: take raw send/notify input and resolve it into the canonical
 * recipient list (queue-bound `enqueue` + body-bound `cc` + warnings).
 *
 * Contract:
 *   - `mention?: AgentId` for one recipient
 *   - `mentions?: AgentId[]` for multi-recipient fanout
 *   - `cc?: AgentId[]` is reference-only and never enqueued
 *
 * Validation (§1.6):
 *   - mention: empty string → INVALID_MENTION; unknown agent_id → UNKNOWN_AGENT
 *   - cc: each entry validated; unknown agents are stripped + warning (§4.5)
 *
 * Enqueue (§1.5, §2.1): cc[] are NOT enqueued. enqueue = [mention] only when
 * mention is present (or after primary fallback resolution); cc[] are surfaced
 * to readers via `[CC: <@id>]` body suffix injection (MessageBodyDecorator port).
 *
 * Note (PR #315 follow-up, ADR-041 amendment 2026-05-05): the previous
 * `enqueue = Array.from(new Set([mention, ...ccValid]))` violated §1.5 by
 * enqueuing cc[] recipients. The cc[] non-enqueue invariant is the multiplicity
 * reduction goal (2.20 → 1.0). See msg `fad41c69` (auditor BLOCK), `6b079a0c`
 * (ARC Option b), `ea7bc5cf` (CTO ratify).
 */
import type { AgentId } from '../../channel-policy'
import { normalizeAgentMentions } from '../../mention-normalization'
import type { PrimaryFallback } from './primary-fallback'

export type InboundResolveError = 'INVALID_MENTION' | 'UNKNOWN_AGENT'

export interface InboundResolveInput {
  channel_id: string
  mention?: AgentId
  mentions?: AgentId[]
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
      const cc = (input.cc ?? []).map((id) => id.trim()).filter((id) => id.length > 0)

      const normalized = normalizeAgentMentions(
        { mention: input.mention, mentions: input.mentions },
        {
          isKnownAgent: deps.isKnownAgent,
          requireKnown: true,
          allowGroupKeywords: true,
        },
      )
      if (!normalized.ok) {
        return { ok: false, error: normalized.error, agent_id: normalized.detail }
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

      if (normalized.mentions.length === 0) {
        return { ok: false, error: 'INVALID_MENTION' }
      }

      // §1.5 — cc[] non-enqueue invariant: enqueue = normalized primary/multi mentions only.
      // cc[] are surfaced via MessageBodyDecorator suffix, not via queue rows.
      const enqueue: AgentId[] = normalized.mentions

      return { ok: true, enqueue, cc: ccValid, warnings }
    },
  }
}
