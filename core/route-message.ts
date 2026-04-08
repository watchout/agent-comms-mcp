/**
 * core/route-message.ts — pure routing functions
 *
 * Extracted from server.ts as part of ADR-041 implementation step 1/2 (PR-A).
 * No DB calls, no side effects. The receiver process (PR-B) and the existing
 * daemon both import from this module so the channel-membership / mention
 * decisions are computed by a single implementation.
 *
 * Behavioural contract: identical to the in-server.ts function before this
 * extraction. PR-A is a pure refactor — see tests/inbound-router.test.ts
 * for the source-level regression checks that protect against drift.
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
}

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
 * Pure routing function (§5.1) — no DB reads/writes, no side effects.
 * Caller is responsible for:
 *   1. Resolving channel + loading agent info (before)
 *   2. DB save (before or after, always)
 *   3. Pushing to pushTargets (after)
 *   4. Sending human warning if noMentions && senderIsHuman (after)
 */
export function routeInbound(
  msg: { authorAgentId: string | null; authorIsBot: boolean; content: string; mentions: string[]; messageType: string },
  channel: ChannelInfo,
  agents: AgentInfo[],
): RouteResult {
  const pushTargets: string[] = []
  const dropTargets: Record<string, string> = {}
  const senderIsHuman = !msg.authorIsBot
  const noMentions = msg.mentions.length === 0
  const isEmergency = isEmergencyMessage(msg.content, msg.messageType)
  const isDm = channel.type === 'dm' || channel.channelId.startsWith('dm:')

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

    // Not mentioned → drop
    dropTargets[agent.agentId] = 'NOT_MENTIONED'
  }

  return { pushTargets, dropTargets, senderIsHuman, noMentions }
}
