/**
 * Crash-only self-liveness (#940 liveness definition D2/D3/D4).
 *
 * The daemon is a deterministic script: its only legal failure mode is
 * "running or dead". These tests pin the strike/exit state machine that
 * collapses "wedged but alive" into an exit(1) that launchd KeepAlive
 * turns into a fresh process.
 */
import { describe, expect, test } from 'bun:test'
import { StateDaemon } from '../core/state-daemon'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './contract/state-daemon/fakes'

function buildDaemon(overrides: { exitDisabled?: boolean } = {}) {
  const clock = new FakeClock('2026-08-28T00:00:00.000Z')
  const metrics = new FakeMetrics()
  const alerts = new FakeAlertSink()
  const exits: number[] = []
  const daemon = new StateDaemon({
    // Self-liveness tests drive evaluateSelfLiveness directly via the test
    // hook, so no SQL is issued; a throwing stub keeps the subject honest.
    db: { query: async () => { throw new Error('no db in this test') } } as any,
    pgListen: new FakePgListen(),
    tmux: new FakeTmux(),
    clock,
    metrics,
    alert: alerts,
    exit: (code: number) => { exits.push(code) },
    config: {
      selfLivenessWedgeSec: 600,
      selfLivenessMaxStrikes: 3,
      selfLivenessExitDisabled: overrides.exitDisabled ?? false,
    },
  })
  return { daemon, clock, metrics, alerts, exits }
}

describe('state-daemon self-liveness (crash-only)', () => {
  test('no pending work never strikes, regardless of idle time', () => {
    const { daemon, clock, exits } = buildDaemon()
    clock.advance(3_600_000)
    expect(daemon.__testSelfLivenessTick(0)).toBe('ok')
    expect(daemon.__testSelfLivenessTick(0)).toBe('ok')
    expect(exits).toEqual([])
  })

  test('pending work with fresh progress is ok', () => {
    const { daemon, clock } = buildDaemon()
    clock.advance(300_000) // 5min < 600s wedge
    expect(daemon.__testSelfLivenessTick(5)).toBe('ok')
  })

  test('three consecutive stalled checks exit(1); alert fires on first strike and on exit', () => {
    const { daemon, clock, metrics, alerts, exits } = buildDaemon()
    clock.advance(601_000)
    expect(daemon.__testSelfLivenessTick(4)).toBe('strike')
    expect(alerts.alerts.length).toBe(1)
    expect(alerts.alerts[0]).toContain('strike 1/3')
    expect(daemon.__testSelfLivenessTick(4)).toBe('strike')
    expect(alerts.alerts.length).toBe(1) // no alert spam on later strikes
    expect(exits).toEqual([])
    expect(daemon.__testSelfLivenessTick(4)).toBe('exit')
    expect(exits).toEqual([1])
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'strike' })).toBe(3)
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'exit' })).toBe(1)
    expect(alerts.alerts.at(-1)).toContain('exiting after 3')
  })

  test('progress between strikes resets the counter and records recovery', () => {
    const { daemon, clock, metrics, exits } = buildDaemon()
    clock.advance(601_000)
    expect(daemon.__testSelfLivenessTick(2)).toBe('strike')
    expect(daemon.__testSelfLivenessTick(2)).toBe('strike')
    // queue makes progress (e.g. a sweep completed) — daemon touches the marker
    daemon.__testTouchQueueProgress()
    expect(daemon.__testSelfLivenessTick(2)).toBe('ok')
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'recovered' })).toBe(1)
    // stall again: counter restarts from zero, so two more strikes do not exit
    clock.advance(601_000)
    expect(daemon.__testSelfLivenessTick(2)).toBe('strike')
    expect(daemon.__testSelfLivenessTick(2)).toBe('strike')
    expect(exits).toEqual([])
  })

  test('kill switch suppresses exit but keeps alert + metric', () => {
    const { daemon, clock, metrics, alerts, exits } = buildDaemon({ exitDisabled: true })
    clock.advance(601_000)
    daemon.__testSelfLivenessTick(1)
    daemon.__testSelfLivenessTick(1)
    expect(daemon.__testSelfLivenessTick(1)).toBe('exit_suppressed')
    expect(exits).toEqual([])
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'exit_suppressed' })).toBe(1)
    expect(alerts.alerts.at(-1)).toContain('exit suppressed')
  })
})
