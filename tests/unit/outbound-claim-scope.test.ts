import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildOutboundClaimQuery,
  consumeOneOutboundRow,
  parseOutboundClaimScope,
  setDbGetter,
} from '../../adapters/outbound-consumer'
import { discordClients } from '../../adapters/discord-client'

const ENV_KEY = 'AGENT_COM_OUTBOUND_CLAIM_SCOPE'

const originalScope = process.env[ENV_KEY]

afterEach(() => {
  if (originalScope === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = originalScope
  }
  discordClients.delete('agent-com-dev')
})

describe('outbound claim scope', () => {
  test('defaults to self and keeps the agent_id claim filter', () => {
    expect(parseOutboundClaimScope(undefined)).toBe('self')
    expect(parseOutboundClaimScope('')).toBe('self')
    expect(parseOutboundClaimScope('self')).toBe('self')

    const query = buildOutboundClaimQuery('agent-com-dev', 'self')
    expect(query.sql).toContain('AND agent_id = $1')
    expect(query.params).toEqual(['agent-com-dev'])
    expect(query.sql).toContain('RETURNING id, message_id, agent_id')
  })

  test('global scope claims pending UI rows without filtering by logical sender', () => {
    expect(parseOutboundClaimScope('global')).toBe('global')

    const query = buildOutboundClaimQuery('agent-com-dev', 'global')
    expect(query.sql).not.toContain('AND agent_id = $1')
    expect(query.params).toEqual([])
    expect(query.sql).toContain("WHERE status = 'pending'")
  })

  test('global dispatcher can deliver a row whose logical sender is another agent', async () => {
    process.env[ENV_KEY] = 'global'

    const queries: Array<{ sql: string; params?: any[] }> = []
    const fakeDb = {
      query: async (sql: string, params?: any[]) => {
        queries.push({ sql, params })
        if (sql.includes('RETURNING id, message_id, agent_id')) {
          return {
            rows: [{
              id: 42,
              message_id: null,
              agent_id: 'codex-test',
              channel_external_id: '1487368919613444156',
              content: 'hello from codex',
              attempts: 1,
              max_attempts: 5,
              discord_message_id: null,
            }],
          }
        }
        return { rows: [], rowCount: 1 }
      },
    }

    setDbGetter(async () => fakeDb, 'agent-com-dev')
    discordClients.set('agent-com-dev', {
      sendAdapterMessage: async (msg: any) => {
        expect(msg.external_channel_id).toBe('1487368919613444156')
        expect(msg.content).toBe('hello from codex')
        expect(msg.nonce).toBe('out-42')
        expect(msg.enforceNonce).toBe(true)
        return { external_message_id: 'discord-42' }
      },
    } as any)

    await consumeOneOutboundRow()

    expect(queries[0].params).toEqual([])
    expect(queries[0].sql).not.toContain('AND agent_id = $1')
    expect(queries.some(q => q.sql.includes("UPDATE outbound_queue SET status = 'sent'"))).toBe(true)
  })
})
