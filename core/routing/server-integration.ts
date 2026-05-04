/**
 * Phase 5 — server-side integration helper for `send` / `notify`.
 *
 * Wraps the 4 ports (§1.7) into a single validation+decoration call site.
 * Both server.ts (canonical enforcement) and cli/index.ts (best-effort warning)
 * route through here so the contract has exactly one expression (§1.8).
 *
 * ADR-041 amendment 2026-05-05 (CEO directive 5e2d9235): the legacy
 * `mentions[]` field is removed. Callers MUST supply `mention` (required) +
 * optional `cc[]`. The MCP server schema rejects missing `mention` upstream.
 */
import {
  createInboundResolver,
  createPrimaryFallback,
  createOutboundPolicyValidator,
  createMessageBodyDecorator,
  type AgentId,
} from './index'

export interface Phase5ResolveInput {
  /** Sender agent_id (server-side: derived from auth). */
  sender: AgentId
  /** Channel id of the destination (server-side: derived from reply_to lookup or `channel` arg). */
  channel_id: string
  /** §1.2 — 1 主 recipient (required at MCP layer). */
  mention?: AgentId
  /** §1.2 — 参照 recipients (queue 投入なし、body 注入対象). */
  cc?: AgentId[]
  /** Original message content (will be decorated with cc[] suffix when applicable). */
  content: string
  /** Used by the resolver for UNKNOWN_AGENT validation. */
  isKnownAgent: (id: AgentId) => boolean
}

export interface Phase5ResolveOk {
  ok: true
  /** Final enqueue list (resolved from `mention` + `cc[]`; consumed by downstream fanout). */
  mentions: AgentId[]
  /** Decorated content (cc[] suffix appended when applicable). */
  content: string
  /** Non-fatal warnings (auto-convert / unknown cc strip / no primary skip). */
  warnings: string[]
}

export interface Phase5ResolveErr {
  ok: false
  /** Error class — `INVALID_MENTION` / `UNKNOWN_AGENT` / `OUTBOUND_ACL_VIOLATION`. */
  error: 'INVALID_MENTION' | 'UNKNOWN_AGENT' | 'OUTBOUND_ACL_VIOLATION'
  /** Identifier surfaced in error message (agent_id or channel_id). */
  detail?: AgentId
  /** For OUTBOUND_ACL_VIOLATION: the offenders. */
  violations?: AgentId[]
}

export type Phase5ResolveResult = Phase5ResolveOk | Phase5ResolveErr

/**
 * Returns `null` when the caller does NOT use the Phase 5 fields (mention/cc).
 * In that case the caller should preserve its legacy behavior. When Phase 5
 * fields are present, returns `{ ok: true, ... }` or `{ ok: false, error }`.
 */
export function resolvePhase5(input: Phase5ResolveInput): Phase5ResolveResult | null {
  const usesPhase5Fields = input.mention !== undefined || (input.cc && input.cc.length > 0)
  if (!usesPhase5Fields) {
    return null
  }

  const inboundResolver = createInboundResolver({
    isKnownAgent: input.isKnownAgent,
    primaryFallback: createPrimaryFallback(),
  })
  const outboundValidator = createOutboundPolicyValidator()
  const decorator = createMessageBodyDecorator()

  const resolved = inboundResolver.resolve({
    channel_id: input.channel_id,
    mention: input.mention,
    cc: input.cc,
  })

  if (!resolved.ok) {
    return { ok: false, error: resolved.error, detail: resolved.agent_id }
  }

  // §2.4 — outbound ACL: server-side reject 一本化 (cc[] strip 削除).
  const aclResult = outboundValidator.validate(input.sender, input.channel_id, resolved.enqueue)
  if (!aclResult.ok) {
    return { ok: false, error: 'OUTBOUND_ACL_VIOLATION', violations: aclResult.violations }
  }

  // §1.5 — cc[] body 注入. cc は queue 非投入だが body suffix で reader に露出.
  const decorated = decorator.decorate(input.content, resolved.cc)

  return {
    ok: true,
    mentions: resolved.enqueue,
    content: decorated,
    warnings: resolved.warnings,
  }
}
