/**
 * Phase 5 §1.7 Port A — InboundResolver.
 *
 * Responsibility: take raw send/notify input and resolve it into the canonical
 * recipient list (queue-bound `enqueue` + body-bound observers + warnings).
 *
 * Contract:
 *   - `mention?: AgentId` for one recipient
 *   - `mentions?: AgentId[]` as a legacy single-owner alias
 *   - `cc?: AgentId[]` / `fyi?: AgentId[]` are reference-only and never enqueued
 *
 * Validation (§1.6):
 *   - mention: empty string → INVALID_MENTION; unknown agent_id → UNKNOWN_AGENT
 *   - cc/fyi: each entry validated; unknown agents are stripped + warning (§4.5)
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
import { GROUP_KEYWORDS, normalizeAgentMentions } from '../../mention-normalization'
import type { PrimaryFallback } from './primary-fallback'

export type InboundResolveError = 'INVALID_MENTION' | 'UNKNOWN_AGENT'
export type InboundResolveControlPlaneError = InboundResolveError | 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED'

export interface InboundResolveInput {
  channel_id: string
  mention?: AgentId
  mentions?: AgentId[]
  cc?: AgentId[]
  fyi?: AgentId[]
}

export interface InboundResolveOk {
  ok: true
  enqueue: AgentId[]
  cc: AgentId[]
  fyi: AgentId[]
  warnings: string[]
}

export interface InboundResolveErr {
  ok: false
  error: InboundResolveControlPlaneError
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

function countActiveInput(value: unknown): number | null {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return 1
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string') ? value.length : null
  }
  return null
}

function normalizeObserverList(
  label: 'cc' | 'fyi',
  value: unknown,
  isKnownAgent: (agent_id: AgentId) => boolean,
  warnings: string[],
): AgentId[] {
  const raw = Array.isArray(value) ? value : []
  const out: AgentId[] = []
  const seen = new Set<AgentId>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id) continue
    if (!isKnownAgent(id) || GROUP_KEYWORDS.has(id)) {
      warnings.push(`${label} agent "${id}" unknown; stripped`)
      continue
    }
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

export function createInboundResolver(deps: InboundResolverDeps): InboundResolver {
  return {
    resolve(input: InboundResolveInput): InboundResolveResult {
      const warnings: string[] = []
      const mentionInputCount = countActiveInput(input.mention)
      const mentionsInputCount = countActiveInput(input.mentions)
      if (mentionInputCount === null || mentionsInputCount === null) {
        return { ok: false, error: 'INVALID_MENTION' }
      }
      if ((mentionsInputCount ?? 0) > 1) {
        return { ok: false, error: 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED' }
      }
      if ((mentionsInputCount ?? 0) === 1) {
        warnings.push('mentions[] is a legacy single-owner alias; use mention')
      }

      const normalized = normalizeAgentMentions(
        { mention: input.mention, mentions: input.mentions },
        {
          isKnownAgent: deps.isKnownAgent,
          requireKnown: true,
          allowGroupKeywords: false,
        },
      )
      if (!normalized.ok) {
        return { ok: false, error: normalized.error, agent_id: normalized.detail }
      }

      if (normalized.mentions.length === 0) {
        return { ok: false, error: 'INVALID_MENTION' }
      }
      if (normalized.mentions.length > 1) {
        return { ok: false, error: 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED' }
      }

      const ccValid = normalizeObserverList('cc', input.cc, deps.isKnownAgent, warnings)
      const fyiValid = normalizeObserverList('fyi', input.fyi, deps.isKnownAgent, warnings)

      // §1.5 — cc[] non-enqueue invariant: enqueue = normalized primary/multi mentions only.
      // Observers are surfaced via MessageBodyDecorator suffix, not via queue rows.
      const enqueue: AgentId[] = normalized.mentions

      return { ok: true, enqueue, cc: ccValid, fyi: fyiValid, warnings }
    },
  }
}
