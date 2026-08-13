import { describe, expect, test } from 'bun:test'
import { buildCodexRunnerCommand } from '../../../core/state-daemon/codex-runner-adapter'

describe('state_daemon Codex runner adapter command contract', () => {
  test('builds structured argv/env for script-controlled Codex receive', () => {
    const plan = buildCodexRunnerCommand({
      agentId: 'codex-aun',
      queueId: 123,
      messageId: 'msg-123',
      requester: 'codex-cto',
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      memoryReadyProject: 'codex-aun',
      ackContent: 'ACK: received by codex-aun; queue_id=123; message_id=msg-123; final close requires explicit --close.',
    })

    expect(plan.command).toBe(process.execPath)
    expect(plan.command).not.toBe('bun')
    expect(plan.args).toEqual([
      'bin/aun.ts',
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', '123',
      '--limit', '1',
      '--ack-mentions', 'codex-cto',
      '--ack-content', 'ACK: received by codex-aun; queue_id=123; message_id=msg-123; final close requires explicit --close.',
    ])
    expect(plan.env).toEqual({
      AGENT_ID: 'codex-aun',
      AGENT_COM_EXPECTED_AGENT_ID: 'codex-aun',
      DATABASE_URL: 'postgresql:///agent_comms?host=/tmp',
      AUN_RECEIVE_CLAIM_SOURCE: 'state-daemon-codex-runner',
      AGENT_COMMS_MEMORY_READY_PROJECT: 'codex-aun',
      AGENT_MEMORY_PROJECT: 'codex-aun',
    })
  })

  test('runner invocation fails closed before spawn when the target project is absent', async () => {
    const { ExecFileCodexRunnerInvoker } = await import('../../../core/state-daemon/codex-runner-adapter')
    const invoker = new ExecFileCodexRunnerInvoker()
    await expect(invoker.invoke({
      agentId: 'codex-aun',
      queueId: 123,
      messageId: 'msg-123',
      requester: null,
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ackContent: 'ACK',
    } as any)).resolves.toMatchObject({
      ok: false,
      stderr: 'memory-ready project is required for Codex runner codex-aun',
    })
  })

  test('allows an explicit Bun executable override for launchd/operator installs', () => {
    const prior = process.env.STATE_DAEMON_BUN_EXECUTABLE
    process.env.STATE_DAEMON_BUN_EXECUTABLE = '/opt/aun/bin/bun'
    try {
      const plan = buildCodexRunnerCommand({
        agentId: 'codex-aun',
        queueId: 123,
        messageId: 'msg-123',
        requester: null,
        databaseUrl: 'postgresql:///agent_comms?host=/tmp',
        ackContent: 'ACK',
      })

      expect(plan.command).toBe('/opt/aun/bin/bun')
    } finally {
      if (prior === undefined) delete process.env.STATE_DAEMON_BUN_EXECUTABLE
      else process.env.STATE_DAEMON_BUN_EXECUTABLE = prior
    }
  })

  test('omits ACK flags when requester is unknown rather than inventing prose ownership', () => {
    const plan = buildCodexRunnerCommand({
      agentId: 'codex-aun',
      queueId: 123,
      messageId: null,
      requester: null,
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ackContent: 'ACK',
    })

    expect(plan.args).toEqual([
      'bin/aun.ts',
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', '123',
      '--limit', '1',
    ])
  })

  test('adds exact no-reply completion flags only when requested by state_daemon policy', () => {
    const plan = buildCodexRunnerCommand({
      agentId: 'codex-aun',
      queueId: 123,
      messageId: 'msg-123',
      requester: 'codex-cto',
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ackContent: 'ACK',
      completeNoReply: true,
      completionReason: 'direct_mention_smoke_completed_without_substantive_reply',
    })

    expect(plan.args).toEqual([
      'bin/aun.ts',
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', '123',
      '--limit', '1',
      '--ack-mentions', 'codex-cto',
      '--ack-content', 'ACK',
      '--complete-no-reply',
      '--completion-reason', 'direct_mention_smoke_completed_without_substantive_reply',
    ])
  })

  test('auto-final reply omits fixed ACK flags and closes through runner final reply mode', () => {
    const plan = buildCodexRunnerCommand({
      agentId: 'codex-aun',
      queueId: 123,
      messageId: 'msg-123',
      requester: 'codex-cto',
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ackContent: '',
      autoFinalReply: true,
    })

    expect(plan.args).toEqual([
      'bin/aun.ts',
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--queue-id', '123',
      '--limit', '1',
      '--auto-final-reply',
    ])
  })
})
