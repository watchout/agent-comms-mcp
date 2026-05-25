import { describe, expect, test } from 'bun:test'
import { buildDirectoryReport } from '../core/directory'
import {
  getAgentDiscordId,
  isHumanAgent,
  loadAgentInfo,
  resolveAgentFromDiscordId,
  resolveAgentFromDiscordIdInMembers,
  type DbAdapter,
} from '../core/route-message-db'

const USABLE_PROVIDER_IDENTITY_PREDICATE =
  "api.status = 'active' AND api.trust_status NOT IN ('disabled', 'revoked')"

function trustFilteredDb<T extends Record<string, unknown>>(
  rowsWithoutTrustFilter: T[],
  rowsWithTrustFilter: T[],
): DbAdapter {
  return {
    async query(sql: string, _params?: unknown[]) {
      expect(sql).toContain('agent_provider_identities')
      return {
        rows: sql.includes(USABLE_PROVIDER_IDENTITY_PREDICATE)
          ? rowsWithTrustFilter
          : rowsWithoutTrustFilter,
      }
    },
  }
}

describe('provider identity trust status enforcement', () => {
  test('isHumanAgent ignores active provider identity rows whose trust is revoked', async () => {
    const db = trustFilteredDb(
      [{ agent_type: 'human' }],
      [],
    )

    await expect(isHumanAgent(db, '123456789012345678')).resolves.toBe(false)
  })

  test('resolveAgentFromDiscordId ignores active provider identity rows whose trust is disabled', async () => {
    const db = trustFilteredDb(
      [{ agent_id: 'provider-disabled-agent' }],
      [],
    )

    await expect(resolveAgentFromDiscordId(db, '123456789012345678')).resolves.toBeNull()
  })

  test('resolveAgentFromDiscordIdInMembers ignores active provider identity rows whose trust is revoked', async () => {
    const db = trustFilteredDb(
      [{ agent_id: 'provider-revoked-agent' }],
      [],
    )

    await expect(
      resolveAgentFromDiscordIdInMembers(db, '123456789012345678', ['provider-revoked-agent']),
    ).resolves.toEqual({ error: 'not_found', candidates: [] })
  })

  test('getAgentDiscordId ignores disabled-trust provider identities and does not use metadata fallback', async () => {
    const db = trustFilteredDb(
      [{ discord_id: '123456789012345678' }],
      [{ discord_id: null }],
    )

    await expect(getAgentDiscordId(db, 'provider-disabled-agent')).resolves.toBeNull()
  })

  test('loadAgentInfo ignores revoked-trust provider identities and does not use metadata fallback', async () => {
    const db = trustFilteredDb(
      [{
        agent_id: 'provider-revoked-agent',
        agent_type: 'dev',
        observer_mode: false,
        discord_id: '123456789012345678',
      }],
      [{
        agent_id: 'provider-revoked-agent',
        agent_type: 'dev',
        observer_mode: false,
        discord_id: null,
      }],
    )

    await expect(loadAgentInfo(db, 'provider-revoked-agent')).resolves.toEqual({
      agentId: 'provider-revoked-agent',
      agentType: 'dev',
      observerMode: false,
      discordId: null,
    })
  })

  test('directory treats disabled-trust provider identities as known but unusable', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM agent_provider_identities')) {
          return {
            rows: [{
              agent_id: 'provider-disabled-agent',
              provider_subject_id: '123456789012345678',
              status: 'active',
              trust_status: 'disabled',
              identity_kind: 'bot_user',
            }],
          }
        }
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              agent_id: 'provider-disabled-agent',
              display_name: 'Provider Disabled Agent',
              agent_type: 'dev',
              runtime: 'TUI',
              status: 'idle',
              metadata: { discord_id: 'legacy-metadata-id' },
            }],
          }
        }
        if (sql.includes('FROM channels')) {
          return {
            rows: [{
              id: 'agent-com',
              name: 'agent-com',
              type: 'channel',
              members: ['provider-disabled-agent'],
              discord_external_id: '987654321098765432',
              adapter_metadata: {},
            }],
          }
        }
        return { rows: [] }
      },
    }

    const report = await buildDirectoryReport(db)
    const agent = report.agents.find((item) => item.agent_id === 'provider-disabled-agent')
    const candidate = report.mention_directory.channels[0]?.candidates[0]

    expect(agent?.has_discord_identity).toBe(false)
    expect(candidate?.warnings).toContain('missing_discord_identity_for_native_mention')
  })
})
