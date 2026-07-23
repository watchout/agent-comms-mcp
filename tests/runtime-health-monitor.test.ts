import { describe, expect, test } from 'bun:test'
import {
  RUNTIME_HEALTH_DIMENSIONS,
  evaluateRuntimeHealth,
  planRuntimeHealthAlert,
  runtimeHealthAlertDedupeKey,
  type RuntimeHealthAlertEmission,
  type RuntimeHealthDimensionInput,
  type RuntimeHealthDimensionName,
} from '../core/runtime-health-monitor'

const NOW_MS = Date.parse('2026-07-21T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()

function healthyDimension(dimension: RuntimeHealthDimensionName): RuntimeHealthDimensionInput {
  return {
    dimension,
    applicability: 'APPLICABLE',
    declared_state: 'HEALTHY',
    reason_code: `${dimension.toUpperCase()}_HEALTHY`,
    observed_at: NOW,
    freshness_limit_seconds: 300,
    evidence_refs: [`evidence:${dimension}`],
    probe_result: 'ok',
  }
}

function healthyDimensions(): RuntimeHealthDimensionInput[] {
  return RUNTIME_HEALTH_DIMENSIONS.map(healthyDimension)
}

function replaceDimension(
  dimensions: RuntimeHealthDimensionInput[],
  name: RuntimeHealthDimensionName,
  patch: Partial<RuntimeHealthDimensionInput>,
): RuntimeHealthDimensionInput[] {
  return dimensions.map((dimension) => dimension.dimension === name ? { ...dimension, ...patch } : dimension)
}

function evaluate(dimensions = healthyDimensions(), agentId = 'arc') {
  return evaluateRuntimeHealth({
    agent_id: agentId,
    runtime_instance_id: `${agentId}-runtime-1`,
    dimensions,
  }, NOW_MS)
}

describe('runtime health projection — seven independent dimensions', () => {
  test('all seven dimensions HEALTHY produces aggregate HEALTHY', () => {
    const report = evaluate()
    expect(report.aggregate_state).toBe('HEALTHY')
    expect(report.dimensions.map((dimension) => dimension.dimension)).toEqual(RUNTIME_HEALTH_DIMENSIONS)
    expect(report.dimensions.every((dimension) => dimension.state === 'HEALTHY')).toBe(true)
    expect(report.mutation_performed).toBe(false)
  })

  test('aggregate precedence is DOWN, then UNKNOWN, then DEGRADED, then HEALTHY', () => {
    let dimensions = replaceDimension(healthyDimensions(), 'queue_actionable_receive', {
      declared_state: 'DEGRADED',
      reason_code: 'QUEUE_PLACED_NOT_ACTIONABLE',
    })
    expect(evaluate(dimensions).aggregate_state).toBe('DEGRADED')

    dimensions = replaceDimension(dimensions, 'ui_runner_reachability', {
      declared_state: 'UNKNOWN',
      reason_code: 'UI_RUNNER_EVIDENCE_MISSING',
    })
    expect(evaluate(dimensions).aggregate_state).toBe('UNKNOWN')

    dimensions = replaceDimension(dimensions, 'endpoint_identity', {
      declared_state: 'DOWN',
      reason_code: 'ENDPOINT_PORT_UNBOUND',
    })
    expect(evaluate(dimensions).aggregate_state).toBe('DOWN')
  })

  test('fresh heartbeat plus wrong endpoint identity cannot produce HEALTHY', () => {
    const dimensions = replaceDimension(healthyDimensions(), 'endpoint_identity', {
      expected_identity: 'arc',
      observed_identity: 'cto',
      reason_code: 'ENDPOINT_EXPECTED_IDENTITY_PRESENT',
    })
    const report = evaluate(dimensions)
    expect(report.dimensions.find((dimension) => dimension.dimension === 'agent_runtime')?.state).toBe('HEALTHY')
    expect(report.dimensions.find((dimension) => dimension.dimension === 'endpoint_identity')).toMatchObject({
      state: 'DOWN',
      reason_code: 'IDENTITY_MISMATCH',
    })
    expect(report.aggregate_state).toBe('DOWN')
  })

  test('healthy process/session plus missing UI or runner reachability is UNKNOWN', () => {
    const dimensions = replaceDimension(healthyDimensions(), 'ui_runner_reachability', {
      declared_state: 'UNKNOWN',
      reason_code: 'UI_RUNNER_EVIDENCE_MISSING',
      observed_at: null,
      evidence_refs: [],
    })
    const report = evaluate(dimensions)
    expect(report.dimensions.find((dimension) => dimension.dimension === 'supervisor_session')?.state).toBe('HEALTHY')
    expect(report.dimensions.find((dimension) => dimension.dimension === 'ui_runner_reachability')).toMatchObject({
      state: 'UNKNOWN',
      reason_code: 'EVIDENCE_ABSENT',
    })
    expect(report.aggregate_state).toBe('UNKNOWN')
  })

  test('queue placement, presentation, and provider projection stay separate', () => {
    let dimensions = replaceDimension(healthyDimensions(), 'queue_actionable_receive', {
      declared_state: 'DEGRADED',
      reason_code: 'QUEUE_PLACED_NOT_ACTIONABLE',
    })
    dimensions = replaceDimension(dimensions, 'runtime_presentation_claim', {
      declared_state: 'UNKNOWN',
      reason_code: 'QUEUE_NOT_PRESENTED_OR_CLAIMED',
    })
    const report = evaluate(dimensions)
    expect(report.dimensions.find((dimension) => dimension.dimension === 'queue_actionable_receive')?.state).toBe('DEGRADED')
    expect(report.dimensions.find((dimension) => dimension.dimension === 'runtime_presentation_claim')?.state).toBe('UNKNOWN')
    expect(report.dimensions.find((dimension) => dimension.dimension === 'provider_projection')?.state).toBe('HEALTHY')
    expect(report.aggregate_state).toBe('UNKNOWN')
  })

  test('Discord configured but projection evidence missing or stale is UNKNOWN', () => {
    let missing = replaceDimension(healthyDimensions(), 'provider_projection', {
      declared_state: 'UNKNOWN',
      reason_code: 'DISCORD_PROJECTION_EVIDENCE_MISSING',
      observed_at: null,
      evidence_refs: ['db:connector_instances:arc:discord'],
    })
    expect(evaluate(missing).dimensions.at(-1)).toMatchObject({ state: 'UNKNOWN', reason_code: 'EVIDENCE_ABSENT' })

    const staleAt = new Date(NOW_MS - 301_000).toISOString()
    const stale = replaceDimension(healthyDimensions(), 'provider_projection', {
      observed_at: staleAt,
      reason_code: 'DISCORD_PROJECTION_FRESH',
    })
    expect(evaluate(stale).dimensions.at(-1)).toMatchObject({ state: 'UNKNOWN', reason_code: 'EVIDENCE_STALE' })
  })

  test('non-Discord projection is excluded only with positive binding evidence', () => {
    const positive = replaceDimension(healthyDimensions(), 'provider_projection', {
      applicability: 'NOT_APPLICABLE',
      applicability_evidence_refs: ['db:agents:arc:expected_provider=slack'],
      reason_code: 'NOT_APPLICABLE_CONFIRMED',
    })
    expect(evaluate(positive).dimensions.at(-1)).toMatchObject({
      applicable: false,
      state: 'HEALTHY',
      reason_code: 'NOT_APPLICABLE_CONFIRMED',
    })

    const unproven = replaceDimension(healthyDimensions(), 'provider_projection', {
      applicability: 'NOT_APPLICABLE',
      applicability_evidence_refs: [],
    })
    expect(evaluate(unproven).dimensions.at(-1)).toMatchObject({
      applicable: true,
      state: 'UNKNOWN',
      reason_code: 'APPLICABILITY_EVIDENCE_MISSING',
    })
  })

  test('probe timeout, exception, invalid timestamp, and future timestamp fail closed', () => {
    let dimensions = replaceDimension(healthyDimensions(), 'supervisor_session', { probe_result: 'timeout' })
    expect(evaluate(dimensions).dimensions[1]).toMatchObject({ state: 'UNKNOWN', reason_code: 'PROBE_TIMEOUT' })

    dimensions = replaceDimension(healthyDimensions(), 'endpoint_identity', { probe_result: 'exception' })
    expect(evaluate(dimensions).dimensions[2]).toMatchObject({ state: 'UNKNOWN', reason_code: 'PROBE_EXCEPTION' })

    dimensions = replaceDimension(healthyDimensions(), 'agent_runtime', { observed_at: 'not-a-date' })
    expect(evaluate(dimensions).dimensions[0]).toMatchObject({ state: 'UNKNOWN', reason_code: 'EVIDENCE_INVALID_TIMESTAMP' })

    dimensions = replaceDimension(healthyDimensions(), 'agent_runtime', {
      observed_at: new Date(NOW_MS + 1).toISOString(),
    })
    expect(evaluate(dimensions).dimensions[0]).toMatchObject({ state: 'UNKNOWN', reason_code: 'EVIDENCE_FUTURE_TIMESTAMP' })
  })
})

describe('deterministic local alert planner', () => {
  function nonHealthyReport() {
    return evaluate(replaceDimension(healthyDimensions(), 'queue_actionable_receive', {
      declared_state: 'DEGRADED',
      reason_code: 'QUEUE_PLACED_NOT_ACTIONABLE',
    }))
  }

  test('dedupe key is stable under input and evidence ordering', () => {
    const first = nonHealthyReport()
    const reversedDimensions = [...healthyDimensions()].reverse().map((dimension) => ({
      ...dimension,
      evidence_refs: [...dimension.evidence_refs].reverse(),
    }))
    const second = evaluate(replaceDimension(reversedDimensions, 'queue_actionable_receive', {
      declared_state: 'DEGRADED',
      reason_code: 'QUEUE_PLACED_NOT_ACTIONABLE',
    }))
    expect(runtimeHealthAlertDedupeKey(first)).toBe(runtimeHealthAlertDedupeKey(second))
  })

  test('same key suppresses before 300 seconds and re-emits at the boundary', () => {
    const report = nonHealthyReport()
    const first = planRuntimeHealthAlert(report, [], NOW_MS)
    expect(first.action).toBe('EMIT')
    const history: RuntimeHealthAlertEmission[] = [{
      agent_id: report.agent_id,
      dedupe_key: first.dedupe_key,
      emitted_at: new Date(NOW_MS).toISOString(),
    }]
    expect(planRuntimeHealthAlert(report, history, NOW_MS + 299_999)).toMatchObject({
      action: 'SUPPRESS',
      reason_code: 'DEDUPE_WINDOW',
    })
    expect(planRuntimeHealthAlert(report, history, NOW_MS + 300_000)).toMatchObject({
      action: 'EMIT',
      reason_code: 'NON_HEALTHY',
    })
  })

  test('rolling cap is exactly six per agent and does not suppress another agent', () => {
    const report = nonHealthyReport()
    const history: RuntimeHealthAlertEmission[] = Array.from({ length: 6 }, (_, index) => ({
      agent_id: 'arc',
      dedupe_key: `prior-key-${index}`,
      emitted_at: new Date(NOW_MS - (index + 1) * 60_000).toISOString(),
    }))
    expect(planRuntimeHealthAlert(report, history, NOW_MS)).toMatchObject({
      action: 'SUPPRESS',
      reason_code: 'AGENT_HOURLY_CAP',
    })

    const otherAgent = evaluate(replaceDimension(healthyDimensions(), 'queue_actionable_receive', {
      declared_state: 'DEGRADED',
      reason_code: 'QUEUE_PLACED_NOT_ACTIONABLE',
    }), 'qa')
    expect(planRuntimeHealthAlert(otherAgent, history, NOW_MS)).toMatchObject({
      action: 'EMIT',
      reason_code: 'NON_HEALTHY',
    })
  })

  test('HEALTHY aggregate never emits an alert plan', () => {
    expect(planRuntimeHealthAlert(evaluate(), [], NOW_MS)).toMatchObject({
      action: 'SUPPRESS',
      reason_code: 'AGGREGATE_HEALTHY',
      mutation_performed: false,
    })
  })
})
