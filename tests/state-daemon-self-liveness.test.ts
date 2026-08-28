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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateDaemon } from '../core/state-daemon'
import { createFileSelfLivenessStore, loadSelfLivenessEnvOverrides, validateSelfLivenessConfig } from '../bin/state-daemon'
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
      store: { read: () => ({ exits: [priorExit], error: null }), appendExit: () => true },
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
      store: { read: () => ({ exits: [base - 2_900_000, base - 2_000_000, base - 1_000_000], error: null }), appendExit: () => true },
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

  test('F2: defer that later matures into exit keeps the 2-alert episode budget', async () => {
    const base = new Date('2026-08-28T00:00:00.000Z').getTime()
    const appended: number[] = []
    // prior exit 800s before the first tick: inside min interval (900s) at
    // first exit attempt, outside it after +201s more.
    const { daemon, clock, alerts, exits } = buildDaemon({
      store: { read: () => ({ exits: [base + 601_000 - 800_000, ...appended], error: null }), appendExit: (ts) => { appended.push(ts); return true } },
    })
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(2) // strike (alert 1)
    await daemon.__testSelfLivenessTick(2) // strike
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_deferred') // terminal alert (alert 2)
    expect(alerts.alerts.length).toBe(2)
    clock.advance(201_000) // now beyond the 900s min interval, same episode
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit')
    expect(exits).toEqual([1])
    expect(alerts.alerts.length).toBe(2) // no third alert: budget respected
  })

  test('F2: unreadable ledger refuses to exit (fail-closed boundedness), alert once', async () => {
    const { daemon, clock, metrics, alerts, exits } = buildDaemon({
      store: { read: () => ({ exits: [], error: 'ledger_read_failed:EIO' }), appendExit: () => true },
    })
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(2)
    await daemon.__testSelfLivenessTick(2)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_ledger_error')
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_ledger_error')
    expect(exits).toEqual([])
    expect(metrics.countInc('state_daemon_self_liveness_total', { result: 'exit_ledger_error' })).toBe(1)
    expect(alerts.alerts.filter((a) => a.includes('ledger unreadable')).length).toBe(1)
  })

  test('F2: ledger write failure refuses to exit (boundedness must be recorded first)', async () => {
    const { daemon, clock, exits } = buildDaemon({
      store: { read: () => ({ exits: [], error: null }), appendExit: () => false },
    })
    clock.advance(601_000)
    await daemon.__testSelfLivenessTick(2)
    await daemon.__testSelfLivenessTick(2)
    expect(await daemon.__testSelfLivenessTick(2)).toBe('exit_ledger_error')
    expect(exits).toEqual([])
  })

  test('F4: eligible existence scans the whole fenced population, not the first batch', async () => {
    // 101 distinct pending pairs; only the last agent is eligible. The old
    // batch-limited probe (LIMIT 100) reported false; the population scan
    // must report true.
    const pairs = Array.from({ length: 101 }, (_, i) => ({
      agent_id: i === 100 ? 'eligible-seat' : `held-seat-${i}`,
      channel_id: 'ch-1',
    }))
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT DISTINCT mq.agent_id')) return { rows: pairs, rowCount: pairs.length }
        if (sql.includes('FROM agents')) {
          const id = String(params?.[0])
          const eligible = id === 'eligible-seat'
          return {
            rows: [{
              agent_id: id,
              agent_type: 'dev',
              runtime: 'codex',
              runtime_engine_preference: 'codex',
              status: eligible ? 'idle' : 'offline',
              profile_enabled: true,
              disabled_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM channels')) {
          return { rows: [{ members: ['eligible-seat', ...pairs.map((p) => p.agent_id)] }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const daemon = new StateDaemon({
      db: db as any,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock,
      metrics: new FakeMetrics(),
      alert: new FakeAlertSink(),
      exit: () => {},
    })
    expect(await daemon.__testLivenessEligiblePendingExists()).toBe(true)
  })
})

describe('file self-liveness store (D3 ledger)', () => {
  test('missing file is empty history (no error); append is durable and atomic-renamed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-'))
    const path = join(dir, 'ledger.json')
    const store = createFileSelfLivenessStore(path)
    expect(store.read()).toEqual({ exits: [], error: null })
    expect(store.appendExit(1_000)).toBe(true)
    expect(store.appendExit(2_000)).toBe(true)
    expect(store.read()).toEqual({ exits: [1_000, 2_000], error: null })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ exits: [1_000, 2_000] })
    rmSync(dir, { recursive: true, force: true })
  })

  test('corrupt ledger reads as an error (fail-closed), and append refuses to overwrite it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-'))
    const path = join(dir, 'ledger.json')
    writeFileSync(path, '{not json', 'utf8')
    const store = createFileSelfLivenessStore(path)
    const r = store.read()
    expect(r.exits).toEqual([])
    expect(r.error).toContain('ledger_read_failed')
    expect(store.appendExit(1_000)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{not json') // history evidence preserved
    rmSync(dir, { recursive: true, force: true })
  })

  test('wrong-shaped ledger is an error, not empty history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-'))
    const path = join(dir, 'ledger.json')
    writeFileSync(path, JSON.stringify({ something: 1 }), 'utf8')
    const store = createFileSelfLivenessStore(path)
    expect(store.read().error).toBe('ledger_shape_invalid')
    rmSync(dir, { recursive: true, force: true })
  })
  test('parseable-invalid ledger entries are corruption (fail-closed), original file preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-'))
    const path = join(dir, 'ledger.json')
    const original = JSON.stringify({ exits: ['corrupt-entry'] })
    writeFileSync(path, original, 'utf8')
    const store = createFileSelfLivenessStore(path)
    const r = store.read()
    expect(r.exits).toEqual([])
    expect(r.error).toBe('ledger_entry_invalid')
    expect(store.appendExit(1_000)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(original) // corruption evidence preserved
    rmSync(dir, { recursive: true, force: true })
  })

  test('non-integer / non-positive / non-finite ledger entries are all corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-'))
    for (const bad of [[1.5], [0], [-10], [null], ['1000'], [1e308 * 10]]) {
      const path = join(dir, `ledger-${JSON.stringify(bad).replace(/[^a-z0-9.-]/gi, '_')}.json`)
      writeFileSync(path, JSON.stringify({ exits: bad }), 'utf8')
      expect(createFileSelfLivenessStore(path).read().error).toBe('ledger_entry_invalid')
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('self-liveness knob validation (fail-closed startup)', () => {
  const base = {
    selfLivenessCheckIntervalMs: 60_000,
    selfLivenessWedgeSec: 600,
    selfLivenessMaxStrikes: 3,
    selfLivenessMinExitIntervalSec: 900,
    selfLivenessExitWindowSec: 3_600,
    selfLivenessMaxExitsPerWindow: 3,
  }
  test('defaults validate clean', () => {
    expect(validateSelfLivenessConfig(base)).toEqual([])
  })
  test('non-positive and non-integer knobs are rejected with the env name', () => {
    expect(validateSelfLivenessConfig({ ...base, selfLivenessWedgeSec: 0 }).join()).toContain('WEDGE_SEC')
    expect(validateSelfLivenessConfig({ ...base, selfLivenessMaxStrikes: -1 }).join()).toContain('MAX_STRIKES')
    expect(validateSelfLivenessConfig({ ...base, selfLivenessMinExitIntervalSec: 1.5 }).join()).toContain('MIN_EXIT_INTERVAL')
  })
  test('window smaller than min exit interval is rejected (invariant)', () => {
    expect(validateSelfLivenessConfig({ ...base, selfLivenessExitWindowSec: 100 }).join()).toContain('EXIT_WINDOW_SEC must be >=')
  })

})

describe('self-liveness env loader (strict, fail-closed)', () => {
  test('unset knobs produce no overrides and no errors', () => {
    expect(loadSelfLivenessEnvOverrides({} as any)).toEqual({ overrides: {}, errors: [] })
  })

  test('valid values read back as effective overrides', () => {
    const { overrides, errors } = loadSelfLivenessEnvOverrides({
      STATE_DAEMON_SELF_LIVENESS_WEDGE_SEC: '300',
      STATE_DAEMON_SELF_LIVENESS_MIN_EXIT_INTERVAL_SEC: '1200',
    } as any)
    expect(errors).toEqual([])
    expect(overrides).toEqual({ selfLivenessWedgeSec: 300, selfLivenessMinExitIntervalSec: 1200 })
  })

  test('malformed values are startup errors, never silent defaults', () => {
    for (const bad of ['abc', 'NaN', 'Infinity', '0', '-1', '1.5', '', ' ', '1e3', '0900']) {
      const { overrides, errors } = loadSelfLivenessEnvOverrides({
        STATE_DAEMON_SELF_LIVENESS_WEDGE_SEC: bad,
      } as any)
      expect(overrides).toEqual({})
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('STATE_DAEMON_SELF_LIVENESS_WEDGE_SEC')
    }
  })
})
