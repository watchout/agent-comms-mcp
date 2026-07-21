import { createHash } from 'node:crypto'

export const RUNTIME_HEALTH_DIMENSIONS = [
  'agent_runtime',
  'supervisor_session',
  'endpoint_identity',
  'queue_actionable_receive',
  'runtime_presentation_claim',
  'ui_runner_reachability',
  'provider_projection',
] as const

export type RuntimeHealthDimensionName = typeof RUNTIME_HEALTH_DIMENSIONS[number]
export type RuntimeHealthState = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN'
export type RuntimeHealthApplicability = 'APPLICABLE' | 'NOT_APPLICABLE' | 'UNKNOWN'
export type RuntimeHealthProbeResult = 'ok' | 'failed' | 'timeout' | 'exception'

export const RUNTIME_HEALTH_FAIL_CLOSED_REASON_STATES = {
  APPLICABILITY_EVIDENCE_MISSING: 'UNKNOWN',
  APPLICABILITY_UNKNOWN: 'UNKNOWN',
  DIMENSION_DUPLICATED: 'UNKNOWN',
  EVIDENCE_ABSENT: 'UNKNOWN',
  EVIDENCE_INVALID_TIMESTAMP: 'UNKNOWN',
  EVIDENCE_FUTURE_TIMESTAMP: 'UNKNOWN',
  EVIDENCE_STALE: 'UNKNOWN',
  FRESHNESS_LIMIT_INVALID: 'UNKNOWN',
  IDENTITY_MISMATCH: 'DOWN',
  PROBE_EXCEPTION: 'UNKNOWN',
  PROBE_FAILED: 'DOWN',
  PROBE_TIMEOUT: 'UNKNOWN',
} as const satisfies Record<string, RuntimeHealthState>

export interface RuntimeHealthDimensionInput {
  dimension: RuntimeHealthDimensionName
  applicability: RuntimeHealthApplicability
  declared_state: RuntimeHealthState
  reason_code: string
  observed_at: string | null
  freshness_limit_seconds: number
  evidence_refs: string[]
  applicability_evidence_refs?: string[]
  expected_identity?: string | null
  observed_identity?: string | null
  probe_result?: RuntimeHealthProbeResult
}

export interface RuntimeHealthDimensionResult {
  dimension: RuntimeHealthDimensionName
  agent_id: string
  runtime_instance_id: string | null
  applicable: boolean
  state: RuntimeHealthState
  reason_code: string
  observed_at: string | null
  freshness_limit_seconds: number
  evidence_refs: string[]
}

export interface RuntimeHealthEvaluationInput {
  agent_id: string
  runtime_instance_id?: string | null
  dimensions: RuntimeHealthDimensionInput[]
}

export interface RuntimeHealthReport {
  schema_version: 'aun-runtime-health/v1'
  agent_id: string
  runtime_instance_id: string | null
  generated_at: string
  aggregate_state: RuntimeHealthState
  dimensions: RuntimeHealthDimensionResult[]
  mutation_performed: false
}

export interface RuntimeHealthAlertEmission {
  agent_id: string
  dedupe_key: string
  emitted_at: string
}

export interface RuntimeHealthAlertPlan {
  schema_version: 'aun-runtime-health-alert-plan/v1'
  action: 'EMIT' | 'SUPPRESS'
  reason_code: 'NON_HEALTHY' | 'AGGREGATE_HEALTHY' | 'DEDUPE_WINDOW' | 'AGENT_HOURLY_CAP'
  agent_id: string
  runtime_instance_id: string | null
  aggregate_state: RuntimeHealthState
  observed_at: string
  dedupe_key: string
  evidence_refs: string[]
  non_healthy_dimensions: Array<{
    dimension: RuntimeHealthDimensionName
    state: RuntimeHealthState
    reason_code: string
  }>
  dedupe_window_seconds: 300
  per_agent_hourly_cap: 6
  mutation_performed: false
}

const STATE_RANK: Record<RuntimeHealthState, number> = {
  HEALTHY: 0,
  DEGRADED: 1,
  UNKNOWN: 2,
  DOWN: 3,
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort()
}

function failClosedResult(
  input: RuntimeHealthDimensionInput,
  agentId: string,
  runtimeInstanceId: string | null,
  state: RuntimeHealthState,
  reasonCode: string,
  applicable = true,
): RuntimeHealthDimensionResult {
  return {
    dimension: input.dimension,
    agent_id: agentId,
    runtime_instance_id: runtimeInstanceId,
    applicable,
    state,
    reason_code: reasonCode,
    observed_at: input.observed_at,
    freshness_limit_seconds: input.freshness_limit_seconds,
    evidence_refs: uniqueSorted([
      ...input.evidence_refs,
      ...(input.applicability_evidence_refs ?? []),
    ]),
  }
}

function evaluateDimension(
  input: RuntimeHealthDimensionInput,
  agentId: string,
  runtimeInstanceId: string | null,
  nowMs: number,
): RuntimeHealthDimensionResult {
  const applicabilityEvidence = uniqueSorted(input.applicability_evidence_refs ?? [])
  if (input.applicability === 'UNKNOWN') {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'APPLICABILITY_UNKNOWN')
  }
  if (input.applicability === 'NOT_APPLICABLE' && applicabilityEvidence.length === 0) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'APPLICABILITY_EVIDENCE_MISSING')
  }
  if (!Number.isFinite(input.freshness_limit_seconds) || input.freshness_limit_seconds <= 0) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'FRESHNESS_LIMIT_INVALID')
  }

  const evidenceRefs = uniqueSorted(input.evidence_refs)
  if (evidenceRefs.length === 0) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'EVIDENCE_ABSENT')
  }
  if (!input.observed_at) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'EVIDENCE_ABSENT')
  }
  const observedMs = Date.parse(input.observed_at)
  if (!Number.isFinite(observedMs)) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'EVIDENCE_INVALID_TIMESTAMP')
  }
  if (observedMs > nowMs) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'EVIDENCE_FUTURE_TIMESTAMP')
  }
  if (nowMs - observedMs > input.freshness_limit_seconds * 1000) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'EVIDENCE_STALE')
  }

  if (input.applicability === 'NOT_APPLICABLE') {
    return failClosedResult(input, agentId, runtimeInstanceId, 'HEALTHY', 'NOT_APPLICABLE_CONFIRMED', false)
  }
  if (input.probe_result === 'timeout') {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'PROBE_TIMEOUT')
  }
  if (input.probe_result === 'exception') {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'PROBE_EXCEPTION')
  }
  if (input.probe_result === 'failed') {
    return failClosedResult(input, agentId, runtimeInstanceId, 'DOWN', 'PROBE_FAILED')
  }
  if (input.expected_identity && input.observed_identity !== input.expected_identity) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'DOWN', 'IDENTITY_MISMATCH')
  }
  if (!input.reason_code.trim()) {
    return failClosedResult(input, agentId, runtimeInstanceId, 'UNKNOWN', 'STATE_REASON_MISSING')
  }

  return failClosedResult(
    input,
    agentId,
    runtimeInstanceId,
    input.declared_state,
    input.reason_code,
  )
}

function missingDimension(
  dimension: RuntimeHealthDimensionName,
  agentId: string,
  runtimeInstanceId: string | null,
  freshnessLimitSeconds: number,
): RuntimeHealthDimensionResult {
  return {
    dimension,
    agent_id: agentId,
    runtime_instance_id: runtimeInstanceId,
    applicable: true,
    state: 'UNKNOWN',
    reason_code: 'EVIDENCE_ABSENT',
    observed_at: null,
    freshness_limit_seconds: freshnessLimitSeconds,
    evidence_refs: [],
  }
}

export function evaluateRuntimeHealth(
  input: RuntimeHealthEvaluationInput,
  nowMs = Date.now(),
  defaultFreshnessLimitSeconds = 300,
): RuntimeHealthReport {
  const runtimeInstanceId = input.runtime_instance_id?.trim() || null
  const grouped = new Map<RuntimeHealthDimensionName, RuntimeHealthDimensionInput[]>()
  for (const dimensionInput of input.dimensions) {
    const current = grouped.get(dimensionInput.dimension) ?? []
    current.push(dimensionInput)
    grouped.set(dimensionInput.dimension, current)
  }

  const dimensions = RUNTIME_HEALTH_DIMENSIONS.map((dimension) => {
    const matches = grouped.get(dimension) ?? []
    if (matches.length === 0) {
      return missingDimension(dimension, input.agent_id, runtimeInstanceId, defaultFreshnessLimitSeconds)
    }
    if (matches.length > 1) {
      return failClosedResult(
        matches[0],
        input.agent_id,
        runtimeInstanceId,
        'UNKNOWN',
        'DIMENSION_DUPLICATED',
      )
    }
    return evaluateDimension(matches[0], input.agent_id, runtimeInstanceId, nowMs)
  })

  const applicable = dimensions.filter((dimension) => dimension.applicable)
  const aggregateState = applicable.reduce<RuntimeHealthState>((current, dimension) => (
    STATE_RANK[dimension.state] > STATE_RANK[current] ? dimension.state : current
  ), 'HEALTHY')

  return {
    schema_version: 'aun-runtime-health/v1',
    agent_id: input.agent_id,
    runtime_instance_id: runtimeInstanceId,
    generated_at: new Date(nowMs).toISOString(),
    aggregate_state: aggregateState,
    dimensions,
    mutation_performed: false,
  }
}

export function runtimeHealthAlertDedupeKey(report: RuntimeHealthReport): string {
  const dimensionPairs = report.dimensions
    .filter((dimension) => dimension.applicable)
    .map((dimension) => `${dimension.dimension}:${dimension.state}:${dimension.reason_code}`)
    .sort()
  const canonical = JSON.stringify([
    report.agent_id,
    report.runtime_instance_id ?? '',
    dimensionPairs,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

export function planRuntimeHealthAlert(
  report: RuntimeHealthReport,
  history: RuntimeHealthAlertEmission[],
  nowMs = Date.now(),
): RuntimeHealthAlertPlan {
  const dedupeKey = runtimeHealthAlertDedupeKey(report)
  const validAgentHistory = history.filter((emission) => {
    if (emission.agent_id !== report.agent_id) return false
    const emittedMs = Date.parse(emission.emitted_at)
    return Number.isFinite(emittedMs) && emittedMs <= nowMs
  })
  const duplicateInWindow = validAgentHistory.some((emission) => {
    const emittedMs = Date.parse(emission.emitted_at)
    return emission.dedupe_key === dedupeKey && nowMs - emittedMs < 300_000
  })
  const emittedInRollingHour = validAgentHistory.filter((emission) => (
    nowMs - Date.parse(emission.emitted_at) < 3_600_000
  )).length

  let action: RuntimeHealthAlertPlan['action'] = 'EMIT'
  let reasonCode: RuntimeHealthAlertPlan['reason_code'] = 'NON_HEALTHY'
  if (report.aggregate_state === 'HEALTHY') {
    action = 'SUPPRESS'
    reasonCode = 'AGGREGATE_HEALTHY'
  } else if (duplicateInWindow) {
    action = 'SUPPRESS'
    reasonCode = 'DEDUPE_WINDOW'
  } else if (emittedInRollingHour >= 6) {
    action = 'SUPPRESS'
    reasonCode = 'AGENT_HOURLY_CAP'
  }

  const nonHealthyDimensions = report.dimensions
    .filter((dimension) => dimension.applicable && dimension.state !== 'HEALTHY')
    .map((dimension) => ({
      dimension: dimension.dimension,
      state: dimension.state,
      reason_code: dimension.reason_code,
    }))

  return {
    schema_version: 'aun-runtime-health-alert-plan/v1',
    action,
    reason_code: reasonCode,
    agent_id: report.agent_id,
    runtime_instance_id: report.runtime_instance_id,
    aggregate_state: report.aggregate_state,
    observed_at: report.generated_at,
    dedupe_key: dedupeKey,
    evidence_refs: uniqueSorted(report.dimensions.flatMap((dimension) => dimension.evidence_refs)),
    non_healthy_dimensions: nonHealthyDimensions,
    dedupe_window_seconds: 300,
    per_agent_hourly_cap: 6,
    mutation_performed: false,
  }
}
