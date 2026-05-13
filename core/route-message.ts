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
 * Behavioural contract for the `inbound` branch is byte-for-byte
 * identical to PR-A's `routeInbound`. The `send-tool` and `cli` branches
 * add a sender-side guard (`SENDER_NOT_A_MEMBER`) so bots cannot fanout
 * into channels they don't belong to. See tests/inbound-router.test.ts
 * and tests/inbound-mentions-filter.test.ts for the source-level
 * regression checks that protect against drift.
 *
 * Backwards compat: `routeInbound` is still exported as an alias that
 * forwards to `routeMessage({sourceType: 'inbound'})`. Planned removal
 * after PR-B consumers migrate.
 */

export interface AgentInfo {
  agentId: string
  agentType: string
  observerMode: boolean
  // ADR-040 D7: the Discord user ID this agent owns, if any. routeInbound
  // matches mentions against both `agentId` and `discordId` so a human
  // writing `<@1487367645933211699>` (raw Discord) still reaches the bot
  // whose agent_id is `agent-com-dev`. Populated by `loadAgentInfo`.
  discordId?: string | null
}

export interface ChannelInfo {
  channelId: string
  threadId?: string | null
  members: string[]
  type?: string  // 'dm' etc.
}

export interface RouteResult {
  pushTargets: string[]
  dropTargets: Record<string, string>  // agentId → reason
  senderIsHuman: boolean
  noMentions: boolean  // true when mentions array is empty (Pattern A)
  senderViolation?: string  // set when the sender itself is blocked (send-tool / cli only)
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
  if (typeof content !== 'string' || content.length === 0) return []
  const mentions: string[] = []
  const regex = /@([a-zA-Z0-9_-]+)/g
  let match
  try {
    while ((match = regex.exec(content)) !== null) {
      const captured = match[1]
      if (!captured) continue
      if (/^\d+$/.test(captured)) continue
      mentions.push(captured)
    }
  } catch {
    return []
  }
  return [...new Set(mentions)]
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
  | 'discord_id_unresolved'
  | 'sender_not_a_member'

/** Reject taxonomy emitted by send / reply guards (route-message-db.ts). */
export type SendRejectReason =
  | 'not_mentioned_in_original'
  | 'claim_expired'
  | 'claim_missing'

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
 * Option A union (Issue #103, fix for silent push failures):
 *   - `mentions` arg (agent IDs) are included directly
 *   - `<@discord_id>` patterns in content are resolved to agent IDs via
 *     the `resolveDiscordIdToAgent` callback and added to the union
 *   - `@agent_id` native patterns in content are also included
 *   - All three sources are deduplicated
 *
 * The resolver callback is injected so this function stays pure and
 * testable without a real DB connection.
 */
export async function buildSendMentions(
  mentions: unknown,
  content: string,
  resolveDiscordIdToAgent: (discordId: string) => Promise<string | null>,
): Promise<string[]> {
  // 1. Agent IDs from the explicit mentions argument
  const argAgentIds: string[] = Array.isArray(mentions) ? (mentions as string[]) : []

  // 2. Agent IDs resolved from <@discord_id> patterns in content
  const discordIds = (content.match(/<@!?(\d+)>/g) ?? [])
    .map(m => m.replace(/<@!?(\d+)>/, '$1'))
  const resolvedFromContent = (
    await Promise.all(discordIds.map(did => resolveDiscordIdToAgent(did).catch(() => null)))
  ).filter((s): s is string => s !== null)

  // Union, dedup
  // Note: parseMentions(content) is intentionally excluded here — its regex
  // matches numeric discord IDs (e.g. <@1485…> → "1485…") as if they were
  // native @agent_id handles, causing false duplicates in the output.
  // Callers that need @agent_id-native extraction should handle it separately.
  return [...new Set([...argAgentIds, ...resolvedFromContent])]
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
 *     from the Gateway.  Matches the old `routeInbound` behaviour exactly.
 *   - `'send-tool'`: called by the MCP `send` tool before it does any DB
 *     writes.  Adds a sender-side `SENDER_NOT_A_MEMBER` check so a bot
 *     cannot fanout into channels it does not belong to.
 *   - `'cli'`: called by the CLI `notify` command.  Same sender guard as
 *     `send-tool`.
 *
 * Caller is responsible for:
 *   1. Resolving channel + loading agent info (before)
 *   2. DB save (before or after, always)
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

  // §C2 sender-side guard: only applies to send-tool / cli. Inbound senders
  // are untrusted external parties (humans or other bots) and cannot be
  // blocked by this check — the receiver still accepts and records the
  // message, it just never gets pushed to any subscriber.
  if (sourceType !== 'inbound' && msg.authorAgentId) {
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
  }

  // Issue #351 A4 detection helper: did the message reference any raw
  // Discord snowflakes? If yes and a recipient's discordId is null in the
  // agents row, the recipient is silently lost to a discord_id_unresolved
  // drop (vs the regular mention_not_in_array drop where the bot's
  // discord_id exists but simply isn't listed).
  const rawDiscordIdsInMentions = msg.mentions.filter((m) => /^\d{6,}$/.test(m))
  const contentHasDiscordSnowflake = /<@!?\d{6,}>/.test(msg.content)

  for (const agent of agents) {
    // Self-send prevention
    if (agent.agentId === msg.authorAgentId) continue

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

    // Emergency → always push (only mentions bypass, §5.1)
    if (isEmergency) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Observer mode → drop
    if (agent.observerMode) {
      dropTargets[agent.agentId] = 'OBSERVER_MODE'
      emitRouteDrop('observer_mode', agent.agentId, logCtx)
      continue
    }

    // Issue #278 (B) — CEO bypass routing. When a human author posts a
    // message with no explicit mentions, every (non-observer, non-self)
    // bot member of the channel is treated as a push target. The CEO
    // routinely posts directives without listing every bot by name; the
    // legacy NOT_MENTIONED drop made those messages invisible to the
    // fleet. DM channels are excluded by the early-return above
    // (always push). Emergencies are also handled above. Auto-skip
    // patterns are applied at queue INSERT (Stage A, #276-A) so they
    // do not need to be re-checked here.
    if (senderIsHuman && noMentions) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Group mentions (@all, @dev, @org)
    if (msg.mentions.includes('all') ||
        (msg.mentions.includes('dev') && agent.agentType === 'dev') ||
        (msg.mentions.includes('org') && agent.agentType === 'org')) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Individual mention
    // ADR-040 D7: match mentions against BOTH the agent_id and the Discord
    // user ID. extractDiscordMentions normally resolves `<@discord_id>` →
    // `agent_id` before we get here, but if the resolver ever returns null
    // (e.g. because metadata.discord_id was briefly wiped by the D8 bug
    // and not yet self-registered), the raw Discord user ID is still in
    // `msg.mentions` and the bot should still count as mentioned.
    if (
      msg.mentions.includes(agent.agentId) ||
      (agent.discordId != null && msg.mentions.includes(agent.discordId))
    ) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Not mentioned → drop.
    //
    // Issue #351 A3/A4 split: if the original message carried raw Discord
    // snowflakes (or msg.mentions contains them) and this agent's
    // discord_id is null on the agents row, the failure mode is the
    // "metadata.discord_id unresolved" path (A4) — distinct from the
    // ordinary "your agent_id just wasn't listed" path (A3). The receiver
    // caller uses the `discord_id_unresolved` signal to trigger a 2nd-
    // attempt DB lookup before giving up.
    dropTargets[agent.agentId] = 'NOT_MENTIONED'
    if (agent.discordId == null && (rawDiscordIdsInMentions.length > 0 || contentHasDiscordSnowflake)) {
      emitRouteDrop('discord_id_unresolved', agent.agentId, logCtx)
    } else {
      emitRouteDrop('mention_not_in_array', agent.agentId, logCtx)
    }
  }

  return { pushTargets, dropTargets, senderIsHuman, noMentions }
}

/**
 * Issue #351 A4 2nd-attempt — re-evaluate `discord_id_unresolved` drops
 * after a fresh agent → discord_id DB lookup.
 *
 * routeMessage stays signature-pure (sync, no I/O). This wrapper takes the
 * routeMessage result + agent list and, for each recipient dropped with
 * `discord_id_unresolved`, calls `resolveDiscordId(agentId)` to refresh
 * the bot's discord_id. On a successful re-resolve, if msg.mentions
 * contains the resolved id, the agent is moved from dropTargets to
 * pushTargets. Every retry (success and failure) is logged.
 *
 * Caller is responsible for injecting a DB-backed resolver (typically
 * `(id) => getAgentDiscordId(db, id)`). When `db` is unavailable the
 * caller should pass a resolver returning null, which makes this wrapper
 * a no-op (the original drop stands).
 */
export async function applyDiscordIdRetry(
  result: RouteResult,
  msg: { authorAgentId: string | null; mentions: string[] },
  channel: { channelId: string },
  resolveDiscordId: (agentId: string) => Promise<string | null>,
  agents?: AgentInfo[],
): Promise<RouteResult> {
  // When the caller provides the agent list, only retry agents whose
  // cached discordId was null at routeMessage time (true A4 path). Without
  // the list, retry every NOT_MENTIONED drop — slower but still correct.
  const a4Candidates = agents
    ? new Set(agents.filter((a) => a.discordId == null).map((a) => a.agentId))
    : null
  const retryCandidates = Object.entries(result.dropTargets)
    .filter(([id, reason]) => reason === 'NOT_MENTIONED' && (a4Candidates ? a4Candidates.has(id) : true))

  if (retryCandidates.length === 0) return result

  const logCtx = { senderAgentId: msg.authorAgentId, channelId: channel.channelId, messageId: null }
  const newPush = [...result.pushTargets]
  const newDrop = { ...result.dropTargets }

  for (const [agentId] of retryCandidates) {
    let resolved: string | null = null
    try {
      resolved = await resolveDiscordId(agentId)
    } catch {
      resolved = null
    }
    if (resolved && msg.mentions.includes(resolved)) {
      newPush.push(agentId)
      delete newDrop[agentId]
      activeLogger({
        ts: new Date().toISOString(),
        level: 'warn',
        event: 'route_drop',
        reason: 'discord_id_unresolved',
        recipient_agent_id: agentId,
        sender_agent_id: logCtx.senderAgentId,
        channel_id: logCtx.channelId,
        message_id: null,
      })
      // Counter stays incremented from the initial routeMessage drop; the
      // 2nd-attempt recovery itself is captured via a separate counter so
      // operators can quantify how often the fallback fires.
      const recoveryKey = counterKey('route_message_discord_id_retry_total', { result: 'recovered' })
      counters.set(recoveryKey, (counters.get(recoveryKey) ?? 0) + 1)
    } else {
      const failKey = counterKey('route_message_discord_id_retry_total', { result: 'unresolved' })
      counters.set(failKey, (counters.get(failKey) ?? 0) + 1)
    }
  }

  return { ...result, pushTargets: newPush, dropTargets: newDrop }
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
