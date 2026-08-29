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
    expect(metrics.countInc('state_daemon_queue_work_backpressure_total', { result: 'pending_runner_concurrency_deferred' })).toBe(2)
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
    expect(metrics.countInc('state_daemon_queue_work_backpressure_total', { result: 'pending_runner_concurrency_deferred' })).toBe(0)
  })

  test('deferral does not touch the row or consume attempts (scheduler untouched rows stay schedulable)', () => {
    const { schedule, metrics } = buildDaemon(1)
    schedule(row(1, 'seat-a'))
    for (let i = 0; i < 5; i++) schedule(row(2, 'seat-b')) // deferred repeatedly
    expect(metrics.countInc('state_daemon_queue_work_backpressure_total', { result: 'pending_runner_concurrency_deferred' })).toBe(5)
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(1)
  })

  test('F1: all-slots-hung with eligible pending strikes and exits — deferral metrics are not progress', async () => {
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const metrics = new FakeMetrics()
    const exits: number[] = []
    const scheduler = { runPending: () => new Promise<void>(() => {}) } // never resolves
    const daemon = new StateDaemon({
      db: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      clock,
      metrics,
      alert: new FakeAlertSink(),
      exit: (code: number) => { exits.push(code) },
      queueWorkScheduler: scheduler as any,
      config: {
        queueWorkMaxConcurrentRunners: 1,
        selfLivenessWedgeSec: 600,
        selfLivenessMaxStrikes: 3,
        queueWorkRunnerTimeoutMs: 600_000, // legitimate child budget 10min
      },
    })
    const schedule = (r: any) => (daemon as any).scheduleQueueWorkRunner('pending', r, () => scheduler.runPending())
    const emitFamily = () => (daemon as any).metrics.inc('state_daemon_state_actions_total', {})
    const alerts = (daemon as any).alert as FakeAlertSink
    expect(schedule(row(1, 'seat-hung'))).toBe('invoked') // occupies the only slot, hangs forever
    // healthy-long phase: inside timeout+grace (1200s) nothing strikes even
    // though the pool is full and eligible work waits
    clock.advance(1_100_000)
    emitFamily()
    expect(schedule(row(2, 'seat-b'))).toBe('deferred_concurrency')
    expect(await daemon.__testSelfLivenessTick(1)).toBe('ok')
    // genuinely wedged phase: slot outlives its own child timeout + grace.
    // The auditor's exact scenario: sweep planning keeps emitting progress-
    // family metrics and deferrals keep flowing, yet no slot ever releases.
    clock.advance(200_000) // total 1300s > 600s timeout + 600s grace
    emitFamily() // refreshes lastQueueProgressAt — idle path alone would say ok
    schedule(row(2, 'seat-b'))
    expect(await daemon.__testSelfLivenessTick(1)).toBe('strike') // slot-wedge signal
    expect(alerts.alerts[0]).toContain('runner slot(s) occupied') // honest cause, not idle-time text
    expect(alerts.alerts[0]).toContain('exceeding the runner timeout budget')
    clock.advance(61_000)
    emitFamily()
    schedule(row(2, 'seat-b'))
    expect(await daemon.__testSelfLivenessTick(1)).toBe('strike')
    clock.advance(61_000)
    emitFamily()
    expect(await daemon.__testSelfLivenessTick(1)).toBe('exit')
    expect(exits).toEqual([1])
  })

  test('F1: three healthy long-running runners within the child budget never false-strike', async () => {
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const exits: number[] = []
    const scheduler = { runPending: () => new Promise<void>(() => {}) }
    const daemon = new StateDaemon({
      db: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock,
      metrics: new FakeMetrics(), alert: new FakeAlertSink(),
      exit: (code: number) => { exits.push(code) },
      queueWorkScheduler: scheduler as any,
      config: {
        queueWorkMaxConcurrentRunners: 3,
        selfLivenessWedgeSec: 600,
        queueWorkRunnerTimeoutMs: 2_400_000, // 40min interim budget (#940 v2)
      },
    })
    const schedule = (r: any) => (daemon as any).scheduleQueueWorkRunner('pending', r, () => scheduler.runPending())
    schedule(row(1, 'seat-a')); schedule(row(2, 'seat-b')); schedule(row(3, 'seat-c'))
    // 39 minutes in: full pool, eligible pending, all children still within
    // their 40min budget — the auditor's healthy-long probe
    for (let i = 0; i < 39; i++) {
      clock.advance(60_000)
      ;(daemon as any).metrics.inc('state_daemon_state_actions_total', {})
      expect(await daemon.__testSelfLivenessTick(1)).toBe('ok')
    }
    expect(exits).toEqual([])
  })

  test('F1: deferral metric is outside the D2 progress family', async () => {
    const { QUEUE_PROGRESS_METRIC_FAMILY } = await import('../core/state-daemon/types')
    expect(QUEUE_PROGRESS_METRIC_FAMILY.has('state_daemon_queue_work_backpressure_total')).toBe(false)
  })

  test('F3: D1 dispatch obeys the same global bound (generic first, D1 deferred)', async () => {
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const metrics = new FakeMetrics()
    const scheduler = { runPending: () => new Promise<void>(() => {}) }
    const d1 = {
      classify: () => ({ outcome: 'admit' }),
      dispatch: () => new Promise<any>(() => {}),
    }
    const daemon = new StateDaemon({
      db: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock, metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler as any, shirubeD1AutoReceive: d1 as any,
      config: { queueWorkMaxConcurrentRunners: 1 },
    })
    ;(daemon as any).scheduleQueueWorkRunner('pending', row(1, 'seat-a'), () => scheduler.runPending())
    const handled = await (daemon as any).tryShirubeD1AutoReceive(row(42, 'dev-001'))
    expect(handled).toBe(false) // deferred, re-swept later — not started
    expect(metrics.countInc('state_daemon_queue_work_backpressure_total', { result: 'd1_runner_concurrency_deferred' })).toBe(1)
    expect((daemon as any).inflightQueueWork.size).toBe(1) // cap respected
  })

  test('F3: D1 first consumes generic capacity (reverse order) and keys never collide', async () => {
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const metrics = new FakeMetrics()
    const scheduler = { runPending: () => new Promise<void>(() => {}) }
    const d1 = { classify: () => ({ outcome: 'admit' }), dispatch: () => new Promise<any>(() => {}) }
    const daemon = new StateDaemon({
      db: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock, metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler as any, shirubeD1AutoReceive: d1 as any,
      config: { queueWorkMaxConcurrentRunners: 1 },
    })
    expect(await (daemon as any).tryShirubeD1AutoReceive(row(42, 'dev-001'))).toBe(true) // D1 takes the slot
    expect((daemon as any).scheduleQueueWorkRunner('pending', row(2, 'seat-b'), () => scheduler.runPending()))
      .toBe('deferred_concurrency')
    // key-lookalike: agent literally named "42" must not collide with D1 queue 42
    const daemon2 = new StateDaemon({
      db: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock, metrics: new FakeMetrics(),
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler as any, shirubeD1AutoReceive: d1 as any,
      config: { queueWorkMaxConcurrentRunners: 2 },
    })
    expect(await (daemon2 as any).tryShirubeD1AutoReceive(row(42, 'dev-001'))).toBe(true)
    expect((daemon2 as any).scheduleQueueWorkRunner('pending', row(7, '42'), () => scheduler.runPending())).toBe('invoked')
    expect((daemon2 as any).inflightQueueWork.size).toBe(2)
  })

  test('F4/F5: production dispatch seam returns acted=false on deferral, row and DB untouched; slot release invokes once', async () => {
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const metrics = new FakeMetrics()
    const updates: string[] = []
    const db = {
      query: async (sql: string) => {
        if (/UPDATE|INSERT|DELETE/i.test(sql)) updates.push(sql.slice(0, 60))
        return { rows: [], rowCount: 0 }
      },
    }
    const resolvers: Array<() => void> = []
    const scheduler = { runPending: () => new Promise<void>((r) => { resolvers.push(r) }) }
    const daemon = new StateDaemon({
      db: db as any,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock, metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler as any,
      config: { queueWorkMaxConcurrentRunners: 1 },
    })
    const rowA = row(1, 'seat-a')
    const rowB = row(2, 'seat-b')
    const before = JSON.stringify(rowB)
    const act = (r: any) => (daemon as any).runObservedQueueAction({ kind: 'invoke_codex_runner' }, r, null, 'agent-comms-mcp')
    expect(await act(rowA)).toBe(true) // occupies slot
    for (let i = 0; i < 3; i++) {
      expect(await act(rowB)).toBe(false) // F4: acted=false → sweep rewoken must not count it
    }
    expect(JSON.stringify(rowB)).toBe(before) // row object byte-identical
    expect(updates).toEqual([]) // F5: zero DB mutations — no attempt/claim consumed
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(1)
    resolvers[0]?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(await act(rowB)).toBe(true) // slot released → invoked exactly once
    expect(metrics.countInc('state_daemon_queue_work_actions_total', { result: 'pending_runner_invoked' })).toBe(2)
  })

  test('F4: received/done deferrals also report non-invoked results', () => {
    const { schedule: _s } = buildDaemon(1) // occupy via helper daemon
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const metrics = new FakeMetrics()
    const scheduler = {
      runPending: () => new Promise<void>(() => {}),
      runReceived: () => new Promise<void>(() => {}),
      runDone: () => new Promise<void>(() => {}),
    }
    const daemon = new StateDaemon({
      db: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock, metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler as any,
      config: { queueWorkMaxConcurrentRunners: 1 },
    })
    const sched = (phase: string, r: any) => (daemon as any).scheduleQueueWorkRunner(phase, r, () => scheduler.runPending())
    expect(sched('pending', row(1, 'seat-a'))).toBe('invoked')
    expect(sched('received', row(2, 'seat-b'))).toBe('deferred_concurrency')
    expect(sched('done', row(3, 'seat-c'))).toBe('deferred_concurrency')
    expect(metrics.countInc('state_daemon_queue_work_backpressure_total', { result: 'received_runner_concurrency_deferred' })).toBe(1)
    expect(metrics.countInc('state_daemon_queue_work_backpressure_total', { result: 'done_runner_concurrency_deferred' })).toBe(1)
  })

  test('F5: production sweepStale — repeated deferral leaves the DB row untouched, rewoken=0; release invokes exactly once', async () => {
    const clock = new FakeClock('2026-08-28T00:00:00.000Z')
    const metrics = new FakeMetrics()
    const mutations: string[] = []
    const invoked: Array<{ queueId: unknown; agentId: string }> = []
    const pendingRow = {
      id: 4242,
      agent_id: 'seat-b',
      message_id: 'msg-4242',
      payload: JSON.stringify({ message_type: 'task', content: 'real work' }),
      status: 'pending',
      claim_expires_at: null,
      created_at: new Date('2026-08-28T00:00:00.000Z'),
      last_wake_attempt_at: null,
      last_heartbeat_at: null,
      message_type: 'task',
      channel_id: 'ch-1',
    }
    const pendingRowFrozen = JSON.stringify(pendingRow)
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) { mutations.push(sql.slice(0, 80)); return { rows: [], rowCount: 0 } }
        if (sql.includes("mq.status='pending'") && sql.includes('created_at <')) {
          return { rows: [JSON.parse(pendingRowFrozen)], rowCount: 1 }
        }
        if (sql.includes('profile_revision') && sql.includes('FROM agents')) {
          return {
            rows: [{
              agent_id: 'seat-b', runtime: 'codex', profile_revision: null, profile_source: null,
              channel_port: null, home_directory: '/repo', metadata: { tmux_session: 'seat-b-session' },
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM agents') && (sql.includes('agent_id=$1') || sql.includes('agent_id = $1'))) {
          return {
            rows: [{
              agent_id: String(params?.[0]),
              agent_type: 'dev',
              runtime: 'codex',
              runtime_engine_preference: 'codex',
              status: 'idle',
              profile_enabled: true,
              disabled_at: null,
              metadata: { memory_project: 'agent-comms-mcp' },
              tmux_session: null,
              last_seen_at: new Date('2026-08-28T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: 'rt-f5', agent_id: 'seat-b', runtime_engine: 'codex',
              runtime_kind: 'local_process', session_name: 'seat-b-session', port: null,
              checkout_path: '/repo', commit_sha: null,
              started_at: '2026-08-27T00:00:00.000Z', last_seen_at: '2030-01-01T00:00:00.000Z',
              status: 'running', metadata: {},
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM runtime_memory_ready_evidence')) {
          return {
            rows: [{
              id: 1, agent_id: 'seat-b', project: 'agent-comms-mcp', runtime_instance_id: 'rt-f5',
              profile_revision: null, profile_source: null, session_name: 'seat-b-session', port: null,
              expected_agent_id: 'seat-b', checkout_path: '/repo', checkout_commit_sha: null,
              recovery_command: 'mcp__wasurezu__recover_context', result_status: 'ready',
              failure_reason: null, completed_at: '2026-08-27T23:55:00.000Z',
              evidence_path: null, evidence_log_id: null,
              valid_until: '2030-01-01T00:00:00.000Z', source: 'wasurezu_boot_recovery', metadata: {},
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM channels')) {
          return { rows: [{ members: ['seat-a', 'seat-b', 'arc'] }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const resolvers: Array<() => void> = []
    const scheduler = {
      runPending: (input: { queueId: unknown; agentId: string }) => {
        invoked.push(input)
        return new Promise<void>((r) => { resolvers.push(r) })
      },
    }
    const daemon = new StateDaemon({
      db: db as any,
      pgListen: new FakePgListen(), tmux: new FakeTmux(), clock, metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler as any,
      config: {
        queueWorkMaxConcurrentRunners: 1,
        pendingStaleAfter: '10 seconds',
      },
    })
    await daemon.start()
    try {
      // saturate the single slot with a hung runner for another seat
      expect((daemon as any).scheduleQueueWorkRunner('pending', row(1, 'seat-a'), () => new Promise<void>(() => {}))).toBe('invoked')
      // three production sweeps: the pending row is fetched each time and deferred each time
      for (let i = 0; i < 3; i++) {
        clock.advance(30_000)
        const result = await daemon.sweepStale()
        expect(result.rewoken).toBe(0) // F4 accounting at the production seam
      }
      expect(invoked).toEqual([]) // runner never started for the deferred row
      expect(mutations).toEqual([]) // zero DB writes: no attempt, claim, or payload consumed
      expect(metrics.countInc('state_daemon_queue_work_backpressure_total', { result: 'pending_runner_concurrency_deferred' })).toBe(3)
      // release the slot; the next sweep invokes exactly once
      ;(daemon as any).inflightQueueWork.clear()
      ;(daemon as any).inflightQueueWorkIds.clear()
      clock.advance(30_000)
      const after = await daemon.sweepStale()
      expect(after.rewoken).toBe(1)
      expect(invoked).toEqual([{ queueId: 4242, agentId: 'seat-b' }])
    } finally {
      // resolve the outstanding runner: stop()'s drain deadline uses the
      // injected clock, which FakeClock never advances
      resolvers.forEach((r) => r())
      await new Promise((r) => setTimeout(r, 0))
      await daemon.stop()
    }
  })
})
