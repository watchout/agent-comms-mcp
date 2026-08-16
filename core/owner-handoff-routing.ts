import { getChannelPolicy, refreshChannelPolicyDbSnapshot } from './channel-policy'
import { evaluateCommunicationAuthority } from './communication-authority'

type QueryResult<T = any> = { rows: T[] } | T[]
type Queryable = {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>
}

export type OwnerHandoffDiagnosticStatus =
  | 'queued_owner'
  | 'relay_policy'
  | 'blocked_channel_membership'
  | 'handoff_only'
  | 'queue_evidence_mismatch'
  | 'unknown_channel'
  | 'not_channel_member'

export interface OwnerHandoffDiagnostic {
  ok: boolean
  status: OwnerHandoffDiagnosticStatus
  sender_agent_id: string
  intended_recipient_agent_id: string
  channel_id: string | null
  queue: {
    queue_id: number
    agent_id: string
    status: string
    message_id: string | null
    channel_id: string | null
  } | null
  handoff_evidence: {
    github_url: string | null
    source: 'metadata_or_flag'
  } | null
  relay_policy: {
    evidence_type: 'relay_policy' | 'owner_policy'
    policy_ref: string
    relay_agent_id: string | null
  } | null
  communication_authority: {
    sender: string
    intended_recipient: string
    channel_id: string
    authority: 'channels.members'
    members: string[]
    outbound_allowlist_status: 'DEPRECATED_NON_AUTHORITATIVE'
    violations: string[]
  } | null
  reason: string
}

interface OwnerHandoffDiagnosticInput {
  senderAgentId: string
  intendedRecipientAgentId: string
  queueId?: number | null
  channelId?: string | null
  githubHandoffUrl?: string | null
  metadata?: Record<string, unknown>
}

interface QueueEvidence {
  queue_id: number
  agent_id: string
  status: string
  message_id: string | null
  channel_id: string | null
}

interface RelayPolicyEvidence {
  evidence_type: 'relay_policy' | 'owner_policy'
  policy_ref: string
  relay_agent_id: string | null
}

function rowsOf<T>(result: QueryResult<T>): T[] {
  return Array.isArray(result) ? result : result.rows
}

function asLegacyQueryable(db: Queryable): { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> } {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
      return { rows: rowsOf<T>(await db.query<T>(sql, params)) }
    },
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseStringArray(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    }
  } catch {}
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function extractRelayPolicyEvidence(metadata: Record<string, unknown> | undefined): RelayPolicyEvidence | null {
  const ownerHandoff = metadata?.owner_handoff
  if (!ownerHandoff || typeof ownerHandoff !== 'object' || Array.isArray(ownerHandoff)) return null
  const data = ownerHandoff as Record<string, unknown>
  const evidenceType = stringValue(data.evidence_type)
  if (evidenceType !== 'relay_policy' && evidenceType !== 'owner_policy') return null
  const policyRef =
    stringValue(data.policy_ref) ??
    stringValue(data.policy) ??
    stringValue(data.reason)
  if (!policyRef) return null
  return {
    evidence_type: evidenceType,
    policy_ref: policyRef,
    relay_agent_id: stringValue(data.relay_agent_id),
  }
}

async function readQueueEvidence(db: Queryable, queueId: number): Promise<QueueEvidence | null> {
  const rows = rowsOf<any>(await db.query(
    `SELECT mq.id,
            mq.agent_id,
            mq.status,
            mq.message_id,
            mq.payload,
            am.channel_id AS message_channel_id
       FROM message_queue mq
       LEFT JOIN agent_messages am ON am.id::text = mq.message_id
      WHERE mq.id = $1`,
    [queueId],
  ))
  const row = rows[0]
  if (!row) return null
  const payload = parseJsonObject(row.payload)
  return {
    queue_id: Number(row.id),
    agent_id: String(row.agent_id),
    status: String(row.status),
    message_id: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    channel_id:
      stringValue(row.message_channel_id) ??
      stringValue(payload?.channel_id) ??
      null,
  }
}

async function buildCommunicationAuthorityDiagnostic(
  db: Queryable,
  senderAgentId: string,
  intendedRecipientAgentId: string,
  channelId: string,
): Promise<{
  missingChannel: boolean
  senderMember: boolean
  communication_authority: OwnerHandoffDiagnostic['communication_authority']
}> {
  const channelRows = rowsOf<any>(await db.query(`SELECT members FROM channels WHERE id = $1`, [channelId]))
  if (channelRows.length === 0) {
    return { missingChannel: true, senderMember: false, communication_authority: null }
  }

  const members = parseStringArray(channelRows[0].members) ?? []
  await refreshChannelPolicyDbSnapshot(asLegacyQueryable(db))
  const policy = getChannelPolicy(channelId)
  const verdict = evaluateCommunicationAuthority({
    sender: senderAgentId,
    recipients: [intendedRecipientAgentId],
    members,
  })

  return {
    missingChannel: false,
    senderMember: members.includes(senderAgentId),
    communication_authority: {
      sender: senderAgentId,
      intended_recipient: intendedRecipientAgentId,
      channel_id: channelId,
      authority: verdict.authority,
      members: verdict.members,
      outbound_allowlist_status: policy.outboundAllowlistStatus,
      violations: verdict.violations,
    },
  }
}

export async function buildOwnerHandoffDiagnostic(
  db: Queryable,
  input: OwnerHandoffDiagnosticInput,
): Promise<OwnerHandoffDiagnostic> {
  const queue = input.queueId ? await readQueueEvidence(db, input.queueId) : null
  const explicitChannelId = input.channelId ?? null
  const channelId = explicitChannelId ?? queue?.channel_id ?? null
  const handoffEvidence = input.githubHandoffUrl
    ? { github_url: input.githubHandoffUrl, source: 'metadata_or_flag' as const }
    : null
  const relayPolicy = extractRelayPolicyEvidence(input.metadata)

  const base = {
    sender_agent_id: input.senderAgentId,
    intended_recipient_agent_id: input.intendedRecipientAgentId,
    channel_id: channelId,
    queue,
    handoff_evidence: handoffEvidence,
    relay_policy: relayPolicy,
  }

  if (input.queueId && !queue) {
    return {
      ok: false,
      status: 'queue_evidence_mismatch',
      ...base,
      communication_authority: null,
      reason: `queue_id ${input.queueId} does not exist`,
    }
  }

  if (queue && queue.agent_id !== input.intendedRecipientAgentId) {
    return {
      ok: false,
      status: 'queue_evidence_mismatch',
      ...base,
      communication_authority: null,
      reason: `queue_id ${queue.queue_id} belongs to ${queue.agent_id}, not ${input.intendedRecipientAgentId}`,
    }
  }

  if (queue && explicitChannelId && queue.channel_id !== explicitChannelId) {
    return {
      ok: false,
      status: 'queue_evidence_mismatch',
      ...base,
      communication_authority: null,
      reason: `queue_id ${queue.queue_id} belongs to channel ${queue.channel_id ?? 'unknown'}, not ${explicitChannelId}`,
    }
  }

  let communicationAuthority: OwnerHandoffDiagnostic['communication_authority'] = null
  if (channelId) {
    const authorityDiagnostic = await buildCommunicationAuthorityDiagnostic(db, input.senderAgentId, input.intendedRecipientAgentId, channelId)
    communicationAuthority = authorityDiagnostic.communication_authority
    if (authorityDiagnostic.missingChannel) {
      return {
        ok: false,
        status: 'unknown_channel',
        ...base,
        communication_authority: communicationAuthority,
        reason: `channel ${channelId} not found`,
      }
    }
    if (!authorityDiagnostic.senderMember) {
      return {
        ok: false,
        status: 'not_channel_member',
        ...base,
        communication_authority: communicationAuthority,
        reason: `${input.senderAgentId} is not a member of channel ${channelId}`,
      }
    }
    if (communicationAuthority && communicationAuthority.violations.length > 0) {
      return {
        ok: false,
        status: 'blocked_channel_membership',
        ...base,
        communication_authority: communicationAuthority,
        reason: `${communicationAuthority.violations.join(',')} are not in channels.members`,
      }
    }
  }

  if (queue) {
    return {
      ok: true,
      status: 'queued_owner',
      ...base,
      communication_authority: communicationAuthority,
      reason: `message_queue row ${queue.queue_id} is addressed to ${input.intendedRecipientAgentId}`,
    }
  }

  if (relayPolicy) {
    return {
      ok: true,
      status: 'relay_policy',
      ...base,
      communication_authority: communicationAuthority,
      reason: `explicit ${relayPolicy.evidence_type} evidence supplied`,
    }
  }

  return {
    ok: false,
    status: 'handoff_only',
    ...base,
    communication_authority: communicationAuthority,
    reason: 'handoff metadata exists, but no message_queue row was created for the owner',
  }
}

export function ownerHandoffDiagnosticCode(diagnostic: OwnerHandoffDiagnostic): string {
  switch (diagnostic.status) {
    case 'blocked_channel_membership':
      return 'OWNER_HANDOFF_CHANNEL_MEMBERSHIP_VIOLATION'
    case 'queue_evidence_mismatch':
      return 'OWNER_HANDOFF_QUEUE_EVIDENCE_MISMATCH'
    case 'unknown_channel':
      return 'OWNER_HANDOFF_CHANNEL_NOT_FOUND'
    case 'not_channel_member':
      return 'OWNER_HANDOFF_NOT_CHANNEL_MEMBER'
    case 'handoff_only':
      return 'OWNER_HANDOFF_QUEUE_EVIDENCE_REQUIRED'
    default:
      return 'OWNER_HANDOFF_INVALID'
  }
}

export async function recordOwnerHandoffDiagnostic(
  db: Queryable,
  diagnostic: OwnerHandoffDiagnostic,
): Promise<void> {
  const eventType = diagnostic.status === 'blocked_channel_membership'
    ? 'owner_handoff.channel_membership_blocked'
    : 'owner_handoff.route_diagnostic'
  await db.query(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      eventType,
      diagnostic.sender_agent_id,
      diagnostic.intended_recipient_agent_id,
      JSON.stringify(diagnostic),
      'default',
    ],
  )
}
