export type RoutingDecision = 'deliver_only' | 'wake_agent' | 'require_human' | 'block'

export type RouteReason =
  | 'direct_mention'
  | 'explicit_command'
  | 'actionable_message_type'
  | 'channel_policy'
  | 'author_is_self'
  | 'non_actionable_type'
  | 'disabled_agent'
  | 'missing_mention_binding'
  | 'unsupported_runtime'

export interface QueueRoutingDecisionInput {
  target_agent_id: string
  target_runtime?: string | null
  target_status?: string | null
  target_profile_enabled?: boolean | null
  target_disabled_at?: string | null
  target_discord_id?: string | null
  message_type: string
  source?: string | null
  content?: string | null
  author_id?: string | null
  mentions?: string[]
  channel_policy?: {
    policy_source?: string | null
    primary_agent_id?: string | null
    adapter_owner_agent_id?: string | null
  } | null
}

export interface QueueRoutingDecisionEvidence {
  routing_decision: RoutingDecision
  route_reason: RouteReason
  message_type: string
  source: string | null
  target_agent_id: string
  target_runtime: string | null
  target_profile_enabled: boolean | null
  target_status: string | null
  has_target_discord_binding: boolean
  direct_mention_evidence: {
    matched: boolean
    source: 'metadata' | 'content' | null
    matched_value: string | null
  }
  author_identity: {
    author_id: string | null
    self_authored: boolean
  }
  channel_policy: {
    policy_source: string | null
    primary_agent_id: string | null
    adapter_owner_agent_id: string | null
  } | null
  llm_classification_used: false
}

const ACTIONABLE_TYPES = new Set(['instruction', 'request', 'question'])
const NON_ACTION_TYPES = new Set(['report', 'chat', 'notice', 'projection'])
const RUNTIME_MANAGED_TYPES = new Set(['codex', 'codex-runner', 'claude', 'claude-code', 'tui'])

function normalize(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedLower(value: string | null | undefined): string | null {
  const raw = normalize(value)
  return raw ? raw.toLowerCase() : null
}

function hasDiscordMention(content: string | null | undefined, discordId: string): boolean {
  const raw = normalize(content)
  if (!raw) return false
  return raw.includes(`<@${discordId}>`) || raw.includes(`<@!${discordId}>`)
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(normalize).filter((value): value is string => !!value))]
}

function directMentionEvidence(input: QueueRoutingDecisionInput): QueueRoutingDecisionEvidence['direct_mention_evidence'] {
  const targetAgentId = normalize(input.target_agent_id)
  const targetDiscordId = normalize(input.target_discord_id)
  const mentions = uniqueStrings(input.mentions ?? [])
  if (targetDiscordId && mentions.includes(targetDiscordId)) {
    return { matched: true, source: 'metadata', matched_value: targetDiscordId }
  }
  if (targetDiscordId && hasDiscordMention(input.content, targetDiscordId)) {
    return { matched: true, source: 'content', matched_value: targetDiscordId }
  }
  if (!isDiscordOrigin(input) && targetAgentId && mentions.includes(targetAgentId)) {
    return { matched: true, source: 'metadata', matched_value: targetAgentId }
  }
  return { matched: false, source: null, matched_value: null }
}

function isSelfAuthored(input: QueueRoutingDecisionInput): boolean {
  const author = normalize(input.author_id)
  if (!author) return false
  return author === normalize(input.target_agent_id) || author === normalize(input.target_discord_id)
}

function isDisabled(input: QueueRoutingDecisionInput): boolean {
  const status = normalizedLower(input.target_status)
  return input.target_profile_enabled === false ||
    !!normalize(input.target_disabled_at) ||
    status === 'disabled' ||
    status === 'retired'
}

function isDiscordOrigin(input: QueueRoutingDecisionInput): boolean {
  const source = normalizedLower(input.source)
  return source === 'discord'
}

function isRuntimeManaged(input: QueueRoutingDecisionInput): boolean {
  const runtime = normalizedLower(input.target_runtime)
  return !!runtime && RUNTIME_MANAGED_TYPES.has(runtime)
}

function baseEvidence(
  input: QueueRoutingDecisionInput,
  routing_decision: RoutingDecision,
  route_reason: RouteReason,
  mentionEvidence: QueueRoutingDecisionEvidence['direct_mention_evidence'],
  selfAuthored: boolean,
): QueueRoutingDecisionEvidence {
  return {
    routing_decision,
    route_reason,
    message_type: normalize(input.message_type) ?? 'unknown',
    source: normalize(input.source),
    target_agent_id: normalize(input.target_agent_id) ?? '',
    target_runtime: normalize(input.target_runtime),
    target_profile_enabled: input.target_profile_enabled ?? null,
    target_status: normalize(input.target_status),
    has_target_discord_binding: !!normalize(input.target_discord_id),
    direct_mention_evidence: mentionEvidence,
    author_identity: {
      author_id: normalize(input.author_id),
      self_authored: selfAuthored,
    },
    channel_policy: input.channel_policy
      ? {
          policy_source: normalize(input.channel_policy.policy_source),
          primary_agent_id: normalize(input.channel_policy.primary_agent_id),
          adapter_owner_agent_id: normalize(input.channel_policy.adapter_owner_agent_id),
        }
      : null,
    llm_classification_used: false,
  }
}

export function decideQueueRouting(input: QueueRoutingDecisionInput): QueueRoutingDecisionEvidence {
  const mentionEvidence = directMentionEvidence(input)
  const selfAuthored = isSelfAuthored(input)
  const messageType = normalize(input.message_type) ?? 'unknown'

  if (isDisabled(input)) {
    return baseEvidence(input, 'block', 'disabled_agent', mentionEvidence, selfAuthored)
  }
  if (selfAuthored) {
    return baseEvidence(input, 'block', 'author_is_self', mentionEvidence, selfAuthored)
  }
  if (ACTIONABLE_TYPES.has(messageType)) {
    return baseEvidence(input, 'wake_agent', 'actionable_message_type', mentionEvidence, selfAuthored)
  }
  if (messageType === 'chat' && isDiscordOrigin(input)) {
    if (!normalize(input.target_discord_id)) {
      return baseEvidence(input, 'deliver_only', 'missing_mention_binding', mentionEvidence, selfAuthored)
    }
    if (mentionEvidence.matched) {
      if (!isRuntimeManaged(input)) {
        return baseEvidence(input, 'block', 'unsupported_runtime', mentionEvidence, selfAuthored)
      }
      return baseEvidence(input, 'wake_agent', 'direct_mention', mentionEvidence, selfAuthored)
    }
  }
  if (NON_ACTION_TYPES.has(messageType)) {
    return baseEvidence(input, 'deliver_only', 'non_actionable_type', mentionEvidence, selfAuthored)
  }
  return baseEvidence(input, 'deliver_only', 'non_actionable_type', mentionEvidence, selfAuthored)
}
