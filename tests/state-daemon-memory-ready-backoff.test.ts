import { describe, expect, test } from 'bun:test'
import { MemoryReadyBackoff } from '../core/state-daemon/memory-ready-backoff'
import type { RuntimeMemoryReadyGateResult } from '../core/runtime-memory-ready'

function blocked(reason: RuntimeMemoryReadyGateResult['reason'] = 'missing_evidence'): RuntimeMemoryReadyGateResult {
  return {
    ok: false,
    gate: 'memory_ready',
    reason,
    agent_id: 'arc',
    project: 'iyasaka-arc',
    checked_at: '2026-08-21T00:00:00.000Z',
    runtime_instance_id: 'runtime-arc',
    evidence_id: null,
    evidence_path: null,
    evidence_log_id: null,
    source: null,
    valid_until: null,
    current_runtime: null,
    details: { code: reason },
  }
}

describe('state-daemon memory-ready backoff', () => {
  test('caps reevaluation and alerts only on blocked fingerprint transitions', () => {
    const backoff = new MemoryReadyBackoff(30_000, 120_000)
    let now = new Date('2026-08-21T00:00:00.000Z')
    const first = backoff.recordBlocked(7, blocked(), now)
    expect(first).toMatchObject({ alert: true, attempts: 1, retry_delay_ms: 30_000 })
    expect(backoff.shouldEvaluate(7, new Date('2026-08-21T00:00:29.999Z'))).toBe(false)
    expect(backoff.shouldEvaluate(7, new Date('2026-08-21T00:00:30.000Z'))).toBe(true)

    now = new Date('2026-08-21T00:00:30.000Z')
    expect(backoff.recordBlocked(7, blocked(), now)).toMatchObject({
      alert: false,
      attempts: 2,
      retry_delay_ms: 60_000,
    })
    now = new Date('2026-08-21T00:01:30.000Z')
    expect(backoff.recordBlocked(7, blocked(), now).retry_delay_ms).toBe(120_000)
    now = new Date('2026-08-21T00:03:30.000Z')
    expect(backoff.recordBlocked(7, blocked(), now).retry_delay_ms).toBe(120_000)

    const changed = backoff.recordBlocked(7, blocked('expired'), now)
    expect(changed).toMatchObject({ alert: true, attempts: 1, retry_delay_ms: 30_000 })
    expect(backoff.recordReady(7)).toBe(true)
    expect(backoff.recordReady(7)).toBe(false)
  })

  test('bounded state evicts the oldest queue id', () => {
    const backoff = new MemoryReadyBackoff(30_000, 60_000, 2)
    const now = new Date('2026-08-21T00:00:00.000Z')
    backoff.recordBlocked(1, blocked(), now)
    backoff.recordBlocked(2, blocked(), now)
    backoff.recordBlocked(3, blocked(), now)
    expect(backoff.shouldEvaluate(1, now)).toBe(true)
    expect(backoff.shouldEvaluate(2, now)).toBe(false)
    expect(backoff.shouldEvaluate(3, now)).toBe(false)
  })
})
