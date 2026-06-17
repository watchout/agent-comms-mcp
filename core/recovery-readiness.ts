import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  CP70_TUI_WAKE_PROMPT_PATTERNS,
  buildCp70DoctorReport,
  buildCp70Preflight,
  type Cp70DoctorReport,
  type Cp70Finding,
  type Cp70Preflight,
} from './cp70-doctor'
import {
  inspectStateDaemonRuntime,
  type StateDaemonRuntimeOptions,
  type StateDaemonRuntimeReadiness,
} from './state-daemon-readiness'
import {
  STATE_DAEMON_LAUNCH_AGENT_LABEL,
  parseStateDaemonLaunchAgentPlist,
  validateStateDaemonLaunchAgentConfig,
  type PathProbe,
  type StateDaemonLaunchAgentConfig,
  type StateDaemonPreflightIssue,
} from './state-daemon/launchagent'
import {
  outboundProjectionSkipReason,
  outboundProjectionSkipCode,
  resolveOutboundProjectionDecision,
  type OutboundProjectionDecision,
  type ProjectionConsumerSource,
} from './outbound-projection'

export type RecoveryReadinessBlockerCode =
  | 'ACTIVATION_SCOPE_REQUIRED'
  | 'CP70_BLOCKER'
  | 'TUI_WAKE_PROMPT_PRESENT'
  | 'STUCK_ACTIVE_QUEUE_ROW'
  | 'DUPLICATE_ACTIVE_BATON'
  | 'LAUNCHAGENT_PLIST_MISSING'
  | 'LAUNCHAGENT_CONFIG_INVALID'
  | 'LAUNCHAGENT_PRIVATE_TMP_PATH'
  | 'STATE_DAEMON_UNLOADED'
  | 'STATE_DAEMON_NOT_RUNNING'
  | 'STATE_DAEMON_CRASH_LOOP_EVIDENCE'
  | 'PROJECTION_NO_DISCORD_ADAPTER_MAPPING'
  | 'PROJECTION_NO_ELIGIBLE_DELIVERY_CONSUMER'
  | 'PROJECTION_DIRECT_DELIVERY_MISMATCH'
  | 'PROJECTION_FALLBACK_DISALLOWED'
  | 'COMPLETE_RECOVERY_UNTESTED'
  | 'COMPLETE_RECOVERY_QUEUE_ROW_MISSING'
  | 'COMPLETE_RECOVERY_PENDING_UNCLAIMED'
  | 'COMPLETE_RECOVERY_REPORT_ONLY'
  | 'COMPLETE_RECOVERY_NOT_PROCESSED'
  | 'COMPLETE_RECOVERY_DURABLE_EVIDENCE_MISSING'

export type RecoveryReadinessComponent =
  | 'scope'
  | 'cp70'
  | 'launchagent'
  | 'queue'
  | 'projection'
  | 'complete_recovery'

export type RecoveryReadinessBlocker = {
  code: RecoveryReadinessBlockerCode
  component: RecoveryReadinessComponent
  subject_type: string
  subject_id: string | null
  queue_ids: Array<string | number>
  message_ids: string[]
  evidence: Record<string, unknown>
}

export type RecoveryProjectionCheckScope = {
  name?: string
  channel_id?: string
  channelId?: string
  thread_id?: string | null
  threadId?: string | null
  sender_agent_id?: string
  senderAgentId?: string
  recipient_agent_ids?: string[]
  recipientAgentIds?: string[]
  expected_consumer_agent_id?: string | null
  expectedConsumerAgentId?: string | null
  expected_consumer_source?: ProjectionConsumerSource | null
  expectedConsumerSource?: ProjectionConsumerSource | null
  allow_fallback?: boolean
  allowFallback?: boolean
}

export type CompleteRecoveryRequiredRoleScope = {
  name?: string
  role?: string
  agent_id?: string
  agentId?: string
  queue_id?: string | number
  queueId?: string | number
  message_id?: string
  messageId?: string
  durable_evidence_urls?: string[]
  durableEvidenceUrls?: string[]
  known_exclusion?: boolean
  knownExclusion?: boolean
  exclusion_reason?: string
  exclusionReason?: string
  require_github_writeback?: boolean
  requireGithubWriteback?: boolean
}

export type RecoveryReadinessScope = {
  scope_id?: string
  scopeId?: string
  agents?: string[]
  channels?: string[]
  cp70?: {
    agent_id?: string | null
    agentId?: string | null
    stale_minutes?: number
    staleMinutes?: number
  }
  queue?: {
    agent_id?: string | null
    agentId?: string | null
    stale_minutes?: number
    staleMinutes?: number
  }
  state_daemon?: {
    expected?: boolean
    require_running?: boolean
    requireRunning?: boolean
    plist_path?: string
    plistPath?: string
    label?: string
    allow_private_tmp?: boolean
    allowPrivateTmp?: boolean
    restore_root?: string | null
    restoreRoot?: string | null
  }
  projection_checks?: RecoveryProjectionCheckScope[]
  projectionChecks?: RecoveryProjectionCheckScope[]
  complete_recovery?: {
    enabled?: boolean
    slo_seconds?: number
    sloSeconds?: number
    required_roles?: CompleteRecoveryRequiredRoleScope[]
    requiredRoles?: CompleteRecoveryRequiredRoleScope[]
  }
  completeRecovery?: RecoveryReadinessScope['complete_recovery']
}

export type RecoveryReadinessOptions = {
  now?: () => Date
  inspectStateDaemonRuntime?: (options?: StateDaemonRuntimeOptions) => StateDaemonRuntimeReadiness
  stateDaemonRuntimeOptions?: StateDaemonRuntimeOptions
  readFileSync?: typeof readFileSync
  existsSync?: typeof existsSync
  statSync?: typeof statSync
  pathProbe?: PathProbe
}

export type RecoveryReadinessCp70Evidence = {
  report: Cp70DoctorReport
  preflight: Cp70Preflight
}

export type RecoveryLaunchAgentPromptArtifact = {
  source: string
  path: string | null
  pattern: string
}

export type RecoveryLaunchAgentReadiness = {
  expected: boolean
  require_running: boolean
  allow_private_tmp: boolean
  runtime: StateDaemonRuntimeReadiness
  plist_path: string | null
  config: StateDaemonLaunchAgentConfig | null
  validation: {
    ok: boolean
    errors: StateDaemonPreflightIssue[]
    warnings: StateDaemonPreflightIssue[]
  } | null
  prompt_artifacts: RecoveryLaunchAgentPromptArtifact[]
}

export type RecoveryQueueReadiness = {
  scope_agent_ids: string[]
  pending_backlog: {
    total: number
    by_agent_status: Array<{ agent_id: string; status: string; count: number }>
  }
  stale_active_rows: Array<{
    queue_id: string | number
    agent_id: string | null
    status: string | null
    message_id: string | null
    evidence: string | null
  }>
  duplicate_active_baton_rows: Array<{
    queue_ids: Array<string | number>
    agent_id: string | null
    evidence: string | null
  }>
}

export type RecoveryProjectionReadiness = {
  name: string
  channel_id: string
  thread_id: string | null
  sender_agent_id: string
  recipient_agent_ids: string[]
  expected_consumer_agent_id: string | null
  expected_consumer_source: ProjectionConsumerSource | null
  allow_fallback: boolean
  decision: OutboundProjectionDecision
  ok: boolean
  blocker_codes: RecoveryReadinessBlockerCode[]
}

export type CompleteRecoveryGateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNTESTED' | 'EXCLUDED'

export type CompleteRecoveryRoleResult = {
  name: string
  role: string
  agent_id: string
  status: CompleteRecoveryGateStatus
  queue_id: string | number | null
  message_id: string | null
  queue_status: string | null
  claimed_by: string | null
  claimed_at: string | null
  processed_at: string | null
  durable_evidence_urls: string[]
  blocker_codes: RecoveryReadinessBlockerCode[]
  evidence: Record<string, unknown>
}

export type CompleteRecoveryReadiness = {
  enabled: boolean
  slo_seconds: number
  summary: {
    pass: number
    fail: number
    blocked: number
    untested: number
    excluded: number
  }
  role_results: CompleteRecoveryRoleResult[]
}

export type RecoveryReadinessReport = {
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  generated_at: string
  scope: {
    scope_id: string | null
    agents: string[]
    channels: string[]
    state_daemon_expected: boolean
    projection_checks: Array<{
      name: string
      channel_id: string
      sender_agent_id: string
      recipient_agent_ids: string[]
    }>
  }
  policy: {
    read_only: true
    dry_run_default: true
    no_db_mutation: true
    no_queue_cleanup_apply: true
    no_state_daemon_restart: true
    no_discord_activation: true
    no_live_codex_or_claude_calls: true
    no_next_inbox_fifo_drain: true
    no_prompt_driven_processing: true
    exact_activation_scope_required: true
  }
  cp70: {
    reports: RecoveryReadinessCp70Evidence[]
    failed_blocker_codes: string[]
  }
  launchagent: RecoveryLaunchAgentReadiness
  queue_readiness: RecoveryQueueReadiness
  projection_readiness: RecoveryProjectionReadiness[]
  complete_recovery: CompleteRecoveryReadiness
  blockers: RecoveryReadinessBlocker[]
  recommended_next_commands: string[]
  mutation_performed: false
}

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

const DEFAULT_PROJECTION_CHECK = {
  name: 'codex-cto-to-ceo-discord-direct',
  channel_id: '1487368919613444156',
  sender_agent_id: 'codex-cto',
  recipient_agent_ids: ['ceo'],
  expected_consumer_agent_id: 'codex-cto',
  expected_consumer_source: 'sender_token_evidence' as ProjectionConsumerSource,
  allow_fallback: false,
}

function uniqueStrings(values: unknown[] | undefined): string[] {
  return Array.from(new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())))
}

function numericMinutes(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function optionString(primary: unknown, fallback: unknown = null): string | null {
  const value = primary ?? fallback
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function optionNumber(primary: unknown, fallback: unknown = null): string | number | null {
  const value = primary ?? fallback
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return null
}

function stringArray(primary: unknown, fallback: unknown = []): string[] {
  const raw = Array.isArray(primary) ? primary : (Array.isArray(fallback) ? fallback : [])
  return uniqueStrings(raw)
}

function normalizeProjectionChecks(scope: RecoveryReadinessScope): RecoveryProjectionCheckScope[] {
  const raw = scope.projection_checks ?? scope.projectionChecks
  if (Array.isArray(raw) && raw.length > 0) return raw
  return [DEFAULT_PROJECTION_CHECK]
}

function normalizeCompleteRecoveryScope(scope: RecoveryReadinessScope) {
  const raw = scope.complete_recovery ?? scope.completeRecovery
  const enabled = raw?.enabled === true
  const roles = raw?.required_roles ?? raw?.requiredRoles ?? []
  return {
    enabled,
    slo_seconds: numericMinutes(raw?.slo_seconds ?? raw?.sloSeconds, 0) || 300,
    required_roles: Array.isArray(roles) ? roles : [],
  }
}

function normalizeCompleteRecoveryRole(raw: CompleteRecoveryRequiredRoleScope, index: number) {
  const role = optionString(raw.role) ?? optionString(raw.name) ?? `role-${index + 1}`
  const agentId = optionString(raw.agent_id, raw.agentId) ?? role
  return {
    name: optionString(raw.name) ?? role,
    role,
    agent_id: agentId,
    queue_id: optionNumber(raw.queue_id, raw.queueId),
    message_id: optionString(raw.message_id, raw.messageId),
    durable_evidence_urls: stringArray(raw.durable_evidence_urls, raw.durableEvidenceUrls),
    known_exclusion: Boolean(raw.known_exclusion ?? raw.knownExclusion ?? false),
    exclusion_reason: optionString(raw.exclusion_reason, raw.exclusionReason),
    require_github_writeback: Boolean(raw.require_github_writeback ?? raw.requireGithubWriteback ?? false),
  }
}

function projectionCheckName(check: RecoveryProjectionCheckScope, index: number): string {
  return optionString(check.name) ?? (index === 0 ? DEFAULT_PROJECTION_CHECK.name : `projection-${index + 1}`)
}

function normalizeProjectionCheck(check: RecoveryProjectionCheckScope, index: number) {
  return {
    name: projectionCheckName(check, index),
    channel_id: optionString(check.channel_id, check.channelId) ?? DEFAULT_PROJECTION_CHECK.channel_id,
    thread_id: optionString(check.thread_id, check.threadId),
    sender_agent_id: optionString(check.sender_agent_id, check.senderAgentId) ?? DEFAULT_PROJECTION_CHECK.sender_agent_id,
    recipient_agent_ids: uniqueStrings(check.recipient_agent_ids ?? check.recipientAgentIds ?? DEFAULT_PROJECTION_CHECK.recipient_agent_ids),
    expected_consumer_agent_id: optionString(check.expected_consumer_agent_id, check.expectedConsumerAgentId)
      ?? DEFAULT_PROJECTION_CHECK.expected_consumer_agent_id,
    expected_consumer_source: (
      check.expected_consumer_source
      ?? check.expectedConsumerSource
      ?? DEFAULT_PROJECTION_CHECK.expected_consumer_source
    ) as ProjectionConsumerSource | null,
    allow_fallback: Boolean(check.allow_fallback ?? check.allowFallback ?? DEFAULT_PROJECTION_CHECK.allow_fallback),
  }
}

function activationScopeBlockers(scope: RecoveryReadinessScope, projectionChecks: ReturnType<typeof normalizeProjectionCheck>[]): RecoveryReadinessBlocker[] {
  const agents = uniqueStrings(scope.agents)
  const channels = uniqueStrings(scope.channels)
  const rawProjectionChecks = scope.projection_checks ?? scope.projectionChecks
  const hasExplicitProjectionChecks = Array.isArray(rawProjectionChecks) && rawProjectionChecks.length > 0
  const projectionAgents = hasExplicitProjectionChecks
    ? uniqueStrings(projectionChecks.flatMap((check) => [check.sender_agent_id, ...check.recipient_agent_ids]))
    : []
  const projectionChannels = hasExplicitProjectionChecks
    ? uniqueStrings(projectionChecks.map((check) => check.channel_id))
    : []
  const missing: string[] = []
  if (agents.length === 0 && projectionAgents.length === 0 && !optionString(scope.cp70?.agent_id, scope.cp70?.agentId)) {
    missing.push('agents')
  }
  if (channels.length === 0 && projectionChannels.length === 0) {
    missing.push('channels')
  }
  if (projectionChecks.length === 0) {
    missing.push('projection_checks')
  }
  if (missing.length === 0) return []
  return [{
    code: 'ACTIVATION_SCOPE_REQUIRED',
    component: 'scope',
    subject_type: 'activation_scope',
    subject_id: null,
    queue_ids: [],
    message_ids: [],
    evidence: { missing },
  }]
}

function cp70LoopPromptBlocksRecovery(finding: Cp70Finding): boolean {
  if (finding.code !== 'LOOP_PROMPT_BACKLOG') return true
  return finding.samples.some((sample) => {
    if (sample.source === 'launchagent.plist') return true
    if (sample.source !== 'message_queue.payload') return false
    return sample.status === 'pending' || sample.status === 'received' || sample.status === 'in_progress'
  })
}

function blockerFromCp70Finding(finding: Cp70Finding): RecoveryReadinessBlocker | null {
  if (!cp70LoopPromptBlocksRecovery(finding)) return null
  const code: RecoveryReadinessBlockerCode =
    finding.code === 'LOOP_PROMPT_BACKLOG'
      ? 'TUI_WAKE_PROMPT_PRESENT'
      : finding.code === 'STUCK_ACTIVE_QUEUE_ROW' || finding.code === 'DUPLICATE_ACTIVE_BATON'
        ? finding.code
        : 'CP70_BLOCKER'
  return {
    code,
    component: finding.code === 'STUCK_ACTIVE_QUEUE_ROW' || finding.code === 'DUPLICATE_ACTIVE_BATON' ? 'queue' : 'cp70',
    subject_type: finding.subject_type,
    subject_id: finding.subject_id,
    queue_ids: finding.queue_id
      ? [finding.queue_id]
      : finding.samples.flatMap((sample) => sample.queue_ids ?? (sample.queue_id !== null ? [sample.queue_id] : [])),
    message_ids: finding.message_id
      ? [finding.message_id]
      : finding.samples.map((sample) => sample.message_id).filter((id): id is string => id !== null),
    evidence: {
      cp70_code: finding.code,
      gate: finding.gate,
      agent_id: finding.agent_id,
      channel_id: finding.channel_id,
      count: finding.count,
      samples: finding.samples,
      recommended_repair: finding.recommended_repair,
    },
  }
}

function launchPromptArtifacts(plistPath: string | null, plistText: string | null): RecoveryLaunchAgentPromptArtifact[] {
  if (!plistText) return []
  return CP70_TUI_WAKE_PROMPT_PATTERNS
    .filter((pattern) => plistText.includes(pattern))
    .map((pattern) => ({ source: 'launchagent.plist', path: plistPath, pattern }))
}

function readTextIfExists(path: string | null, options: RecoveryReadinessOptions): string | null {
  if (!path) return null
  const exists = options.existsSync ?? existsSync
  const read = options.readFileSync ?? readFileSync
  try {
    if (!exists(path)) return null
    return read(path, 'utf8')
  } catch {
    return null
  }
}

function blockerForLaunchIssue(issue: StateDaemonPreflightIssue): RecoveryReadinessBlocker {
  return {
    code: issue.code === 'ephemeral_launchagent_path' ? 'LAUNCHAGENT_PRIVATE_TMP_PATH' : 'LAUNCHAGENT_CONFIG_INVALID',
    component: 'launchagent',
    subject_type: 'launchagent_path',
    subject_id: issue.path ?? issue.code,
    queue_ids: [],
    message_ids: [],
    evidence: { issue },
  }
}

function disposablePathBlockers(runtime: StateDaemonRuntimeReadiness, allowPrivateTmp: boolean): RecoveryReadinessBlocker[] {
  if (allowPrivateTmp) return []
  const suspect = /(?:^|\/)(?:private\/tmp|tmp)\//i
  const values: Array<[string, string | null]> = [
    ['paths.program', runtime.paths.program],
    ['paths.script', runtime.paths.script],
    ['paths.working_directory', runtime.paths.working_directory],
    ['process.command', runtime.process.command],
    ['process.cwd', runtime.process.cwd],
  ]
  return values
    .filter(([_field, value]) => value !== null && suspect.test(value))
    .map(([field, value]) => ({
      code: 'LAUNCHAGENT_PRIVATE_TMP_PATH' as const,
      component: 'launchagent' as const,
      subject_type: 'launchagent_path',
      subject_id: value,
      queue_ids: [],
      message_ids: [],
      evidence: { field, path: value },
    }))
}

function launchStateBlockers(readiness: RecoveryLaunchAgentReadiness): RecoveryReadinessBlocker[] {
  if (!readiness.expected) return []
  const runtime = readiness.runtime
  const blockers: RecoveryReadinessBlocker[] = []
  if (!readiness.plist_path) {
    blockers.push({
      code: 'LAUNCHAGENT_PLIST_MISSING',
      component: 'launchagent',
      subject_type: 'launchagent',
      subject_id: runtime.label,
      queue_ids: [],
      message_ids: [],
      evidence: { label: runtime.label },
    })
  }
  if (!readiness.require_running) return blockers
  if (runtime.launchd.loaded === false || runtime.status === 'unloaded') {
    blockers.push({
      code: 'STATE_DAEMON_UNLOADED',
      component: 'launchagent',
      subject_type: 'launchagent',
      subject_id: runtime.label,
      queue_ids: [],
      message_ids: [],
      evidence: { launchd: runtime.launchd, status: runtime.status },
    })
  } else if (runtime.launchd.loaded === true && runtime.launchd.running === false) {
    blockers.push({
      code: 'STATE_DAEMON_NOT_RUNNING',
      component: 'launchagent',
      subject_type: 'launchagent',
      subject_id: runtime.label,
      queue_ids: [],
      message_ids: [],
      evidence: { launchd: runtime.launchd, status: runtime.status },
    })
  }
  if (runtime.status === 'degraded' || runtime.stderr.fatal_fingerprint) {
    blockers.push({
      code: 'STATE_DAEMON_CRASH_LOOP_EVIDENCE',
      component: 'launchagent',
      subject_type: 'launchagent',
      subject_id: runtime.label,
      queue_ids: [],
      message_ids: [],
      evidence: { stderr: runtime.stderr, launchd: runtime.launchd },
    })
  }
  return blockers
}

function buildLaunchAgentReadiness(scope: RecoveryReadinessScope, options: RecoveryReadinessOptions): {
  readiness: RecoveryLaunchAgentReadiness
  blockers: RecoveryReadinessBlocker[]
} {
  const stateScope = scope.state_daemon ?? {}
  const expected = stateScope.expected !== false
  const requireRunning = stateScope.require_running ?? stateScope.requireRunning ?? expected
  const allowPrivateTmp = Boolean(stateScope.allow_private_tmp ?? stateScope.allowPrivateTmp ?? false)
  const label = optionString(stateScope.label) ?? STATE_DAEMON_LAUNCH_AGENT_LABEL
  const plistPath = optionString(stateScope.plist_path, stateScope.plistPath) ?? undefined
  const inspect = options.inspectStateDaemonRuntime ?? inspectStateDaemonRuntime
  const runtime = inspect({
    ...(options.stateDaemonRuntimeOptions ?? {}),
    label,
    ...(plistPath ? { plistPath } : {}),
  })
  const actualPlistPath = runtime.paths.plist_path ?? plistPath ?? null
  const plistText = readTextIfExists(actualPlistPath, options)
  const config = plistText ? parseStateDaemonLaunchAgentPlist(plistText) : null
  const validation = config
    ? validateStateDaemonLaunchAgentConfig(config, {
      probe: options.pathProbe,
      allowRestoreOwnedTemp: allowPrivateTmp,
      restoreRoot: optionString(stateScope.restore_root, stateScope.restoreRoot),
    })
    : null
  const promptArtifacts = launchPromptArtifacts(actualPlistPath, plistText)
  const readiness: RecoveryLaunchAgentReadiness = {
    expected,
    require_running: Boolean(requireRunning),
    allow_private_tmp: allowPrivateTmp,
    runtime,
    plist_path: actualPlistPath,
    config,
    validation,
    prompt_artifacts: promptArtifacts,
  }
  const blockers = [
    ...promptArtifacts.map((artifact): RecoveryReadinessBlocker => ({
      code: 'TUI_WAKE_PROMPT_PRESENT',
      component: 'launchagent',
      subject_type: 'launchagent_prompt',
      subject_id: artifact.path,
      queue_ids: [],
      message_ids: [],
      evidence: artifact,
    })),
    ...(validation?.errors ?? []).map(blockerForLaunchIssue),
    ...disposablePathBlockers(runtime, allowPrivateTmp),
    ...launchStateBlockers(readiness),
  ]
  return { readiness, blockers }
}

function cp70AgentScopes(scope: RecoveryReadinessScope, projectionChecks: ReturnType<typeof normalizeProjectionCheck>[]): string[] {
  const explicit = uniqueStrings(scope.agents)
  const cp70Agent = optionString(scope.cp70?.agent_id, scope.cp70?.agentId)
  const queueAgent = optionString(scope.queue?.agent_id, scope.queue?.agentId)
  const projectionAgents = uniqueStrings(projectionChecks.flatMap((check) => [check.sender_agent_id, ...check.recipient_agent_ids]))
  const combined = uniqueStrings([...explicit, ...(cp70Agent ? [cp70Agent] : []), ...(queueAgent ? [queueAgent] : []), ...projectionAgents])
  return combined
}

function queueReadinessFromCp70(scopeAgentIds: string[], cp70Reports: RecoveryReadinessCp70Evidence[]): RecoveryQueueReadiness {
  const byAgentStatus = cp70Reports.flatMap(({ report }) => report.queue_backlog.by_agent_status)
  const stale = cp70Reports
    .flatMap(({ report }) => report.findings)
    .filter((finding) => finding.code === 'STUCK_ACTIVE_QUEUE_ROW' && finding.count > 0)
    .flatMap((finding) => finding.samples.map((sample) => ({
      queue_id: sample.queue_id ?? sample.record_id ?? finding.subject_id,
      agent_id: sample.agent_id,
      status: sample.status,
      message_id: sample.message_id,
      evidence: sample.evidence,
    })))
  const duplicate = cp70Reports
    .flatMap(({ report }) => report.findings)
    .filter((finding) => finding.code === 'DUPLICATE_ACTIVE_BATON' && finding.count > 0)
    .map((finding) => ({
      queue_ids: finding.samples.flatMap((sample) => sample.queue_ids ?? (sample.queue_id !== null ? [sample.queue_id] : [])),
      agent_id: finding.agent_id,
      evidence: typeof finding.evidence.baton_key === 'string' ? finding.evidence.baton_key : null,
    }))
  return {
    scope_agent_ids: scopeAgentIds,
    pending_backlog: {
      total: byAgentStatus
        .filter((row) => row.status === 'pending')
        .reduce((sum, row) => sum + row.count, 0),
      by_agent_status: byAgentStatus,
    },
    stale_active_rows: stale,
    duplicate_active_baton_rows: duplicate,
  }
}

async function buildProjectionReadiness(
  db: Queryable,
  normalized: ReturnType<typeof normalizeProjectionCheck>,
): Promise<{
  readiness: RecoveryProjectionReadiness
  blockers: RecoveryReadinessBlocker[]
}> {
  const decision = await resolveOutboundProjectionDecision(db, {
    channelId: normalized.channel_id,
    threadId: normalized.thread_id,
    senderAgentId: normalized.sender_agent_id,
    recipientAgentIds: normalized.recipient_agent_ids,
    fallbackAllowed: normalized.allow_fallback,
  })
  const blockerCodes: RecoveryReadinessBlockerCode[] = []
  const blockers: RecoveryReadinessBlocker[] = []
  const addBlocker = (code: RecoveryReadinessBlockerCode, evidence: Record<string, unknown>) => {
    blockerCodes.push(code)
    blockers.push({
      code,
      component: 'projection',
      subject_type: 'projection_check',
      subject_id: normalized.name,
      queue_ids: [],
      message_ids: [],
      evidence: {
        channel_id: normalized.channel_id,
        sender_agent_id: normalized.sender_agent_id,
        recipient_agent_ids: normalized.recipient_agent_ids,
        ...evidence,
      },
    })
  }

  const skipReason = outboundProjectionSkipReason(decision)
  if (skipReason) {
    addBlocker(outboundProjectionSkipCode(skipReason) === 'NO_DISCORD_ADAPTER_MAPPING'
      ? 'PROJECTION_NO_DISCORD_ADAPTER_MAPPING'
      : 'PROJECTION_NO_ELIGIBLE_DELIVERY_CONSUMER', {
      skip_reason: skipReason,
      decision,
    })
  }

  if (
    decision.consumerAgentId !== normalized.expected_consumer_agent_id
    || decision.consumerSource !== normalized.expected_consumer_source
  ) {
    addBlocker('PROJECTION_DIRECT_DELIVERY_MISMATCH', {
      expected_consumer_agent_id: normalized.expected_consumer_agent_id,
      expected_consumer_source: normalized.expected_consumer_source,
      actual_consumer_agent_id: decision.consumerAgentId,
      actual_consumer_source: decision.consumerSource,
      decision,
    })
  }

  const fallbackSource = decision.consumerSource === 'channel_policy_adapter_owner'
    || decision.consumerSource === 'channel_policy_primary'
  if (!normalized.allow_fallback && fallbackSource) {
    addBlocker('PROJECTION_FALLBACK_DISALLOWED', {
      actual_consumer_agent_id: decision.consumerAgentId,
      actual_consumer_source: decision.consumerSource,
      delivery_fallback_reason: decision.deliveryFallbackReason,
      decision,
    })
  }

  return {
    readiness: {
      ...normalized,
      decision,
      ok: blockers.length === 0,
      blocker_codes: blockerCodes,
    },
    blockers,
  }
}

async function fetchCompleteRecoveryQueueRow(
  db: Queryable,
  role: ReturnType<typeof normalizeCompleteRecoveryRole>,
): Promise<Record<string, unknown> | null> {
  if (role.queue_id !== null) {
    const result = await db.query(
      `SELECT id, agent_id, message_id, payload, status, created_at, read_at,
              claimed_by, claimed_at, claim_expires_at, done_at, replied_at,
              replied_with, failed_reason
         FROM message_queue
        WHERE id = $1
        LIMIT 1`,
      [role.queue_id],
    )
    return result.rows[0] ?? null
  }
  if (role.message_id) {
    const result = await db.query(
      `SELECT id, agent_id, message_id, payload, status, created_at, read_at,
              claimed_by, claimed_at, claim_expires_at, done_at, replied_at,
              replied_with, failed_reason
         FROM message_queue
        WHERE message_id = $1
          AND agent_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [role.message_id, role.agent_id],
    )
    return result.rows[0] ?? null
  }
  return null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function githubUrlsFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') {
    return /^https:\/\/github\.com\/\S+/i.test(value.trim()) ? [value.trim()] : []
  }
  if (Array.isArray(value)) return value.flatMap(githubUrlsFromUnknown)
  if (!isRecord(value)) return []
  return Object.values(value).flatMap(githubUrlsFromUnknown)
}

function durableEvidenceUrlsFromQueueRow(row: Record<string, unknown>, seed: string[]): string[] {
  const payload = parseJsonObject(row.payload)
  const writebackResult = isRecord(payload.writeback_result) ? payload.writeback_result : {}
  const runnerResult = isRecord(payload.runner_result) ? payload.runner_result : {}
  return uniqueStrings([
    ...seed,
    ...githubUrlsFromUnknown(writebackResult.posted_with),
    ...githubUrlsFromUnknown(writebackResult),
    ...githubUrlsFromUnknown(runnerResult.evidence),
    ...githubUrlsFromUnknown(runnerResult.writeback),
    ...githubUrlsFromUnknown(payload.github_issue_url),
    ...githubUrlsFromUnknown(payload.github_pr_url),
  ])
}

function completeRecoveryBlocker(
  code: RecoveryReadinessBlockerCode,
  role: ReturnType<typeof normalizeCompleteRecoveryRole>,
  row: Record<string, unknown> | null,
  evidence: Record<string, unknown>,
): RecoveryReadinessBlocker {
  return {
    code,
    component: 'complete_recovery',
    subject_type: 'complete_recovery_role',
    subject_id: role.name,
    queue_ids: row?.id !== undefined && row?.id !== null ? [row.id as string | number] : [],
    message_ids: typeof row?.message_id === 'string'
      ? [row.message_id]
      : (role.message_id ? [role.message_id] : []),
    evidence: {
      role: role.role,
      agent_id: role.agent_id,
      queue_id: role.queue_id,
      message_id: role.message_id,
      ...evidence,
    },
  }
}

function completeRecoveryResultFromBlocker(
  role: ReturnType<typeof normalizeCompleteRecoveryRole>,
  row: Record<string, unknown> | null,
  status: CompleteRecoveryGateStatus,
  blockerCodes: RecoveryReadinessBlockerCode[],
  durableEvidenceUrls: string[],
  evidence: Record<string, unknown>,
): CompleteRecoveryRoleResult {
  return {
    name: role.name,
    role: role.role,
    agent_id: role.agent_id,
    status,
    queue_id: (row?.id as string | number | null | undefined) ?? role.queue_id,
    message_id: firstString(row?.message_id, role.message_id),
    queue_status: firstString(row?.status),
    claimed_by: firstString(row?.claimed_by),
    claimed_at: firstString(row?.claimed_at),
    processed_at: firstString(row?.replied_at, row?.done_at),
    durable_evidence_urls: durableEvidenceUrls,
    blocker_codes: blockerCodes,
    evidence,
  }
}

async function evaluateCompleteRecoveryRole(
  db: Queryable,
  role: ReturnType<typeof normalizeCompleteRecoveryRole>,
): Promise<{ result: CompleteRecoveryRoleResult; blockers: RecoveryReadinessBlocker[] }> {
  if (role.known_exclusion) {
    return {
      result: completeRecoveryResultFromBlocker(role, null, 'EXCLUDED', [], role.durable_evidence_urls, {
        exclusion_reason: role.exclusion_reason,
      }),
      blockers: [],
    }
  }

  if (role.queue_id === null && !role.message_id) {
    const code = 'COMPLETE_RECOVERY_UNTESTED' as const
    const evidence = { reason: 'no queue_id or message_id evidence was supplied' }
    return {
      result: completeRecoveryResultFromBlocker(role, null, 'UNTESTED', [code], role.durable_evidence_urls, evidence),
      blockers: [completeRecoveryBlocker(code, role, null, evidence)],
    }
  }

  const row = await fetchCompleteRecoveryQueueRow(db, role)
  if (!row) {
    const code = 'COMPLETE_RECOVERY_QUEUE_ROW_MISSING' as const
    const evidence = { reason: 'referenced queue row was not found' }
    return {
      result: completeRecoveryResultFromBlocker(role, null, 'BLOCKED', [code], role.durable_evidence_urls, evidence),
      blockers: [completeRecoveryBlocker(code, role, null, evidence)],
    }
  }

  const payload = parseJsonObject(row.payload)
  const messageType = firstString(payload.message_type) ?? '(unknown)'
  const queueStatus = firstString(row.status) ?? '(unknown)'
  const durableEvidenceUrls = durableEvidenceUrlsFromQueueRow(row, role.durable_evidence_urls)
  const baseEvidence = {
    queue_status: queueStatus,
    message_type: messageType,
    claimed_by: row.claimed_by ?? null,
    claimed_at: row.claimed_at ?? null,
    claim_expires_at: row.claim_expires_at ?? null,
    done_at: row.done_at ?? null,
    replied_at: row.replied_at ?? null,
    durable_evidence_urls: durableEvidenceUrls,
  }

  if (messageType === 'chat' || messageType === 'notice' || messageType === 'projection' || messageType === 'report') {
    const code = 'COMPLETE_RECOVERY_REPORT_ONLY' as const
    const evidence = { ...baseEvidence, reason: 'message_type is deliver-only / non-actionable evidence' }
    return {
      result: completeRecoveryResultFromBlocker(role, row, 'FAIL', [code], durableEvidenceUrls, evidence),
      blockers: [completeRecoveryBlocker(code, role, row, evidence)],
    }
  }

  if (queueStatus === 'pending' || queueStatus === 'read') {
    const code = 'COMPLETE_RECOVERY_PENDING_UNCLAIMED' as const
    const evidence = { ...baseEvidence, reason: 'queue row has not been claimed or processed' }
    return {
      result: completeRecoveryResultFromBlocker(role, row, 'FAIL', [code], durableEvidenceUrls, evidence),
      blockers: [completeRecoveryBlocker(code, role, row, evidence)],
    }
  }

  if (queueStatus === 'received' || queueStatus === 'in_progress') {
    const code = 'COMPLETE_RECOVERY_NOT_PROCESSED' as const
    const evidence = { ...baseEvidence, reason: 'queue row is claimed but has no terminal processed evidence' }
    return {
      result: completeRecoveryResultFromBlocker(role, row, 'BLOCKED', [code], durableEvidenceUrls, evidence),
      blockers: [completeRecoveryBlocker(code, role, row, evidence)],
    }
  }

  const payloadHasRunnerResult = isRecord(payload.runner_result)
  const payloadHasWritebackResult = isRecord(payload.writeback_result)
  const processed = Boolean(row.claimed_at) && (
    Boolean(row.done_at)
    || Boolean(row.replied_at)
    || payloadHasRunnerResult
    || payloadHasWritebackResult
  )
  if (!processed || queueStatus === 'failed' || queueStatus === 'skipped') {
    const code = 'COMPLETE_RECOVERY_NOT_PROCESSED' as const
    const evidence = { ...baseEvidence, reason: 'terminal row does not prove successful bot processing' }
    return {
      result: completeRecoveryResultFromBlocker(role, row, 'FAIL', [code], durableEvidenceUrls, evidence),
      blockers: [completeRecoveryBlocker(code, role, row, evidence)],
    }
  }

  if (durableEvidenceUrls.length === 0 || role.require_github_writeback) {
    const hasGithubEvidence = durableEvidenceUrls.some((url) => /^https:\/\/github\.com\/\S+/i.test(url))
    if (!hasGithubEvidence) {
      const code = 'COMPLETE_RECOVERY_DURABLE_EVIDENCE_MISSING' as const
      const evidence = { ...baseEvidence, reason: 'processed row has no durable GitHub evidence URL' }
      return {
        result: completeRecoveryResultFromBlocker(role, row, 'FAIL', [code], durableEvidenceUrls, evidence),
        blockers: [completeRecoveryBlocker(code, role, row, evidence)],
      }
    }
  }

  return {
    result: completeRecoveryResultFromBlocker(role, row, 'PASS', [], durableEvidenceUrls, baseEvidence),
    blockers: [],
  }
}

async function buildCompleteRecoveryReadiness(
  db: Queryable,
  scope: RecoveryReadinessScope,
): Promise<{ readiness: CompleteRecoveryReadiness; blockers: RecoveryReadinessBlocker[] }> {
  const completeScope = normalizeCompleteRecoveryScope(scope)
  if (!completeScope.enabled) {
    return {
      readiness: {
        enabled: false,
        slo_seconds: completeScope.slo_seconds,
        summary: { pass: 0, fail: 0, blocked: 0, untested: 0, excluded: 0 },
        role_results: [],
      },
      blockers: [],
    }
  }

  if (completeScope.required_roles.length === 0) {
    const role = normalizeCompleteRecoveryRole({ role: 'complete-recovery' }, 0)
    const code = 'COMPLETE_RECOVERY_UNTESTED' as const
    const evidence = { reason: 'complete_recovery.enabled=true but required_roles is empty' }
    return {
      readiness: {
        enabled: true,
        slo_seconds: completeScope.slo_seconds,
        summary: { pass: 0, fail: 0, blocked: 0, untested: 1, excluded: 0 },
        role_results: [completeRecoveryResultFromBlocker(role, null, 'UNTESTED', [code], [], evidence)],
      },
      blockers: [completeRecoveryBlocker(code, role, null, evidence)],
    }
  }

  const evaluated = await Promise.all(completeScope.required_roles
    .map((raw, index) => evaluateCompleteRecoveryRole(db, normalizeCompleteRecoveryRole(raw, index))))
  const roleResults = evaluated.map((item) => item.result)
  const summary = {
    pass: roleResults.filter((item) => item.status === 'PASS').length,
    fail: roleResults.filter((item) => item.status === 'FAIL').length,
    blocked: roleResults.filter((item) => item.status === 'BLOCKED').length,
    untested: roleResults.filter((item) => item.status === 'UNTESTED').length,
    excluded: roleResults.filter((item) => item.status === 'EXCLUDED').length,
  }
  return {
    readiness: {
      enabled: true,
      slo_seconds: completeScope.slo_seconds,
      summary,
      role_results: roleResults,
    },
    blockers: evaluated.flatMap((item) => item.blockers),
  }
}

function recommendedCommands(report: {
  scopeAgentIds: string[]
  plistPath: string | null
  blockers: RecoveryReadinessBlocker[]
}): string[] {
  const commands: string[] = []
  for (const agentId of report.scopeAgentIds) {
    commands.push(`agent-com queue cp70-preflight --agent-id ${agentId} --format json`)
  }
  if (report.plistPath) {
    commands.push(`bun scripts/state-daemon-launchagent.ts preflight --plist ${report.plistPath}`)
  }
  if (report.blockers.some((blocker) => blocker.component === 'projection')) {
    commands.push('agent-com diagnose-projection --channel 1487368919613444156 --from codex-cto --to ceo --format json')
  }
  if (report.blockers.some((blocker) => blocker.component === 'complete_recovery')) {
    commands.push('agent-com recovery readiness --scope-file <complete-recovery-scope.json> --format json')
  }
  return Array.from(new Set(commands))
}

export async function buildRecoveryReadinessReport(
  db: Queryable,
  scope: RecoveryReadinessScope,
  options: RecoveryReadinessOptions = {},
): Promise<RecoveryReadinessReport> {
  const now = options.now ?? (() => new Date())
  const projectionChecks = normalizeProjectionChecks(scope).map(normalizeProjectionCheck)
  const scopeAgentIds = cp70AgentScopes(scope, projectionChecks)
  const staleMinutes = numericMinutes(scope.cp70?.stale_minutes ?? scope.cp70?.staleMinutes ?? scope.queue?.stale_minutes ?? scope.queue?.staleMinutes, 15)
  const cp70Targets = scopeAgentIds.length > 0 ? scopeAgentIds : [null]
  const cp70Reports = await Promise.all(cp70Targets.map(async (agentId) => {
    const report = await buildCp70DoctorReport(db, {
      agentId,
      staleSeconds: staleMinutes * 60,
      inspectLaunchAgent: false,
      now,
    })
    return { report, preflight: buildCp70Preflight(report) }
  }))
  const cp70Blockers = cp70Reports
    .flatMap(({ report }) => report.findings)
    .filter((finding) => finding.severity === 'blocker' && finding.count > 0)
    .map(blockerFromCp70Finding)
    .filter((blocker): blocker is RecoveryReadinessBlocker => blocker !== null)
  const launch = buildLaunchAgentReadiness(scope, options)
  const projection = await Promise.all(projectionChecks.map((check) => buildProjectionReadiness(db, check)))
  const completeRecovery = await buildCompleteRecoveryReadiness(db, scope)
  const blockers = [
    ...activationScopeBlockers(scope, projectionChecks),
    ...cp70Blockers,
    ...launch.blockers,
    ...projection.flatMap((item) => item.blockers),
    ...completeRecovery.blockers,
  ]
  const agents = uniqueStrings([...uniqueStrings(scope.agents), ...scopeAgentIds])
  const channels = uniqueStrings([...uniqueStrings(scope.channels), ...projectionChecks.map((check) => check.channel_id)])
  const ok = blockers.length === 0
  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: now().toISOString(),
    scope: {
      scope_id: optionString(scope.scope_id, scope.scopeId),
      agents,
      channels,
      state_daemon_expected: scope.state_daemon?.expected !== false,
      projection_checks: projectionChecks.map((check) => ({
        name: check.name,
        channel_id: check.channel_id,
        sender_agent_id: check.sender_agent_id,
        recipient_agent_ids: check.recipient_agent_ids,
      })),
    },
    policy: {
      read_only: true,
      dry_run_default: true,
      no_db_mutation: true,
      no_queue_cleanup_apply: true,
      no_state_daemon_restart: true,
      no_discord_activation: true,
      no_live_codex_or_claude_calls: true,
      no_next_inbox_fifo_drain: true,
      no_prompt_driven_processing: true,
      exact_activation_scope_required: true,
    },
    cp70: {
      reports: cp70Reports,
      failed_blocker_codes: Array.from(new Set(cp70Reports.flatMap(({ preflight }) => preflight.failed_blocker_codes))),
    },
    launchagent: launch.readiness,
    queue_readiness: queueReadinessFromCp70(scopeAgentIds, cp70Reports),
    projection_readiness: projection.map((item) => item.readiness),
    complete_recovery: completeRecovery.readiness,
    blockers,
    recommended_next_commands: recommendedCommands({
      scopeAgentIds,
      plistPath: launch.readiness.plist_path,
      blockers,
    }),
    mutation_performed: false,
  }
}

export function formatRecoveryReadinessText(report: RecoveryReadinessReport): string {
  const lines = [
    'CP-80 Recovery Readiness',
    `Result: ${report.go_no_go}`,
    `Scope: ${report.scope.scope_id ?? '(unnamed)'}`,
    `Agents: ${report.scope.agents.join(', ') || '(none)'}`,
    `Channels: ${report.scope.channels.join(', ') || '(none)'}`,
    '',
    'Policy: read-only, dry-run default, no DB mutation, no restart, no Discord activation, no next/inbox/FIFO drain',
    '',
    `LaunchAgent: ${report.launchagent.runtime.status} loaded=${String(report.launchagent.runtime.launchd.loaded)} running=${String(report.launchagent.runtime.launchd.running)}`,
    `Queue pending backlog: ${report.queue_readiness.pending_backlog.total}`,
    `Projection checks: ${report.projection_readiness.map((item) => `${item.name}=${item.ok ? 'ok' : item.blocker_codes.join('|')}`).join(', ') || '(none)'}`,
    `Complete recovery: ${report.complete_recovery.enabled ? `pass=${report.complete_recovery.summary.pass} fail=${report.complete_recovery.summary.fail} blocked=${report.complete_recovery.summary.blocked} untested=${report.complete_recovery.summary.untested} excluded=${report.complete_recovery.summary.excluded}` : 'disabled'}`,
    '',
    'Blockers:',
    ...(report.blockers.length === 0
      ? ['  none']
      : report.blockers.map((blocker) => `  [${blocker.component}] ${blocker.code}: ${blocker.subject_id ?? '(scope)'}`)),
    '',
    'Recommended next commands:',
    ...(report.recommended_next_commands.length === 0
      ? ['  none']
      : report.recommended_next_commands.map((command) => `  ${command}`)),
    '',
    `Mutation performed: ${String(report.mutation_performed)}`,
  ]
  return `${lines.join('\n')}\n`
}
