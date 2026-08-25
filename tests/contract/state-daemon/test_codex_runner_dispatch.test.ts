import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import type { DBClient, StateDaemonConfig } from '../../../core/state-daemon/types'
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

const QUEUE_127801_BLOCKING_AUDIT_REQUEST = `schema_version: shirube-v3/audit_request/v1
audit_request_id: AUDIT-CELL-KUSABI-PR252-RL-RECON-512A458-20260715
control_source: https://github.com/watchout/agent-memory/issues/180
control_handoff: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
correction_gate_result: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977871304
cell: {id: CELL-KUSABI-PR252-RAPID-LITE-ROUTE-RECONCILIATION-001}
execution_context:
  from: {agent_id: kusabi, active_function: implementation_executor}
  to: {agent_id: codex-audit, active_function: evidence_audit_gate}
subject:
  repository: watchout/agent-memory
  pull_request: 252
  exact_base: 3b3200ecbe83fbeec4a349f1ce1e0c705493436f
  prior_blocked_head: 5aff61d2bbc905526a6a67950a3eda1179147ed7
  exact_head: 512a458c4f4d68d681e9f7cbe9eff34a5b09a4e6
  implementation_evidence: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977920274
trusted_github_provenance:
  required_comment_author_login: iyasaka-ai
  required_author_association: [MEMBER, COLLABORATOR]
  reviewer_actor: codex-audit
  execution_context_agent_id: codex-audit
  marker: shirube-v3:evidence-audit-gate-result:PR252-512A458
  posting_note: Use the configured iyasaka-ai GitHub credential without printing its token; after posting, read back user.login and author_association from GitHub API.
required_response:
  destination: PR 252 top-level comment
  fenced_yaml_schema: shirube-structured-audit/v1
  audit_checklist_id: AUDIT-CHECKLIST-KUSABI-PR252-RL-RECON-001
  implementation_actor: kusabi
  target:
    repository: watchout/agent-memory
    pull_request: 252
    cell_id: CELL-KUSABI-PR252-RAPID-LITE-ROUTE-RECONCILIATION-001
    control_handoff: https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
    exact_head: 512a458c4f4d68d681e9f7cbe9eff34a5b09a4e6
  items_rule: KRL-001 through KRL-012 exactly once, each PASS or BLOCK
  aggregate_rule: PASS only if all items PASS; passing next_action must be none
audit_focus:
  KRL-009: Verify watchout/OWNER self-authored audit is rejected and iyasaka-ai/COLLABORATOR audit provenance is accepted only with exact marker and execution-context actor.
  KRL-010: Verify WRONG-CHECKLIST-ID is rejected and exact canonical checklist is required; rerun all negative cases.
  all_items: Revalidate KRL-001 through KRL-012, not only the prior blockers.
evidence_refs:
  - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
  - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977871304
  - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977920274
  - https://github.com/watchout/agent-memory/actions/runs/29396888522
  - https://github.com/watchout/agent-memory/actions/runs/29396888951
  - https://github.com/watchout/agent-memory/actions/runs/29397036854
forbidden_operations: [edit_or_fix, owner_approval, merge, deploy, publish, release, protected_state_mutation, product_doc_edit, shirube_edit]
lifecycle_state: AUDIT_REQUESTED
next_action:
  blocking: true
  owner_agent: codex-audit
  owner_function: evidence_audit_gate
  action: Independently audit the exact head and publish terminal PASS or BLOCK.
  handoff_method: Post one top-level PR 252 comment, verify GitHub author metadata, then return its exact URL through AUN.
  input_refs:
    - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977616868
    - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977871304
    - https://github.com/watchout/agent-memory/pull/252#issuecomment-4977920274
    - https://github.com/watchout/agent-memory/actions/runs/29397036854
  scope: read-only exact-head audit; no implementation or owner authority
  deliverable: terminal PASS or BLOCK, KRL-001..012 exactly once
  completion_evidence: provenance-bound PR audit URL plus AUN return
  stop_reason: FRESH_INDEPENDENT_AUDIT_REQUIRED`

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

function daemon(
  clock: FakeClock,
  codexRunner: FakeCodexRunner,
  tmux = new FakeTmux(),
  config: Partial<StateDaemonConfig> = {},
) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner,
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
  return { daemon: d, metrics, alert, tmux }
}

function scopedDaemon(
  clock: FakeClock,
  codexRunner: FakeCodexRunner,
  agentAllowlist: string[],
  tmux = new FakeTmux(),
) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner,
    clock,
    metrics,
    alert,
    config: {
      agentIdPrefix: 'sd-test-',
      agentAllowlist,
      codexRunnerEnabled: true,
      codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
    },
  })
  return { daemon: d, metrics, alert, tmux }
}

function denylistDaemon(
  clock: FakeClock,
  codexRunner: FakeCodexRunner,
  agentDenylist: string[],
  tmux = new FakeTmux(),
) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner,
    clock,
    metrics,
    alert,
    config: {
      agentIdPrefix: 'sd-test-',
      agentDenylist,
      codexRunnerEnabled: true,
      codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
    },
  })
  return { daemon: d, metrics, alert, tmux }
}

function disabledDaemon(clock: FakeClock, codexRunner: FakeCodexRunner) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const tmux = new FakeTmux()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner,
    clock,
    metrics,
    alert,
    config: { agentIdPrefix: 'sd-test-' },
  })
  return { daemon: d, metrics, alert, tmux }
}

class CloseRowAfterReserveDB implements DBClient {
  private readonly delegate: PgDBClient
  constructor(
    private readonly client: Client,
    private readonly queueId: number,
  ) {
    this.delegate = new PgDBClient(client)
  }

  async query<T = any>(sql: string, params?: unknown[]) {
    const result = await this.delegate.query<T>(sql, params)
    if (sql.includes('UPDATE agents') && sql.includes('last_wake_attempt_at=$1')) {
      await this.client.query(
        `UPDATE message_queue
            SET status='replied',
                replied_at=now(),
                replied_with='99999999-9999-4999-8999-999999999999'
          WHERE id=$1`,
        [this.queueId],
      )
    }
    return result
  }
}

async function deleteMemoryReadyEvidence(agentId: string): Promise<void> {
  await pg.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id=$1`, [agentId])
}

async function expireMemoryReadyEvidence(agentId: string): Promise<void> {
  await pg.query(
    `UPDATE runtime_memory_ready_evidence
        SET valid_until='2026-05-17T00:00:00.000Z'
      WHERE agent_id=$1`,
    [agentId],
  )
}

async function mismatchMemoryReadyRuntime(agentId: string): Promise<void> {
  await pg.query(
    `UPDATE runtime_memory_ready_evidence
        SET runtime_instance_id='runtime-mismatch-for-memory-ready-test'
      WHERE agent_id=$1`,
    [agentId],
  )
}

describe('state_daemon invoke_codex_runner dispatch boundary', () => {
  test('pending idle Codex runtime invokes runner and never tmux wake', async () => {
    const agent = makeAgentId('codex-runner')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-111111111111',
      payload: JSON.stringify({ author_id: 'codex-cto', content: 'do work', message_type: 'instruction' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(1)
      expect(runner.invocations[0]).toMatchObject({
        agentId: agent,
        queueId: id,
        messageId: '11111111-1111-4111-8111-111111111111',
        requester: 'codex-cto',
        databaseUrl: 'postgresql:///agent_comms?host=/tmp',
        payload: JSON.stringify({ author_id: 'codex-cto', content: 'do work', message_type: 'instruction' }),
        completeNoReply: false,
        completionReason: null,
      })
      expect(runner.invocations[0].ackContent).toContain('queue_id={queue_id}')
      expect(runner.invocations[0].ackContent).toContain('message_id={message_id}')
      expect(runner.invocations[0].ackContent).not.toContain(`queue_id=${id}`)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('missing/stale/mismatched memory-ready evidence blocks Codex runner before dispatch', async () => {
    const scenarios = [
      { suffix: 'missing-memory', reason: 'missing_evidence', mutate: deleteMemoryReadyEvidence },
      { suffix: 'stale-memory', reason: 'expired', mutate: expireMemoryReadyEvidence },
      { suffix: 'mismatch-memory', reason: 'runtime_instance_mismatch', mutate: mismatchMemoryReadyRuntime },
    ] as const

    for (const scenario of scenarios) {
      const agent = makeAgentId(`codex-${scenario.suffix}`)
      await seedAgent(pg, {
        agent_id: agent,
        runtime: 'codex',
        tmux_session: null,
        status: 'online',
        last_seen_at: '2026-05-18T00:00:01.000Z',
      })
      await scenario.mutate(agent)
      const id = await seedQueueRow(pg, {
        agent_id: agent,
        status: 'pending',
        message_id: '11111111-1111-4111-8111-111111111119',
        payload: JSON.stringify({ author_id: 'codex-cto', content: `do work ${scenario.suffix}`, message_type: 'instruction' }),
        created_at: new Date('2026-05-18T00:00:00.000Z'),
      })

      const runner = new FakeCodexRunner()
      const h = daemon(new FakeClock('2026-05-18T00:00:01.000Z'), runner)
      await h.daemon.start()
      try {
        await h.daemon.__testHandleEvent({
          op: 'INSERT',
          id,
          agent_id: agent,
          status: 'pending',
          claim_expires_at: null,
        })

        expect(runner.invocations).toHaveLength(0)
        expect(h.metrics.countInc('state_daemon_wake_actions_total', {
          result: 'memory_ready_blocked',
          action: 'invoke_codex_runner',
          reason: scenario.reason,
        })).toBe(1)
        expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(0)
        expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_error' })).toBe(0)
        const row = (await pg.query(
          `SELECT status, claimed_by, last_wake_attempt_at FROM message_queue WHERE id=$1`,
          [id],
        )).rows[0] as { status: string; claimed_by: string | null; last_wake_attempt_at: Date | null }
        expect(row).toEqual({ status: 'pending', claimed_by: null, last_wake_attempt_at: null })
      } finally {
        await h.daemon.stop()
      }
    }
  })

  test('repeated identical memory-ready blocks are exponentially deferred and alert only on transitions', async () => {
    const agent = makeAgentId('memory-backoff-dedup')
    const runtimeInstanceId = '11111111-2222-4333-8444-555555555555'
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'idle',
      runtime_instance_id: runtimeInstanceId,
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    await deleteMemoryReadyEvidence(agent)
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-555555555555',
      payload: JSON.stringify({ author_id: 'arc', content: 'backoff fixture', message_type: 'instruction' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const runner = new FakeCodexRunner()
    const h = daemon(clock, runner)
    const event = { op: 'INSERT' as const, id, agent_id: agent, status: 'pending', claim_expires_at: null }
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent(event)
      await h.daemon.__testHandleEvent(event)
      await h.daemon.__testHandleEvent(event)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'memory_ready_blocked',
        reason: 'missing_evidence',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_memory_ready_backoff_total', { result: 'deferred' })).toBe(2)
      expect(h.alert.alerts.filter(value => value.includes('memory_ready gate blocked'))).toHaveLength(1)

      clock.advance(30_000)
      await h.daemon.__testHandleEvent(event)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'memory_ready_blocked',
        reason: 'missing_evidence',
      })).toBe(2)
      expect(h.alert.alerts.filter(value => value.includes('memory_ready gate blocked'))).toHaveLength(1)

      await seedAgent(pg, {
        agent_id: agent,
        runtime: 'codex',
        tmux_session: null,
        status: 'idle',
        runtime_instance_id: runtimeInstanceId,
        last_seen_at: '2026-05-18T00:01:31.000Z',
      })
      clock.advance(60_000)
      await h.daemon.__testHandleEvent(event)
      expect(runner.invocations).toHaveLength(1)
      expect(h.alert.alerts.filter(value => value.includes('memory_ready gate recovered'))).toHaveLength(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('disabled memory-ready gate config fails closed instead of bypassing dispatch', async () => {
    const agent = makeAgentId('codex-config-bypass')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-111111111121',
      payload: JSON.stringify({ author_id: 'codex-cto', content: 'do work with disabled memory gate', message_type: 'instruction' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const h = daemon(new FakeClock('2026-05-18T00:00:01.000Z'), runner, new FakeTmux(), {
      memoryReadyGateEnabled: false,
    })
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'memory_ready_blocked',
        action: 'invoke_codex_runner',
        reason: 'unaudited_bypass',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('legacy TUI paths are disabled before memory-ready gated runner dispatch', async () => {
    const pendingScenarios = [
      { suffix: 'tui-missing-memory', reason: 'missing_evidence', mutate: deleteMemoryReadyEvidence },
      { suffix: 'tui-stale-memory', reason: 'expired', mutate: expireMemoryReadyEvidence },
      { suffix: 'tui-mismatch-memory', reason: 'runtime_instance_mismatch', mutate: mismatchMemoryReadyRuntime },
    ] as const

    for (const scenario of pendingScenarios) {
      const agent = makeAgentId(scenario.suffix)
      await seedAgent(pg, {
        agent_id: agent,
        runtime: 'TUI',
        status: 'online',
        last_seen_at: '2026-05-18T00:00:01.000Z',
      })
      await scenario.mutate(agent)
      const id = await seedQueueRow(pg, {
        agent_id: agent,
        status: 'pending',
        payload: JSON.stringify({ author_id: 'codex-cto', content: `wake ${scenario.suffix}`, message_type: 'instruction' }),
        created_at: new Date('2026-05-18T00:00:00.000Z'),
      })

      const h = daemon(new FakeClock('2026-05-18T00:00:01.000Z'), new FakeCodexRunner())
      await h.daemon.start()
      try {
        await h.daemon.__testHandleEvent({
          op: 'INSERT',
          id,
          agent_id: agent,
          status: 'pending',
          claim_expires_at: null,
        })
        expect(h.tmux.sentKeys).toEqual([])
        expect(h.metrics.countInc('state_daemon_wake_actions_total', {
          result: 'memory_ready_blocked',
          action: 'legacy_tui_disabled',
          reason: scenario.reason,
        })).toBe(0)
        expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'legacy_tui_disabled' })).toBe(1)
        expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      } finally {
        await h.daemon.stop()
      }
    }

    const receivedAgent = makeAgentId('tui-received-missing-memory')
    await seedAgent(pg, {
      agent_id: receivedAgent,
      runtime: 'TUI',
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    await deleteMemoryReadyEvidence(receivedAgent)
    const receivedId = await seedQueueRow(pg, {
      agent_id: receivedAgent,
      status: 'received',
      payload: JSON.stringify({ author_id: 'codex-cto', content: 'wake received without memory', message_type: 'instruction' }),
      claim_expires_at: new Date('2026-05-18T00:01:00.000Z'),
      claimed_by: receivedAgent,
      claimed_at: new Date('2026-05-18T00:00:00.000Z'),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const h = daemon(new FakeClock('2026-05-18T00:00:01.000Z'), new FakeCodexRunner())
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'UPDATE',
        id: receivedId,
        agent_id: receivedAgent,
        status: 'received',
        claim_expires_at: new Date('2026-05-18T00:01:00.000Z'),
      })
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'memory_ready_blocked',
        action: 'legacy_tui_disabled',
        reason: 'missing_evidence',
      })).toBe(0)
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('pending report row is not dispatched, terminalized, or runner-error looped', async () => {
    const agent = makeAgentId('codex-report')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-111111111120',
      payload: JSON.stringify({ author_id: 'agent-com-dev', message_type: 'report', content: 'implementation status only' }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const h = daemon(new FakeClock('2026-05-18T00:00:01.000Z'), runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.metrics.countInc('state_daemon_state_actions_total', {
        action: 'terminal_non_actionable',
        status: 'pending',
        terminal: 'true',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', {
        result: 'non_actionable_terminalized',
        reason: 'NON_ACTIONABLE_REPORT',
        message_type: 'report',
      })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_error' })).toBe(0)
      const row = (await pg.query(
        `SELECT status, claimed_by, replied_with, failed_reason FROM message_queue WHERE id=$1`,
        [id],
      )).rows[0] as { status: string; claimed_by: string | null; replied_with: string | null; failed_reason: string | null }
      expect(row).toEqual({
        status: 'skipped',
        claimed_by: null,
        replied_with: null,
        failed_reason: 'NON_ACTIONABLE_REPORT',
      })
    } finally {
      await h.daemon.stop()
    }
  })

  test('direct mention smoke is passed to auto-final reply without daemon ACK', async () => {
    const agent = makeAgentId('codex-smoke')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      discord_id: '999010',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-333333333333',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: '<@999010> 疎通テスト',
        message_type: 'chat',
        source: 'discord',
        input_mentions: ['999010'],
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    runner.result = {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        retained_count: 1,
        retained: [{ queue_id: String(id), message_id: '11111111-1111-4111-8111-333333333333' }],
        completion: {
          outcome: 'completed_reply',
          terminal_queue_ids: [String(id)],
          reason: 'auto_final_reply_completed',
        },
      }) + '\n',
      stderr: '',
      typed_result: {
        outcome: 'claimed_work',
        retained_count: 1,
        queue_ids: [String(id)],
        completion_outcome: 'completed_reply',
        terminal_queue_ids: [String(id)],
        completion_reason: 'auto_final_reply_completed',
      },
    }
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, new FakeTmux(), { codexRunnerAutoFinalReply: true })
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(1)
      expect(runner.invocations[0]).toMatchObject({
        queueId: id,
        completeNoReply: false,
        completionReason: null,
        autoFinalReply: true,
        ackContent: '',
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_final_replied' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('auto-final reply mode passes exact queue without daemon-authored ACK prose', async () => {
    const agent = makeAgentId('codex-final')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      discord_id: '999010',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-444444444444',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: '<@999010> 日本語で返答して',
        message_type: 'chat',
        source: 'discord',
        input_mentions: ['999010'],
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    runner.result = {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        retained_count: 1,
        retained: [{ queue_id: String(id), message_id: '11111111-1111-4111-8111-444444444444' }],
        completion: {
          outcome: 'completed_reply',
          terminal_queue_ids: [String(id)],
          reason: 'auto_final_reply_completed',
        },
      }) + '\n',
      stderr: '',
      typed_result: {
        outcome: 'claimed_work',
        retained_count: 1,
        queue_ids: [String(id)],
        completion_outcome: 'completed_reply',
        terminal_queue_ids: [String(id)],
        completion_reason: 'auto_final_reply_completed',
      },
    }
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, new FakeTmux(), { codexRunnerAutoFinalReply: true })
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(1)
      expect(runner.invocations[0]).toMatchObject({
        queueId: id,
        requester: 'codex-cto',
        completeNoReply: false,
        completionReason: null,
        autoFinalReply: true,
        ackContent: '',
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_final_replied' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_open' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('structured no-reply terminal work is completed by state_daemon without invoking runner', async () => {
    const agent = makeAgentId('codex-complete')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-222222222222',
      payload: JSON.stringify({
        author_id: 'codex-cto',
        content: 'NORM-060 synthetic probe',
        no_reply_required: true,
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      const row = await pg.query<{ status: string; done_at: Date | null; payload: string }>(
        `SELECT status, done_at, payload FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(row.rows[0]?.status).toBe('done')
      expect(row.rows[0]?.done_at).toBeTruthy()
      expect(JSON.parse(row.rows[0]?.payload ?? '{}').terminal_baton).toMatchObject({
        no_reply_required: true,
        reason: 'payload_no_reply_required',
        set_by: 'state_daemon',
        source: 'deterministic_no_reply_policy',
      })
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'state_daemon_no_reply_completed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_terminal_completed' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('queue 127801 blocking audit request remains claimable without a terminal baton', async () => {
    const agent = makeAgentId('codex-blocking-audit')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-227801227801',
      payload: JSON.stringify({
        author_id: 'kusabi',
        content: QUEUE_127801_BLOCKING_AUDIT_REQUEST,
        message_type: 'instruction',
        source: 'agent-comms',
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(1)
      expect(runner.invocations[0]).toMatchObject({
        agentId: agent,
        queueId: id,
        completeNoReply: false,
        completionReason: null,
      })
      expect(runner.invocations[0].ackContent).toContain('final close requires explicit --close')
      const result = await pg.query<{ status: string; payload: string }>(
        `SELECT status, payload FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(result.rows[0]?.status).toBe('pending')
      expect(JSON.parse(result.rows[0]?.payload ?? '{}').terminal_baton).toBeUndefined()
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'state_daemon_no_reply_completed' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI no-reply terminal work is completed without prompt injection', async () => {
    const agent = makeAgentId('tui-no-reply')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      tmux_session: `${agent}-session`,
      status: 'idle',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-555555555555',
      payload: JSON.stringify({
        author_id: 'state-daemon-smoke',
        content: 'NORM-060 synthetic probe',
        no_reply_required: true,
      }),
      created_at: new Date('2026-05-18T00:00:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const tmux = new FakeTmux()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner, tmux)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(tmux.sentKeys).toEqual([])
      const row = await pg.query<{ status: string; done_at: Date | null }>(
        `SELECT status, done_at FROM message_queue WHERE id=$1`,
        [id],
      )
      expect(row.rows[0]).toMatchObject({ status: 'done' })
      expect(row.rows[0]?.done_at).toBeTruthy()
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'state_daemon_no_reply_completed' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('pending busy Codex runtime observes and does not start duplicate runner', async () => {
    const agent = makeAgentId('codex-busy')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const pending = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })
    await seedQueueRow(pg, {
      agent_id: agent,
      status: 'received',
      claimed_by: agent,
      claimed_at: new Date('2026-05-18T00:00:00.000Z'),
      claim_expires_at: new Date('2026-05-18T00:01:00.000Z'),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: pending,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'observe_busy' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'active_claim_skipped' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('Codex runner execution is disabled by default until operator activation', async () => {
    const agent = makeAgentId('codex-disabled')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = disabledDaemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('runner failure records diagnostics without terminal-failing the row', async () => {
    const agent = makeAgentId('codex-fail')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    runner.result = { ok: false, code: 1, stderr: 'runner failed' }
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      const row = await pg.query(`SELECT status FROM message_queue WHERE id=$1`, [id])
      expect(row.rows[0].status).toBe('pending')
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_error' })).toBe(1)
      expect(h.alert.contains('codex runner failed')).toBe(true)
    } finally {
      await h.daemon.stop()
    }
  })

  test('stale pending event does not invoke runner after row was already closed', async () => {
    const agent = makeAgentId('codex-stale-event')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:01.000Z',
    })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    const metrics = new FakeMetrics()
    const alert = new FakeAlertSink()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const d = new StateDaemon({
      db: new CloseRowAfterReserveDB(pg, id),
      pgListen: new FakePgListen(),
      tmux: new FakeTmux(),
      codexRunner: runner,
      clock,
      metrics,
      alert,
      config: {
        agentIdPrefix: 'sd-test-',
        codexRunnerEnabled: true,
        codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
      },
    })

    await d.start()
    try {
      await d.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_stale_skipped' })).toBe(1)
      expect(alert.alerts).toEqual([])
      const row = await pg.query(`SELECT status, replied_with FROM message_queue WHERE id=$1`, [id])
      expect(row.rows[0]).toMatchObject({
        status: 'replied',
        replied_with: '99999999-9999-4999-8999-999999999999',
      })
    } finally {
      await d.stop()
    }
  })

  test('legacy TUI pending path is disabled and does not inject wake prompts', async () => {
    const agent = makeAgentId('tui-wake-disabled')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', tmux_session: `${agent}-session`, status: 'online' })
    const id = await seedQueueRow(pg, { agent_id: agent, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI legacy profile with Codex preference invokes runner without tmux prompt injection', async () => {
    const agent = makeAgentId('tui-codex-preference')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      runtime_engine_preference: 'codex',
      tmux_session: `${agent}-session`,
      status: 'idle',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-333333333333',
      payload: JSON.stringify({ author_id: 'ceo', content: '<@999010> 疎通テスト', message_type: 'instruction' }),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(1)
      expect(runner.invocations[0]).toMatchObject({
        agentId: agent,
        queueId: id,
        requester: 'ceo',
      })
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI legacy profile with Codex preference and no tmux session bypasses stall gate and invokes runner', async () => {
    const agent = makeAgentId('tui-codex-no-tmux-runner')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      runtime_engine_preference: 'codex',
      tmux_session: null,
      status: 'idle',
      last_seen_at: '2026-05-18T00:00:00.000Z',
    })
    const id = await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      message_id: '11111111-1111-4111-8111-444444444444',
      payload: JSON.stringify({ author_id: 'ceo', content: '<@999010> 疎通テスト without tmux', message_type: 'instruction' }),
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:05:00.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(1)
      expect(runner.invocations[0]).toMatchObject({
        agentId: agent,
        queueId: id,
        requester: 'ceo',
      })
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_stall_skipped_total', { kind: 'tmux_missing' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'stall_skipped' })).toBe(0)
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent allowlist ignores pg_notify rows outside the activation scope', async () => {
    const allowed = makeAgentId('allowed-codex')
    const blocked = makeAgentId('blocked-codex')
    await seedAgent(pg, { agent_id: allowed, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    await seedAgent(pg, { agent_id: blocked, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    const blockedId = await seedQueueRow(pg, { agent_id: blocked, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = scopedDaemon(clock, runner, [allowed])
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: blockedId,
        agent_id: blocked,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations).toHaveLength(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_scope_skipped_total', { path: 'notify' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_state_actions_total')).toBe(0)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent allowlist limits stale sweep wake to selected agents', async () => {
    const allowed = makeAgentId('allowed-tui')
    const blocked = makeAgentId('blocked-tui')
    await seedAgent(pg, { agent_id: allowed, runtime: 'TUI', tmux_session: `${allowed}-session`, status: 'online' })
    await seedAgent(pg, { agent_id: blocked, runtime: 'TUI', tmux_session: `${blocked}-session`, status: 'online' })
    const old = new Date('2026-05-18T00:00:00.000Z')
    await seedQueueRow(pg, { agent_id: allowed, status: 'pending', created_at: old })
    await seedQueueRow(pg, { agent_id: blocked, status: 'pending', created_at: old })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:30.000Z')
    const h = scopedDaemon(clock, runner, [allowed])
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()

      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent denylist excludes stale sweep wake while preserving fleet default', async () => {
    const allowed = makeAgentId('denied-sweep-allowed')
    const denied = makeAgentId('denied-sweep-blocked')
    await seedAgent(pg, { agent_id: allowed, runtime: 'TUI', tmux_session: `${allowed}-session`, status: 'online' })
    await seedAgent(pg, { agent_id: denied, runtime: 'TUI', tmux_session: `${denied}-session`, status: 'online' })
    const old = new Date('2026-05-18T00:00:00.000Z')
    await seedQueueRow(pg, { agent_id: allowed, status: 'pending', created_at: old })
    await seedQueueRow(pg, { agent_id: denied, status: 'pending', created_at: old })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:30.000Z')
    const h = denylistDaemon(clock, runner, [denied])
    await h.daemon.start()
    try {
      const result = await h.daemon.sweepStale()

      expect(result.rewoken).toBe(0)
      expect(h.tmux.sentKeys).toEqual([])
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('agent denylist ignores pg_notify rows while allowing non-denied fleet rows', async () => {
    const allowed = makeAgentId('denied-sibling-allowed')
    const denied = makeAgentId('denied-sibling-blocked')
    await seedAgent(pg, { agent_id: allowed, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    await seedAgent(pg, { agent_id: denied, runtime: 'codex', tmux_session: null, status: 'online', last_seen_at: '2026-05-18T00:00:01.000Z' })
    const deniedId = await seedQueueRow(pg, { agent_id: denied, status: 'pending' })
    const allowedId = await seedQueueRow(pg, { agent_id: allowed, status: 'pending' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:00:01.000Z')
    const h = denylistDaemon(clock, runner, [denied])
    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: deniedId,
        agent_id: denied,
        status: 'pending',
        claim_expires_at: null,
      })
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: allowedId,
        agent_id: allowed,
        status: 'pending',
        claim_expires_at: null,
      })

      expect(runner.invocations.map((x) => x.agentId)).toEqual([allowed])
      expect(h.metrics.countInc('state_daemon_scope_skipped_total', { path: 'notify' })).toBe(1)
      expect(h.metrics.countInc('state_daemon_state_actions_total', { action: 'invoke_codex_runner' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('offline agents are not auto-restarted when full-fleet scope is enabled', async () => {
    const agent = makeAgentId('offline-no-restart')
    await seedAgent(pg, { agent_id: agent, runtime: 'TUI', tmux_session: null, status: 'offline' })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:05:00.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      const result = await h.daemon.checkBotLiveness()

      expect(result).toEqual({ checked: 0, restarted: 0, escalated: 0 })
      expect(h.tmux.restarts).toEqual([])
      expect(h.metrics.countInc('state_daemon_bot_liveness_skipped_total', { status: 'offline' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })

  test('TUI legacy profile with Codex preference is not treated as a tmux restart target', async () => {
    const agent = makeAgentId('tui-codex-no-restart')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      runtime_engine_preference: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: '2026-05-18T00:00:00.000Z',
    })

    const runner = new FakeCodexRunner()
    const clock = new FakeClock('2026-05-18T00:05:00.000Z')
    const h = daemon(clock, runner)
    await h.daemon.start()
    try {
      const result = await h.daemon.checkBotLiveness()

      expect(result).toEqual({ checked: 1, restarted: 0, escalated: 0 })
      expect(h.tmux.restarts).toEqual([])
      expect(h.metrics.countInc('state_daemon_bot_liveness_skipped_total', { runtime: 'codex' })).toBe(1)
    } finally {
      await h.daemon.stop()
    }
  })
})
