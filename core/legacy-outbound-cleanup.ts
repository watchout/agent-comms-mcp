export const LEGACY_OUTBOUND_OBSOLETE_REASON = 'LEGACY_PRE_411_UNPROJECTED_OBSOLETE'
export const LEGACY_OUTBOUND_BACKFILL_REASON = 'LEGACY_PRE_411_BACKFILL_CONSUMER_AGENT_ID'

export type LegacyOutboundAction = 'backfill_consumer' | 'mark_obsolete' | 'manual_review'

export interface LegacyOutboundCandidate {
  id: string | number
  message_id: string
  agent_id: string
  consumer_agent_id: string | null
  channel_external_id: string
  status: string
  attempts: number
  max_attempts: number
  last_error: string | null
  created_at: string | Date
  content: string
}

export interface LegacyOutboundCleanupOptions {
  adapterOwner: string
  channelExternalId: string
  backfillMessageIds?: ReadonlySet<string>
  obsoleteMessageIds?: ReadonlySet<string>
}

export interface LegacyOutboundClassification {
  action: LegacyOutboundAction
  reason: string
  consumer_agent_id: string | null
}

const OBSOLETE_PATTERNS: RegExp[] = [
  /^ACK:/i,
  /\bpost-merge received\b/i,
  /\bpost-restart result accepted\b/i,
  /\bPASS received and recorded\b/i,
  /\bResult accepted as partial PASS\b/i,
  /\b#411 PASS noted\b/i,
  /\bpost-merge verification complete\b/i,
]

function isBoundedLegacyCandidate(row: LegacyOutboundCandidate, channelExternalId: string): boolean {
  return row.consumer_agent_id == null
    && row.status === 'pending'
    && row.attempts === 0
    && row.channel_external_id === channelExternalId
}

export function classifyLegacyOutboundCandidate(
  row: LegacyOutboundCandidate,
  opts: LegacyOutboundCleanupOptions,
): LegacyOutboundClassification {
  if (!isBoundedLegacyCandidate(row, opts.channelExternalId)) {
    return {
      action: 'manual_review',
      reason: 'not_bounded_legacy_candidate',
      consumer_agent_id: row.consumer_agent_id,
    }
  }

  if (opts.obsoleteMessageIds?.has(row.message_id)) {
    return {
      action: 'mark_obsolete',
      reason: `${LEGACY_OUTBOUND_OBSOLETE_REASON}:explicit_message_id`,
      consumer_agent_id: null,
    }
  }

  if (opts.backfillMessageIds?.has(row.message_id)) {
    return {
      action: 'backfill_consumer',
      reason: `${LEGACY_OUTBOUND_BACKFILL_REASON}:explicit_message_id`,
      consumer_agent_id: opts.adapterOwner,
    }
  }

  const text = row.content.trim()
  const matched = OBSOLETE_PATTERNS.find(pattern => pattern.test(text))
  if (matched) {
    return {
      action: 'mark_obsolete',
      reason: `${LEGACY_OUTBOUND_OBSOLETE_REASON}:pattern:${matched.source}`,
      consumer_agent_id: null,
    }
  }

  return {
    action: 'manual_review',
    reason: 'requires_operator_classification',
    consumer_agent_id: null,
  }
}

export function summarizeLegacyOutboundClassifications(
  classifications: readonly LegacyOutboundClassification[],
): Record<LegacyOutboundAction, number> {
  return classifications.reduce<Record<LegacyOutboundAction, number>>(
    (acc, item) => {
      acc[item.action] += 1
      return acc
    },
    { backfill_consumer: 0, mark_obsolete: 0, manual_review: 0 },
  )
}
