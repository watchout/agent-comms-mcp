export type TerminalBatonQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>

export type TerminalBatonDecisionCode = 'TERMINAL_BATON_REQUIRED'

export type TerminalBatonDecision =
  | {
      allowed: true
      reason:
        | 'queue_missing'
        | 'internal_unbacked'
        | 'source_missing'
        | 'bot_or_internal_source'
        | 'explicit_no_reply_required'
        | 'baton_forwarded'
      details: Record<string, unknown>
    }
  | {
      allowed: false
      code: TerminalBatonDecisionCode
      reason: 'human_source_requires_reply_or_baton'
      details: Record<string, unknown>
    }

type QueueSourceRow = {
  id: string | number
  agent_id: string
  message_id: string | null
  payload: unknown
  source_message_id: string | null
  reply_to: string | null
  author_id: string | null
  author_bot: boolean | number | null
  message_metadata: unknown
}

type MessageAncestryRow = {
  message_id: string
  reply_to: string | null
  author_id: string | null
  author_bot: boolean | number | null
  message_metadata: unknown
}

type AgentRow = {
  agent_id: string
  agent_type: string
  metadata: unknown
}

type BatonRow = {
  message_id: string
  recipient_agent_id: string
  queue_status: string
}

const ACCEPTED_BATON_QUEUE_STATUSES = new Set([
  'pending',
  'read',
  'received',
  'in_progress',
  'done',
  'replied',
])

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1' || value === 'yes'
}

export function hasExplicitNoReplyRequiredFlag(...sources: unknown[]): boolean {
  for (const source of sources) {
    const record = asRecord(source)
    if (
      isTruthyFlag(record.no_reply_required)
      || isTruthyFlag(record.internal_no_reply_required)
      || isTruthyFlag(record.aun_no_reply_required)
    ) {
      return true
    }

    const aun = asRecord(record.aun)
    if (isTruthyFlag(aun.no_reply_required)) return true

    const terminalBaton = asRecord(record.terminal_baton)
    if (
      isTruthyFlag(terminalBaton.no_reply_required)
      || isTruthyFlag(terminalBaton.allow_done)
    ) {
      return true
    }
  }
  return false
}

function agentMetadataDiscordId(agent: AgentRow): string | null {
  const metadata = asRecord(agent.metadata)
  const discordId = metadata.discord_id
  return typeof discordId === 'string' && discordId.length > 0 ? discordId : null
}

function resolveAuthorAgent(authorId: string, agents: AgentRow[]): AgentRow | null {
  return agents.find((agent) => agent.agent_id === authorId)
    ?? agents.find((agent) => agentMetadataDiscordId(agent) === authorId)
    ?? null
}

function isHumanAuthoredMessage(row: Pick<MessageAncestryRow, 'author_id' | 'author_bot'>, agents: AgentRow[]): boolean {
  if (row.author_bot === false || row.author_bot === 0) return true
  const author = row.author_id ? resolveAuthorAgent(row.author_id, agents) : null
  return author?.agent_type === 'human'
}

async function fetchMessageAncestry(
  query: TerminalBatonQuery,
  row: QueueSourceRow,
): Promise<MessageAncestryRow[]> {
  const ancestry: MessageAncestryRow[] = [{
    message_id: row.source_message_id!,
    reply_to: row.reply_to,
    author_id: row.author_id,
    author_bot: row.author_bot,
    message_metadata: row.message_metadata,
  }]
  const seen = new Set([row.source_message_id!])
  let nextParent = row.reply_to
  while (nextParent && !seen.has(nextParent) && ancestry.length < 20) {
    seen.add(nextParent)
    const parentRows = await query<MessageAncestryRow>(
      `SELECT id::text AS message_id,
              reply_to::text AS reply_to,
              author_id,
              author_bot,
              metadata AS message_metadata
         FROM agent_messages
        WHERE id::text = $1
        LIMIT 1`,
      [nextParent],
    )
    const parent = parentRows[0]
    if (!parent) break
    ancestry.push(parent)
    nextParent = parent.reply_to
  }
  return ancestry
}

function isNonHumanRecipient(agentId: string, agents: AgentRow[]): boolean {
  const agent = agents.find((candidate) => candidate.agent_id === agentId)
  return agent?.agent_type !== 'human'
}

function decisionDetails(
  row: Partial<QueueSourceRow>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    queue_id: row.id === undefined ? null : String(row.id),
    agent_id: row.agent_id ?? null,
    message_id: row.message_id ?? null,
    source_message_id: row.source_message_id ?? null,
    author_id: row.author_id ?? null,
    ...extra,
  }
}

export async function evaluateDoneTransition(
  query: TerminalBatonQuery,
  opts: { queueId: string | number; agentId: string },
): Promise<TerminalBatonDecision> {
  const rows = await query<QueueSourceRow>(
    `SELECT mq.id,
            mq.agent_id,
            mq.message_id,
            mq.payload,
            am.id::text AS source_message_id,
            am.reply_to::text AS reply_to,
            am.author_id,
            am.author_bot,
            am.metadata AS message_metadata
       FROM message_queue mq
       LEFT JOIN agent_messages am ON am.id::text = mq.message_id
      WHERE mq.id = $1
      LIMIT 1`,
    [opts.queueId],
  )
  const row = rows[0]
  if (!row) {
    return { allowed: true, reason: 'queue_missing', details: { queue_id: String(opts.queueId) } }
  }
  if (!row.message_id) {
    return { allowed: true, reason: 'internal_unbacked', details: decisionDetails(row) }
  }
  if (!row.source_message_id || !row.author_id) {
    return { allowed: true, reason: 'source_missing', details: decisionDetails(row) }
  }

  const agents = await query<AgentRow>(
    `SELECT agent_id, agent_type, metadata FROM agents`,
  )
  const ancestry = await fetchMessageAncestry(query, row)
  const humanRoot = ancestry.find((message) => isHumanAuthoredMessage(message, agents))
  if (!humanRoot) {
    return { allowed: true, reason: 'bot_or_internal_source', details: decisionDetails(row) }
  }

  if (hasExplicitNoReplyRequiredFlag(row.payload, row.message_metadata)) {
    return { allowed: true, reason: 'explicit_no_reply_required', details: decisionDetails(row) }
  }

  const batonRows = await query<BatonRow>(
    `SELECT child.id::text AS message_id,
            child_mq.agent_id AS recipient_agent_id,
            child_mq.status AS queue_status
       FROM agent_messages child
       JOIN message_queue child_mq ON child_mq.message_id = child.id::text
      WHERE child.reply_to::text = $1
        AND child.author_id = $2
      ORDER BY child.created_at DESC
      LIMIT 50`,
    [row.source_message_id, opts.agentId],
  )
  const baton = batonRows.find((candidate) =>
    ACCEPTED_BATON_QUEUE_STATUSES.has(candidate.queue_status)
    && isNonHumanRecipient(candidate.recipient_agent_id, agents)
  )
  if (baton) {
    return {
      allowed: true,
      reason: 'baton_forwarded',
      details: decisionDetails(row, {
        baton_message_id: baton.message_id,
        baton_recipient_agent_id: baton.recipient_agent_id,
        baton_queue_status: baton.queue_status,
      }),
    }
  }

  return {
    allowed: false,
    code: 'TERMINAL_BATON_REQUIRED',
    reason: 'human_source_requires_reply_or_baton',
    details: decisionDetails(row, {
      human_root_message_id: humanRoot.message_id,
      human_root_author_id: humanRoot.author_id,
    }),
  }
}

export function formatDoneTransitionRejection(decision: TerminalBatonDecision): string {
  if (decision.allowed) return ''
  return `Error [${decision.code}]: human-rooted queue rows cannot be closed with bare done; send a reply to the requester, forward a durable AUN baton to another bot, or mark the row with explicit no_reply_required metadata. details=${JSON.stringify(decision.details)}`
}
