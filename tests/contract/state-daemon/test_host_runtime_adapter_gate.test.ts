import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import type {
  HostRuntimeInvocationExecution,
  HostRuntimeInvoker,
} from '../../../core/state-daemon/types'
import {
  isHostRuntimeFailureRetryable,
  parseHostRuntimeResultForProfile,
  selectHostRuntimeAdapter,
  type HostRuntimeRunnerResult,
  type RuntimeInvocationProfile,
} from '../../../core/state-daemon/host-runtime-invocation'
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
})

function hostProfile(overrides: Partial<RuntimeInvocationProfile> = {}): RuntimeInvocationProfile {
  return {
    profile_id: 'test-codex-host-runtime',
    runtime: 'codex',
    cwd: '/repo',
    allowed_dirs: ['/repo'],
    prompt_delivery: 'stdin-json',
    output_stream: 'jsonl',
    final_output_schema_ref: 'schema://host-runtime-result',
    sandbox: 'read-only',
    env_allowlist: [],
    secret_policy: 'none',
    timeout_ms: 30_000,
    degraded_tui_fallback_allowed: false,
    ...overrides,
  }
}

function daemon(input: {
  clock: FakeClock
  codexRunner: FakeCodexRunner
  hostRuntimeInvoker?: HostRuntimeInvoker
  profile?: RuntimeInvocationProfile | null
  hostRuntimeAdapterEnabled?: boolean
  supportedFlags?: string[] | null
  schemaPath?: string | null
  schemaJson?: string | null
  outputLastMessagePath?: string | null
}) {
  const metrics = new FakeMetrics()
  const alert = new FakeAlertSink()
  const tmux = new FakeTmux()
  const d = new StateDaemon({
    db: new PgDBClient(pg),
    pgListen: new FakePgListen(),
    tmux,
    codexRunner: input.codexRunner,
    hostRuntimeInvoker: input.hostRuntimeInvoker,
    clock: input.clock,
    metrics,
    alert,
    config: {
      agentIdPrefix: 'sd-test-',
      codexRunnerEnabled: true,
      codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
      hostRuntimeAdapterEnabled: input.hostRuntimeAdapterEnabled ?? false,
      hostRuntimeInvocationProfile: input.profile ?? null,
      hostRuntimeInvocationSupportedFlags: input.supportedFlags ?? null,
      hostRuntimeInvocationSchemaPath: input.schemaPath ?? null,
      hostRuntimeInvocationSchemaJson: input.schemaJson ?? null,
      hostRuntimeInvocationOutputLastMessagePath: input.outputLastMessagePath ?? null,
    },
  })
  return { daemon: d, metrics, alert, tmux }
}

class FixtureHostRuntimeInvoker implements HostRuntimeInvoker {
  executions: HostRuntimeInvocationExecution[] = []
  results: HostRuntimeRunnerResult[] = []
  stdout = JSON.stringify({
    type: 'final_result',
    final_message: 'fixture complete',
    structured_result: { outcome: 'claimed_work' },
  })
  exitStatus = 0
  schemaValid = true
  timedOut = false

  async invoke(input: HostRuntimeInvocationExecution): Promise<HostRuntimeRunnerResult> {
    this.executions.push(input)
    const result = parseHostRuntimeResultForProfile(input.profile, {
      invocation_id: input.invocation.invocation_id,
      stdout: this.stdout,
      exit_status: this.exitStatus,
      started_at: '2026-06-01T05:00:00.000Z',
      finished_at: '2026-06-01T05:00:01.000Z',
      schema_valid: this.schemaValid,
      timed_out: this.timedOut,
    })
    this.results.push(result)
    return result
  }
}

async function seedPendingCodexWork(suffix: string): Promise<{ agent: string; queueId: number }> {
  const agent = makeAgentId(suffix)
  await seedAgent(pg, {
    agent_id: agent,
    runtime: 'codex',
    tmux_session: null,
    status: 'online',
    last_seen_at: new Date('2030-06-01T05:00:00.000Z'),
  })
  const queueId = await seedQueueRow(pg, {
    agent_id: agent,
    status: 'pending',
    message_id: '11111111-1111-4111-8111-111111111111',
    payload: JSON.stringify({ author_id: 'aun', content: 'untrusted payload must not become argv', message_type: 'instruction' }),
    created_at: new Date('2030-06-01T05:00:00.000Z'),
  })
  return { agent, queueId }
}

describe('CP-40D host runtime adapter profile gate', () => {
  test('disabled/default path preserves existing CP-40B codex-runner behavior', async () => {
    const { agent, queueId } = await seedPendingCodexWork('host-gate-disabled')
    const codexRunner = new FakeCodexRunner()
    const hostRuntimeInvoker = new FixtureHostRuntimeInvoker()
    const h = daemon({
      clock: new FakeClock('2030-06-01T05:00:01.000Z'),
      codexRunner,
      hostRuntimeInvoker,
      profile: hostProfile(),
      hostRuntimeAdapterEnabled: false,
    })

    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: queueId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
    } finally {
      await h.daemon.stop()
    }

    expect(codexRunner.invocations).toHaveLength(1)
    expect(codexRunner.invocations[0]).toMatchObject({
      agentId: agent,
      queueId,
      messageId: '11111111-1111-4111-8111-111111111111',
    })
    expect(hostRuntimeInvoker.executions).toHaveLength(0)
    expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })).toBe(1)
  })

  test('explicit host-runtime profile builds structured argv and parses fixture output into typed evidence', async () => {
    const { agent, queueId } = await seedPendingCodexWork('host-gate-enabled')
    const codexRunner = new FakeCodexRunner()
    const hostRuntimeInvoker = new FixtureHostRuntimeInvoker()
    const h = daemon({
      clock: new FakeClock('2030-06-01T05:00:01.000Z'),
      codexRunner,
      hostRuntimeInvoker,
      profile: hostProfile({ allowed_dirs: ['/repo', '/repo/shared'] }),
      hostRuntimeAdapterEnabled: true,
      supportedFlags: ['--json', '--output-schema', '--output-last-message', '--sandbox', '--cd', '--add-dir', '--ephemeral'],
      schemaPath: '/tmp/cp40d-schema.json',
      outputLastMessagePath: '/tmp/cp40d-final.txt',
    })

    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: queueId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
    } finally {
      await h.daemon.stop()
    }

    expect(codexRunner.invocations).toHaveLength(0)
    expect(hostRuntimeInvoker.executions).toHaveLength(1)
    const execution = hostRuntimeInvoker.executions[0]
    expect(execution.command.command).toBe('codex')
    expect(execution.command.args).toEqual([
      'exec',
      '--json',
      '--output-schema', '/tmp/cp40d-schema.json',
      '--output-last-message', '/tmp/cp40d-final.txt',
      '--sandbox', 'read-only',
      '--cd', '/repo',
      '--add-dir', '/repo/shared',
      '--ephemeral',
      '-',
    ])
    expect(execution.command.stdin).toContain(`message_queue://${queueId}/payload`)
    expect(execution.command.args.join(' ')).not.toContain('untrusted payload must not become argv')
    expect(hostRuntimeInvoker.results[0]).toMatchObject({
      runtime: 'codex',
      final_message: 'fixture complete',
      schema_valid: true,
      parser_outcome: 'success',
      final_structured_result: { outcome: 'claimed_work' },
    })
    expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_invoked' })).toBe(1)
  })

  test('unsupported flags fail closed once with typed non-retryable terminal evidence', async () => {
    const { agent, queueId } = await seedPendingCodexWork('host-gate-flags')
    const codexRunner = new FakeCodexRunner()
    const hostRuntimeInvoker = new FixtureHostRuntimeInvoker()
    const h = daemon({
      clock: new FakeClock('2030-06-01T05:00:01.000Z'),
      codexRunner,
      hostRuntimeInvoker,
      profile: hostProfile(),
      hostRuntimeAdapterEnabled: true,
      supportedFlags: ['--json', '--sandbox', '--cd'],
      schemaPath: '/tmp/cp40d-schema.json',
      outputLastMessagePath: '/tmp/cp40d-final.txt',
    })

    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: queueId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
    } finally {
      await h.daemon.stop()
    }

    const row = await pg.query(
      `SELECT status, failed_reason, done_at, payload FROM message_queue WHERE id=$1`,
      [queueId],
    )
    expect(row.rows[0]).toMatchObject({
      status: 'failed',
      failed_reason: 'RUNTIME_FLAG_UNSUPPORTED',
    })
    expect(row.rows[0].done_at).not.toBeNull()
    expect(JSON.parse(row.rows[0].payload)).toMatchObject({
      runner_error: {
        code: 'RUNTIME_FLAG_UNSUPPORTED',
        retryable: false,
        invocation_source: 'state-daemon-host-runtime-adapter',
        pending_fence: { queue_id: queueId, status: 'pending' },
      },
      queue_work_runner_error_recovery: {
        attempts: 0,
        max_reclaims: 0,
        last_action: 'failed_non_retryable',
      },
    })
    expect(codexRunner.invocations).toHaveLength(0)
    expect(hostRuntimeInvoker.executions).toHaveLength(0)
    expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_failed' })).toBe(1)
    expect(h.metrics.countInc('state_daemon_wake_actions_total', {
      result: 'host_runtime_failure_failed_non_retryable',
      code: 'RUNTIME_FLAG_UNSUPPORTED',
    })).toBe(1)
    expect(h.alert.contains('marked failed code=RUNTIME_FLAG_UNSUPPORTED')).toBe(true)
  })

  test('malformed host stream becomes typed failed and cannot become done or replied', async () => {
    const { agent, queueId } = await seedPendingCodexWork('host-gate-malformed')
    const codexRunner = new FakeCodexRunner()
    const hostRuntimeInvoker = new FixtureHostRuntimeInvoker()
    hostRuntimeInvoker.stdout = '{not-json'
    const h = daemon({
      clock: new FakeClock('2030-06-01T05:00:01.000Z'),
      codexRunner,
      hostRuntimeInvoker,
      profile: hostProfile(),
      hostRuntimeAdapterEnabled: true,
      supportedFlags: ['--json', '--output-schema', '--output-last-message', '--sandbox', '--cd', '--ephemeral'],
      schemaPath: '/tmp/cp40d-schema.json',
      outputLastMessagePath: '/tmp/cp40d-final.txt',
    })

    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: queueId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
    } finally {
      await h.daemon.stop()
    }

    const row = await pg.query(
      `SELECT status, failed_reason, replied_with, payload FROM message_queue WHERE id=$1`,
      [queueId],
    )
    expect(row.rows[0]).toMatchObject({
      status: 'failed',
      failed_reason: 'STREAM_PARSE_ERROR',
      replied_with: null,
    })
    expect(JSON.parse(row.rows[0].payload)).toMatchObject({
      runner_error: { code: 'STREAM_PARSE_ERROR', retryable: false },
      queue_work_runner_error_recovery: { last_action: 'failed_non_retryable' },
    })
    expect(codexRunner.invocations).toHaveLength(0)
    expect(hostRuntimeInvoker.executions).toHaveLength(1)
    expect(hostRuntimeInvoker.results[0]).toMatchObject({
      schema_valid: false,
      parser_outcome: 'parse_error',
      failure_code: 'STREAM_PARSE_ERROR',
    })
    expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_error' })).toBe(1)
  })

  test('SCHEMA_REQUIRED terminalizes once without launch or later retry', async () => {
    const { agent, queueId } = await seedPendingCodexWork('host-gate-schema-terminal')
    const codexRunner = new FakeCodexRunner()
    const hostRuntimeInvoker = new FixtureHostRuntimeInvoker()
    const h = daemon({
      clock: new FakeClock('2030-06-01T05:00:01.000Z'),
      codexRunner,
      hostRuntimeInvoker,
      profile: hostProfile(),
      hostRuntimeAdapterEnabled: true,
      schemaPath: '/tmp/cp40d-schema.json',
      outputLastMessagePath: null,
    })

    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: queueId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
      await h.daemon.sweepStale()
    } finally {
      await h.daemon.stop()
    }

    const row = await pg.query(
      `SELECT status, failed_reason, done_at, payload FROM message_queue WHERE id=$1`,
      [queueId],
    )
    expect(row.rows[0]).toMatchObject({ status: 'failed', failed_reason: 'SCHEMA_REQUIRED' })
    expect(row.rows[0].done_at).not.toBeNull()
    expect(JSON.parse(row.rows[0].payload)).toMatchObject({
      runner_error: {
        code: 'SCHEMA_REQUIRED',
        retryable: false,
        runtime_id: 'test-codex-host-runtime',
        pending_fence: { queue_id: queueId, status: 'pending' },
      },
      queue_work_runner_error_recovery: {
        attempts: 0,
        max_reclaims: 0,
        last_action: 'failed_non_retryable',
        reason: 'SCHEMA_REQUIRED',
      },
    })
    expect(codexRunner.invocations).toHaveLength(0)
    expect(hostRuntimeInvoker.executions).toHaveLength(0)
    expect(h.alert.alerts.filter((alert) => alert.includes(`queue_id=${queueId}`))).toHaveLength(1)
  })

  test('one SCHEMA_REQUIRED row does not stop a later row in the same stale sweep', async () => {
    const claudeAgent = makeAgentId('host-gate-fairness-claude')
    await seedAgent(pg, {
      agent_id: claudeAgent,
      runtime: 'codex',
      runtime_engine_preference: 'claude-code',
      tmux_session: null,
      status: 'online',
      last_seen_at: new Date('2030-06-01T05:00:00.000Z'),
    })
    const blockedQueueId = await seedQueueRow(pg, {
      agent_id: claudeAgent,
      status: 'pending',
      payload: JSON.stringify({ author_id: 'aun', content: 'first row', message_type: 'instruction' }),
      created_at: new Date('2030-06-01T04:58:00.000Z'),
    })

    const codexAgent = makeAgentId('host-gate-fairness-codex')
    await seedAgent(pg, {
      agent_id: codexAgent,
      runtime: 'codex',
      tmux_session: null,
      status: 'online',
      last_seen_at: new Date('2030-06-01T05:00:00.000Z'),
    })
    const laterQueueId = await seedQueueRow(pg, {
      agent_id: codexAgent,
      status: 'pending',
      payload: JSON.stringify({ author_id: 'aun', content: 'second row', message_type: 'instruction' }),
      created_at: new Date('2030-06-01T04:59:00.000Z'),
    })

    const codexRunner = new FakeCodexRunner()
    const hostRuntimeInvoker = new FixtureHostRuntimeInvoker()
    const h = daemon({
      clock: new FakeClock('2030-06-01T05:00:01.000Z'),
      codexRunner,
      hostRuntimeInvoker,
      hostRuntimeAdapterEnabled: false,
      schemaJson: null,
    })

    await h.daemon.start()
    try {
      await h.daemon.sweepStale()
      await h.daemon.sweepStale()
    } finally {
      await h.daemon.stop()
    }

    const first = await pg.query(
      `SELECT status, failed_reason FROM message_queue WHERE id=$1`,
      [blockedQueueId],
    )
    expect(first.rows[0]).toMatchObject({ status: 'failed', failed_reason: 'SCHEMA_REQUIRED' })
    expect(codexRunner.invocations).toHaveLength(1)
    expect(codexRunner.invocations[0]).toMatchObject({ agentId: codexAgent, queueId: laterQueueId })
    expect(hostRuntimeInvoker.executions).toHaveLength(0)
    expect(h.alert.alerts.filter((alert) => alert.includes(`queue_id=${blockedQueueId}`))).toHaveLength(1)
  })

  test('runtime timeout remains retryable and does not terminalize the pending row', async () => {
    const { agent, queueId } = await seedPendingCodexWork('host-gate-timeout')
    const codexRunner = new FakeCodexRunner()
    const hostRuntimeInvoker = new FixtureHostRuntimeInvoker()
    hostRuntimeInvoker.timedOut = true
    const h = daemon({
      clock: new FakeClock('2030-06-01T05:00:01.000Z'),
      codexRunner,
      hostRuntimeInvoker,
      profile: hostProfile(),
      hostRuntimeAdapterEnabled: true,
      supportedFlags: ['--json', '--output-schema', '--output-last-message', '--sandbox', '--cd'],
      schemaPath: '/tmp/cp40d-schema.json',
      outputLastMessagePath: '/tmp/cp40d-final.txt',
    })

    await h.daemon.start()
    try {
      await h.daemon.__testHandleEvent({
        op: 'INSERT',
        id: queueId,
        agent_id: agent,
        status: 'pending',
        claim_expires_at: null,
      })
    } finally {
      await h.daemon.stop()
    }

    const row = await pg.query(`SELECT status, failed_reason, payload FROM message_queue WHERE id=$1`, [queueId])
    expect(row.rows[0]).toMatchObject({ status: 'pending', failed_reason: null })
    expect(JSON.parse(row.rows[0].payload).runner_error).toBeUndefined()
    expect(hostRuntimeInvoker.results[0]).toMatchObject({ failure_code: 'RUNTIME_TIMEOUT' })
    expect(isHostRuntimeFailureRetryable('RUNTIME_TIMEOUT')).toBe(true)
    expect(isHostRuntimeFailureRetryable('SCHEMA_REQUIRED')).toBe(false)
  })

  test('invalid profile/schema selection returns typed failure instead of prose fallback', () => {
    const baseInvocation = {
      invocation_id: 'inv-invalid',
      agent_id: 'codex-aun',
      task_kind: 'receive' as const,
      trusted_instruction: 'Run exact queue_id=1.',
      policy_refs: [],
      untrusted_context_refs: [],
      context_pack_refs: [],
      expected_result_schema_ref: 'schema://result',
      runtime_profile_ref: 'profile://bad',
    }

    expect(selectHostRuntimeAdapter({
      enabled: true,
      profile: hostProfile({ profile_id: '' }),
      invocation: baseInvocation,
      schemaPath: '/tmp/schema.json',
      outputLastMessagePath: '/tmp/final.txt',
    })).toMatchObject({
      ok: false,
      failure: { failure_code: 'RUNTIME_PROFILE_INVALID' },
    })

    expect(selectHostRuntimeAdapter({
      enabled: true,
      profile: hostProfile(),
      invocation: baseInvocation,
      schemaPath: '/tmp/schema.json',
    })).toMatchObject({
      ok: false,
      failure: { failure_code: 'SCHEMA_REQUIRED' },
    })
  })
})
