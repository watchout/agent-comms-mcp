export const GITHUB_WORK_EVENT_LOG_CORE_VERSION = 'github_work_event_log_core_v1' as const
export const GITHUB_WORK_QUEUE_VIEW_VERSION = 'github_work_queue_view_v1' as const

export type GithubWorkEventType =
  | 'github_work.item_seen'
  | 'github_work.dispatch_planned'
  | 'github_work.claim_requested'
  | 'github_work.claim_won'
  | 'github_work.claim_lost'
  | 'github_work.duplicate_suppressed'
  | 'github_work.blocked'
  | 'github_work.dispatch_failed'

export type GithubWorkEventStatus =
  | 'plan_only'
  | 'dry_run'
  | 'would_queue'
  | 'claim_requested'
  | 'claim_won'
  | 'claim_lost'
  | 'duplicate_suppressed'
  | 'blocked'
  | 'dispatch_failed'

export type GithubWorkRoute = 'fast' | 'protected' | 'manual'
export type GithubWorkRunnerPolicy =
  | 'codex_native_fast_lane'
  | 'claude_code_autonomous_lane'
  | 'headless_runtime_adapter_lane'
  | 'governed_manual_lane'
  | 'stop_lane'

export type GithubWorkClaimPhase =
  | 'not_applicable'
  | 'claim_requested'
  | 'settle_and_reread'
  | 'claim_won'
  | 'claim_lost'
  | 'work_blocked'

export type GithubWorkPollProfileId =
  | 'serial_seat_default'
  | 'audit_pool_profile'
  | 'protected_surface_gate_profile'

export interface GithubWorkClaimConfirmation {
  work_key: string | null
  claim_id: string | null
  claimant_seat: string | null
  github_created_at: string | null
  lease_expires_at: string | null
  phase: GithubWorkClaimPhase
  settle_window_ms: number
  reread_after_settle: boolean
  stable_event_set: boolean
  stable_event_set_rule: 'two_consecutive_reads_or_contract_unstable'
  deterministic_winner_rule: 'earliest_github_created_at_tie_claim_id'
  confirmed_winner_claim_id: string | null
  winner_confirmation_required_before_execution: true
  winner_execution_precondition_met: boolean
  runtime_execution_performed: false
  result_publication_performed: false
}

export interface GithubWorkPollProfile {
  profile_id: GithubWorkPollProfileId
  source_ref: string
  poll_interval_ms: number
  jitter_ms_min: number
  jitter_ms_max: number
  max_in_flight_claims_per_seat: 1
  max_new_claims_per_poll: 1
  pool_width_source: string | null
  race_behavior: 'two_phase_claim_confirmation'
  no_poll_overlap: true
  api_rate_limit_backoff: 'exponential_backoff_with_jitter'
  repo_hammer_guard: 'etag_or_if_none_match_when_available'
  missed_signal_recovery: {
    signal_required_for_discovery: false
    next_poll_discovers_work: boolean
    claim_possible_without_human_relay: boolean
  }
  starvation_guard: {
    unclaimed_after_one_lead_tick: 'lead_nudges_pool_with_queue_view_refs'
    unclaimed_after_two_lead_ticks: 'owner_escalation_as_capacity_signal'
    metrics_derive_from_events: string[]
  }
}

export interface GithubWorkProtectedSurfaceClassifierInput {
  declared_protected_surface: boolean
  title: string
  body: string
  labels: string[]
  changed_paths: string[]
  declared_operations: string[]
  route_labels: string[]
  owner_decision_url: string | null
}

export interface GithubWorkProtectedSurfaceClassification {
  classification_source: 'independent_classifier_v1'
  declared_protected_surface: boolean
  protected_surface_classified: boolean
  protected_surface_reasons: string[]
  owner_decision_required: boolean
  owner_decision_url: string | null
  claim_allowed: boolean
  queue_view_state: 'claimable' | 'blocked'
  blocker_codes: string[]
}

export interface GithubWorkProtectedSurfaceContract extends GithubWorkProtectedSurfaceClassification {
  classifier_inputs: GithubWorkProtectedSurfaceClassifierInput
}

export interface GithubWorkClaimRaceResult {
  work_key: string | null
  candidate_claim_ids: string[]
  deterministic_winner_claim_id: string | null
  confirmed_winner_count: number
  losing_claim_ids: string[]
  loser_runtime_execution_performed: boolean
  loser_result_publication_performed: boolean
  errors: string[]
}

export interface GithubWorkEventLogCore {
  schema_version: typeof GITHUB_WORK_EVENT_LOG_CORE_VERSION
  event_id: string
  event_type: GithubWorkEventType
  recorded_at: string
  recorded_by: string
  control_source: string
  lane: 'P1_contract_only'
  status: GithubWorkEventStatus
  github: {
    repo: string
    kind: 'issue' | 'pull_request'
    number: number
    url: string
    node_id: string
    activity_cursor: string
    fingerprint: string
    labels: string[]
  }
  route: {
    role: string | null
    owner: string | null
    route: GithubWorkRoute
    runner_policy: GithubWorkRunnerPolicy
    protected: boolean
    autonomous_execution_allowed: false
  }
  queue: {
    queue_id: null
    agent_id: string | null
    status: null
  }
  claim: GithubWorkClaimConfirmation
  poll_profile: GithubWorkPollProfile
  protected_surface: GithubWorkProtectedSurfaceContract
  evidence: {
    ssot: 'github'
    aun_is_acceleration_only: true
    completion_evidence_not_accepted: string[]
    mutation_performed: false
    live_github_api_performed: false
    live_canary_performed: false
    daemon_or_scheduler_touched: false
    token_used: false
    db_queue_mutation_performed: false
    repo_settings_changed: false
    workflow_changed: false
    deploy_changed: false
  }
  blocker_codes: string[]
  notes: string[]
}

export interface GithubWorkQueueView {
  schema_version: typeof GITHUB_WORK_QUEUE_VIEW_VERSION
  repo: string
  kind: 'issue' | 'pull_request'
  number: number
  url: string
  fingerprint: string
  status: GithubWorkEventStatus
  role: string | null
  owner: string | null
  route: GithubWorkRoute
  runner_policy: GithubWorkRunnerPolicy
  protected: boolean
  autonomous_execution_allowed: boolean
  queue_id: string | null
  queue_status: string | null
  claim_allowed: boolean
  protected_surface_classified: boolean
  owner_decision_required: boolean
  owner_decision_url: string | null
  event_count: number
  latest_event_id: string
  blocker_codes: string[]
  ssot: 'github'
  aun_is_acceleration_only: true
  p2_required_for_execution: true
  mutation_performed: false
}

export type EventLogCoreParseResult =
  | { ok: true; event: GithubWorkEventLogCore }
  | { ok: false; errors: string[] }

const EVENT_TYPES: readonly GithubWorkEventType[] = [
  'github_work.item_seen',
  'github_work.dispatch_planned',
  'github_work.claim_requested',
  'github_work.claim_won',
  'github_work.claim_lost',
  'github_work.duplicate_suppressed',
  'github_work.blocked',
  'github_work.dispatch_failed',
]

const STATUSES: readonly GithubWorkEventStatus[] = [
  'plan_only',
  'dry_run',
  'would_queue',
  'claim_requested',
  'claim_won',
  'claim_lost',
  'duplicate_suppressed',
  'blocked',
  'dispatch_failed',
]

const ROUTES: readonly GithubWorkRoute[] = ['fast', 'protected', 'manual']

const RUNNER_POLICIES: readonly GithubWorkRunnerPolicy[] = [
  'codex_native_fast_lane',
  'claude_code_autonomous_lane',
  'headless_runtime_adapter_lane',
  'governed_manual_lane',
  'stop_lane',
]

const CLAIM_PHASES: readonly GithubWorkClaimPhase[] = [
  'not_applicable',
  'claim_requested',
  'settle_and_reread',
  'claim_won',
  'claim_lost',
  'work_blocked',
]

const POLL_PROFILE_IDS: readonly GithubWorkPollProfileId[] = [
  'serial_seat_default',
  'audit_pool_profile',
  'protected_surface_gate_profile',
]

const REQUIRED_REJECTED_COMPLETION_EVIDENCE = [
  'aun_ack',
  'queue_id',
  'discord_projection',
  'tui_visibility',
  'green_ci_alone',
]

const FORBIDDEN_EVIDENCE_FLAGS = [
  'mutation_performed',
  'live_github_api_performed',
  'live_canary_performed',
  'daemon_or_scheduler_touched',
  'token_used',
  'db_queue_mutation_performed',
  'repo_settings_changed',
  'workflow_changed',
  'deploy_changed',
] as const

export function parseEventLogCoreJson(text: string): EventLogCoreParseResult {
  try {
    return parseEventLogCore(JSON.parse(text))
  } catch (err) {
    return { ok: false, errors: [`json_parse_failed:${err instanceof Error ? err.message : String(err)}`] }
  }
}

export function parseEventLogCore(input: unknown): EventLogCoreParseResult {
  const errors: string[] = []
  if (!isRecord(input)) return { ok: false, errors: ['event_must_be_object'] }

  expectLiteral(input, 'schema_version', GITHUB_WORK_EVENT_LOG_CORE_VERSION, errors)
  expectString(input, 'event_id', errors)
  expectEnum(input, 'event_type', EVENT_TYPES, errors)
  expectString(input, 'recorded_at', errors)
  expectString(input, 'recorded_by', errors)
  expectString(input, 'control_source', errors)
  expectLiteral(input, 'lane', 'P1_contract_only', errors)
  expectEnum(input, 'status', STATUSES, errors)

  const github = expectRecord(input, 'github', errors)
  if (github) {
    expectString(github, 'repo', errors, 'github.repo')
    expectEnum(github, 'kind', ['issue', 'pull_request'] as const, errors, 'github.kind')
    expectPositiveInteger(github, 'number', errors, 'github.number')
    expectString(github, 'url', errors, 'github.url')
    expectString(github, 'node_id', errors, 'github.node_id')
    expectString(github, 'activity_cursor', errors, 'github.activity_cursor')
    expectString(github, 'fingerprint', errors, 'github.fingerprint')
    expectStringArray(github, 'labels', errors, 'github.labels')
  }

  const route = expectRecord(input, 'route', errors)
  if (route) {
    expectNullableString(route, 'role', errors, 'route.role')
    expectNullableString(route, 'owner', errors, 'route.owner')
    expectEnum(route, 'route', ROUTES, errors, 'route.route')
    expectEnum(route, 'runner_policy', RUNNER_POLICIES, errors, 'route.runner_policy')
    expectBoolean(route, 'protected', errors, 'route.protected')
    expectLiteral(route, 'autonomous_execution_allowed', false, errors, 'route.autonomous_execution_allowed')
  }

  const queue = expectRecord(input, 'queue', errors)
  if (queue) {
    expectLiteral(queue, 'queue_id', null, errors, 'queue.queue_id')
    expectNullableString(queue, 'agent_id', errors, 'queue.agent_id')
    expectLiteral(queue, 'status', null, errors, 'queue.status')
  }

  const claim = expectRecord(input, 'claim', errors)
  if (claim) validateClaimConfirmation(claim, errors)

  const pollProfile = expectRecord(input, 'poll_profile', errors)
  if (pollProfile) validatePollProfile(pollProfile, errors)

  const protectedSurface = expectRecord(input, 'protected_surface', errors)
  if (protectedSurface) validateProtectedSurfaceContract(protectedSurface, input, errors)

  const evidence = expectRecord(input, 'evidence', errors)
  if (evidence) {
    expectLiteral(evidence, 'ssot', 'github', errors, 'evidence.ssot')
    expectLiteral(evidence, 'aun_is_acceleration_only', true, errors, 'evidence.aun_is_acceleration_only')
    const rejected = expectStringArray(evidence, 'completion_evidence_not_accepted', errors, 'evidence.completion_evidence_not_accepted')
    for (const required of REQUIRED_REJECTED_COMPLETION_EVIDENCE) {
      if (rejected && !rejected.includes(required)) {
        errors.push(`evidence.completion_evidence_not_accepted_missing:${required}`)
      }
    }
    for (const flag of FORBIDDEN_EVIDENCE_FLAGS) {
      expectLiteral(evidence, flag, false, errors, `evidence.${flag}`)
    }
  }

  expectStringArray(input, 'blocker_codes', errors)
  expectStringArray(input, 'notes', errors)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, event: input as GithubWorkEventLogCore }
}

export function projectQueueView(events: GithubWorkEventLogCore[]): GithubWorkQueueView {
  if (events.length === 0) throw new Error('projectQueueView requires at least one EventLogCore event')
  const sorted = [...events].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.event_id.localeCompare(b.event_id))
  const latest = sorted[sorted.length - 1]
  const blockerCodes = Array.from(new Set(sorted.flatMap((event) => event.blocker_codes))).sort()
  return {
    schema_version: GITHUB_WORK_QUEUE_VIEW_VERSION,
    repo: latest.github.repo,
    kind: latest.github.kind,
    number: latest.github.number,
    url: latest.github.url,
    fingerprint: latest.github.fingerprint,
    status: latest.status,
    role: latest.route.role,
    owner: latest.route.owner,
    route: latest.route.route,
    runner_policy: latest.route.runner_policy,
    protected: latest.route.protected,
    autonomous_execution_allowed: latest.route.autonomous_execution_allowed,
    queue_id: latest.queue.queue_id,
    queue_status: latest.queue.status,
    claim_allowed: latest.status !== 'blocked' && latest.blocker_codes.length === 0 && latest.protected_surface.claim_allowed,
    protected_surface_classified: latest.protected_surface.protected_surface_classified,
    owner_decision_required: latest.protected_surface.owner_decision_required,
    owner_decision_url: latest.protected_surface.owner_decision_url,
    event_count: sorted.length,
    latest_event_id: latest.event_id,
    blocker_codes: blockerCodes,
    ssot: 'github',
    aun_is_acceleration_only: true,
    p2_required_for_execution: true,
    mutation_performed: false,
  }
}

export function evaluateTwoPhaseClaimRace(
  events: GithubWorkEventLogCore[],
  options: { now?: string } = {},
): GithubWorkClaimRaceResult {
  const now = Date.parse(options.now ?? new Date().toISOString())
  const candidates = events.filter((event) => event.claim.phase === 'claim_requested')
  const candidateClaimIds = candidates.map((event) => event.claim.claim_id).filter((claimId): claimId is string => claimId !== null)
  const workKey = candidates[0]?.claim.work_key ?? null
  const validCandidates = candidates.filter((event) => {
    const leaseExpiresAt = event.claim.lease_expires_at ? Date.parse(event.claim.lease_expires_at) : Number.NaN
    return (
      event.claim.work_key === workKey &&
      event.claim.claim_id !== null &&
      event.claim.claimant_seat !== null &&
      Number.isFinite(leaseExpiresAt) &&
      leaseExpiresAt > now &&
      event.protected_surface.claim_allowed &&
      !event.claim.winner_execution_precondition_met &&
      !event.claim.runtime_execution_performed &&
      !event.claim.result_publication_performed
    )
  })
  const sortedValid = [...validCandidates].sort((a, b) => {
    const createdAt = compareNullableString(a.claim.github_created_at, b.claim.github_created_at)
    if (createdAt !== 0) return createdAt
    return String(a.claim.claim_id).localeCompare(String(b.claim.claim_id))
  })
  const winnerClaimId = sortedValid[0]?.claim.claim_id ?? null
  const losingClaimIds = sortedValid
    .map((event) => event.claim.claim_id)
    .filter((claimId): claimId is string => claimId !== null && claimId !== winnerClaimId)
  const winnerEvents = events.filter(
    (event) => event.claim.phase === 'claim_won' && event.claim.confirmed_winner_claim_id === winnerClaimId,
  )
  const loserEvents = events.filter((event) => event.claim.claim_id !== null && losingClaimIds.includes(event.claim.claim_id))
  const errors: string[] = []

  if (candidateClaimIds.length < 2) errors.push('synthetic_two_seat_race_requires_two_candidate_claims')
  if (new Set(candidateClaimIds).size !== candidateClaimIds.length) errors.push('claim_ids_must_be_unique')
  if (winnerClaimId === null) errors.push('deterministic_winner_missing')
  if (winnerEvents.length !== 1) errors.push('exactly_one_claim_won_event_required')
  if (winnerEvents[0]?.claim.claim_id !== winnerClaimId) errors.push('claim_won_event_must_belong_to_deterministic_winner')
  for (const claimId of losingClaimIds) {
    const lost = loserEvents.some((event) => event.claim.claim_id === claimId && event.claim.phase === 'claim_lost')
    if (!lost) errors.push(`losing_claim_missing_claim_lost:${claimId}`)
  }

  const loserRuntimeExecutionPerformed = loserEvents.some((event) => event.claim.runtime_execution_performed)
  const loserResultPublicationPerformed = loserEvents.some((event) => event.claim.result_publication_performed)
  if (loserRuntimeExecutionPerformed) errors.push('losing_seat_executes_work')
  if (loserResultPublicationPerformed) errors.push('losing_seat_publishes_result')

  return {
    work_key: workKey,
    candidate_claim_ids: candidateClaimIds,
    deterministic_winner_claim_id: winnerClaimId,
    confirmed_winner_count: winnerEvents.length,
    losing_claim_ids: losingClaimIds,
    loser_runtime_execution_performed: loserRuntimeExecutionPerformed,
    loser_result_publication_performed: loserResultPublicationPerformed,
    errors,
  }
}

export function classifyProtectedSurface(
  input: GithubWorkProtectedSurfaceClassifierInput,
): GithubWorkProtectedSurfaceClassification {
  const text = [
    input.title,
    input.body,
    ...input.labels,
    ...input.route_labels,
    ...input.declared_operations,
    ...input.changed_paths,
  ]
    .join('\n')
    .toLowerCase()
  const reasons: string[] = []
  const addReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (text.includes('runner:aun-runner') || text.includes('aun runner') || text.includes('runtime activation')) {
    addReason('runner_runtime_activation')
  }
  if (
    input.changed_paths.some(
      (path) =>
        path === 'bin/state-daemon.ts' ||
        path === 'core/state-daemon/index.ts' ||
        path.includes('queue-work') ||
        path.toLowerCase().includes('scheduler'),
    ) ||
    text.includes('state-daemon enablement') ||
    text.includes('queue-work scheduler')
  ) {
    addReason('state_daemon_or_scheduler_enablement')
  }
  if (
    input.changed_paths.some((path) => path.toLowerCase().includes('launchagent') || path.endsWith('.plist')) ||
    text.includes('launchd') ||
    text.includes('plist')
  ) {
    addReason('launchd_or_plist_activation')
  }
  if (text.includes('token') || text.includes('secret') || text.includes('credential')) {
    addReason('token_or_secret_source')
  }
  if (text.includes('db schema') || text.includes('database schema') || text.includes('db queue') || text.includes('queue lifecycle')) {
    addReason('db_or_queue_lifecycle_mutation')
  }
  if (
    input.changed_paths.some((path) => path.startsWith('.github/workflows/')) ||
    text.includes('branch protection') ||
    text.includes('ruleset') ||
    text.includes('required check') ||
    text.includes('workflow')
  ) {
    addReason('repo_settings_or_workflow')
  }
  if (text.includes('deploy') || text.includes('production')) addReason('deploy_or_production')
  if (text.includes('pricing') || text.includes('billing')) addReason('pricing_or_billing')
  if (text.includes('contract .v2') || text.includes('contract.v2')) addReason('contract_v2')

  const protectedSurfaceClassified = reasons.length > 0
  const ownerDecisionUrl = input.owner_decision_url
  const hasOwnerDecision = ownerDecisionUrl !== null && ownerDecisionUrl.trim().length > 0
  const blockerCodes: string[] = []
  if (protectedSurfaceClassified && !hasOwnerDecision) blockerCodes.push('PROTECTED_SURFACE_OWNER_REQUIRED')
  if (input.declared_protected_surface && !protectedSurfaceClassified) blockerCodes.push('CONTRACT_INVALID')
  const queueViewState = blockerCodes.length > 0 ? 'blocked' : 'claimable'

  return {
    classification_source: 'independent_classifier_v1',
    declared_protected_surface: input.declared_protected_surface,
    protected_surface_classified: protectedSurfaceClassified,
    protected_surface_reasons: reasons,
    owner_decision_required: protectedSurfaceClassified && !hasOwnerDecision,
    owner_decision_url: ownerDecisionUrl,
    claim_allowed: queueViewState === 'claimable',
    queue_view_state: queueViewState,
    blocker_codes: blockerCodes,
  }
}

function validateClaimConfirmation(input: Record<string, unknown>, errors: string[]): void {
  const phase = input.phase
  expectNullableString(input, 'work_key', errors, 'claim.work_key')
  expectNullableString(input, 'claim_id', errors, 'claim.claim_id')
  expectNullableString(input, 'claimant_seat', errors, 'claim.claimant_seat')
  expectNullableString(input, 'github_created_at', errors, 'claim.github_created_at')
  expectNullableString(input, 'lease_expires_at', errors, 'claim.lease_expires_at')
  expectEnum(input, 'phase', CLAIM_PHASES, errors, 'claim.phase')
  expectNonNegativeInteger(input, 'settle_window_ms', errors, 'claim.settle_window_ms')
  expectBoolean(input, 'reread_after_settle', errors, 'claim.reread_after_settle')
  expectBoolean(input, 'stable_event_set', errors, 'claim.stable_event_set')
  expectLiteral(
    input,
    'stable_event_set_rule',
    'two_consecutive_reads_or_contract_unstable',
    errors,
    'claim.stable_event_set_rule',
  )
  expectLiteral(
    input,
    'deterministic_winner_rule',
    'earliest_github_created_at_tie_claim_id',
    errors,
    'claim.deterministic_winner_rule',
  )
  expectNullableString(input, 'confirmed_winner_claim_id', errors, 'claim.confirmed_winner_claim_id')
  expectLiteral(
    input,
    'winner_confirmation_required_before_execution',
    true,
    errors,
    'claim.winner_confirmation_required_before_execution',
  )
  expectBoolean(input, 'winner_execution_precondition_met', errors, 'claim.winner_execution_precondition_met')
  expectLiteral(input, 'runtime_execution_performed', false, errors, 'claim.runtime_execution_performed')
  expectLiteral(input, 'result_publication_performed', false, errors, 'claim.result_publication_performed')

  if (phase === 'claim_requested') {
    expectLiteral(input, 'confirmed_winner_claim_id', null, errors, 'claim.confirmed_winner_claim_id')
    expectLiteral(input, 'winner_execution_precondition_met', false, errors, 'claim.winner_execution_precondition_met')
  }
  if (phase === 'claim_won') {
    if (input.claim_id === null) errors.push('claim.claim_won_requires_claim_id')
    if (input.claim_id !== input.confirmed_winner_claim_id) errors.push('claim.claim_won_requires_self_as_confirmed_winner')
    expectLiteral(input, 'reread_after_settle', true, errors, 'claim.reread_after_settle')
    expectLiteral(input, 'stable_event_set', true, errors, 'claim.stable_event_set')
    expectLiteral(input, 'winner_execution_precondition_met', true, errors, 'claim.winner_execution_precondition_met')
  }
  if (phase === 'claim_lost') {
    expectLiteral(input, 'winner_execution_precondition_met', false, errors, 'claim.winner_execution_precondition_met')
  }
  if (phase === 'work_blocked') {
    expectLiteral(input, 'winner_execution_precondition_met', false, errors, 'claim.winner_execution_precondition_met')
  }
}

function validatePollProfile(input: Record<string, unknown>, errors: string[]): void {
  const profileId = input.profile_id
  expectEnum(input, 'profile_id', POLL_PROFILE_IDS, errors, 'poll_profile.profile_id')
  expectString(input, 'source_ref', errors, 'poll_profile.source_ref')
  expectPositiveInteger(input, 'poll_interval_ms', errors, 'poll_profile.poll_interval_ms')
  expectNonNegativeInteger(input, 'jitter_ms_min', errors, 'poll_profile.jitter_ms_min')
  expectNonNegativeInteger(input, 'jitter_ms_max', errors, 'poll_profile.jitter_ms_max')
  expectLiteral(input, 'max_in_flight_claims_per_seat', 1, errors, 'poll_profile.max_in_flight_claims_per_seat')
  expectLiteral(input, 'max_new_claims_per_poll', 1, errors, 'poll_profile.max_new_claims_per_poll')
  expectNullableString(input, 'pool_width_source', errors, 'poll_profile.pool_width_source')
  expectLiteral(input, 'race_behavior', 'two_phase_claim_confirmation', errors, 'poll_profile.race_behavior')
  expectLiteral(input, 'no_poll_overlap', true, errors, 'poll_profile.no_poll_overlap')
  expectLiteral(
    input,
    'api_rate_limit_backoff',
    'exponential_backoff_with_jitter',
    errors,
    'poll_profile.api_rate_limit_backoff',
  )
  expectLiteral(
    input,
    'repo_hammer_guard',
    'etag_or_if_none_match_when_available',
    errors,
    'poll_profile.repo_hammer_guard',
  )

  if (profileId === 'audit_pool_profile') {
    expectLiteral(input, 'source_ref', 'watchout/iyasaka-arc#32', errors, 'poll_profile.source_ref')
    expectLiteral(input, 'poll_interval_ms', 60000, errors, 'poll_profile.poll_interval_ms')
    expectLiteral(input, 'jitter_ms_max', 20000, errors, 'poll_profile.jitter_ms_max')
    if (typeof input.pool_width_source !== 'string' || !input.pool_width_source.includes('evidence_audit_gate')) {
      errors.push('poll_profile.pool_width_source_must_reference_32_evidence_audit_gate_registry')
    }
  }
  if (profileId === 'serial_seat_default' || profileId === 'protected_surface_gate_profile') {
    expectLiteral(input, 'poll_interval_ms', 120000, errors, 'poll_profile.poll_interval_ms')
    expectLiteral(input, 'jitter_ms_max', 30000, errors, 'poll_profile.jitter_ms_max')
  }

  const missedSignalRecovery = expectRecord(
    input,
    'missed_signal_recovery',
    errors,
    'poll_profile.missed_signal_recovery',
  )
  if (missedSignalRecovery) {
    expectLiteral(
      missedSignalRecovery,
      'signal_required_for_discovery',
      false,
      errors,
      'poll_profile.missed_signal_recovery.signal_required_for_discovery',
    )
    expectBoolean(
      missedSignalRecovery,
      'next_poll_discovers_work',
      errors,
      'poll_profile.missed_signal_recovery.next_poll_discovers_work',
    )
    expectBoolean(
      missedSignalRecovery,
      'claim_possible_without_human_relay',
      errors,
      'poll_profile.missed_signal_recovery.claim_possible_without_human_relay',
    )
  }

  const starvationGuard = expectRecord(input, 'starvation_guard', errors, 'poll_profile.starvation_guard')
  if (starvationGuard) {
    expectLiteral(
      starvationGuard,
      'unclaimed_after_one_lead_tick',
      'lead_nudges_pool_with_queue_view_refs',
      errors,
      'poll_profile.starvation_guard.unclaimed_after_one_lead_tick',
    )
    expectLiteral(
      starvationGuard,
      'unclaimed_after_two_lead_ticks',
      'owner_escalation_as_capacity_signal',
      errors,
      'poll_profile.starvation_guard.unclaimed_after_two_lead_ticks',
    )
    const metrics = expectStringArray(
      starvationGuard,
      'metrics_derive_from_events',
      errors,
      'poll_profile.starvation_guard.metrics_derive_from_events',
    )
    for (const metric of [
      'request_to_claim_latency_ms',
      'unclaimed_count_by_function',
      'active_claims_by_seat',
      'claim_lost_count_by_seat',
    ]) {
      if (metrics && !metrics.includes(metric)) {
        errors.push(`poll_profile.starvation_guard.metrics_derive_from_events_missing:${metric}`)
      }
    }
  }
}

function validateProtectedSurfaceContract(
  input: Record<string, unknown>,
  event: Record<string, unknown>,
  errors: string[],
): void {
  expectLiteral(
    input,
    'classification_source',
    'independent_classifier_v1',
    errors,
    'protected_surface.classification_source',
  )
  expectBoolean(input, 'declared_protected_surface', errors, 'protected_surface.declared_protected_surface')
  expectBoolean(input, 'protected_surface_classified', errors, 'protected_surface.protected_surface_classified')
  const protectedSurfaceReasons = expectStringArray(
    input,
    'protected_surface_reasons',
    errors,
    'protected_surface.protected_surface_reasons',
  )
  expectBoolean(input, 'owner_decision_required', errors, 'protected_surface.owner_decision_required')
  expectNullableString(input, 'owner_decision_url', errors, 'protected_surface.owner_decision_url')
  expectBoolean(input, 'claim_allowed', errors, 'protected_surface.claim_allowed')
  expectEnum(input, 'queue_view_state', ['claimable', 'blocked'] as const, errors, 'protected_surface.queue_view_state')

  const classifierInputs = expectRecord(input, 'classifier_inputs', errors, 'protected_surface.classifier_inputs')
  if (!classifierInputs) return
  expectBoolean(
    classifierInputs,
    'declared_protected_surface',
    errors,
    'protected_surface.classifier_inputs.declared_protected_surface',
  )
  expectString(classifierInputs, 'title', errors, 'protected_surface.classifier_inputs.title')
  expectString(classifierInputs, 'body', errors, 'protected_surface.classifier_inputs.body')
  expectStringArray(classifierInputs, 'labels', errors, 'protected_surface.classifier_inputs.labels')
  expectStringArray(classifierInputs, 'changed_paths', errors, 'protected_surface.classifier_inputs.changed_paths')
  expectStringArray(
    classifierInputs,
    'declared_operations',
    errors,
    'protected_surface.classifier_inputs.declared_operations',
  )
  expectStringArray(classifierInputs, 'route_labels', errors, 'protected_surface.classifier_inputs.route_labels')
  expectNullableString(
    classifierInputs,
    'owner_decision_url',
    errors,
    'protected_surface.classifier_inputs.owner_decision_url',
  )
  if (errors.some((error) => error.startsWith('protected_surface.classifier_inputs.'))) return

  const computed = classifyProtectedSurface(classifierInputs as unknown as GithubWorkProtectedSurfaceClassifierInput)
  if (input.declared_protected_surface !== computed.declared_protected_surface) {
    errors.push('protected_surface.declared_protected_surface_mismatch')
  }
  if (input.protected_surface_classified !== computed.protected_surface_classified) {
    errors.push('protected_surface.protected_surface_classified_mismatch')
  }
  if (input.owner_decision_required !== computed.owner_decision_required) {
    errors.push('protected_surface.owner_decision_required_mismatch')
  }
  if (input.owner_decision_url !== computed.owner_decision_url) {
    errors.push('protected_surface.owner_decision_url_mismatch')
  }
  if (input.claim_allowed !== computed.claim_allowed) {
    errors.push('protected_surface.claim_allowed_mismatch')
  }
  if (input.queue_view_state !== computed.queue_view_state) {
    errors.push('protected_surface.queue_view_state_mismatch')
  }
  for (const reason of computed.protected_surface_reasons) {
    if (protectedSurfaceReasons && !protectedSurfaceReasons.includes(reason)) {
      errors.push(`protected_surface.protected_surface_reasons_missing:${reason}`)
    }
  }
  const eventBlockerCodes = Array.isArray(event.blocker_codes) ? event.blocker_codes : []
  for (const blocker of computed.blocker_codes) {
    if (!eventBlockerCodes.includes(blocker)) errors.push(`blocker_codes_missing:${blocker}`)
  }
  if (computed.queue_view_state === 'blocked') expectLiteral(event, 'status', 'blocked', errors, 'status')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareNullableString(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a.localeCompare(b)
}

function expectRecord(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): Record<string, unknown> | null {
  const value = input[key]
  if (!isRecord(value)) {
    errors.push(`${label}_must_be_object`)
    return null
  }
  return value
}

function expectString(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): string | null {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label}_must_be_string`)
    return null
  }
  return value
}

function expectNullableString(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): string | null {
  const value = input[key]
  if (value === null) return null
  return expectString(input, key, errors, label)
}

function expectStringArray(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): string[] | null {
  const value = input[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${label}_must_be_string_array`)
    return null
  }
  return value as string[]
}

function expectBoolean(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): void {
  if (typeof input[key] !== 'boolean') errors.push(`${label}_must_be_boolean`)
}

function expectPositiveInteger(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): void {
  const value = input[key]
  if (!Number.isInteger(value) || Number(value) <= 0) errors.push(`${label}_must_be_positive_integer`)
}

function expectNonNegativeInteger(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): void {
  const value = input[key]
  if (!Number.isInteger(value) || Number(value) < 0) errors.push(`${label}_must_be_non_negative_integer`)
}

function expectLiteral(
  input: Record<string, unknown>,
  key: string,
  expected: string | boolean | number | null,
  errors: string[],
  label = key,
): void {
  if (input[key] !== expected) errors.push(`${label}_must_equal_${String(expected)}`)
}

function expectEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  errors: string[],
  label = key,
): void {
  if (typeof input[key] !== 'string' || !allowed.includes(input[key] as T)) {
    errors.push(`${label}_invalid`)
  }
}
