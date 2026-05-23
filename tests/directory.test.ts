import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDirectoryReport, formatDirectoryText } from '../core/directory'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { migrateSqlite } from '../db/migrate-sqlite'

describe('bot/channel directory report', () => {
  test('combines agents, channels, role routing, and sendability', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM agents')) {
          return {
            rows: [
              { agent_id: 'codex-aun', display_name: 'AUN', agent_type: 'dev', runtime: 'TUI', status: 'idle', metadata: { discord_id: '1', tmux_session: 'codex-aun' } },
              { agent_id: 'codex-cto', display_name: 'CTO', agent_type: 'dev', runtime: 'TUI', status: 'idle', metadata: { discord_id: '2' } },
              { agent_id: 'cto', display_name: 'CTO', agent_type: 'dev', runtime: 'TUI', status: 'disabled', metadata: { discord_id: '2' } },
              { agent_id: 'ceo', display_name: 'CEO', agent_type: 'human', runtime: 'discord', status: 'online', metadata: { discord_id: '3' } },
            ],
          }
        }
        if (sql.includes('FROM channels')) {
          return {
            rows: [
              { id: '1487368919613444156', name: 'agent-com', type: 'channel', members: ['ceo', 'codex-aun', 'codex-cto'], discord_external_id: '1487368919613444156', adapter_metadata: {} },
              { id: 'internal-ops', name: 'internal ops', type: 'channel', members: ['codex-aun'], discord_external_id: null, adapter_metadata: {} },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const report = await buildDirectoryReport(db)
    const aun = report.agents.find((agent) => agent.agent_id === 'codex-aun')
    const cto = report.agents.find((agent) => agent.agent_id === 'codex-cto')
    const legacy = report.agents.find((agent) => agent.agent_id === 'cto')
    const agentCom = report.channels.find((channel) => channel.name === 'agent-com')
    const mentionAgentCom = report.mention_directory.channels.find((channel) => channel.name === 'agent-com')

    expect(report.summary.agent_count).toBe(4)
    expect(aun?.sendability).toBe('ready')
    expect(aun?.channels).toContain('agent-com')
    expect(legacy?.sendability).toBe('blocked')
    expect(legacy?.warnings).toContain('disabled')
    expect(legacy?.warnings).toContain('display_name_not_unique')
    expect(legacy?.warnings).toContain('discord_identity_not_unique')
    expect(cto?.warnings).toContain('discord_identity_not_unique')
    expect(agentCom?.warnings).toContain('channel_id_looks_like_platform_external_id')
    expect(mentionAgentCom?.recommended.map((candidate) => candidate.agent_id)).toContain('codex-aun')
    expect(mentionAgentCom?.candidates.find((candidate) => candidate.agent_id === 'ceo')?.queue_target).toBe(false)
    expect(report.mention_directory.policy.final_send_must_revalidate_db).toBe(true)
    expect(report.id_policy.db_ssot).toBe(true)
    expect(report.warnings).toContain('some_discord_identities_are_not_unique')
    expect(formatDirectoryText(report)).toContain('Bot / Channel Directory')
  })

  test('falls back to SQLite cli_type when agents.runtime is absent', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM agents') && sql.includes('cli_type AS runtime')) {
          return {
            rows: [
              { agent_id: 'codex-aun', display_name: 'AUN', agent_type: 'dev', runtime: 'TUI', status: 'idle', metadata: {} },
            ],
          }
        }
        if (sql.includes('FROM agents') && sql.includes('runtime')) {
          throw new Error('no such column: runtime')
        }
        if (sql.includes('FROM channels')) {
          return {
            rows: [
              { id: 'agent-com', name: 'agent-com', type: 'channel', members: ['codex-aun'], discord_external_id: null, adapter_metadata: {} },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const report = await buildDirectoryReport(db)
    expect(report.agents[0]?.runtime).toBe('TUI')
    expect(report.agents[0]?.sendability).toBe('ready')
  })

  test('runs against a migrated SQLite directory schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-comms-directory-'))
    const dbPath = join(dir, 'agent-comms.db')
    let adapter: SqliteAdapter | null = null
    try {
      migrateSqlite(dbPath)
      const seed = new Database(dbPath)
      seed.exec(`
        INSERT INTO agents (agent_id, display_name, agent_type, cli_type, status, metadata)
        VALUES ('sqlite-bot', 'SQLite Bot', 'dev', 'TUI', 'idle', '{}');
        INSERT INTO channels (id, name, type, members)
        VALUES ('agent-com', 'agent-com', 'channel', '["sqlite-bot"]');
      `)
      seed.close()

      adapter = new SqliteAdapter(dbPath)
      const report = await buildDirectoryReport({
        query: async (sql: string, params?: unknown[]) => ({ rows: await adapter!.query(sql, params) }),
      })

      expect(report.summary.agent_count).toBe(1)
      expect(report.agents[0]?.agent_id).toBe('sqlite-bot')
      expect(report.agents[0]?.runtime).toBe('TUI')
      expect(report.agents[0]?.sendability).toBe('ready')
    } finally {
      await adapter?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
