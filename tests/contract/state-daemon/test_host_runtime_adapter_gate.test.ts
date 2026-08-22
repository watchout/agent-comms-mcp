import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import { StateDaemon } from '../../../core/state-daemon'
import type {
  HostRuntimeInvocationExecution,
  HostRuntimeInvoker,
} from '../../../core/state-daemon/types'
import {
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

  async invoke(input: HostRuntimeInvocationExecution): Promise<HostRuntimeRunnerResult> {
    this.executions.push(input)
    const result = parseHostRuntimeResultForProfile(input.profile, {
      invocation_id: input.invocation.invocation_id,
      stdout: this.stdout,
      exit_status: this.exitStatus,
      started_at: '2026-06-01T05:00:00.000Z',
      finished_at: '2026-06-01T05:00:01.000Z',
      schema_valid: this.schemaValid,
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
    status: 'idle',
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

  test('unsupported flags fail closed with typed evidence and leave queue lifecycle untouched', async () => {
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

    const row = await pg.query(`SELECT status FROM message_queue WHERE id=$1`, [queueId])
    expect(row.rows[0].status).toBe('pending')
    expect(codexRunner.invocations).toHaveLength(0)
    expect(hostRuntimeInvoker.executions).toHaveLength(0)
    expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_failed' })).toBe(1)
    expect(h.alert.contains('RUNTIME_FLAG_UNSUPPORTED')).toBe(true)
  })

  test('malformed host stream is typed failure evidence and cannot close or transfer work', async () => {
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

    const row = await pg.query(`SELECT status FROM message_queue WHERE id=$1`, [queueId])
    expect(row.rows[0].status).toBe('pending')
    expect(codexRunner.invocations).toHaveLength(0)
    expect(hostRuntimeInvoker.executions).toHaveLength(1)
    expect(hostRuntimeInvoker.results[0]).toMatchObject({
      schema_valid: false,
      parser_outcome: 'parse_error',
      failure_code: 'STREAM_PARSE_ERROR',
    })
    expect(h.metrics.countInc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_error' })).toBe(1)
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
