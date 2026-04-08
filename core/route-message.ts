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

/** Parse @agent_id mentions from message content */
export function parseMentions(content: string): string[] {
  const mentions: string[] = []
  const regex = /@([a-zA-Z0-9_-]+)/g
  let match
  while ((match = regex.exec(content)) !== null) {
    mentions.push(match[1])
  }
  return [...new Set(mentions)]
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

  // §C2 sender-side guard: only applies to send-tool / cli. Inbound senders
  // are untrusted external parties (humans or other bots) and cannot be
  // blocked by this check — the receiver still accepts and records the
  // message, it just never gets pushed to any subscriber.
  if (sourceType !== 'inbound' && msg.authorAgentId) {
    if (!channel.members.includes(msg.authorAgentId)) {
      return {
        pushTargets: [],
        dropTargets: {},
        senderIsHuman,
        noMentions,
        senderViolation: 'SENDER_NOT_A_MEMBER',
      }
    }
  }

  for (const agent of agents) {
    // Self-send prevention
    if (agent.agentId === msg.authorAgentId) continue

    // Must be a channel member
    if (!channel.members.includes(agent.agentId)) {
      dropTargets[agent.agentId] = 'NOT_A_MEMBER'
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
    if (msg.mentions.includes(agent.agentId)) {
      pushTargets.push(agent.agentId)
      continue
    }

    // Not mentioned → drop
    dropTargets[agent.agentId] = 'NOT_MENTIONED'
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
