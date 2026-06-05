import type { DbAdapter } from './db'

type InboundSmokeStatus = 'pass' | 'incomplete' | 'blocked'

type InboundSmokeOptions = {
  provider?: string
  windowHours?: number
  bindingRole?: string | null
}

export type InboundSmokeQueueRow = {
  agent_id: string
  status: string
  count: number
}

export type InboundSmokeChannel = {
  channel_id: string
  name: string | null
  external_id: string | null
  adapter_owner_agent_id: string | null
  member_count: number
  latest_message_id: string | null
  latest_created_at: string | null
  latest_author_id: string | null
  latest_discord_message_id: string | null
  input_mentions: string[]
  queue_rows: InboundSmokeQueueRow[]
  bot_authored_duplicate_count: number | null
  status: InboundSmokeStatus
  blockers: string[]
  warnings: string[]
}

export type InboundSmokeReport = {
  ok: true
  generated_at: string
  policy: {
    read_only: true
    db_evidence_required: true
    smoke_requires: string[]
  }
  options: {
    provider: string
    window_hours: number
    binding_role: string | null
  }
  summary: {
    target_channels: number
    passed: number
    incomplete: number
    blocked: number
    blocker_count: number
  }
  channels: InboundSmokeChannel[]
  blockers: string[]
  warnings: string[]
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > 0 ? text : null
}

function asCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function asStringArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed.slice(1, -1).split(',').map((entry) => entry.trim()).filter(Boolean)
    }
    return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean)
  }
  return []
}

function timestampString(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function classifyChannel(blockers: string[], warnings: string[]): InboundSmokeStatus {
  if (blockers.length > 0) return 'blocked'
  if (warnings.length > 0) return 'incomplete'
  return 'pass'
}

async function queryTargetChannels(db: DbAdapter, provider: string, bindingRole: string | null): Promise<any[]> {
  const bindingRoleSql = bindingRole ? 'AND b.binding_role = $2' : ''
  const params = bindingRole ? [provider, bindingRole] : [provider]
  return await db.query(
    `SELECT c.id AS channel_id, c.name, c.members, ca.external_id, p.adapter_owner_agent_id
       FROM channels c
       JOIN channel_adapters ca
         ON ca.channel_id = c.id
        AND ca.platform = $1
       LEFT JOIN channel_routing_policy p
         ON p.channel_id = c.id
      WHERE EXISTS (
        SELECT 1
          FROM channel_connector_bindings b
         WHERE b.channel_id = c.id
           AND b.provider = $1
           AND b.status = 'active'
           ${bindingRoleSql}
      )
      ORDER BY c.name, c.id`,
    params,
  )
}

async function queryLatestInbound(db: DbAdapter, channelId: string, provider: string, cutoff: string): Promise<any | null> {
  return await db.queryOne(
    `SELECT id, channel_id, author_id, author_bot, discord_message_id, input_mentions, created_at
       FROM agent_messages
      WHERE channel_id = $1
        AND source = $2
        AND direction = 'inbound'
        AND created_at >= $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [channelId, provider, cutoff],
  )
}

async function queryQueueRows(db: DbAdapter, messageId: string): Promise<InboundSmokeQueueRow[]> {
  const rows = await db.query(
    `SELECT agent_id, status, COUNT(*) AS count
       FROM message_queue
      WHERE message_id = $1
      GROUP BY agent_id, status
      ORDER BY agent_id, status`,
    [messageId],
  )
  return rows.map((row: any) => ({
    agent_id: String(row.agent_id),
    status: String(row.status),
    count: asCount(row.count),
  }))
}

async function queryBotDuplicateCount(db: DbAdapter, channelId: string, provider: string, cutoff: string): Promise<number | null> {
  try {
    const row = await db.queryOne(
      `SELECT COALESCE(SUM(duplicate_rows.row_count), 0) AS count
         FROM (
           SELECT COUNT(*) AS row_count
             FROM agent_messages am
            WHERE am.channel_id = $1
              AND am.source = $2
              AND am.direction = 'inbound'
              AND COALESCE(am.author_bot, false) = true
              AND am.created_at >= $3
              AND am.discord_message_id IS NOT NULL
              AND am.discord_message_id <> ''
            GROUP BY am.discord_message_id
           HAVING COUNT(*) > 1
         ) duplicate_rows`,
      [channelId, provider, cutoff],
    )
    return asCount((row as any)?.count)
  } catch {
    return null
  }
}

export async function buildInboundSmokeReport(
  db: DbAdapter,
  options: InboundSmokeOptions = {},
): Promise<InboundSmokeReport> {
  const provider = options.provider ?? 'discord'
  const windowHours = options.windowHours ?? 168
  const bindingRole = options.bindingRole === undefined ? null : options.bindingRole
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const targets = await queryTargetChannels(db, provider, bindingRole)

  const channels: InboundSmokeChannel[] = []
  for (const target of targets) {
    const channelId = String(target.channel_id)
    const members = asStringArray(target.members)
    const latest = await queryLatestInbound(db, channelId, provider, cutoff)
    const inputMentions = asStringArray(latest?.input_mentions)
    const invalidMentions = inputMentions.filter((agentId) => !members.includes(agentId))
    const queueRows = latest?.id ? await queryQueueRows(db, String(latest.id)) : []
    const queuedAgentIds = new Set(queueRows.map((row) => row.agent_id))
    const botDuplicateCount = await queryBotDuplicateCount(db, channelId, provider, cutoff)
    const blockers: string[] = []
    const warnings: string[] = []

    if (!latest) warnings.push('discord_inbound_not_observed_in_window')
    if (latest && inputMentions.length === 0) warnings.push('mention_resolution_not_observed')
    if (latest && queueRows.length === 0) warnings.push('message_queue_enqueue_not_observed')
    if (invalidMentions.length > 0) blockers.push(`input_mentions_not_channel_members:${invalidMentions.join(',')}`)
    if (inputMentions.length > 0) {
      const missingMentionQueues = inputMentions.filter((agentId) => !queuedAgentIds.has(agentId))
      const unexpectedQueueRows = [...queuedAgentIds].filter((agentId) => !inputMentions.includes(agentId))
      if (missingMentionQueues.length > 0) blockers.push(`mentioned_recipient_not_enqueued:${missingMentionQueues.join(',')}`)
      if (unexpectedQueueRows.length > 0) blockers.push(`unexpected_enqueued_recipient:${unexpectedQueueRows.join(',')}`)
    }
    if (botDuplicateCount === null) warnings.push('bot_duplicate_query_unavailable')
    else if (botDuplicateCount > 0) blockers.push(`bot_authored_duplicate_rows:${botDuplicateCount}`)

    channels.push({
      channel_id: channelId,
      name: asString(target.name),
      external_id: asString(target.external_id),
      adapter_owner_agent_id: asString(target.adapter_owner_agent_id),
      member_count: members.length,
      latest_message_id: latest?.id ? String(latest.id) : null,
      latest_created_at: timestampString(latest?.created_at),
      latest_author_id: asString(latest?.author_id),
      latest_discord_message_id: asString(latest?.discord_message_id),
      input_mentions: inputMentions,
      queue_rows: queueRows,
      bot_authored_duplicate_count: botDuplicateCount,
      status: classifyChannel(blockers, warnings),
      blockers,
      warnings,
    })
  }

  const blockers = channels.flatMap((channel) => channel.blockers.map((blocker) => `${channel.name ?? channel.channel_id}:${blocker}`))
  const warnings: string[] = []
  if (channels.length === 0) warnings.push('no_target_channels')
  const passed = channels.filter((channel) => channel.status === 'pass').length
  const blocked = channels.filter((channel) => channel.status === 'blocked').length
  const incomplete = channels.filter((channel) => channel.status === 'incomplete').length

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    policy: {
      read_only: true,
      db_evidence_required: true,
      smoke_requires: [
        'agent_messages.source=discord',
        'agent_messages.direction=inbound',
        'channel_id matches target channel',
        'input_mentions resolved to channel members',
        'message_queue rows exist for routed recipients',
        'bot-authored duplicate rows are absent',
      ],
    },
    options: {
      provider,
      window_hours: windowHours,
      binding_role: bindingRole,
    },
    summary: {
      target_channels: channels.length,
      passed,
      incomplete,
      blocked,
      blocker_count: blockers.length,
    },
    channels,
    blockers,
    warnings,
  }
}

export function formatInboundSmokeText(report: InboundSmokeReport): string {
  const lines = [
    'Inbound Smoke Evidence',
    `Generated: ${report.generated_at}`,
    `Targets: ${report.summary.target_channels} pass=${report.summary.passed} incomplete=${report.summary.incomplete} blocked=${report.summary.blocked}`,
    `Window: ${report.options.window_hours}h provider=${report.options.provider} binding_role=${report.options.binding_role ?? 'any-active'}`,
    '',
  ]
  for (const channel of report.channels) {
    const name = channel.name ?? channel.channel_id
    const latest = channel.latest_message_id ? `${channel.latest_message_id} @ ${channel.latest_created_at ?? 'unknown'}` : 'none'
    const queue = channel.queue_rows.map((row) => `${row.agent_id}:${row.status}(${row.count})`).join(', ') || 'none'
    const notes = [...channel.blockers, ...channel.warnings].join(', ') || 'ok'
    lines.push(`- ${name}: ${channel.status} latest=${latest} mentions=${channel.input_mentions.join(',') || 'none'} queue=${queue} notes=${notes}`)
  }
  if (report.blockers.length > 0) {
    lines.push('', 'Blockers:')
    for (const blocker of report.blockers) lines.push(`- ${blocker}`)
  }
  return `${lines.join('\n')}\n`
}
