/**
 * Crash-only self-liveness (#940 liveness definition D2/D3/D4).
 *
 * D2 equivalence: queue progress is BOUND to emissions of the published
 * queue-family metrics (queue_work_actions / memory_ready_backoff /
 * state_actions) — not to sweep completion, not to function entry. The
 * motivating incident (2026-08-27 18:05 JST: scheduler-only silence while
 * other components stayed alive) is pinned as a regression below.
 * D3 boundedness: self-exits are durable-ledgered; min 900s apart; three
 * within 1h latch fail-visible (no more auto-exits, one owner alert).
 */
import { describe, expect, test } from 'bun:test'
import { StateDaemon } from '../core/state-daemon'
import type { SelfLivenessStore } from '../core/state-daemon/types'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './contract/state-daemon/fakes'

function buildDaemon(overrides: { exitDisabled?: boolean; store?: SelfLivenessStore } = {}) {
  const clock = new FakeClock('2026-08-28T00:00:00.000Z')
  const metrics = new FakeMetrics()
  const alerts = new FakeAlertSink()
  const exits: number[] = []
  const daemon = new StateDaemon({
    db: { query: async () => { throw new Error('no db in this test') } } as any,
    pgListen: new FakePgListen(),
    tmux: new FakeTmux(),
    clock,
    metrics,
    alert: alerts,
    exit: (code: number) => { exits.push(code) },
    selfLivenessStore: overrides.store,
    config: {
      selfLivenessWedgeSec: 600,
      selfLivenessMaxStrikes: 3,
      selfLivenessExitDisabled: overrides.exitDisabled ?? false,
      selfLivenessMinExitIntervalSec: 900,
      selfLivenessExitWindowSec: 3_600,
      selfLivenessMaxExitsPerWindow: 3,
    },
  })
  // reach the wrapped metric sink the daemon actually uses
  const emit = (name: string) => (daemon as any).metrics.inc(name, {})
  return { daemon, clock, metrics, alerts, exits, emit }
}

describe('state-daemon self-liveness (crash-only)', () => {
  test('no eligible pending never strikes, regardless of idle time', async () => {
    const { daemon, clock, exits } = buildDaemon()
    clock.advance(3_600_000)
    expect(await daemon.__testSelfLivenessTick(0)).toBe('ok')
    expect(await daemon.__testSelfLivenessTick(0)).toBe('ok')
    expect(exits).toEqual([])
  })

  test('D2 binding: queue-family metric emission is progress; non-family emissions are not', async () => {
    const { daemon, clock, emit } = buildDaemon()
    clock.advance(601_000)
    emit('state_daemon_queue_work_actions_total') // queue family => progress
    expect(await daemon.__testSelfLivenessTick(3)).toBe('ok')

    // incident signature (8/27 18:05): other components keep emitting,
    // queue family goes silent => strikes accumulate to exit.
    clock.advance(601_000)
    emit('state_daemon_bot_liveness_skipped_total') // NOT queue family
    expect(await daemon.__testSelfLivenessTick(3)).toBe('strike')
    emit('state_daemon_bot_liveness_skipped_total')
    expect(await daemon.__testSelfLivenessTick(3)).toBe('strike')
    emit('state_daemon_bot_liveness_skipped_total')
    expect(await daemon.__testSelfLivenessTick(3)).toBe('exit')
  })

  test('three consecutive stalled checks exit(1); episode alert + exit alert = exactly 2', async () => {
    const { daemon, clock, metrics, alerts, exits } = buildDaemon()
    clock.advance(601_000)
    expect(await daemon.__testSelfLivenessTick(4)).toBe('strike')
    expect(alerts.alerts.length).toBe(1)
    expect(alerts.alerts[0]).toContain('strike 1/3')
    expect(await daemon.__testSelfLivenessTick(4)).toBe('strike')
    expect(alerts.alerts.length).toBe(1)
    expect(exits).toEqual([])
    expect(await daemon.__testSelfLivenessTick(4)).toBe('exit')
    expect(exits).toEqual([1])
    expect(alerts.alerts.length).toBe(2)
    expect(alerts.alerts.at(-1)).toContain('exiting after 3')
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'strike' })).toBe(3)
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'exit' })).toBe(1)
  })

  test('D3 min interval: a recent prior self-exit defers the next exit (no hot loop)', async () => {
    const priorExit = new Date('2026-08-28T00:00:00.000Z').getTime() - 100_000 // 100s ago
    const { daemon, clock, alerts, exits } = buildDaemon({
      store: { readExits: () => [priorExit], appendExit: () => {} },
    })
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(2)
    await daemon.__testSelfLivenessTick(2)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_deferred')
    expect(exits).toEqual([])
    expect(alerts.alerts.at(-1)).toContain('exit deferred')
  })

  test('D3 latch: three exits inside the window halt auto-restart fail-visibly, alert once', async () => {
    const base = new Date('2026-08-28T00:00:00.000Z').getTime()
    const { daemon, clock, metrics, alerts, exits } = buildDaemon({
      store: { readExits: () => [base - 2_900_000, base - 2_000_000, base - 1_000_000], appendExit: () => {} },
    })
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(2)
    await daemon.__testSelfLivenessTick(2)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_latched')
    expect(exits).toEqual([])
    const alertsAfterLatch = alerts.alerts.length
    // further ticks stay latched silently — no alert/metric spam
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_latched')
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_latched')
    expect(alerts.alerts.length).toBe(alertsAfterLatch)
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'exit_latched' })).toBe(1)
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'strike' })).toBe(3) // capped at max
  })

  test('kill switch suppresses exit once per episode without alert/metric spam', async () => {
    const { daemon, clock, metrics, alerts, exits } = buildDaemon({ exitDisabled: true })
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(1)
    await daemon.__testSelfLivenessTick(1)
    expect(await daemon.__testSelfLivenessTick(1)).toBe('exit_suppressed')
    const after = alerts.alerts.length
    expect(await daemon.__testSelfLivenessTick(1)).toBe('exit_suppressed')
    expect(await daemon.__testSelfLivenessTick(1)).toBe('exit_suppressed')
    expect(exits).toEqual([])
    expect(alerts.alerts.length).toBe(after) // no spam across ticks
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'exit_suppressed' })).toBe(1)
  })

  test('recovery resets strikes, episode latches, and records the recovered metric', async () => {
    const { daemon, clock, metrics, exits, emit } = buildDaemon()
    clock.advance(601_000)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('strike')
    expect(await daemon.__testSelfLivenessTick(2)).toBe('strike')
    emit('state_daemon_memory_ready_backoff_total') // legitimate gate deferral IS progress
    expect(await daemon.__testSelfLivenessTick(2)).toBe('ok')
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'recovered' })).toBe(1)
    clock.advance(601_000)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('strike')
    expect(await daemon.__testSelfLivenessTick(2)).toBe('strike')
    expect(exits).toEqual([]) // counter restarted; no exit after only 2 strikes
  })

  test('default in-memory ledger enforces min interval across a second wedge in one process', async () => {
    const { daemon, clock, exits, emit } = buildDaemon()
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(2)
    await daemon.__testSelfLivenessTick(2)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit')
    expect(exits).toEqual([1])
    // recover, wedge again immediately: min-interval (900s) defers the second exit
    emit('state_daemon_queue_work_actions_total')
    expect(await daemon.__testSelfLivenessTick(2)).toBe('ok')
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(2)
    await daemon.__testSelfLivenessTick(2)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_deferred')
    expect(exits).toEqual([1])
  })
})
