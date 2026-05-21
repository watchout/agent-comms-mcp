import { buildQueueDoctorReport, type QueueDoctorFinding, type QueueDoctorReport } from './queue-doctor'

export type QueueNormalizationStepStatus = 'clean' | 'ready' | 'needs_decision' | 'policy_required'

export type QueueNormalizationStep = {
  code: string
  status: QueueNormalizationStepStatus
  severity: 'blocker' | 'warning' | 'info'
  title: string
  candidate_count: number
  sample_count: number
  sample_by_agent: Record<string, number>
  sample_queue_ids: Array<string | number>
  dry_run_command: string | null
  execute_command: string | null
  approval_required: boolean
  estimated_operator_time: string
  next_action: string
}

export type QueueNormalizationReport = {
  ok: true
  generated_at: string
  scope: QueueDoctorReport['scope']
  health: {
    inbound_runtime_clean: boolean
    projection_clean: boolean
    legacy_clean: boolean
    overall_clean: boolean
  }
  status_counts: QueueDoctorReport['status_counts']
  doctor_summary: QueueDoctorReport['summary']
  steps: QueueNormalizationStep[]
}

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

const INBOUND_RUNTIME_BLOCKERS = [
  'stale_pending',
  'active_claim_missing_owner',
  'expired_active_claim',
  'retired_or_offline_recipient',
  'tui_without_tmux_session',
] as const

function findingByCode(report: QueueDoctorReport): Record<string, QueueDoctorFinding> {
  return Object.fromEntries(report.blockers.map((finding) => [finding.code, finding]))
}

function emptyFinding(code: string): QueueDoctorFinding {
  return {
    code,
    severity: 'info',
    title: code,
    count: 0,
    sample_count: 0,
    sample_by_agent: {},
    samples: [],
    action: '',
  }
}

function firstSample(finding: QueueDoctorFinding) {
  return finding.samples[0] ?? null
}

function sampleQueueIds(finding: QueueDoctorFinding): Array<string | number> {
  return finding.samples.map((sample) => sample.queue_id)
}

function agentScopeArg(report: QueueDoctorReport): string {
  return report.scope.agent_id ? ` --agent-id ${report.scope.agent_id}` : ''
}

function singleQueueCloseCommands(
  finding: QueueDoctorFinding,
  reason: string,
): Pick<QueueNormalizationStep, 'dry_run_command' | 'execute_command'> {
  const sample = firstSample(finding)
  if (!sample) return { dry_run_command: null, execute_command: null }
  const base = `agent-com queue close-obsolete --agent-id ${sample.agent_id} --queue-id ${sample.queue_id} --reason "${reason}"`
  return {
    dry_run_command: `${base} --dry-run`,
    execute_command: `${base} --execute`,
  }
}

function stepFromFinding(
  finding: QueueDoctorFinding,
  input: {
    status: QueueNormalizationStepStatus
    title: string
    dryRunCommand?: string | null
    executeCommand?: string | null
    approvalRequired?: boolean
    estimatedOperatorTime: string
    nextAction: string
  },
): QueueNormalizationStep {
  const hasCandidates = finding.count > 0
  return {
    code: finding.code,
    status: hasCandidates ? input.status : 'clean',
    severity: finding.severity,
    title: input.title,
    candidate_count: finding.count,
    sample_count: finding.sample_count,
    sample_by_agent: finding.sample_by_agent,
    sample_queue_ids: sampleQueueIds(finding),
    dry_run_command: hasCandidates ? input.dryRunCommand ?? null : null,
    execute_command: hasCandidates ? input.executeCommand ?? null : null,
    approval_required: hasCandidates ? input.approvalRequired ?? true : false,
    estimated_operator_time: hasCandidates ? input.estimatedOperatorTime : '0m',
    next_action: hasCandidates ? input.nextAction : 'No action needed.',
  }
}

function outboundCommands(finding: QueueDoctorFinding): Pick<QueueNormalizationStep, 'dry_run_command' | 'execute_command'> {
  const sample = firstSample(finding)
  const messageId = sample?.message_id
  if (!messageId) {
    return {
      dry_run_command: 'agent-com diagnose-queue --format json',
      execute_command: null,
    }
  }
  return {
    dry_run_command: `agent-com diagnose-delivery --outbound-message-id ${messageId}`,
    execute_command: null,
  }
}

export function deriveQueueNormalizationReport(report: QueueDoctorReport): QueueNormalizationReport {
  const byCode = findingByCode(report)
  const get = (code: string) => byCode[code] ?? emptyFinding(code)

  const expired = get('expired_active_claim')
  const reclaimCommand = `agent-com queue reclaim-expired${agentScopeArg(report)}`
  const ackClose = singleQueueCloseCommands(
    get('ack_spam_pending'),
    'ACK/progress evidence is non-actionable',
  )
  const staleClose = singleQueueCloseCommands(
    get('stale_pending'),
    'obsolete after evidence review',
  )
  const outbound = outboundCommands(get('outbound_pending_stale'))

  const steps: QueueNormalizationStep[] = [
    stepFromFinding(expired, {
      status: 'ready',
      title: 'Reclaim expired active claims',
      dryRunCommand: `${reclaimCommand} --dry-run`,
      executeCommand: `${reclaimCommand} --execute`,
      estimatedOperatorTime: '10-20m',
      nextAction: 'Run the dry-run, then execute if every row is an expired claim and not active work.',
    }),
    stepFromFinding(get('active_claim_missing_owner'), {
      status: 'needs_decision',
      title: 'Repair active rows with no claim owner',
      dryRunCommand: 'agent-com diagnose-queue --format json',
      executeCommand: null,
      estimatedOperatorTime: '15-30m',
      nextAction: 'Inspect each active row; reclaim or close only with an explicit queue id.',
    }),
    stepFromFinding(get('stale_pending'), {
      status: 'needs_decision',
      title: 'Classify stale pending rows',
      dryRunCommand: staleClose.dry_run_command,
      executeCommand: staleClose.execute_command,
      estimatedOperatorTime: '10-30m',
      nextAction: 'For each stale row, decide wake, reassign, or close-obsolete. Use queue-id scoped commands.',
    }),
    stepFromFinding(get('retired_or_offline_recipient'), {
      status: 'needs_decision',
      title: 'Drain retired or offline recipients',
      dryRunCommand: 'agent-com diagnose-queue --format json',
      executeCommand: null,
      estimatedOperatorTime: '15-45m',
      nextAction: 'Decide whether the recipient has a replacement identity; reassign if yes, close obsolete if not.',
    }),
    stepFromFinding(get('tui_without_tmux_session'), {
      status: 'needs_decision',
      title: 'Fix unwakeable TUI recipients',
      dryRunCommand: 'agent-com diagnose-queue --format json',
      executeCommand: null,
      estimatedOperatorTime: '15-45m',
      nextAction: 'Fix tmux metadata or route the work to a managed identity before closing anything.',
    }),
    stepFromFinding(get('ack_spam_pending'), {
      status: 'ready',
      title: 'Close non-actionable ACK/progress rows',
      dryRunCommand: ackClose.dry_run_command,
      executeCommand: ackClose.execute_command,
      estimatedOperatorTime: '10-20m',
      nextAction: 'Close only ACK/progress rows that are already represented as evidence elsewhere.',
    }),
    stepFromFinding(get('outbound_pending_stale'), {
      status: 'needs_decision',
      title: 'Classify stale outbound projection rows',
      dryRunCommand: outbound.dry_run_command,
      executeCommand: outbound.execute_command,
      estimatedOperatorTime: '1-2h',
      nextAction: 'Group by consumer/projection evidence; re-project display-worthy rows and mark obsolete status rows only after review.',
    }),
    stepFromFinding(get('legacy_status_mix'), {
      status: 'policy_required',
      title: 'Archive or normalize legacy terminal rows',
      dryRunCommand: 'agent-com diagnose-queue --format json',
      executeCommand: null,
      estimatedOperatorTime: '0.5-1d',
      nextAction: 'Write a terminal-state archive policy before mutating historical read/skipped/failed rows.',
    }),
  ]

  const inboundRuntimeClean = INBOUND_RUNTIME_BLOCKERS.every((code) => get(code).count === 0)
  const projectionClean = get('outbound_pending_stale').count === 0
  const legacyClean = get('legacy_status_mix').count === 0 && get('ack_spam_pending').count === 0

  return {
    ok: true,
    generated_at: report.generated_at,
    scope: report.scope,
    health: {
      inbound_runtime_clean: inboundRuntimeClean,
      projection_clean: projectionClean,
      legacy_clean: legacyClean,
      overall_clean: inboundRuntimeClean && projectionClean && legacyClean,
    },
    status_counts: report.status_counts,
    doctor_summary: report.summary,
    steps,
  }
}

export async function buildQueueNormalizationReport(
  db: Queryable,
  options: { agentId?: string | null; staleSeconds?: number } = {},
): Promise<QueueNormalizationReport> {
  const doctor = await buildQueueDoctorReport(db, options)
  return deriveQueueNormalizationReport(doctor)
}

export function formatQueueNormalizationText(report: QueueNormalizationReport): string {
  const lines = [
    'Queue Normalization',
    `Scope: ${report.scope.agent_id ?? 'all agents'} / stale>${report.scope.stale_minutes}m`,
    `Health: inbound=${report.health.inbound_runtime_clean ? 'clean' : 'dirty'} projection=${report.health.projection_clean ? 'clean' : 'dirty'} legacy=${report.health.legacy_clean ? 'clean' : 'dirty'}`,
    '',
    'Steps:',
  ]
  for (const step of report.steps.filter((item) => item.candidate_count > 0)) {
    lines.push(`  [${step.status}] ${step.code}: ${step.candidate_count} (${step.estimated_operator_time})`)
    lines.push(`    next: ${step.next_action}`)
    if (step.dry_run_command) lines.push(`    dry-run: ${step.dry_run_command}`)
    if (step.execute_command) lines.push(`    execute: ${step.execute_command}`)
  }
  if (report.steps.every((step) => step.candidate_count === 0)) {
    lines.push('  clean: no normalization candidates found')
  }
  return `${lines.join('\n')}\n`
}
