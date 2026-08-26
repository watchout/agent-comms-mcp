export type QueueDoctorSeverity = 'blocker' | 'warning' | 'info'

export type QueueDoctorOptions = {
  agentId?: string | null
  staleSeconds?: number
}

export type QueueDoctorSample = {
  queue_id: string | number
  agent_id: string
  message_id: string | null
  status: string
  created_at: string | Date | null
  age_seconds: number
  author_id: string | null
  content: string | null
}

export type QueueDoctorFinding = {
  code: string
  severity: QueueDoctorSeverity
  title: string
  count: number
  sample_count: number
  sample_by_agent: Record<string, number>
  samples: QueueDoctorSample[]
  action: string
}

export type QueueDoctorReport = {
  ok: true
  generated_at: string
  scope: {
    agent_id: string | null
    stale_minutes: number
  }
  status_counts: Record<string, number>
  blockers: QueueDoctorFinding[]
  summary: {
    blocker_count: number
    warning_count: number
  }
}

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

const LOOP_NEXT_PROMPT_SQL = "payload_json.payload->>'content' LIKE 'Call the agent-comms next tool now. Do not call inbox.%'"
const LOOP_PROCESS_PROMPT_SQL = "payload_json.payload->>'content' LIKE 'Start processing the agent-comms message you just received. Call the agent-comms processing tool for its queue_id.%Do not call inbox or next.%'"

function groupSamples(rows: any[]): Pick<QueueDoctorFinding, 'count' | 'sample_count' | 'sample_by_agent' | 'samples'> {
  const sampleByAgent: Record<string, number> = {}
  const samples: QueueDoctorSample[] = []
  for (const row of rows) {
    sampleByAgent[row.agent_id] = (sampleByAgent[row.agent_id] ?? 0) + 1
    if (samples.length < 8) {
      samples.push({
        queue_id: row.id,
        agent_id: row.agent_id,
        message_id: row.message_id ?? null,
        status: row.status,
        created_at: row.created_at ?? null,
        age_seconds: Number(row.age_seconds ?? 0),
        author_id: row.author_id ?? null,
        content: row.content ?? null,
      })
    }
  }
  return {
    count: Number(rows[0]?.total_count ?? rows.length),
    sample_count: rows.length,
    sample_by_agent: sampleByAgent,
    samples,
  }
}

function finding(
  code: string,
  severity: QueueDoctorSeverity,
  title: string,
  rows: any[],
  action: string,
): QueueDoctorFinding {
  return {
    code,
    severity,
    title,
    ...groupSamples(rows),
    action,
  }
}

export async function buildQueueDoctorReport(db: Queryable, options: QueueDoctorOptions = {}): Promise<QueueDoctorReport> {
  const agentId = options.agentId ?? null
  const staleSeconds = Number.isFinite(options.staleSeconds) && (options.staleSeconds ?? 0) >= 0
    ? Number(options.staleSeconds)
    : 15 * 60
  const staleMinutes = Math.floor(staleSeconds / 60)
  const agentFilter = agentId ? ' AND mq.agent_id = $2' : ''
  const params = agentId ? [String(staleSeconds), agentId] : [String(staleSeconds)]
  const agentOnlyFilter = agentId ? ' AND mq.agent_id = $1' : ''
  const agentOnlyParams = agentId ? [agentId] : []

  const counts = await db.query(
    `SELECT status, count(*)::int AS count
       FROM message_queue mq
      WHERE 1=1${agentOnlyFilter}
      GROUP BY status
      ORDER BY status`,
    agentOnlyParams,
  )

  const baseSelect = `
    SELECT mq.id, mq.agent_id, mq.message_id, mq.status, mq.created_at, mq.claimed_by,
           mq.claimed_at, mq.claim_expires_at, mq.done_at,
           count(*) OVER ()::int AS total_count,
           extract(epoch from (now() - mq.created_at))::int AS age_seconds,
           payload_json.payload->>'author_id' AS author_id,
           left(coalesce(payload_json.payload->>'content', ''), 180) AS content,
           a.status AS agent_status,
           a.runtime AS agent_runtime,
           a.metadata AS agent_metadata,
           a.metadata->>'tmux_session' AS tmux_session,
           a.metadata->>'discord_id' AS discord_id,
           a.metadata->>'retired' AS retired
      FROM message_queue mq
      LEFT JOIN agents a ON a.agent_id = mq.agent_id
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN left(ltrim(mq.payload), 1) = '{' THEN mq.payload::jsonb
          ELSE '{}'::jsonb
        END AS payload
      ) payload_json
     WHERE 1=1`

  const legacyRows = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status IN ('read', 'skipped', 'failed')
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )
  const typedFailed = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status = 'failed'
       AND mq.failed_reason IN ('WAKE_INVOCATION_RETRY_EXHAUSTED', 'QUEUE_WORK_RUNNER_ERROR_RETRY_EXHAUSTED')
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )
  const stalePending = await db.query(
    `${baseSelect}
       ${agentFilter}
       AND mq.status = 'pending'
       AND mq.created_at < now() - ($1 || ' seconds')::interval
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    params,
  )
  const activeMissingOwner = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status IN ('received', 'in_progress')
       AND mq.claimed_by IS NULL
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )
  const expiredClaims = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status IN ('received', 'in_progress')
       AND mq.claim_expires_at IS NOT NULL
       AND mq.claim_expires_at < now()
     ORDER BY mq.claim_expires_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )
  const retiredOrOffline = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status = 'pending'
       AND (
         a.agent_id IS NULL
         OR a.metadata->>'retired' = 'true'
         OR a.status IN ('offline', 'disabled', 'disconnected')
       )
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )
  const tuiUnwakeable = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status = 'pending'
       AND a.runtime = 'TUI'
       AND coalesce(a.metadata->>'tmux_session', '') = ''
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )
  const ackSpam = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status = 'pending'
       AND payload_json.payload->>'content' LIKE 'ACK: received by %; queue_id=%'
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )
  const loopPromptBacklog = await db.query(
    `${baseSelect}
       ${agentOnlyFilter}
       AND mq.status IN ('pending', 'received', 'in_progress')
       AND (
         ${LOOP_NEXT_PROMPT_SQL}
         OR ${LOOP_PROCESS_PROMPT_SQL}
       )
     ORDER BY mq.created_at ASC
     LIMIT 50`,
    agentOnlyParams,
  )

  const outboundFilter = agentId
    ? ' AND coalesce(oq.consumer_agent_id, oq.agent_id) = $2'
    : ''
  const outboundRows = await db.query(
    `SELECT oq.id, oq.message_id, coalesce(oq.consumer_agent_id, oq.agent_id) AS agent_id,
            oq.status, oq.created_at,
            count(*) OVER ()::int AS total_count,
            extract(epoch from (now() - oq.created_at))::int AS age_seconds,
            oq.last_error,
            a.status AS agent_status,
            a.runtime AS agent_runtime,
            a.metadata->>'discord_id' AS discord_id,
            left(oq.content, 180) AS content
       FROM outbound_queue oq
       LEFT JOIN agents a ON a.agent_id = coalesce(oq.consumer_agent_id, oq.agent_id)
      WHERE oq.status = 'pending'
        AND oq.created_at < now() - ($1 || ' seconds')::interval
        ${outboundFilter}
      ORDER BY oq.created_at ASC
      LIMIT 50`,
    params,
  )

  const blockers = [
    finding(
      'legacy_status_mix',
      'warning',
      'message_queue still contains legacy terminal/active statuses',
      legacyRows.rows,
      'Finish or explicitly archive legacy read/skipped/failed rows before treating queue health as clean.',
    ),
    finding(
      'typed_failed_awaiting_repair',
      'blocker',
      'typed-failed rows awaiting repair (bounded delivery attempts exhausted)',
      typedFailed.rows,
      'Fix the underlying cause, then reopen with: agent-com queue requeue-failed --id <queue_id> --execute. The fleet is not healthy while typed-failed rows sit unrepaired.',
    ),
    finding(
      'stale_pending',
      'blocker',
      `pending rows older than ${staleMinutes} minutes`,
      stalePending.rows,
      'Explain each stale row with agent status, then either wake, migrate, reassign, or close it.',
    ),
    finding(
      'active_claim_missing_owner',
      'blocker',
      'active rows without claimed_by',
      activeMissingOwner.rows,
      'Repair or reclaim; received/in_progress rows must always have an owner.',
    ),
    finding(
      'expired_active_claim',
      'blocker',
      'received/in_progress rows past claim_expires_at',
      expiredClaims.rows,
      'Run deterministic reclaim or close; do not manually inject tmux work.',
    ),
    finding(
      'retired_or_offline_recipient',
      'blocker',
      'pending rows addressed to retired, disabled, offline, or missing agents',
      retiredOrOffline.rows,
      'Reassign to replacement identity or close as obsolete; retired agents must not keep active queue.',
    ),
    finding(
      'tui_without_tmux_session',
      'blocker',
      'pending TUI rows whose agent has no tmux_session metadata',
      tuiUnwakeable.rows,
      'Fix agent metadata or route the work to an identity with a managed consumer.',
    ),
    finding(
      'ack_spam_pending',
      'warning',
      'ACK/progress rows still pending',
      ackSpam.rows,
      'ACK/progress should be side-channel evidence or auto-closed system info, not operator-blocking work.',
    ),
    finding(
      'loop_prompt_backlog',
      'blocker',
      'natural-language next/process loop prompts still queued or active',
      loopPromptBacklog.rows,
      'Do not drain with next. Close each obsolete loop prompt by explicit queue_id; use --include-active only for the single active row being intentionally closed.',
    ),
    finding(
      'outbound_pending_stale',
      'blocker',
      `outbound_queue pending rows older than ${staleMinutes} minutes`,
      outboundRows.rows,
      'Start the responsible consumer or re-project the row; Discord projection is not complete until sent or failed.',
    ),
  ]

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    scope: {
      agent_id: agentId,
      stale_minutes: staleMinutes,
    },
    status_counts: counts.rows.reduce((acc: Record<string, number>, row: any) => {
      acc[row.status] = Number(row.count)
      return acc
    }, {}),
    blockers,
    summary: {
      blocker_count: blockers.filter((b) => b.severity === 'blocker' && b.count > 0).length,
      warning_count: blockers.filter((b) => b.severity === 'warning' && b.count > 0).length,
    },
  }
}

export function formatQueueDoctorText(report: QueueDoctorReport): string {
  const lines = [
    'Queue Doctor',
    `Scope: ${report.scope.agent_id ?? 'all agents'} / stale>${report.scope.stale_minutes}m`,
    '',
    'Status counts:',
    ...Object.entries(report.status_counts).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'Findings:',
    ...report.blockers
      .filter((b) => b.count > 0)
      .map((b) => `  [${b.severity}] ${b.code}: ${b.count} (${Object.keys(b.sample_by_agent).join(', ') || 'n/a'})`),
  ]
  return `${lines.join('\n')}\n`
}
