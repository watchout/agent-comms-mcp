import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  buildChannelRegistrationReconcileReport,
  recordUnregisteredInboundDiagnostic,
} from '../core/channel-registration-reconcile'

async function withReconcileDb<T>(fn: (db: SqliteAdapter, path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-channel-reconcile-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    for (const [agentId, discordId] of [
      ['agent-com-dev', '900000000000000001'],
      ['arc', '900000000000000002'],
      ['codex-cto', '900000000000000003'],
    ] as const) {
      seed.prepare(
        `INSERT INTO agents (
           agent_id, display_name, agent_type, cli_type, runtime, status, metadata,
           provider_token_source_ref
         ) VALUES (?, ?, 'dev', 'TUI', 'codex', 'idle', ?, ?)`,
      ).run(
        agentId,
        agentId,
        JSON.stringify({ discord_id: discordId }),
        agentId === 'agent-com-dev' ? 'local-env:DISCORD_TOKEN_AGENT_COM_DEV' : null,
      )
      seed.prepare(
        `INSERT INTO agent_ui_bindings (agent_id, ui_type, ui_id, ui_handle, ui_token_ref, status)
         VALUES (?, 'discord', ?, ?, ?, 'registered')`,
      ).run(
        agentId,
        discordId,
        agentId,
        agentId === 'agent-com-dev' ? 'local-env:DISCORD_TOKEN_AGENT_COM_DEV' : null,
      )
    }
    seed.prepare(
      `INSERT INTO agent_messages (
         id, channel_id, author_id, content, message_type, metadata, input_mentions,
         source, direction, role, created_at
       ) VALUES (?, ?, ?, ?, 'chat', ?, ?, 'discord', 'inbound', 'user', ?)`,
    ).run(
      'msg-unregistered-1',
      '1509299147109306508',
      'human-discord',
      '<@900000000000000002> and <@900000000000000003> please inspect',
      JSON.stringify({
        discord_channel_id: '1509299147109306508',
        discord_message_id: 'discord-msg-1',
        mentions: [],
      }),
      JSON.stringify([]),
      new Date().toISOString(),
    )
    seed.close()

    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter, dbPath)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('channel registration reconcile', () => {
  test('dry-run plans missing Discord channel registration without mutating', async () => {
    await withReconcileDb(async (db) => {
      const report = await buildChannelRegistrationReconcileReport(db, {
        provider: 'discord',
        adapterOwnerAgentId: 'agent-com-dev',
        sqlDialect: 'sqlite',
      })

      expect(report.ok).toBe(true)
      expect(report.dry_run).toBe(true)
      expect(report.summary).toMatchObject({
        observed_missing_channels: 1,
        planned: 1,
        skipped: 0,
        executed: 0,
      })
      expect(report.planned[0]).toMatchObject({
        external_channel_id: '1509299147109306508',
        proposed_channel_id: '1509299147109306508',
        adapter_owner_agent_id: 'agent-com-dev',
        primary_agent_id: 'agent-com-dev',
      })
      expect(report.planned[0].proposed_members).toEqual([
        'agent-com-dev',
        'arc',
        'codex-cto',
      ])
      expect(report.planned[0].observations.raw_mention_ids).toEqual([
        '900000000000000002',
        '900000000000000003',
      ])
      expect(report.planned[0].actions.map((action) => action.table)).toEqual([
        'channels',
        'channel_adapters',
        'channel_routing_policy',
        'audit_log',
      ])
      expect(report.plan_hash).toMatch(/^[a-f0-9]{64}$/)

      expect(await db.query('SELECT * FROM channels')).toHaveLength(0)
      expect(await db.query('SELECT * FROM channel_adapters')).toHaveLength(0)
      expect(await db.query('SELECT * FROM channel_routing_policy')).toHaveLength(0)
    })
  })

  test('execute requires exact operator approval hash, then writes audited registration rows', async () => {
    await withReconcileDb(async (db) => {
      const dry = await buildChannelRegistrationReconcileReport(db, {
        provider: 'discord',
        adapterOwnerAgentId: 'agent-com-dev',
        sqlDialect: 'sqlite',
      })
      const refused = await buildChannelRegistrationReconcileReport(db, {
        provider: 'discord',
        adapterOwnerAgentId: 'agent-com-dev',
        dryRun: false,
        confirmPlanHash: 'wrong-hash',
        sqlDialect: 'sqlite',
      })
      expect(refused.ok).toBe(false)
      expect(refused.error).toBe('OPERATOR_APPROVAL_REQUIRED')
      expect(await db.query('SELECT * FROM channels')).toHaveLength(0)

      const executed = await buildChannelRegistrationReconcileReport(db, {
        provider: 'discord',
        adapterOwnerAgentId: 'agent-com-dev',
        dryRun: false,
        confirmPlanHash: dry.plan_hash,
        sqlDialect: 'sqlite',
      })
      expect(executed.ok).toBe(true)
      expect(executed.summary.executed).toBe(1)
      expect(executed.mutations).toMatchObject({
        channels_upserted: 1,
        channel_adapters_upserted: 1,
        channel_routing_policies_upserted: 1,
        audit_rows_inserted: 1,
      })

      const channels = await db.query<any>('SELECT id, name, members FROM channels')
      expect(channels).toHaveLength(1)
      expect(channels[0].id).toBe('1509299147109306508')
      expect(JSON.parse(channels[0].members)).toEqual([
        'agent-com-dev',
        'arc',
        'codex-cto',
      ])
      const adapters = await db.query<any>('SELECT channel_id, platform, external_id FROM channel_adapters')
      expect(adapters).toEqual([
        {
          channel_id: '1509299147109306508',
          platform: 'discord',
          external_id: '1509299147109306508',
        },
      ])
      const policies = await db.query<any>('SELECT channel_id, primary_agent_id, adapter_owner_agent_id, policy_source FROM channel_routing_policy')
      expect(policies).toEqual([
        {
          channel_id: '1509299147109306508',
          primary_agent_id: 'agent-com-dev',
          adapter_owner_agent_id: 'agent-com-dev',
          policy_source: 'channel_registration_reconcile',
        },
      ])
      const audits = await db.query<any>("SELECT event_type, target, detail FROM audit_log WHERE event_type = 'channel.registration_reconcile_execute'")
      expect(audits).toHaveLength(1)
      expect(audits[0].target).toBe('1509299147109306508')
      expect(JSON.parse(audits[0].detail).plan_hash).toBe(dry.plan_hash)
    })
  })

  test('registered channels are skipped and unregistered inbound diagnostics are auditable', async () => {
    await withReconcileDb(async (db) => {
      await db.execute(
        `INSERT INTO channels (id, name, members) VALUES ($1, $2, $3)`,
        ['1509299147109306508', 'registered', JSON.stringify(['agent-com-dev'])],
      )
      await db.execute(
        `INSERT INTO channel_adapters (channel_id, platform, external_id, metadata)
         VALUES ($1, 'discord', $2, $3)`,
        ['1509299147109306508', '1509299147109306508', JSON.stringify({})],
      )

      const report = await buildChannelRegistrationReconcileReport(db, {
        provider: 'discord',
        adapterOwnerAgentId: 'agent-com-dev',
        sqlDialect: 'sqlite',
      })
      expect(report.planned).toHaveLength(0)
      expect(report.skipped).toEqual([
        {
          external_channel_id: '1509299147109306508',
          reason: 'already_registered',
          details: { channels_id: '1509299147109306508' },
        },
      ])

      const recorded = await recordUnregisteredInboundDiagnostic(
        {
          query: async (sql: string, params?: any[]) => ({ rows: await db.query(sql, params) }),
        },
        {
          provider: 'discord',
          externalChannelId: 'missing-channel',
          externalMessageId: 'missing-message',
          receiverAgentId: 'agent-com-dev',
          authorExternalId: 'human-discord',
          authorName: 'Human',
          authorIsBot: false,
          content: '<@900000000000000002> hello',
          messageId: 'msg-missing',
          mentions: [],
          timestamp: new Date('2026-05-29T00:00:00.000Z'),
        },
      )
      expect(recorded).toBe(true)
      const audits = await db.query<any>("SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type = 'inbound.channel_unregistered'")
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        agent_id: 'agent-com-dev',
        target: 'missing-channel',
      })
      expect(JSON.parse(audits[0].detail)).toMatchObject({
        reason: 'CHANNEL_UNKNOWN',
        external_channel_id: 'missing-channel',
        external_message_id: 'missing-message',
        queue_rows_created: 0,
        raw_mention_ids: ['900000000000000002'],
      })
    })
  })
})
