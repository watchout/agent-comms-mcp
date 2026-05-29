import { getChannelPolicy } from './channel-policy'

type QueryResult<T = any> = { rows: T[] } | T[]
type Queryable = {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>
}

export interface OutboundAclViolationDetail {
  operation: 'send' | 'notify'
  sender: string
  intended_recipients: string[]
  channel_id: string
  violated_policy: 'channel.outboundAllowlist'
  outbound_allowlist: string[] | null
  policy_source: string
  violations: string[]
}

function rowsOf<T>(result: QueryResult<T>): T[] {
  return Array.isArray(result) ? result : result.rows
}

async function readPolicySource(db: Queryable, channelId: string, fallbackPolicySource: string): Promise<string> {
  try {
    const rows = rowsOf<any>(await db.query(
      `SELECT policy_source FROM channel_routing_policy WHERE channel_id = $1`,
      [channelId],
    ))
    const source = rows[0]?.policy_source
    if (typeof source === 'string' && source.trim().length > 0) return source.trim()
  } catch {}
  return fallbackPolicySource
}

export async function buildOutboundAclViolationDetail(
  db: Queryable,
  operation: 'send' | 'notify',
  sender: string,
  channelId: string,
  intendedRecipients: string[],
  violations: string[],
): Promise<OutboundAclViolationDetail> {
  const policy = getChannelPolicy(channelId)
  return {
    operation,
    sender,
    intended_recipients: intendedRecipients,
    channel_id: channelId,
    violated_policy: 'channel.outboundAllowlist',
    outbound_allowlist: policy.outboundAllowlist,
    policy_source: await readPolicySource(db, channelId, policy.policySource),
    violations,
  }
}

export async function recordOutboundAclViolation(
  db: Queryable,
  detail: OutboundAclViolationDetail,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      'outbound.acl_violation',
      detail.sender,
      detail.channel_id,
      JSON.stringify(detail),
      'default',
    ],
  )
}

export function formatOutboundAclViolation(detail: OutboundAclViolationDetail): string {
  return `sender ${detail.sender} or recipients ${detail.violations.join(',')} violate channel.outboundAllowlist; allowlist=${JSON.stringify(detail.outbound_allowlist)} policy_source=${detail.policy_source}`
}
