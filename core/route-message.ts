/**
 * core/route-message.ts — pure routing functions
 *
 * PR-A (step 1/2): extracted pure functions from server.ts.
 * PR-B (step 2/2): renamed `routeInbound` → `routeMessage` and added a
 * `sourceType: 'inbound' | 'send-tool' | 'cli'` discriminator so the same
 * pure function can be called from all push paths (receiver inbound, bot
 * `send` tool, CLI `notify`). Unifying the call sites was §C2 of the
 * v0.2.0 spec — without the discriminator each caller had to duplicate
 * the channel-membership and mention checks.
 *
 * All branches enforce the DB-owned sender membership boundary. Native
 * inbound additionally requires a resolved non-human agent identity; null,
 * unmapped, external-human, and nonmember senders fail closed.
 *
 * Backwards compat: `routeInbound` is still exported as an alias that
 * forwards to `routeMessage({sourceType: 'inbound'})`. Planned removal
 * after PR-B consumers migrate.
 */

import { parseNativeAgentMentions } from './mention-normalization'

export interface AgentInfo {
  agentId: string
  agentType: string
  observerMode: boolean
  // Adapter metadata loaded for observability and compatibility. Core
  // routing does not match mentions against external IDs.
  discordId?: string | null
}

export interface ChannelInfo {
  channelId: string
  threadId?: string | null
  members: string[]
  type?: string  // 'dm' etc.
  // Channel primary remains policy metadata, but no-mention inbound messages
  // now alert instead of silently routing to primary or fanout.
  primary?: string | null
}

export interface RouteResult {
  pushTargets: string[]
  dropTargets: Record<string, string>  // agentId → reason
  senderIsHuman: boolean
  noMentions: boolean  // true when mentions array is empty (Pattern A)
  senderViolation?: string  // set whenever the sender itself is blocked
}

/** Call-site discriminator for `routeMessage`. */
export type RouteSourceType = 'inbound' | 'send-tool' | 'cli'

/** Parse @agent_id mentions from message content.
 *
 * Issue #351 Phase A: defensive against malformed input. Empty / non-string
 * / pure-`<@>` / numeric-only IDs (Discord snowflakes) return an empty array
 * without throwing. Numeric-only IDs are excluded because the `@` regex
 * would otherwise alias raw Discord IDs as native agent_ids (false-positive
 * documented in buildSendMentions above).
 */
export function parseMentions(content: unknown): string[] {
  return parseNativeAgentMentions(content)
}

// ─── Issue #351 Phase A: drop / reject observability ──────────────────────
//
// routeMessage / resolveSendDestination historically dropped recipients
// silently (return value showed `dropTargets[agentId] = REASON` but nothing
// was logged and no metric was incremented). When mention plumbing broke
// (CTO bug report msg `3b65e0cf`, 2026-05-13), the silent drops made the
// failure mode invisible. Phase A converts every drop / reject path to a
// structured warn-log + counter without changing routing semantics.

/** Drop taxonomy emitted by routeMessage / send-tool guards. */
export type RouteDropReason =
  | 'channel_non_member'
  | 'observer_mode'
  | 'mention_not_in_array'
  | 'sender_not_a_member'
  | 'sender_identity_unresolved'
  | 'sender_human_not_allowed'
  | 'human_agent_no_queue'
  | 'not_primary_no_mention'
  | 'missing_mention_target'

/** Reject taxonomy emitted by send / reply guards (route-message-db.ts).
 *
 * Phase A scope intentionally limited to the one reject path
 * `resolveSendDestination` actually owns. Claim-related send decisions
 * (`claim_missing` / already-closed no-op) live in
 * `core/send-fallback-decision.ts`; they are not wired here so we don't
 * define a label without a producer.
 */
export type SendRejectReason =
  | 'not_mentioned_in_original'

interface RouteDropEvent {
  ts: string
  level: 'warn'
  event: 'route_drop'
  reason: RouteDropReason
  recipient_agent_id: string
  sender_agent_id: string | null
  channel_id: string
  message_id?: string | null
}

interface SendRejectEvent {
  ts: string
  level: 'warn'
  event: 'send_reject'
  reason: SendRejectReason
  caller_agent_id: string
  original_author: string | null
  original_id: string
  has_parsed_mentions: boolean
  has_metadata_mentions: boolean
}

/** Structured-log sink. Default writes JSON line to stderr. */
export type ObservabilityLogger = (event: RouteDropEvent | SendRejectEvent) => void

let activeLogger: ObservabilityLogger = (event) => {
  try {
    process.stderr.write(JSON.stringify(event) + '\n')
  } catch {
    /* ignore — logging must never throw */
  }
}

/** Replace the active logger (tests inject a capturing sink). */
export function setObservabilityLogger(fn: ObservabilityLogger | null): void {
  activeLogger = fn ?? ((event) => {
    try { process.stderr.write(JSON.stringify(event) + '\n') } catch { /* */ }
  })
}

/** Counter store — `<metric>|<labelKey>=<labelVal>,...` → count. */
const counters = new Map<string, number>()

function counterKey(metric: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
  const labelStr = entries.map(([k, v]) => `${k}=${v}`).join(',')
  return labelStr ? `${metric}|${labelStr}` : metric
}

export function incRouteMessageDrop(reason: RouteDropReason): void {
  const key = counterKey('route_message_drops_total', { reason })
  counters.set(key, (counters.get(key) ?? 0) + 1)
}

export function incSendReject(reason: SendRejectReason): void {
  const key = counterKey('send_reject_total', { reason })
  counters.set(key, (counters.get(key) ?? 0) + 1)
}

/** Read a snapshot of all counters (test-friendly). */
export function getObservabilityCounters(): Record<string, number> {
  return Object.fromEntries(counters)
}

/** Test helper — reset counters between cases. */
export function resetObservabilityCounters(): void {
  counters.clear()
}

function emitRouteDrop(
  reason: RouteDropReason,
  recipientAgentId: string,
  ctx: { senderAgentId: string | null; channelId: string; messageId?: string | null },
): void {
  activeLogger({
    ts: new Date().toISOString(),
    level: 'warn',
    event: 'route_drop',
    reason,
    recipient_agent_id: recipientAgentId,
    sender_agent_id: ctx.senderAgentId,
    channel_id: ctx.channelId,
    message_id: ctx.messageId ?? null,
  })
  incRouteMessageDrop(reason)
}

/** Emitted by resolveSendDestination on NOT_MENTIONED_IN_ORIGINAL reject. */
export function emitSendReject(
  reason: SendRejectReason,
  ctx: {
    callerAgentId: string
    originalAuthor: string | null
    originalId: string
    hasParsedMentions: boolean
    hasMetadataMentions: boolean
  },
): void {
  activeLogger({
    ts: new Date().toISOString(),
    level: 'warn',
    event: 'send_reject',
    reason,
    caller_agent_id: ctx.callerAgentId,
    original_author: ctx.originalAuthor,
    original_id: ctx.originalId,
    has_parsed_mentions: ctx.hasParsedMentions,
    has_metadata_mentions: ctx.hasMetadataMentions,
  })
  incSendReject(reason)
}

/**
 * Build the final `sendMentions` list for the send-tool push routing.
 *
 * Core routing contract:
 *   - `mentions` contains already-resolved agent IDs selected from the
 *     DB-owned channel member list.
 *   - Chat-adapter tokens such as Discord `<@snowflake>` are display/input
 *     syntax only. They must be translated by the adapter before this helper
 *     is called and must never extend the core recipient list.
 */
export async function buildSendMentions(
  mentions: unknown,
  _content: string,
  _resolveDiscordIdToAgent?: (discordId: string) => Promise<string | null>,
): Promise<string[]> {
  const argAgentIds: string[] = Array.isArray(mentions) ? (mentions as string[]) : []
  return [...new Set(argAgentIds)]
}

/** Detect emergency messages (broadcast bypass: type=emergency or content starts with !stop) */
export function isEmergencyMessage(content: string, messageType: string): boolean {
  if (messageType === 'emergency') return true
  if (content.startsWith('!stop')) return true
  return false
}

/**
 * Unified routing function (§C2) — no DB reads/writes, no side effects.
 *
 * `sourceType` selects the guards:
 *   - `'inbound'` (default): called by the receiver when a message arrives
 *     from the Gateway. Requires a resolved non-human DB member sender.
 *   - `'send-tool'`: called by the MCP `send` tool before it does any DB
 *     writes.  Adds a sender-side `SENDER_NOT_A_MEMBER` check so a bot
 *     cannot fanout into channels it does not belong to.
 *   - `'cli'`: called by the CLI `notify` command.  Same sender guard as
 *     `send-tool`.
 *
 * Caller is responsible for:
 *   1. Resolving channel + loading agent info (before)
 *   2. DB save only after a successful sender decision
 *   3. Pushing to pushTargets (after)
 *   4. Sending human warning if noMentions && senderIsHuman (after)
 *   5. Returning an error to the sender if `senderViolation` is set
 */
export function routeMessage(
  msg: { authorAgentId: string | null; authorIsBot: boolean; content: string; mentions: string[]; messageType: string },
  channel: ChannelInfo,
  agents: AgentInfo[],
  sourceType: RouteSourceType = 'inbound',
): RouteResult {
  const pushTargets: string[] = []
  const dropTargets: Record<string, string> = {}
  const senderIsHuman = !msg.authorIsBot
  const noMentions = msg.mentions.length === 0
  const isEmergency = isEmergencyMessage(msg.content, msg.messageType)
  const isDm = channel.type === 'dm' || channel.channelId.startsWith('dm:')

  const logCtx = { senderAgentId: msg.authorAgentId, channelId: channel.channelId, messageId: null }

  if (!msg.authorAgentId) {
    emitRouteDrop('sender_identity_unresolved', '(unresolved)', logCtx)
    return {
      pushTargets: [],
      dropTargets: {},
      senderIsHuman,
      noMentions,
      senderViolation: 'SENDER_ID_UNRESOLVED',
    }
  }
  if (!channel.members.includes(msg.authorAgentId)) {
    emitRouteDrop('sender_not_a_member', msg.authorAgentId, logCtx)
    return {
      pushTargets: [],
      dropTargets: {},
      senderIsHuman,
      noMentions,
      senderViolation: 'SENDER_NOT_A_MEMBER',
    }
  }
  if (sourceType === 'inbound') {
    const senderAgent = agents.find((agent) => agent.agentId === msg.authorAgentId)
    if (!senderAgent) {
      emitRouteDrop('sender_identity_unresolved', msg.authorAgentId, logCtx)
      return {
        pushTargets: [],
        dropTargets: {},
        senderIsHuman,
        noMentions,
        senderViolation: 'SENDER_ID_UNRESOLVED',
      }
    }
    if (senderAgent.agentType === 'human') {
      emitRouteDrop('sender_human_not_allowed', msg.authorAgentId, logCtx)
      return {
        pushTargets: [],
        dropTargets: {},
        senderIsHuman,
        noMentions,
        senderViolation: 'SENDER_HUMAN_NOT_ALLOWED',
      }
    }
  }

  for (const agent of agents) {
    // Self-send prevention
    if (agent.agentId === msg.authorAgentId) continue

    // Human agents (e.g. CEO) have no LLM runtime and never consume
    // `message_queue`. Push targets are LLM-bound by definition; if we
    // leave humans in here, every bot reply to CEO inserts a queue row
    // that no one drains (observed 2026-05-24: 48 stale rows accreted
    // on `ceo`). Discord delivery still happens for humans via
    // `outbound_queue` — that path is independent of pushTargets.
    if (agent.agentType === 'human') {
      dropTargets[agent.agentId] = 'HUMAN_AGENT_NO_QUEUE'
      emitRouteDrop('human_agent_no_queue', agent.agentId, logCtx)
      continue
    }

    // Must be a channel member
    if (!channel.members.includes(agent.agentId)) {
      dropTargets[agent.agentId] = 'NOT_A_MEMBER'
      emitRouteDrop('channel_non_member', agent.agentId, logCtx)
      continue
    }

    // DM → always push
    if (isDm) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Emergency without explicit mentions is a broadcast bypass. If a caller
    // supplies concrete mentions, keep routing scoped to those targets.
    if (isEmergency && noMentions) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Observer mode → drop
    if (agent.observerMode) {
      dropTargets[agent.agentId] = 'OBSERVER_MODE'
      emitRouteDrop('observer_mode', agent.agentId, logCtx)
      continue
    }

    // CEO directive 2026-05-27: missing mention targets must alert instead of
    // silently falling through to channel.primary or legacy human fanout. The
    // adapter/router layer sends the human-visible alert when this returns no
    // pushTargets with noMentions=true.
    if (noMentions) {
      if (channel.primary != null) {
        const isPrimary = agent.agentId === channel.primary
        dropTargets[agent.agentId] = isPrimary ? 'MISSING_MENTION_TARGET' : 'NOT_PRIMARY_NO_MENTION'
        emitRouteDrop(isPrimary ? 'missing_mention_target' : 'not_primary_no_mention', agent.agentId, logCtx)
        continue
      }
      if (senderIsHuman) {
        dropTargets[agent.agentId] = 'MISSING_MENTION_TARGET'
        emitRouteDrop('missing_mention_target', agent.agentId, logCtx)
        continue
      }
    }

    // Group / broadcast mentions (@all, @everyone, @here, @dev, @org).
    // `@everyone` / `@here` are recognised as broadcast escape hatches per
    // #527 so users can still fanout intentionally when channel.primary is
    // set. Outbound bot sends still strip these via FORBIDDEN_PATTERNS in
    // server.ts; this only changes inbound interpretation.
    if (msg.mentions.includes('all') ||
        msg.mentions.includes('everyone') ||
        msg.mentions.includes('here') ||
        (msg.mentions.includes('dev') && agent.agentType === 'dev') ||
        (msg.mentions.includes('org') && agent.agentType === 'org')) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Individual mention. Mentions are core agent IDs only; adapter-level
    // external IDs must have been translated before entering routeMessage().
    if (msg.mentions.includes(agent.agentId)) {
      pushTargets.push(agent.agentId)
      continue
    }

    dropTargets[agent.agentId] = 'NOT_MENTIONED'
    emitRouteDrop('mention_not_in_array', agent.agentId, logCtx)
  }

  return { pushTargets, dropTargets, senderIsHuman, noMentions }
}

/**
 * Backwards-compatibility alias for the PR-A name. Forwards to
 * `routeMessage` with `sourceType: 'inbound'`. Scheduled for removal
 * after all callers migrate to `routeMessage` directly.
 */
export function routeInbound(
  msg: { authorAgentId: string | null; authorIsBot: boolean; content: string; mentions: string[]; messageType: string },
  channel: ChannelInfo,
  agents: AgentInfo[],
): RouteResult {
  return routeMessage(msg, channel, agents, 'inbound')
}
