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

describe('state_daemon typed acknowledgement and fail-open delivery', () => {
  test('substantive chat, report, notice, and projection rows fail open to runner delivery', async () => {
    const fixtures = [
      ['chat', 'Run CHECK and ADJUST, then publish evidence.'],
      ['report', 'Please audit PR #950 and publish a verdict.'],
      ['notice', 'Investigate the failed readiness check and report the cause.'],
      ['projection', 'Execute the bounded repair described by this projection.'],
    ] as const
    const subjects = new Map<string, { agent: string; id: number }>()
    for (const [messageType, content] of fixtures) {
      const agent = makeAgentId(`typed-delivery-${messageType}`)
      await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
      subjects.set(messageType, { agent, id: await seedQueueRow(pg, {
        agent_id: agent,
        status: 'pending',
        payload: payload(messageType, { content }),
        created_at: new Date('2026-05-18T00:00:00.000Z'),
      }) })
    }

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()

      expect(result.scanned).toBe(4)
      expect(result.rewoken).toBe(4)
      expect(h.runner.invocations.map((invocation) => invocation.queueId).sort((a, b) => a - b))
        .toEqual([...subjects.values()].map(({ id }) => id).sort((a, b) => a - b))
      expect(h.tmux.sentKeys).toEqual([])
      for (const [messageType] of fixtures) {
        const row = await readQueue(subjects.get(messageType)!.id)
        expect(row.status).toBe('pending')
        expect(row.failed_reason).toBeNull()
        expect(row.done_at).toBeNull()
        expect(JSON.parse(row.payload).queue_disposition).toBeUndefined()
        expect(h.metrics.countInc('state_daemon_wake_actions_total', {
          result: 'routing_delivery_fallback',
          message_type: messageType,
          route_reason: 'non_actionable_type',
        })).toBe(1)
      }
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'terminal_non_actionable' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('only an exact typed acknowledgement envelope is terminalized automatically', async () => {
    const agent = makeAgentId('typed-ack')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
    const acknowledgedMessageId = '11111111-1111-4111-8111-999999999999'
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      payload: payload('chat', {
        content: 'Free-form text is not consulted by the terminal decision.',
        typed_ack: {
          schema_version: 'aun-queue-ack/v1',
          kind: 'receipt',
          acknowledged_message_id: acknowledgedMessageId,
        },
      }),
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
      expect(row.status).toBe('done')
      expect(row.failed_reason).toBe('TYPED_ACK_RECEIPT')
      expect(row.done_at).toBeTruthy()
      expect(JSON.parse(row.payload).queue_disposition).toMatchObject({
        code: 'TYPED_ACK_RECEIPT',
        set_by: 'state_daemon',
        source: 'typed_ack_envelope',
        message_type: 'chat',
        routing_decision: 'deliver_only',
        route_reason: 'non_actionable_type',
        acknowledgement: {
          schema_version: 'aun-queue-ack/v1',
          kind: 'receipt',
          acknowledged_message_id: acknowledgedMessageId,
        },
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'typed_ack_terminalized',
        reason: 'TYPED_ACK_RECEIPT',
        message_type: 'chat',
      })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('ACK prose without the typed envelope fails open to runner delivery', async () => {
    const agent = makeAgentId('ack-prose-only')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      payload: payload('chat', { content: 'ACK: audit PASS received and recorded. No reply required.' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      const row = await readQueue(id)
      expect(result.scanned).toBe(1)
      expect(result.rewoken).toBe(1)
      expect(h.runner.invocations).toHaveLength(1)
      expect(h.runner.invocations[0]).toMatchObject({ agentId: agent, queueId: id })
      expect(row.status).toBe('pending')
      expect(row.failed_reason).toBeNull()
      expect(row.done_at).toBeNull()
      expect(JSON.parse(row.payload).queue_disposition).toBeUndefined()
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'routing_delivery_fallback',
        message_type: 'chat',
        route_reason: 'non_actionable_type',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'typed_ack_terminalized' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('malformed typed acknowledgement envelopes fail open to runner delivery', async () => {
    const fixtures = [
      ['wrong-schema', { schema_version: 'aun-queue-ack/v0', kind: 'receipt', acknowledged_message_id: 'message-1' }],
      ['empty-id', { schema_version: 'aun-queue-ack/v1', kind: 'receipt', acknowledged_message_id: '' }],
      ['extra-key', { schema_version: 'aun-queue-ack/v1', kind: 'receipt', acknowledged_message_id: 'message-3', prose: 'ACK' }],
    ] as const
    const ids: number[] = []
    for (const [suffix, typedAck] of fixtures) {
      const agent = makeAgentId(`malformed-ack-${suffix}`)
      await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
      ids.push(await seedQueueRow(pg, {
        agent_id: agent,
        status: 'pending',
        payload: payload('chat', { content: 'ACK: received and recorded.', typed_ack: typedAck }),
        created_at: new Date('2026-05-18T00:00:00.000Z'),
      }))
    }

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      expect(result.scanned).toBe(3)
      expect(result.rewoken).toBe(3)
      expect(h.runner.invocations.map((invocation) => invocation.queueId).sort((a, b) => a - b))
        .toEqual([...ids].sort((a, b) => a - b))
      for (const id of ids) {
        expect(await readQueue(id)).toMatchObject({ status: 'pending', failed_reason: null, done_at: null })
      }
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'routing_delivery_fallback',
        message_type: 'chat',
        route_reason: 'non_actionable_type',
      })).toBe(3)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'typed_ack_terminalized' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('unknown message type fails open to runner delivery', async () => {
    const agent = makeAgentId('unknown-delivery')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      payload: payload('approval', { content: 'Apply the approved repair and publish evidence.' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const h = buildHarness()
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()
      const row = await readQueue(id)
      expect(result.scanned).toBe(1)
      expect(result.rewoken).toBe(1)
      expect(h.runner.invocations).toHaveLength(1)
      expect(h.runner.invocations[0]).toMatchObject({ agentId: agent, queueId: id })
      expect(row.status).toBe('pending')
      expect(row.failed_reason).toBeNull()
      expect(row.done_at).toBeNull()
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'routing_delivery_fallback',
        message_type: 'approval',
        route_reason: 'non_actionable_type',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'routing_hold' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('actionable pending row still reaches Codex runner', async () => {
    const agent = makeAgentId('actionable-pass')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
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

  test('reclaim-then-wake delivers an expired report claim instead of terminalizing it', async () => {
    const agent = makeAgentId('expired-report')
    await seedAgent(pg, { agent_id: agent, runtime: 'codex', tmux_session: null, status: 'online' })
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
      expect(h.runner.invocations).toHaveLength(1)
      expect(h.runner.invocations[0]).toMatchObject({ agentId: agent, queueId: id })
      expect(row).toMatchObject({
        status: 'pending',
        failed_reason: null,
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'reclaimed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'routing_delivery_fallback',
        message_type: 'report',
        route_reason: 'non_actionable_type',
      })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})
