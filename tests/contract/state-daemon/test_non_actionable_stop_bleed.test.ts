import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import type { StateDaemonConfig } from '../../../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeCodexRunner,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
  PgDBClient,
} from './fakes'
import { cleanAll, makeAgentId, openClient, seedAgent, seedQueueRow } from './seed'

let pg: Client

beforeAll(async () => {
  pg = await openClient()
})

afterAll(async () => {
  if (pg) {
    await cleanAll(pg)
    await pg.end()
  }
})

beforeEach(async () => {
  await cleanAll(pg)
  await pg.query('BEGIN')
})

afterEach(async () => {
  await pg.query('ROLLBACK')
  await cleanAll(pg)
})

function buildHarness(clock = new FakeClock('2026-05-18T00:00:30.000Z'), config: Partial<StateDaemonConfig> = {}) {
  const runner = new FakeCodexRunner()
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const tmux = new FakeTmux()
  const daemon = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner: runner,
    clock,
    metrics,
    alert,
    config: {
      agentIdPrefix: 'sd-test-',
      codexRunnerEnabled: true,
      codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ...config,
    },
  })
  return { daemon, runner, metrics, alert, tmux, clock }
}

async function readQueue(id: number): Promise<{
  status: string
  failed_reason: string | null
  done_at: Date | null
  payload: string
  claimed_by: string | null
  claimed_at: Date | null
  claim_expires_at: Date | null
}> {
  const row = await pg.query(
    `SELECT status, failed_reason, done_at, payload, claimed_by, claimed_at, claim_expires_at
       FROM message_queue WHERE id=$1`,
    [id],
  )
  return row.rows[0]
}

function payload(messageType: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    author_id: 'codex-cto',
    content: `${messageType} fixture`,
    message_type: messageType,
    source: 'agent-comms',
    ...extra,
  })
}

describe('state_daemon non-actionable poison-row stop-bleed (#696)', () => {
  test('pending report row is terminalized once and never runner-dispatched', async () => {
    const agent = makeAgentId('non-action-report')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'idle' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      payload: payload('report'),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const h = buildHarness()
    await h.daemon.start()
    try {
      const first = await h.daemon.sweepStale()
      const afterFirst = await readQueue(id)
      const second = await h.daemon.sweepStale()
      const afterSecond = await readQueue(id)

      expect(first.scanned).toBe(1)
      expect(first.rewoken).toBe(0)
      expect(second.scanned).toBe(0)
      expect(h.runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(afterFirst.status).toBe('skipped')
      expect(afterFirst.failed_reason).toBe('NON_ACTIONABLE_REPORT')
      expect(afterFirst.done_at).toBeTruthy()
      expect(afterSecond.done_at?.toISOString()).toBe(afterFirst.done_at?.toISOString())
      expect(JSON.parse(afterFirst.payload).queue_disposition).toMatchObject({
        code: 'NON_ACTIONABLE_REPORT',
        set_by: 'state_daemon',
        source: 'deterministic_queue_routing',
        message_type: 'report',
        routing_decision: 'deliver_only',
        route_reason: 'non_actionable_type',
      })
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'terminal_non_actionable' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'non_actionable_terminalized', reason: 'NON_ACTIONABLE_REPORT' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('deterministic chat, notice, and projection rows receive stable terminal reasons', async () => {
    const agent = makeAgentId('non-action-types')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'idle' })
    const rows = [
      ['chat', 'NON_ACTIONABLE_CHAT'],
      ['notice', 'NON_ACTIONABLE_NOTICE'],
      ['projection', 'NON_ACTIONABLE_PROJECTION'],
    ] as const
    const ids = new Map<string, number>()
    for (const [messageType] of rows) {
      ids.set(messageType, await seedQueueRow(pg, {
        agent_id: agent,
        status: 'pending',
        payload: payload(messageType),
        created_at: new Date('2026-05-18T00:00:00.000Z'),
      }))
    }

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.scanned).toBe(3)
      expect(result.rewoken).toBe(0)
      expect(h.runner.invocations).toHaveLength(0)

      for (const [messageType, reason] of rows) {
        const row = await readQueue(ids.get(messageType)!)
        expect(row.status).toBe('skipped')
        expect(row.failed_reason).toBe(reason)
        expect(JSON.parse(row.payload).queue_disposition).toMatchObject({
          code: reason,
          message_type: messageType,
        })
        expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'non_actionable_terminalized', reason })).toBe(1)
      }
    } finally {
      await h.daemon.stop()
    }
  })

  test('unknown message type is held open with diagnostics, not terminalized or dispatched', async () => {
    const agent = makeAgentId('unknown-held')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'idle' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      payload: payload('approval'),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      const row = await readQueue(id)
      expect(result.scanned).toBe(1)
      expect(result.rewoken).toBe(0)
      expect(h.runner.invocations).toHaveLength(0)
      expect(row.status).toBe('pending')
      expect(row.failed_reason).toBeNull()
      expect(row.done_at).toBeNull()
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'routing_hold' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'routing_non_actionable_held',
        message_type: 'approval',
      })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('actionable pending row still reaches Codex runner', async () => {
    const agent = makeAgentId('actionable-pass')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'idle' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      payload: payload('instruction', { content: 'review PR #696' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.scanned).toBe(1)
      expect(result.rewoken).toBe(1)
      expect(h.runner.invocations).toHaveLength(1)
      expect(h.runner.invocations[0]).toMatchObject({ agentId: agent, queueId: id })
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('reclaim-then-wake terminalizes an expired non-actionable claim without dispatch', async () => {
    const agent = makeAgentId('expired-report')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'idle' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      claimed_by: agent,
      claimed_at: new Date('2026-05-18T00:00:00.000Z'),
      claim_expires_at: new Date('2026-05-18T00:00:10.000Z'),
      payload: payload('report'),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      const row = await readQueue(id)
      expect(result.reclaimed).toBe(1)
      expect(result.rewoken).toBe(0)
      expect(h.runner.invocations).toHaveLength(0)
      expect(row).toMatchObject({
        status: 'skipped',
        failed_reason: 'NON_ACTIONABLE_REPORT',
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'non_actionable_terminalized', reason: 'NON_ACTIONABLE_REPORT' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})
