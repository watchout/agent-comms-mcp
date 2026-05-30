import { describe, expect, test } from 'bun:test'
import {
  DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES,
  resolveDbDiscordBotToken,
} from '../../core/discord-token-resolution'

function mockDb(options: {
  credentialRows?: any[]
  agentRows?: any[]
  queries?: string[]
}) {
  return {
    query: async (sql: string) => {
      options.queries?.push(sql)
      if (sql.includes('connector_credentials')) {
        return { rows: options.credentialRows ?? [] }
      }
      if (sql.includes('provider_token_source_ref')) {
        return { rows: options.agentRows ?? [] }
      }
      return { rows: [] }
    },
  }
}

describe('#604 Discord runtime login credential contract', () => {
  test('registered connector credential with secret_ref is accepted for runtime login', async () => {
    const queries: string[] = []
    const result = await resolveDbDiscordBotToken(
      mockDb({
        queries,
        credentialRows: [{
          credential_id: 'cred-registered',
          secret_ref: 'local-env:CODEX_CTO_DISCORD_TOKEN',
          credential_status: 'registered',
        }],
      }),
      'codex-cto',
      { CODEX_CTO_DISCORD_TOKEN: 'registered-token' },
    )

    expect(result).toMatchObject({
      token: 'registered-token',
      source: 'connector_credential',
      credentialId: 'cred-registered',
      credentialStatus: 'registered',
      secretRef: 'local-env:CODEX_CTO_DISCORD_TOKEN',
      tokenSource: 'local-env:CODEX_CTO_DISCORD_TOKEN',
    })
    expect(queries[0]).toContain('connector_credentials')
    for (const status of DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES) {
      expect(queries[0]).toContain(`'${status}'`)
    }
  })

  test('active connector credential with secret_ref is accepted for runtime login', async () => {
    const result = await resolveDbDiscordBotToken(
      mockDb({
        credentialRows: [{
          credential_id: 'cred-active',
          secret_ref: 'local-env:ACTIVE_DISCORD_TOKEN',
          credential_status: 'active',
        }],
      }),
      'codex-cto',
      { ACTIVE_DISCORD_TOKEN: 'active-token' },
    )

    expect(result?.token).toBe('active-token')
    expect(result?.credentialStatus).toBe('active')
  })

  test('disabled, revoked, and rotated connector credentials are not runtime-login eligible', async () => {
    for (const credential_status of ['disabled', 'revoked', 'rotated']) {
      const result = await resolveDbDiscordBotToken(
        mockDb({
          credentialRows: [{
            credential_id: `cred-${credential_status}`,
            secret_ref: 'local-env:DISCORD_TOKEN',
            credential_status,
          }],
        }),
        'codex-cto',
        { DISCORD_TOKEN: 'blocked-token' },
      )

      expect(result).toBeNull()
    }
  })

  test('unresolvable connector secret_ref is skipped without accepting the credential', async () => {
    const result = await resolveDbDiscordBotToken(
      mockDb({
        credentialRows: [{
          credential_id: 'cred-missing-secret',
          secret_ref: 'local-env:MISSING_DISCORD_TOKEN',
          credential_status: 'registered',
        }],
      }),
      'codex-cto',
      {},
    )

    expect(result).toBeNull()
  })

  test('legacy agents.provider_token_source_ref remains a DB fallback', async () => {
    const result = await resolveDbDiscordBotToken(
      mockDb({
        credentialRows: [],
        agentRows: [{ provider_token_source_ref: 'local-env:LEGACY_DISCORD_TOKEN' }],
      }),
      'codex-cto',
      { LEGACY_DISCORD_TOKEN: 'legacy-token' },
    )

    expect(result).toMatchObject({
      token: 'legacy-token',
      source: 'agent_provider_token_source_ref',
      credentialId: null,
      credentialStatus: null,
      secretRef: 'local-env:LEGACY_DISCORD_TOKEN',
    })
  })
})
