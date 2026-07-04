import { randomUUID } from 'node:crypto'
import type { DbAdapter } from '../db'

export interface QueueWorkReservationPlanOptions {
  agentId?: string | null
  commit?: string | null
  messageId?: string | null
  fromAgentId?: string | null
  channelId?: string | null
  content?: string | null
  issueRef?: string | null
  priority?: string | number | null
  now?: () => Date
  newMessageId?: () => string
}

export interface QueueWorkReservationFinding {
  code: string
  message: string
  evidence?: Record<string, unknown>
}

export interface QueueWorkReservationOpenRow {
  queue_id: string
  agent_id: string
  message_id: string | null
  status: string
  created_at: string | null
  claimed_by: string | null
}

export interface QueueWorkReservationAgent {
  agent_id: string
  status: string | null
  runtime: string | null
  disabled_at: string | null
}

export interface QueueWorkReservationPlanReport {
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  generated_at: string
  issue_ref: string
  target: {
    agent_id: string | null
    commit: string | null
    runtime: 'codex-exec'
  }
  reservation: {
    message_id: string | null
    priority: number | null
    payload: Record<string, unknown> | null
    sql: {
      text: string
      params: unknown[]
    } | null
  }
  post_reservation: {
    expected_returning_fields: string[]
    verification_sql: Array<{ text: string; params: unknown[] }>
    activation_plan_command: string[]
    dry_run_before_execute: true
  }
  agent: QueueWorkReservationAgent | null
  open_rows: QueueWorkReservationOpenRow[]
  blockers: QueueWorkReservationFinding[]
  warnings: QueueWorkReservationFinding[]
  policy: {
    read_only: true
    no_db_mutation: true
    no_state_daemon_restart: true
    no_launchctl_mutation: true
    no_live_runner_enablement: true
    no_queue_drain: true
    no_discord_live_write: true
    reservation_requires_separate_approval: true
    execute_requires_separate_approval: true
  }
  mutation_performed: false
  restart_performed: false
}

type AgentRow = {
  agent_id: string
  status?: string | null
  runtime?: string | null
  disabled_at?: string | Date | null
}

type QueueRow = {
  id: string | number
  agent_id: string
  message_id?: string | null
  status: string
  created_at?: string | Date | null
  claimed_by?: string | null
}

const BLOCKING_QUEUE_STATUSES = ['pending', 'received', 'in_progress']
const DEFAULT_ISSUE_REF = '#722'
const DEFAULT_FROM_AGENT = 'agent-com-dev'
const DEFAULT_CHANNEL_ID = 'github:watchout/agent-comms-mcp/issues/722'
const DEFAULT_PRIORITY = 100

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeDate(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString()
  return trimOrNull(value ?? null)
}

function normalizeAgent(row: AgentRow): QueueWorkReservationAgent {
  return {
    agent_id: row.agent_id,
    status: trimOrNull(row.status ?? null),
    runtime: trimOrNull(row.runtime ?? null),
    disabled_at: normalizeDate(row.disabled_at),
  }
}

function normalizeQueueRow(row: QueueRow): QueueWorkReservationOpenRow {
  return {
    queue_id: String(row.id),
    agent_id: row.agent_id,
    message_id: trimOrNull(row.message_id ?? null),
    status: row.status,
    created_at: normalizeDate(row.created_at),
    claimed_by: trimOrNull(row.claimed_by ?? null),
  }
}

function parsePriority(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return DEFAULT_PRIORITY
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function defaultContent(issueRef: string): string {
  return `DB-primary queue-work scheduler canary for ${issueRef}. Reply is not required; scheduler finalization is the completion evidence.`
}

function buildPayload(input: {
  issueRef: string
  agentId: string
  messageId: string
  fromAgentId: string
  channelId: string
  content: string
}): Record<string, unknown> {
  return {
    source: 'state-daemon-queue-work-canary-reservation',
    issue: input.issueRef,
    author_id: input.fromAgentId,
    channel_id: input.channelId,
    content: input.content,
    message_type: 'instruction',
    message_id: input.messageId,
    reply_contract: {
      required: false,
      reason: 'DB-primary canary closes by queue-work scheduler finalization; no Discord reply is required.',
    },
    canary_contract: {
      target_agent_id: input.agentId,
      max_canary_count: 1,
      expected_lifecycle: ['pending', 'received', 'in_progress', 'done', 'replied'],
      completion_evidence: 'message_queue.replied terminal state for this exact queue_id/message_id',
      prohibited: [
        'fifo_drain',
        'prompt_driven_next',
        'prompt_driven_inbox',
        'automatic_retry_loop',
        'discord_live_write',
        'fleet_wide_activation',
      ],
    },
  }
}

function reservationSql(agentId: string, messageId: string, payload: Record<string, unknown>, priority: number) {
  return {
    text: [
      'WITH reservation AS (',
      '  INSERT INTO message_queue (agent_id, message_id, payload, status, priority)',
      "  VALUES ($1::text, $2::text, $3::text, 'pending', $4::int)",
      '  ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING',
      '  RETURNING id, agent_id, message_id, status, created_at',
      ')',
      'SELECT id AS queue_id, agent_id, message_id, status, created_at AS created_after',
      '  FROM reservation;',
    ].join('\n'),
    params: [agentId, messageId, JSON.stringify(payload), priority],
  }
}

function emptyReport(
  generatedAt: string,
  issueRef: string,
  options: QueueWorkReservationPlanOptions,
  blockers: QueueWorkReservationFinding[],
  warnings: QueueWorkReservationFinding[] = [],
): QueueWorkReservationPlanReport {
  return {
    ok: false,
    go_no_go: 'NO_GO',
    generated_at: generatedAt,
    issue_ref: issueRef,
    target: {
      agent_id: trimOrNull(options.agentId ?? null),
      commit: trimOrNull(options.commit ?? null),
      runtime: 'codex-exec',
    },
    reservation: {
      message_id: trimOrNull(options.messageId ?? null),
      priority: parsePriority(options.priority),
      payload: null,
      sql: null,
    },
    post_reservation: {
      expected_returning_fields: ['queue_id', 'agent_id', 'message_id', 'status', 'created_after'],
      verification_sql: [],
      activation_plan_command: [],
      dry_run_before_execute: true,
    },
    agent: null,
    open_rows: [],
    blockers,
    warnings,
    policy: {
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_live_runner_enablement: true,
      no_queue_drain: true,
      no_discord_live_write: true,
      reservation_requires_separate_approval: true,
      execute_requires_separate_approval: true,
    },
    mutation_performed: false,
    restart_performed: false,
  }
}

export async function buildQueueWorkReservationPlan(
  db: DbAdapter,
  options: QueueWorkReservationPlanOptions = {},
): Promise<QueueWorkReservationPlanReport> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString()
  const issueRef = trimOrNull(options.issueRef ?? null) ?? DEFAULT_ISSUE_REF
  const agentId = trimOrNull(options.agentId ?? null)
  const commit = trimOrNull(options.commit ?? null)
  const priority = parsePriority(options.priority)
  const blockers: QueueWorkReservationFinding[] = []
  const warnings: QueueWorkReservationFinding[] = []

  if (!agentId) {
    blockers.push({ code: 'agent_id_required', message: 'Queue-work row reservation planning requires --agent-id.' })
  } else if (!/^[A-Za-z0-9._:-]+$/.test(agentId)) {
    blockers.push({
      code: 'agent_id_invalid',
      message: '--agent-id must contain only letters, numbers, dot, underscore, colon, or hyphen.',
      evidence: { agent_id: agentId },
    })
  }
  if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) {
    blockers.push({ code: 'commit_required', message: 'Queue-work row reservation planning requires a 7-40 character git commit SHA.' })
  }
  if (priority === null) {
    blockers.push({
      code: 'priority_invalid',
      message: '--priority must be a zero-or-positive integer.',
      evidence: { priority: options.priority },
    })
  }
  if (blockers.length > 0 || !agentId || !commit || priority === null) {
    return emptyReport(generatedAt, issueRef, options, blockers, warnings)
  }

  const agentRows = await db.query<AgentRow>(
    `SELECT agent_id, status, runtime, disabled_at
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  )
  const agent = agentRows[0] ? normalizeAgent(agentRows[0]) : null
  if (!agent) {
    blockers.push({
      code: 'target_agent_not_found',
      message: `Agent ${agentId} was not found; row reservation must target a registered bot.`,
      evidence: { agent_id: agentId },
    })
  } else if (agent.disabled_at) {
    blockers.push({
      code: 'target_agent_disabled',
      message: `Agent ${agentId} is disabled; row reservation must target an enabled bot.`,
      evidence: { agent_id: agentId, disabled_at: agent.disabled_at },
    })
  }

  const openRows = (await db.query<QueueRow>(
    `SELECT id, agent_id, message_id, status, created_at, claimed_by
       FROM message_queue
      WHERE agent_id = $1
        AND status = ANY($2::text[])
      ORDER BY created_at ASC, id ASC
      LIMIT 10`,
    [agentId, BLOCKING_QUEUE_STATUSES],
  )).map(normalizeQueueRow)
  if (openRows.length > 0) {
    blockers.push({
      code: 'target_agent_has_open_queue_rows',
      message: `Agent ${agentId} already has claimable queue rows; reserve a fresh canary row only after residue policy or closure is approved.`,
      evidence: { count: openRows.length, queue_ids: openRows.map((row) => row.queue_id) },
    })
  }
  const doneResidueRows = (await db.query<QueueRow>(
    `SELECT id, agent_id, message_id, status, created_at, claimed_by
       FROM message_queue
      WHERE agent_id = $1
        AND status = 'done'
      ORDER BY created_at ASC, id ASC
      LIMIT 10`,
    [agentId],
  )).map(normalizeQueueRow)
  if (doneResidueRows.length > 0) {
    warnings.push({
      code: 'target_agent_has_done_residue_rows',
      message: 'Agent has done-state residue rows. They are not claimable by the exact queue-id canary runner, but must remain governed by residue policy before broader rollout.',
      evidence: { count: doneResidueRows.length, queue_ids: doneResidueRows.map((row) => row.queue_id) },
    })
  }

  const messageId = trimOrNull(options.messageId ?? null) ?? (options.newMessageId ?? randomUUID)()
  const duplicateRows = await db.query<QueueRow>(
    `SELECT id, agent_id, message_id, status, created_at, claimed_by
       FROM message_queue
      WHERE agent_id = $1
        AND message_id = $2
      LIMIT 1`,
    [agentId, messageId],
  )
  if (duplicateRows.length > 0) {
    blockers.push({
      code: 'message_id_already_reserved',
      message: 'The proposed message_id already exists for the target agent.',
      evidence: { agent_id: agentId, message_id: messageId, queue_id: String(duplicateRows[0].id) },
    })
  }

  const fromAgentId = trimOrNull(options.fromAgentId ?? null) ?? DEFAULT_FROM_AGENT
  const channelId = trimOrNull(options.channelId ?? null) ?? DEFAULT_CHANNEL_ID
  const content = trimOrNull(options.content ?? null) ?? defaultContent(issueRef)
  const payload = buildPayload({ issueRef, agentId, messageId, fromAgentId, channelId, content })
  const sql = reservationSql(agentId, messageId, payload, priority)
  const activationPlanCommand = [
    'bun',
    'cli/index.ts',
    'state-daemon',
    'queue-work-activation-plan',
    '--agent-id',
    agentId,
    '--queue-id',
    '<returned_queue_id>',
    '--commit',
    commit,
    '--runtime',
    'codex-exec',
    '--format',
    'json',
  ]
  const verificationSql = [
    {
      text: [
        'SELECT id AS queue_id, agent_id, message_id, status, created_at AS created_after',
        '  FROM message_queue',
        ' WHERE agent_id = $1',
        '   AND message_id = $2',
        ' LIMIT 1;',
      ].join('\n'),
      params: [agentId, messageId],
    },
    {
      text: [
        'SELECT id AS queue_id, status, claimed_by, claimed_at, claim_expires_at, done_at, replied_at, replied_with',
        '  FROM message_queue',
        ' WHERE agent_id = $1',
        '   AND message_id = $2',
        ' LIMIT 1;',
      ].join('\n'),
      params: [agentId, messageId],
    },
  ]

  return {
    ok: blockers.length === 0,
    go_no_go: blockers.length === 0 ? 'GO' : 'NO_GO',
    generated_at: generatedAt,
    issue_ref: issueRef,
    target: {
      agent_id: agentId,
      commit,
      runtime: 'codex-exec',
    },
    reservation: {
      message_id: messageId,
      priority,
      payload,
      sql,
    },
    post_reservation: {
      expected_returning_fields: ['queue_id', 'agent_id', 'message_id', 'status', 'created_after'],
      verification_sql: verificationSql,
      activation_plan_command: blockers.length === 0 ? activationPlanCommand : [],
      dry_run_before_execute: true,
    },
    agent,
    open_rows: openRows,
    blockers,
    warnings,
    policy: {
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_live_runner_enablement: true,
      no_queue_drain: true,
      no_discord_live_write: true,
      reservation_requires_separate_approval: true,
      execute_requires_separate_approval: true,
    },
    mutation_performed: false,
    restart_performed: false,
  }
}

export function formatQueueWorkReservationPlanText(report: QueueWorkReservationPlanReport): string {
  const lines = [
    `Queue-work reservation plan: ${report.go_no_go}`,
    `OK: ${report.ok}`,
    `Generated: ${report.generated_at}`,
    `Issue: ${report.issue_ref}`,
    `Target: agent=${report.target.agent_id ?? '(missing)'} commit=${report.target.commit ?? '(missing)'} runtime=${report.target.runtime}`,
    `Message id: ${report.reservation.message_id ?? '(none)'}`,
    `Priority: ${report.reservation.priority ?? '(invalid)'}`,
    `Mutation performed: ${report.mutation_performed}`,
    `Restart performed: ${report.restart_performed}`,
    `Reservation requires separate approval: ${report.policy.reservation_requires_separate_approval}`,
    `Execute requires separate approval: ${report.policy.execute_requires_separate_approval}`,
  ]
  if (report.blockers.length > 0) {
    lines.push('Blockers:')
    for (const blocker of report.blockers) lines.push(`- ${blocker.code}: ${blocker.message}`)
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of report.warnings) lines.push(`- ${warning.code}: ${warning.message}`)
  }
  if (report.open_rows.length > 0) {
    lines.push(`Open rows: ${report.open_rows.map((row) => `${row.queue_id}:${row.status}`).join(', ')}`)
  }
  if (report.post_reservation.activation_plan_command.length > 0) {
    lines.push(`Post-reservation activation-plan command: ${report.post_reservation.activation_plan_command.join(' ')}`)
  }
  return `${lines.join('\n')}\n`
}
