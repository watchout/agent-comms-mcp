import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDirectoryReport } from '../core/directory'
import { migrateSqlite } from '../db/migrate-sqlite'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('provider identity registry', () => {
  test('SQLite migration creates and backfills provider identities from rollout metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-comms-provider-identity-'))
    const dbPath = join(dir, 'agent-comms.db')
    try {
      migrateSqlite(dbPath)
      const db = new Database(dbPath)
      db.exec(`
        INSERT INTO agents (agent_id, display_name, agent_type, cli_type, status, metadata)
        VALUES
          ('provider-bot', 'Provider Bot', 'dev', 'TUI', 'idle', '{"discord_id":"111111111111111111"}'),
          ('provider-human', 'Provider Human', 'human', 'discord', 'online', '{"discord_id":"222222222222222222"}');
      `)
      db.close()

      migrateSqlite(dbPath)

      const verify = new Database(dbPath)
      const rows = verify
        .query(`
          SELECT agent_id, provider, provider_subject_id, identity_kind, status, trust_status, metadata
            FROM agent_provider_identities
           ORDER BY agent_id
        `)
        .all() as Array<{
          agent_id: string
          provider: string
          provider_subject_id: string
          identity_kind: string
          status: string
          trust_status: string
          metadata: string
        }>
      verify.close()

      expect(rows).toEqual([
        {
          agent_id: 'provider-bot',
          provider: 'discord',
          provider_subject_id: '111111111111111111',
          identity_kind: 'bot_user',
          status: 'active',
          trust_status: 'local',
          metadata: '{"source":"agents.metadata.discord_id_backfill"}',
        },
        {
          agent_id: 'provider-human',
          provider: 'discord',
          provider_subject_id: '222222222222222222',
          identity_kind: 'human_user',
          status: 'active',
          trust_status: 'local',
          metadata: '{"source":"agents.metadata.discord_id_backfill"}',
        },
      ])

      const disable = new Database(dbPath)
      disable.exec(`
        UPDATE agent_provider_identities
           SET status = 'disabled',
               trust_status = 'disabled'
         WHERE agent_id = 'provider-bot';
      `)
      disable.close()

      migrateSqlite(dbPath)

      const disabledCheck = new Database(dbPath)
      const disabled = disabledCheck
        .query("SELECT status, trust_status FROM agent_provider_identities WHERE agent_id = 'provider-bot'")
        .get() as { status: string; trust_status: string }
      disabledCheck.close()

      expect(disabled).toEqual({ status: 'disabled', trust_status: 'disabled' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('directory prefers provider identities over rollout metadata', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM agent_provider_identities')) {
          return {
            rows: [
              { agent_id: 'codex-aun', provider_subject_id: '100', status: 'active', identity_kind: 'bot_user' },
              { agent_id: 'codex-cto', provider_subject_id: '200', status: 'active', identity_kind: 'bot_user' },
            ],
          }
        }
        if (sql.includes('FROM agents')) {
          return {
            rows: [
              { agent_id: 'codex-aun', display_name: 'AUN', agent_type: 'dev', runtime: 'TUI', status: 'idle', metadata: { discord_id: 'legacy-shared' } },
              { agent_id: 'codex-cto', display_name: 'CTO', agent_type: 'dev', runtime: 'TUI', status: 'idle', metadata: { discord_id: 'legacy-shared' } },
            ],
          }
        }
        if (sql.includes('FROM channels')) {
          return {
            rows: [
              { id: 'agent-com', name: 'agent-com', type: 'channel', members: ['codex-aun', 'codex-cto'], discord_external_id: '123', adapter_metadata: {} },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const report = await buildDirectoryReport(db)

    expect(report.agents.find((agent) => agent.agent_id === 'codex-aun')?.warnings).not.toContain('discord_identity_not_unique')
    expect(report.agents.find((agent) => agent.agent_id === 'codex-cto')?.warnings).not.toContain('discord_identity_not_unique')
    expect(report.warnings).not.toContain('some_discord_identities_are_not_unique')
  })

  test('runtime code treats provider identities as the authority', () => {
    const discordAdapter = readFileSync(join(REPO_ROOT, 'adapters', 'discord.ts'), 'utf8')
    const routeDb = readFileSync(join(REPO_ROOT, 'core', 'route-message-db.ts'), 'utf8')
    const outboundProjection = readFileSync(join(REPO_ROOT, 'core', 'outbound-projection.ts'), 'utf8')

    expect(discordAdapter).toContain('INSERT INTO agent_provider_identities')
    expect(discordAdapter).toContain('duplicate provider identity blocked')
    expect(discordAdapter).toContain("agents.metadata.discord_id is")
    expect(routeDb).toContain('FROM agent_provider_identities')
    expect(routeDb).toContain("provider = 'discord'")
    expect(routeDb).toContain("metadata->>'discord_id'")
    expect(outboundProjection).toContain('FROM agent_provider_identities')
    expect(outboundProjection).toContain('discordIdentityState')
  })
})
