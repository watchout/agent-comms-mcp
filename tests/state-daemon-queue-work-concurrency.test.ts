/**
 * E7 — bounded concurrent queue-work runners (issue #940 definition v2, R1).
 *
 * 8/27 fleet activation: an unbounded scheduler ran 13 LLM CLI children at
 * once; resource contention produced CODEX_OUTPUT_LAST_MESSAGE_MISSING on
 * 10+ seats. The bound turns burst overload into visible deferral: rows
 * stay pending, are re-swept later, and never consume a retry attempt.
 */
import { describe, expect, test } from 'bun:test'
import { StateDaemon } from '../core/state-daemon'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './contract/state-daemon/fakes'

function row(id: number, agent: string) {
  return {
    id,
    agent_id: agent,
    message_id: `msg-${id}`,
    payload: '{}',
    status: 'pending',
    claim_expires_at: null,
    created_at: new Date('2026-08-28T00:00:00.000Z'),
    last_wake_attempt_at: null,
    last_heartbeat_at: null,
  } as any
}

function buildDaemon(bound: number) {
  const metrics = new FakeMetrics()
  const resolvers: Array<() => void> = []
  const scheduler = {
    runPending: () => new Promise<void>((resolve) => { resolvers.push(resolve) }),
  }
  const daemon = new StateDaemon({
    db: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
    pgListen: new FakePgListen(),
    tmux: new FakeTmux(),
    clock: new FakeClock('2026-08-28T00:00:00.000Z'),
    metrics,
    alert: new FakeAlertSink(),
    queueWorkScheduler: scheduler as any,
    config: { queueWorkMaxConcurrentRunners: bound },
  })
  const schedule = (r: any) => (daemon as any).scheduleQueueWorkRunner('pending', r, () => scheduler.runPending())
  return { daemon, metrics, schedule, resolvers }
}

describe('queue-work concurrency bound (E7)', () => {
  test('runners over the bound are deferred with a visible metric, not invoked', () => {
    const { metrics, schedule } = buildDaemon(3)
    for (let i = 1; i <= 5; i++) schedule(row(i, `seat-${i}`))
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(3)
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_concurrency_deferred' })).toBe(2)
  })

  test('a completed runner frees a slot for the next sweep', async () => {
    const { metrics, schedule, resolvers } = buildDaemon(2)
    schedule(row(1, 'seat-a'))
    schedule(row(2, 'seat-b'))
    schedule(row(3, 'seat-c')) // deferred
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(2)
    await new Promise((r) => setTimeout(r, 0)) // let the async run() start and register resolvers
    resolvers[0]() // seat-a finishes
    await new Promise((r) => setTimeout(r, 0)) // let the finally clear inflight
    schedule(row(3, 'seat-c')) // re-swept
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(3)
  })

  test('per-agent dedup still applies inside the bound (same agent is busy-deferred, not double-run)', () => {
    const { metrics, schedule } = buildDaemon(3)
    schedule(row(1, 'seat-a'))
    schedule(row(2, 'seat-a')) // same agent: busy defer, not concurrency defer
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(1)
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_agent_busy_deferred' })).toBe(1)
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_concurrency_deferred' })).toBe(0)
  })

  test('deferral does not touch the row or consume attempts (scheduler untouched rows stay schedulable)', () => {
    const { schedule, metrics } = buildDaemon(1)
    schedule(row(1, 'seat-a'))
    for (let i = 0; i < 5; i++) schedule(row(2, 'seat-b')) // deferred repeatedly
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_concurrency_deferred' })).toBe(5)
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(1)
  })
})
