import type {
  RecoveryProjectionReadiness,
  RecoveryReadinessReport,
  RecoveryReadinessScope,
} from './recovery-readiness'

export type RecoveryActivationPlanBlockerCode =
  | 'READINESS_REPORT_REQUIRED'
  | 'READINESS_REPORT_NO_GO'
  | 'READINESS_SCOPE_MISMATCH'
  | 'ACTIVATION_SCOPE_REQUIRED'

export type RecoveryActivationPlanBlocker = {
  code: RecoveryActivationPlanBlockerCode
  subject_type: 'readiness_report' | 'activation_scope'
  subject_id: string | null
  evidence: Record<string, unknown>
}

export type RecoveryActivationPhaseCode =
  | 'cp70_preflight_evidence_check'
  | 'state_daemon_launchagent_readiness_check'
  | 'queue_receive_process_canary_plan'
  | 'completion_outcome_evidence_plan'
  | 'discord_projection_evidence_plan'
  | 'audit_evidence_plan'
  | 'rollback_trigger_list'

export type RecoveryActivationRequiredEvidence = {
  cp70: {
    failed_blocker_codes: string[]
    expected_failed_blocker_codes: []
    scope_agent_ids: string[]
  }
  launchagent: {
    label: string | null
    plist_path: string | null
    program: string | null
    script: string | null
    working_directory: string | null
    loaded: boolean | null
    running: boolean | null
    fatal_stderr_fingerprint: string | null
  }
  queue_canary: {
    canary_first_only: true
    agent_ids: string[]
    baseline_pending_backlog_total: number
    baseline_stale_active_queue_ids: Array<string | number>
    baseline_duplicate_active_queue_ids: Array<string | number>
    future_queue_ids_required: true
    max_canary_count: 1
  }
  discord_projection: Array<{
    name: string
    channel_id: string
    sender_agent_id: string
    recipient_agent_ids: string[]
    expected_consumer_agent_id: string | null
    expected_consumer_source: string | null
    actual_consumer_agent_id: string | null
    actual_consumer_source: string | null
    connector_instance_id: string | null
    channel_binding_id: string | null
    provider_channel_access_id: string | null
    expected_no_aun_router_fallback: true
    forbidden_consumer_sources: string[]
    delivery_fallback_reason: string | null
  }>
  audit_events: string[]
}

export type RecoveryActivationRollbackTrigger = {
  code:
    | 'FIFO_DRAIN_DETECTED'
    | 'LOOP_PROMPT_DETECTED'
    | 'DUPLICATE_ACTIVE_WORK'
    | 'PROJECTION_FALLBACK_UNEXPECTED'
    | 'SEND_FAILURE_IS_PROJECTION_FAILURE'
    | 'STATE_DAEMON_WRONG_PATH_OR_AGENT_ID'
    | 'DISCORD_CREDENTIAL_OR_WRITE_EVIDENCE_MISSING'
  severity: 'stop'
  evidence_required: string[]
}

export type RecoveryActivationPhase = {
  order: number
  code: RecoveryActivationPhaseCode
  title: string
  execution_allowed: false
  canary_first_only: true
  required_evidence_keys: string[]
  notes: string[]
}

export type RecoveryActivationPlanReport = {
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  generated_at: string
  scope: NormalizedActivationScope
  readiness_report: {
    present: boolean
    ok: boolean | null
    go_no_go: string | null
    generated_at: string | null
  }
  phases: RecoveryActivationPhase[]
  required_evidence: RecoveryActivationRequiredEvidence | null
  rollback_triggers: RecoveryActivationRollbackTrigger[]
  blockers: RecoveryActivationPlanBlocker[]
  non_goals: string[]
  mutation_performed: false
}

export type RecoveryActivationPlanOptions = {
  now?: () => Date
}

type ProjectionScope = {
  name: string
  channel_id: string
  sender_agent_id: string
  recipient_agent_ids: string[]
  expected_consumer_agent_id: string | null
  expected_consumer_source: string | null
}

type NormalizedActivationScope = {
  scope_id: string | null
  agents: string[]
  channels: string[]
  state_daemon_expected: boolean
  projection_checks: ProjectionScope[]
}

const DEFAULT_PROJECTION_CHECK: ProjectionScope = {
  name: 'codex-cto-to-ceo-discord-direct',
  channel_id: '1487368919613444156',
  sender_agent_id: 'codex-cto',
  recipient_agent_ids: ['ceo'],
  expected_consumer_agent_id: 'codex-cto',
  expected_consumer_source: 'sender_token_evidence',
}

const AUDIT_EVENTS = [
  'recovery.activation.canary_started',
  'state_daemon.canary.queue_received',
  'state_daemon.canary.queue_completed',
  'discord.projection.sent',
  'recovery.activation.canary_completed',
] as const

function uniqueSorted(values: unknown[] | undefined): string[] {
  return Array.from(new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())))
    .sort()
}

function optString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeProjectionChecks(scope: RecoveryReadinessScope): ProjectionScope[] {
  const raw = scope.projection_checks ?? scope.projectionChecks
  const checks = Array.isArray(raw) && raw.length > 0 ? raw : [DEFAULT_PROJECTION_CHECK]
  return checks.map((check, index) => ({
    name: optString(check.name) ?? (index === 0 ? DEFAULT_PROJECTION_CHECK.name : `projection-${index + 1}`),
    channel_id: optString(check.channel_id ?? check.channelId) ?? DEFAULT_PROJECTION_CHECK.channel_id,
    sender_agent_id: optString(check.sender_agent_id ?? check.senderAgentId) ?? DEFAULT_PROJECTION_CHECK.sender_agent_id,
    recipient_agent_ids: uniqueSorted(check.recipient_agent_ids ?? check.recipientAgentIds ?? DEFAULT_PROJECTION_CHECK.recipient_agent_ids),
    expected_consumer_agent_id: optString(check.expected_consumer_agent_id ?? check.expectedConsumerAgentId)
      ?? DEFAULT_PROJECTION_CHECK.expected_consumer_agent_id,
    expected_consumer_source: optString(check.expected_consumer_source ?? check.expectedConsumerSource)
      ?? DEFAULT_PROJECTION_CHECK.expected_consumer_source,
  }))
}

export function normalizeActivationScope(scope: RecoveryReadinessScope): NormalizedActivationScope {
  const projectionChecks = normalizeProjectionChecks(scope)
  const projectionAgents = projectionChecks.flatMap((check) => [check.sender_agent_id, ...check.recipient_agent_ids])
  const cp70Agent = optString(scope.cp70?.agent_id ?? scope.cp70?.agentId)
  const queueAgent = optString(scope.queue?.agent_id ?? scope.queue?.agentId)
  return {
    scope_id: optString(scope.scope_id ?? scope.scopeId),
    agents: uniqueSorted([
      ...(scope.agents ?? []),
      ...(cp70Agent ? [cp70Agent] : []),
      ...(queueAgent ? [queueAgent] : []),
      ...projectionAgents,
    ]),
    channels: uniqueSorted([
      ...(scope.channels ?? []),
      ...projectionChecks.map((check) => check.channel_id),
    ]),
    state_daemon_expected: scope.state_daemon?.expected !== false,
    projection_checks: projectionChecks,
  }
}

function normalizedReadinessScope(report: RecoveryReadinessReport): NormalizedActivationScope {
  return {
    scope_id: report.scope.scope_id,
    agents: uniqueSorted(report.scope.agents),
    channels: uniqueSorted(report.scope.channels),
    state_daemon_expected: report.scope.state_daemon_expected,
    projection_checks: report.scope.projection_checks.map((check) => ({
      name: check.name,
      channel_id: check.channel_id,
      sender_agent_id: check.sender_agent_id,
      recipient_agent_ids: uniqueSorted(check.recipient_agent_ids),
      expected_consumer_agent_id: projectionByName(report, check.name)?.expected_consumer_agent_id ?? null,
      expected_consumer_source: projectionByName(report, check.name)?.expected_consumer_source ?? null,
    })),
  }
}

function projectionByName(report: RecoveryReadinessReport, name: string): RecoveryProjectionReadiness | null {
  return report.projection_readiness.find((item) => item.name === name) ?? null
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function scopesEqual(a: NormalizedActivationScope, b: NormalizedActivationScope): boolean {
  return canonical(a) === canonical(b)
}

function activationScopeRequired(
  scopeInput: RecoveryReadinessScope,
  scope: NormalizedActivationScope,
): RecoveryActivationPlanBlocker[] {
  const explicitProjectionChecks = scopeInput.projection_checks ?? scopeInput.projectionChecks
  const hasExplicitProjectionChecks = Array.isArray(explicitProjectionChecks) && explicitProjectionChecks.length > 0
  const explicitProjectionAgents = hasExplicitProjectionChecks
    ? scope.projection_checks.flatMap((check) => [check.sender_agent_id, ...check.recipient_agent_ids])
    : []
  const explicitProjectionChannels = hasExplicitProjectionChecks
    ? scope.projection_checks.map((check) => check.channel_id)
    : []
  const cp70Agent = optString(scopeInput.cp70?.agent_id ?? scopeInput.cp70?.agentId)
  const queueAgent = optString(scopeInput.queue?.agent_id ?? scopeInput.queue?.agentId)
  const missing: string[] = []
  if (uniqueSorted([...(scopeInput.agents ?? []), ...explicitProjectionAgents, cp70Agent, queueAgent]).length === 0) missing.push('agents')
  if (uniqueSorted([...(scopeInput.channels ?? []), ...explicitProjectionChannels]).length === 0) missing.push('channels')
  if (!hasExplicitProjectionChecks) missing.push('projection_checks')
  return missing.length === 0
    ? []
    : [{
      code: 'ACTIVATION_SCOPE_REQUIRED',
      subject_type: 'activation_scope',
      subject_id: scope.scope_id,
      evidence: { missing },
    }]
}

function readinessBlockers(
  scope: NormalizedActivationScope,
  readinessReport: RecoveryReadinessReport | null,
): RecoveryActivationPlanBlocker[] {
  if (!readinessReport) {
    return [{
      code: 'READINESS_REPORT_REQUIRED',
      subject_type: 'readiness_report',
      subject_id: null,
      evidence: { required: true },
    }]
  }
  if (!readinessReport.ok || readinessReport.go_no_go !== 'GO') {
    return [{
      code: 'READINESS_REPORT_NO_GO',
      subject_type: 'readiness_report',
      subject_id: readinessReport.scope.scope_id,
      evidence: {
        ok: readinessReport.ok,
        go_no_go: readinessReport.go_no_go,
        blocker_codes: readinessReport.blockers.map((blocker) => blocker.code),
      },
    }]
  }
  const readinessScope = normalizedReadinessScope(readinessReport)
  if (!scopesEqual(scope, readinessScope)) {
    return [{
      code: 'READINESS_SCOPE_MISMATCH',
      subject_type: 'activation_scope',
      subject_id: scope.scope_id,
      evidence: {
        scope_file: scope,
        readiness_report: readinessScope,
      },
    }]
  }
  return []
}

function phases(): RecoveryActivationPhase[] {
  return [
    {
      order: 1,
      code: 'cp70_preflight_evidence_check',
      title: 'CP-70 preflight evidence check',
      execution_allowed: false,
      canary_first_only: true,
      required_evidence_keys: ['cp70.failed_blocker_codes', 'cp70.expected_failed_blocker_codes'],
      notes: ['Verify the readiness report still has zero CP-70 blocker codes before any activation step is approved.'],
    },
    {
      order: 2,
      code: 'state_daemon_launchagent_readiness_check',
      title: 'state_daemon LaunchAgent readiness check',
      execution_allowed: false,
      canary_first_only: true,
      required_evidence_keys: ['launchagent.plist_path', 'launchagent.script', 'launchagent.working_directory', 'launchagent.loaded', 'launchagent.running'],
      notes: ['Confirm the LaunchAgent points at the approved durable checkout and has no crash-loop fingerprint.'],
    },
    {
      order: 3,
      code: 'queue_receive_process_canary_plan',
      title: 'Queue receive/process canary plan',
      execution_allowed: false,
      canary_first_only: true,
      required_evidence_keys: ['queue_canary.agent_ids', 'queue_canary.future_queue_ids_required', 'queue_canary.max_canary_count'],
      notes: ['Canary execution is a future approved action and must target one exact queue id produced by that action.'],
    },
    {
      order: 4,
      code: 'completion_outcome_evidence_plan',
      title: 'Completion outcome evidence plan',
      execution_allowed: false,
      canary_first_only: true,
      required_evidence_keys: ['queue_canary.future_queue_ids_required', 'audit_events'],
      notes: ['Future success requires terminal lifecycle evidence for the exact canary queue id.'],
    },
    {
      order: 5,
      code: 'discord_projection_evidence_plan',
      title: 'Discord projection evidence plan',
      execution_allowed: false,
      canary_first_only: true,
      required_evidence_keys: ['discord_projection.expected_consumer_agent_id', 'discord_projection.expected_consumer_source', 'discord_projection.connector_instance_id'],
      notes: ['Projection success requires direct delivery evidence and no AUN/router delivery fallback.'],
    },
    {
      order: 6,
      code: 'audit_evidence_plan',
      title: 'Audit evidence plan',
      execution_allowed: false,
      canary_first_only: true,
      required_evidence_keys: ['audit_events'],
      notes: ['The listed audit event names are expected only after a separately approved future execution.'],
    },
    {
      order: 7,
      code: 'rollback_trigger_list',
      title: 'Rollback trigger list',
      execution_allowed: false,
      canary_first_only: true,
      required_evidence_keys: ['rollback_triggers'],
      notes: ['Rollback triggers are reported for operator review; this command does not execute rollback.'],
    },
  ]
}

function rollbackTriggers(): RecoveryActivationRollbackTrigger[] {
  return [
    {
      code: 'FIFO_DRAIN_DETECTED',
      severity: 'stop',
      evidence_required: ['unexpected next/inbox/FIFO processing evidence', 'queue ids affected'],
    },
    {
      code: 'LOOP_PROMPT_DETECTED',
      severity: 'stop',
      evidence_required: ['legacy wake prompt artifact source', 'exact queue/message ids where present'],
    },
    {
      code: 'DUPLICATE_ACTIVE_WORK',
      severity: 'stop',
      evidence_required: ['duplicate active baton/turn ids', 'exact queue ids'],
    },
    {
      code: 'PROJECTION_FALLBACK_UNEXPECTED',
      severity: 'stop',
      evidence_required: ['actual consumer_agent_id', 'actual consumer_source', 'delivery_fallback_reason'],
    },
    {
      code: 'SEND_FAILURE_IS_PROJECTION_FAILURE',
      severity: 'stop',
      evidence_required: ['outbound queue id', 'last_error', 'attempt count'],
    },
    {
      code: 'STATE_DAEMON_WRONG_PATH_OR_AGENT_ID',
      severity: 'stop',
      evidence_required: ['LaunchAgent ProgramArguments[1]', 'WorkingDirectory', 'state_daemon AGENT_ID evidence if present'],
    },
    {
      code: 'DISCORD_CREDENTIAL_OR_WRITE_EVIDENCE_MISSING',
      severity: 'stop',
      evidence_required: ['connector_instance_id', 'credential_id', 'channel_binding_id or provider_channel_access_id'],
    },
  ]
}

function requiredEvidence(readinessReport: RecoveryReadinessReport): RecoveryActivationRequiredEvidence {
  return {
    cp70: {
      failed_blocker_codes: readinessReport.cp70.failed_blocker_codes,
      expected_failed_blocker_codes: [],
      scope_agent_ids: readinessReport.queue_readiness.scope_agent_ids,
    },
    launchagent: {
      label: readinessReport.launchagent.runtime.label,
      plist_path: readinessReport.launchagent.plist_path,
      program: readinessReport.launchagent.runtime.paths.program,
      script: readinessReport.launchagent.runtime.paths.script,
      working_directory: readinessReport.launchagent.runtime.paths.working_directory,
      loaded: readinessReport.launchagent.runtime.launchd.loaded,
      running: readinessReport.launchagent.runtime.launchd.running,
      fatal_stderr_fingerprint: readinessReport.launchagent.runtime.stderr.fatal_fingerprint,
    },
    queue_canary: {
      canary_first_only: true,
      agent_ids: readinessReport.scope.agents,
      baseline_pending_backlog_total: readinessReport.queue_readiness.pending_backlog.total,
      baseline_stale_active_queue_ids: readinessReport.queue_readiness.stale_active_rows.map((row) => row.queue_id),
      baseline_duplicate_active_queue_ids: readinessReport.queue_readiness.duplicate_active_baton_rows.flatMap((row) => row.queue_ids),
      future_queue_ids_required: true,
      max_canary_count: 1,
    },
    discord_projection: readinessReport.projection_readiness.map((projection) => ({
      name: projection.name,
      channel_id: projection.channel_id,
      sender_agent_id: projection.sender_agent_id,
      recipient_agent_ids: projection.recipient_agent_ids,
      expected_consumer_agent_id: projection.expected_consumer_agent_id,
      expected_consumer_source: projection.expected_consumer_source,
      actual_consumer_agent_id: projection.decision.consumerAgentId,
      actual_consumer_source: projection.decision.consumerSource,
      connector_instance_id: projection.decision.consumerEvidence?.connector_instance_id ?? null,
      channel_binding_id: projection.decision.consumerEvidence?.channel_binding_id ?? null,
      provider_channel_access_id: projection.decision.consumerEvidence?.provider_channel_access_id ?? null,
      expected_no_aun_router_fallback: true,
      forbidden_consumer_sources: ['channel_policy_adapter_owner', 'channel_policy_primary', 'none'],
      delivery_fallback_reason: projection.decision.deliveryFallbackReason,
    })),
    audit_events: [...AUDIT_EVENTS],
  }
}

export function buildRecoveryActivationPlan(
  scopeInput: RecoveryReadinessScope,
  readinessReport: RecoveryReadinessReport | null,
  options: RecoveryActivationPlanOptions = {},
): RecoveryActivationPlanReport {
  const now = options.now ?? (() => new Date())
  const scope = normalizeActivationScope(scopeInput)
  const blockers = [
    ...activationScopeRequired(scopeInput, scope),
    ...readinessBlockers(scope, readinessReport),
  ]
  const ok = blockers.length === 0
  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: now().toISOString(),
    scope,
    readiness_report: {
      present: readinessReport !== null,
      ok: readinessReport?.ok ?? null,
      go_no_go: readinessReport?.go_no_go ?? null,
      generated_at: readinessReport?.generated_at ?? null,
    },
    phases: ok ? phases() : [],
    required_evidence: ok && readinessReport ? requiredEvidence(readinessReport) : null,
    rollback_triggers: rollbackTriggers(),
    blockers,
    non_goals: [
      'state_daemon_restart',
      'launchctl_bootstrap_or_kickstart',
      'discord_activation',
      'live_codex_or_claude_calls',
      'next_inbox_fifo_drain',
      'prompt_driven_processing',
      'fleet_wide_activation',
      'canary_execution',
      'audit_request_before_653_settles',
    ],
    mutation_performed: false,
  }
}

export function formatRecoveryActivationPlanText(report: RecoveryActivationPlanReport): string {
  const lines = [
    'CP-80 Activation Plan',
    `Result: ${report.go_no_go}`,
    `Scope: ${report.scope.scope_id ?? '(unnamed)'}`,
    `Agents: ${report.scope.agents.join(', ') || '(none)'}`,
    `Channels: ${report.scope.channels.join(', ') || '(none)'}`,
    '',
    'Policy: read-only, canary-first only, no mutation, no runtime or Discord activation',
    '',
    'Phases:',
    ...(report.phases.length === 0
      ? ['  none']
      : report.phases.map((phase) => `  ${phase.order}. ${phase.code}`)),
    '',
    'Blockers:',
    ...(report.blockers.length === 0
      ? ['  none']
      : report.blockers.map((blocker) => `  ${blocker.code}: ${blocker.subject_id ?? '(none)'}`)),
    '',
    'Rollback triggers:',
    ...report.rollback_triggers.map((trigger) => `  ${trigger.code}`),
    '',
    `Mutation performed: ${String(report.mutation_performed)}`,
  ]
  return `${lines.join('\n')}\n`
}
