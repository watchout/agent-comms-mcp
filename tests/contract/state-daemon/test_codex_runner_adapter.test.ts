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
      ackContent: 'ACK: received by codex-aun; queue_id=123; message_id=msg-123; final close requires explicit --close.',
    })

    expect(plan.command).toBe('bun')
    expect(plan.args).toEqual([
      'bin/aun.ts',
      'codex-runner',
      '--agent-id', 'codex-aun',
      '--limit', '1',
      '--ack-mentions', 'codex-cto',
      '--ack-content', 'ACK: received by codex-aun; queue_id=123; message_id=msg-123; final close requires explicit --close.',
    ])
    expect(plan.env).toEqual({
      AGENT_ID: 'codex-aun',
      AGENT_COM_EXPECTED_AGENT_ID: 'codex-aun',
      DATABASE_URL: 'postgresql:///agent_comms?host=/tmp',
    })
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
      '--limit', '1',
    ])
  })
})
