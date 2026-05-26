import { describe, expect, test } from 'bun:test'
import { evaluateDoneTransition } from '../../core/terminal-baton-invariant'

type Fixture = {
  queue?: Record<string, unknown>
  agents?: Array<Record<string, unknown>>
  batons?: Array<Record<string, unknown>>
  messages?: Record<string, Record<string, unknown>>
}

function queryFor(fixture: Fixture) {
  return async function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    if (sql.includes('FROM message_queue mq') && sql.includes('LEFT JOIN agent_messages am')) {
      return fixture.queue ? [fixture.queue as T] : []
    }
    if (sql.includes('SELECT agent_id, agent_type, metadata FROM agents')) {
      return (fixture.agents ?? []) as T[]
    }
    if (sql.includes('FROM agent_messages child')) {
      return (fixture.batons ?? []) as T[]
    }
    if (sql.includes('FROM agent_messages') && sql.includes('WHERE id::text = $1')) {
      const id = String(params?.[0] ?? '')
      const message = fixture.messages?.[id]
      return message ? [message as T] : []
    }
    return []
  }
}

function queue(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    agent_id: 'codex-aun',
    message_id: 'root-message',
    payload: '{}',
    source_message_id: 'root-message',
    reply_to: null,
    author_id: '1227059781265653783',
    author_bot: false,
    message_metadata: '{}',
    ...overrides,
  }
}

describe('terminal baton invariant', () => {
  test('blocks bare done for human-authored work without reply or baton evidence', async () => {
    const decision = await evaluateDoneTransition(queryFor({
      queue: queue(),
      agents: [{ agent_id: 'ceo', agent_type: 'human', metadata: { discord_id: '1227059781265653783' } }],
      batons: [],
    }), { queueId: 42, agentId: 'codex-aun' })

    expect(decision).toMatchObject({
      allowed: false,
      code: 'TERMINAL_BATON_REQUIRED',
      reason: 'human_source_requires_reply_or_baton',
    })
  })

  test('allows bare done for bot-authored/internal work', async () => {
    const decision = await evaluateDoneTransition(queryFor({
      queue: queue({ author_id: 'codex-cto', author_bot: true }),
      agents: [{ agent_id: 'codex-cto', agent_type: 'dev', metadata: {} }],
    }), { queueId: 42, agentId: 'codex-aun' })

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'bot_or_internal_source',
    })
  })

  test('allows explicit no-reply-required rows', async () => {
    const decision = await evaluateDoneTransition(queryFor({
      queue: queue({ payload: JSON.stringify({ terminal_baton: { no_reply_required: true } }) }),
      agents: [{ agent_id: 'ceo', agent_type: 'human', metadata: { discord_id: '1227059781265653783' } }],
    }), { queueId: 42, agentId: 'codex-aun' })

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'explicit_no_reply_required',
    })
  })

  test('allows human-authored work when the current agent passed a durable bot baton', async () => {
    const decision = await evaluateDoneTransition(queryFor({
      queue: queue(),
      agents: [
        { agent_id: 'ceo', agent_type: 'human', metadata: { discord_id: '1227059781265653783' } },
        { agent_id: 'codex-cto', agent_type: 'dev', metadata: {} },
      ],
      batons: [{
        message_id: 'child-message',
        recipient_agent_id: 'codex-cto',
        queue_status: 'pending',
      }],
    }), { queueId: 42, agentId: 'codex-aun' })

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'baton_forwarded',
      details: {
        baton_message_id: 'child-message',
        baton_recipient_agent_id: 'codex-cto',
      },
    })
  })

  test('blocks bare done for bot-authored baton work with a human root ancestor', async () => {
    const decision = await evaluateDoneTransition(queryFor({
      queue: queue({
        source_message_id: 'baton-message',
        message_id: 'baton-message',
        reply_to: 'root-message',
        author_id: 'codex-aun',
        author_bot: true,
      }),
      agents: [
        { agent_id: 'ceo', agent_type: 'human', metadata: { discord_id: '1227059781265653783' } },
        { agent_id: 'codex-aun', agent_type: 'dev', metadata: {} },
      ],
      messages: {
        'root-message': {
          message_id: 'root-message',
          reply_to: null,
          author_id: '1227059781265653783',
          author_bot: false,
          message_metadata: '{}',
        },
      },
      batons: [],
    }), { queueId: 42, agentId: 'codex-cto' })

    expect(decision).toMatchObject({
      allowed: false,
      code: 'TERMINAL_BATON_REQUIRED',
      details: {
        human_root_message_id: 'root-message',
        human_root_author_id: '1227059781265653783',
      },
    })
  })
})
