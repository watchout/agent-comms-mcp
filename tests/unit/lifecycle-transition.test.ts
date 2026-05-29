import { describe, expect, test } from 'bun:test'
import { lifecycleTransitionCore, type LifecycleTransitionDb } from '../../core/lifecycle-transition'

type Fixture = {
  row?: Record<string, unknown>
  sourceRow?: Record<string, unknown>
  agents?: Array<Record<string, unknown>>
  batons?: Array<Record<string, unknown>>
}

function dbFor(fixture: Fixture): { db: LifecycleTransitionDb; executed: string[] } {
  const executed: string[] = []
  return {
    executed,
    db: {
      async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        if (sql.includes('FROM message_queue') && !sql.includes('LEFT JOIN agent_messages am')) {
          return fixture.row ? [fixture.row as T] : []
        }
        if (sql.includes('FROM message_queue mq') && sql.includes('LEFT JOIN agent_messages am')) {
          return fixture.sourceRow ? [fixture.sourceRow as T] : []
        }
        if (sql.includes('SELECT agent_id, agent_type, metadata FROM agents')) {
          return (fixture.agents ?? []) as T[]
        }
        if (sql.includes('FROM agent_messages child')) {
          return (fixture.batons ?? []) as T[]
        }
        return []
      },
      async execute(sql: string): Promise<{ rowCount: number }> {
        executed.push(sql)
        return { rowCount: 1 }
      },
    },
  }
}

function transitionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    agent_id: 'codex-aun',
    message_id: 'root-message',
    status: 'in_progress',
    ...overrides,
  }
}

function sourceRow(overrides: Record<string, unknown> = {}) {
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

describe('lifecycle transition core', () => {
  test('processing advances received rows through the exported handler fixture', async () => {
    const { db, executed } = dbFor({
      row: transitionRow({ status: 'received' }),
    })

    const result = await lifecycleTransitionCore(db, {
      mode: 'processing',
      queueId: 42,
      agentId: 'codex-aun',
    })

    expect(result).toMatchObject({ ok: true, status: 'in_progress' })
    expect(executed).toHaveLength(1)
    expect(executed[0]).toContain("status = 'in_progress'")
  })

  test('done rejects human-authored source rows before any status update', async () => {
    const { db, executed } = dbFor({
      row: transitionRow(),
      sourceRow: sourceRow(),
      agents: [{ agent_id: 'ceo', agent_type: 'human', metadata: { discord_id: '1227059781265653783' } }],
    })

    const result = await lifecycleTransitionCore(db, {
      mode: 'done',
      queueId: 42,
      agentId: 'codex-aun',
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'TERMINAL_BATON_REQUIRED',
    })
    expect(executed).toHaveLength(0)
  })
})
