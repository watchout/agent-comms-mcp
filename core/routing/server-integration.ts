/**
 * Phase 5 — server-side integration helper for `send` / `notify`.
 *
 * Wraps the 4 ports (§1.7) into a single validation+decoration call site.
 * Both server.ts (canonical enforcement) and cli/index.ts (best-effort warning)
 * route through here so the contract has exactly one expression (§1.8).
 *
 * Slice 2 control-plane contract (2026-05-31): `mention` is the canonical
 * single active owner. `mentions[]` is retained only as a one-owner legacy
 * alias. `cc[]` / `fyi[]` are observer-only and never become queue rows.
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
  /** Single recipient. */
  mention?: AgentId
  /** Legacy single-owner alias. Multi-active fanout is rejected. */
  mentions?: AgentId[]
  /** §1.2 — 参照 recipients (queue 投入なし、body 注入対象). */
  cc?: AgentId[]
  /** Observer-only FYI recipients (queue 投入なし、body 注入対象). */
  fyi?: AgentId[]
  /** Original message content (will be decorated with observer suffixes when applicable). */
  content: string
  /** Used by the resolver for UNKNOWN_AGENT validation. */
  isKnownAgent: (id: AgentId) => boolean
}

export interface Phase5ResolveOk {
  ok: true
  /** Final enqueue list (resolved from `mention` / `mentions[]`; consumed by downstream fanout). */
  mentions: AgentId[]
  /** Decorated content (cc[] suffix appended when applicable). */
  content: string
  /** Observer-only cc list; never enqueued. */
  cc: AgentId[]
  /** Observer-only fyi list; never enqueued. */
  fyi: AgentId[]
  /** Non-fatal warnings (auto-convert / unknown cc strip / no primary skip). */
  warnings: string[]
}

export interface Phase5ResolveErr {
  ok: false
  /** Error class — active-owner / policy validation failures. */
  error: 'INVALID_MENTION' | 'UNKNOWN_AGENT' | 'MULTI_ACTIVE_RECIPIENT_UNSUPPORTED' | 'OUTBOUND_ACL_VIOLATION'
  /** Identifier surfaced in error message (agent_id or channel_id). */
  detail?: AgentId
  /** For OUTBOUND_ACL_VIOLATION: the canonical attempted recipients. */
  intended_recipients?: AgentId[]
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
  const usesPhase5Fields = input.mention !== undefined ||
    input.mentions !== undefined ||
    (input.cc && input.cc.length > 0) ||
    (input.fyi && input.fyi.length > 0)
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
    mentions: input.mentions,
    cc: input.cc,
    fyi: input.fyi,
  })

  if (!resolved.ok) {
    return { ok: false, error: resolved.error, detail: resolved.agent_id }
  }

  // §2.4 — outbound ACL: active owner + observers must all be policy-allowed.
  const policyRecipients = [...resolved.enqueue, ...resolved.cc, ...resolved.fyi]
  const aclResult = outboundValidator.validate(input.sender, input.channel_id, policyRecipients)
  if (!aclResult.ok) {
    return {
      ok: false,
      error: 'OUTBOUND_ACL_VIOLATION',
      intended_recipients: policyRecipients,
      violations: aclResult.violations,
    }
  }

  // §1.5 — observer body 注入. Observers are visible but non-claimable.
  const decorated = decorator.decorate(input.content, resolved.cc, resolved.fyi)

  return {
    ok: true,
    mentions: resolved.enqueue,
    content: decorated,
    cc: resolved.cc,
    fyi: resolved.fyi,
    warnings: resolved.warnings,
  }
}
