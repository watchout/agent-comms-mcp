import { describe, expect, test } from 'bun:test'
import { resolveAgentFromDiscordId, resolveAgentFromDiscordIdInMembers, type DbAdapter } from '../../core/route-message-db'

function fakeDb(rows: Array<{ agent_id: string }>): DbAdapter {
  return {
    async query(_sql: string, _params?: unknown[]) {
      return { rows }
    },
  }
}

describe('member-scoped adapter identity resolver', () => {
  test('global resolver fails closed on duplicate external IDs', async () => {
    const result = await resolveAgentFromDiscordId(
      fakeDb([{ agent_id: 'adf-dev' }, { agent_id: 'adf-lead' }]),
      '1486171173980209162',
    )
    expect(result).toBeNull()
  })

  test('resolves exactly one channel member', async () => {
    const result = await resolveAgentFromDiscordIdInMembers(
      fakeDb([{ agent_id: 'codex-aun' }]),
      '1487367645933211699',
      ['codex-aun', 'lead-ama'],
    )
    expect(result).toEqual({ agentId: 'codex-aun' })
  })

  test('fails closed on duplicate external IDs', async () => {
    const result = await resolveAgentFromDiscordIdInMembers(
      fakeDb([{ agent_id: 'agent-com-dev' }, { agent_id: 'codex-test' }]),
      '1487367645933211699',
      ['agent-com-dev', 'codex-test', 'lead-ama'],
    )
    expect(result).toEqual({
      error: 'ambiguous',
      candidates: ['agent-com-dev', 'codex-test'],
    })
  })

  test('does not resolve non-members', async () => {
    const result = await resolveAgentFromDiscordIdInMembers(
      fakeDb([]),
      '1487367645933211699',
      ['lead-ama'],
    )
    expect(result).toEqual({ error: 'not_found', candidates: [] })
  })
})
