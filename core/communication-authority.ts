export const CHANNEL_COMMUNICATION_AUTHORITY = 'channels.members' as const
export const OUTBOUND_ALLOWLIST_COMPATIBILITY_STATUS = 'DEPRECATED_NON_AUTHORITATIVE' as const

export type CommunicationAuthorityVerdict = {
  ok: boolean
  authority: typeof CHANNEL_COMMUNICATION_AUTHORITY
  members: string[]
  violations: string[]
  outbound_allowlist_status: typeof OUTBOUND_ALLOWLIST_COMPATIBILITY_STATUS
}

function normalizedIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/**
 * Canonical channel communication authority.
 *
 * `channel_routing_policy.outbound_allowlist` intentionally is not accepted as
 * input: it remains compatibility/diagnostic data and cannot affect this
 * verdict. Sender, active owner, cc, and fyi identities all have to be members
 * of the channel.
 */
export function evaluateCommunicationAuthority(input: {
  sender: string
  recipients: readonly string[]
  members: readonly string[]
}): CommunicationAuthorityVerdict {
  const members = normalizedIds(input.members)
  const memberSet = new Set(members)
  const participants = normalizedIds([input.sender, ...input.recipients])
  const violations = participants.filter((agentId) => !memberSet.has(agentId))
  return {
    ok: violations.length === 0,
    authority: CHANNEL_COMMUNICATION_AUTHORITY,
    members,
    violations,
    outbound_allowlist_status: OUTBOUND_ALLOWLIST_COMPATIBILITY_STATUS,
  }
}

export type AutomaticProcessingBlockReason =
  | 'AGENT_NOT_ENROLLED'
  | 'AGENT_NOT_ENABLED'
  | 'RUNTIME_NOT_READY'
  | 'AGENT_NOT_CHANNEL_MEMBER'
  | 'AGENT_TYPE_HUMAN'

export type AutomaticProcessingEligibilityVerdict = {
  ok: boolean
  authority: 'db.agent_runtime_and_channels.members'
  reasons: AutomaticProcessingBlockReason[]
  host_allowlist_required: false
}

/** Canonical steady-state automatic-processing eligibility predicate. */
export function evaluateAutomaticProcessingEligibility(input: {
  enrolled: boolean
  enabled: boolean
  runtimeReady: boolean
  channelMember: boolean
  humanAgent: boolean
}): AutomaticProcessingEligibilityVerdict {
  const reasons: AutomaticProcessingBlockReason[] = []
  if (!input.enrolled) reasons.push('AGENT_NOT_ENROLLED')
  if (!input.enabled) reasons.push('AGENT_NOT_ENABLED')
  if (!input.runtimeReady) reasons.push('RUNTIME_NOT_READY')
  if (!input.channelMember) reasons.push('AGENT_NOT_CHANNEL_MEMBER')
  if (input.humanAgent) reasons.push('AGENT_TYPE_HUMAN')
  return {
    ok: reasons.length === 0,
    authority: 'db.agent_runtime_and_channels.members',
    reasons,
    host_allowlist_required: false,
  }
}
