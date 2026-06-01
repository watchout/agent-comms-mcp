import { describe, expect, test } from 'bun:test'
import {
  buildCodexRuntimeRunnerInvocation,
  buildCodexRunnerCommand,
} from '../../../core/state-daemon/codex-runner-adapter'
import {
  RUNTIME_RUNNER_CONTRACT_VERSION,
  buildRuntimeRunnerInvocation,
  parseRuntimeRunnerStdout,
} from '../../../core/state-daemon/runtime-runner-contract'

describe('runtime runner adapter contract', () => {
  test('normalizes Codex and Claude to the same queue/baton invocation shape', () => {
    const codex = buildRuntimeRunnerInvocation({
      runtimeKind: 'codex',
      agentId: 'codex-aun',
      queueId: 94526,
      messageId: 'msg-94526',
      requester: 'codex-cto',
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ackContent: 'ACK',
      payload: { content: 'targeted work' },
      batonContext: {
        conversation_id: 'conv-1',
        baton_id: 'baton-1',
        owner_agent_id: 'codex-aun',
        state: 'active',
      },
    })
    const claude = buildRuntimeRunnerInvocation({
      runtimeKind: 'claude',
      agentId: 'devauditor',
      queueId: '94519',
      messageId: 'msg-94519',
      requester: 'aun',
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ackContent: 'ACK',
    })

    expect(codex.contract_version).toBe(RUNTIME_RUNNER_CONTRACT_VERSION)
    expect(codex.runtime_kind).toBe('codex')
    expect(codex.queue_context).toMatchObject({
      queue_id: '94526',
      message_id: 'msg-94526',
      agent_id: 'codex-aun',
    })
    expect(codex.baton_context).toMatchObject({
      conversation_id: 'conv-1',
      baton_id: 'baton-1',
      owner_agent_id: 'codex-aun',
      state: 'active',
    })
    expect(claude.contract_version).toBe(RUNTIME_RUNNER_CONTRACT_VERSION)
    expect(claude.runtime_kind).toBe('claude')
    expect(claude.queue_context.queue_id).toBe('94519')
    expect(claude.baton_context).toBeNull()
  })

  test('Codex adapter receives exact queue_id instead of draining FIFO rows', () => {
    const invocation = buildCodexRuntimeRunnerInvocation({
      agentId: 'codex-aun',
      queueId: 94526,
      messageId: 'msg-94526',
      requester: null,
      databaseUrl: 'postgresql:///agent_comms?host=/tmp',
      ackContent: 'ACK',
      payload: { content: 'targeted work' },
    })
    const plan = buildCodexRunnerCommand({
      agentId: invocation.agent_id,
      queueId: Number(invocation.queue_id),
      messageId: invocation.message_id,
      requester: invocation.requester,
      databaseUrl: invocation.database_url,
      ackContent: invocation.ack_content,
      payload: invocation.queue_context.payload,
    })

    expect(plan.args).toContain('--queue-id')
    expect(plan.args.slice(plan.args.indexOf('--queue-id'), plan.args.indexOf('--queue-id') + 2))
      .toEqual(['--queue-id', '94526'])
  })

  test('adapter stdout is reduced to typed runner result evidence', () => {
    const typed = parseRuntimeRunnerStdout(JSON.stringify({
      ok: true,
      retained_count: 1,
      retained: [{ queue_id: '94526', message_id: 'msg-94526' }],
    }))

    expect(typed).toMatchObject({
      outcome: 'claimed_work',
      retained_count: 1,
      queue_ids: ['94526'],
    })
    expect(parseRuntimeRunnerStdout('not-json')).toMatchObject({
      outcome: 'parse_error',
      retained_count: null,
      queue_ids: [],
    })
  })
})
