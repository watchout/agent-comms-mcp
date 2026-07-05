export const GITHUB_WORK_EVENT_LOG_CORE_VERSION = 'github_work_event_log_core_v1' as const
export const GITHUB_WORK_QUEUE_VIEW_VERSION = 'github_work_queue_view_v1' as const

export type GithubWorkEventType =
  | 'github_work.item_seen'
  | 'github_work.dispatch_planned'
  | 'github_work.duplicate_suppressed'
  | 'github_work.blocked'
  | 'github_work.dispatch_failed'

export type GithubWorkEventStatus =
  | 'plan_only'
  | 'dry_run'
  | 'would_queue'
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
  'github_work.duplicate_suppressed',
  'github_work.blocked',
  'github_work.dispatch_failed',
]

const STATUSES: readonly GithubWorkEventStatus[] = [
  'plan_only',
  'dry_run',
  'would_queue',
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
    event_count: sorted.length,
    latest_event_id: latest.event_id,
    blocker_codes: blockerCodes,
    ssot: 'github',
    aun_is_acceleration_only: true,
    p2_required_for_execution: true,
    mutation_performed: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectRecord(
  input: Record<string, unknown>,
  key: string,
  errors: string[],
): Record<string, unknown> | null {
  const value = input[key]
  if (!isRecord(value)) {
    errors.push(`${key}_must_be_object`)
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

function expectLiteral(
  input: Record<string, unknown>,
  key: string,
  expected: string | boolean | null,
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
