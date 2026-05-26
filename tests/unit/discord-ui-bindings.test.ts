import { describe, expect, test } from 'bun:test'
import {
  getAgentDiscordUiId,
  resolveAgentFromDiscordUiId,
  resolveAgentFromDiscordUiIdInMembers,
  type UiBindingDb,
} from '../../core/ui-bindings'

function fakeDb(options: {
  bindings?: Array<{ agent_id: string; ui_id: string; status?: string; surface_role?: string }>
  legacy?: Record<string, string>
}): UiBindingDb {
  return {
    async query(sql: string, params?: any[]) {
      if (sql.includes('FROM agent_ui_bindings')) {
        const bindings = options.bindings ?? []
        if (sql.includes('agent_id = $1')) {
          const agentId = String(params?.[0] ?? '')
          return {
            rows: bindings
              .filter((row) => row.agent_id === agentId)
              .map((row, index) => ({ binding_id: `binding-${index}`, status: 'registered', ...row })),
          }
        }
        if (sql.includes('ui_id = $1')) {
          const uiId = String(params?.[0] ?? '')
          return {
            rows: bindings
              .filter((row) => row.ui_id === uiId)
              .map((row, index) => ({ binding_id: `binding-${index}`, status: 'registered', ...row })),
          }
        }
      }
      if (sql.includes("metadata->>'discord_id'")) {
        if (sql.includes('WHERE agent_id = $1')) {
          const agentId = String(params?.[0] ?? '')
          const discordId = Object.entries(options.legacy ?? {}).find(([, value]) => value === agentId)?.[0] ?? null
          return { rows: discordId ? [{ discord_id: discordId }] : [] }
        }
        const discordId = String(params?.[0] ?? '')
        const agentId = options.legacy?.[discordId]
        return { rows: agentId ? [{ agent_id: agentId }] : [] }
      }
      return { rows: [] }
    },
  }
}

describe('Discord UI bindings', () => {
  test('agent lookup prefers agent_ui_bindings over legacy metadata', async () => {
    const db = fakeDb({
      bindings: [{ agent_id: 'codex-aun', ui_id: 'binding-discord-id' }],
      legacy: { 'legacy-discord-id': 'codex-aun' },
    })
    await expect(getAgentDiscordUiId(db, 'codex-aun')).resolves.toBe('binding-discord-id')
  })

  test('Discord id lookup falls back to legacy metadata when no binding exists', async () => {
    const db = fakeDb({ legacy: { 'legacy-discord-id': 'codex-aun' } })
    await expect(resolveAgentFromDiscordUiId(db, 'legacy-discord-id')).resolves.toBe('codex-aun')
  })

  test('member-scoped lookup deduplicates to the canonical member agent_id', async () => {
    const db = fakeDb({
      bindings: [
        { agent_id: 'outside-channel', ui_id: 'discord-1' },
        { agent_id: 'codex-aun', ui_id: 'discord-1' },
      ],
    })
    await expect(
      resolveAgentFromDiscordUiIdInMembers(db, 'discord-1', ['codex-aun', 'agent-com-dev']),
    ).resolves.toEqual({ agentId: 'codex-aun' })
  })

  test('member-scoped lookup fails closed on duplicate active bindings in members', async () => {
    const db = fakeDb({
      bindings: [
        { agent_id: 'codex-aun', ui_id: 'discord-1' },
        { agent_id: 'agent-com-dev', ui_id: 'discord-1' },
      ],
    })
    await expect(
      resolveAgentFromDiscordUiIdInMembers(db, 'discord-1', ['codex-aun', 'agent-com-dev']),
    ).resolves.toEqual({ error: 'ambiguous', candidates: ['codex-aun', 'agent-com-dev'] })
  })
})
