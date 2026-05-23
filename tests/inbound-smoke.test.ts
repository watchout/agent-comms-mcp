import { describe, expect, test } from 'bun:test'
import { buildInboundSmokeReport, formatInboundSmokeText } from '../core/inbound-smoke'

describe('inbound smoke evidence report', () => {
  test('classifies channel-level Discord inbound evidence without mutating DB', async () => {
    const queries: string[] = []
    const db = {
      async query(sql: string, params?: any[]) {
        queries.push(sql)
        if (sql.includes('FROM channels c')) {
          return [
            {
              channel_id: 'agent-com',
              name: 'agent-com',
              members: ['codex-aun', 'auditor'],
              external_id: '1487368919613444156',
              adapter_owner_agent_id: 'agent-com-dev',
            },
            {
              channel_id: 'hotel-kanri',
              name: 'hotel-kanri',
              members: ['hotel-dev', 'codex-aun'],
              external_id: '1486097810989383773',
              adapter_owner_agent_id: 'hotel-dev',
            },
          ]
        }
        if (sql.includes('FROM message_queue')) {
          return [{ agent_id: 'codex-aun', status: 'pending', count: '1' }]
        }
        return []
      },
      async queryOne(sql: string, params?: any[]) {
        queries.push(sql)
        if (sql.includes('COUNT(DISTINCT am.id)')) {
          return { count: '0' }
        }
        if (sql.includes('FROM agent_messages') && params?.[0] === 'agent-com') {
          return {
            id: '00000000-0000-4000-8000-000000000001',
            channel_id: 'agent-com',
            author_id: 'ceo-discord',
            author_bot: false,
            discord_message_id: '1500000000000000001',
            input_mentions: ['codex-aun'],
            created_at: '2026-05-23T00:00:00.000Z',
          }
        }
        if (sql.includes('FROM agent_messages') && params?.[0] === 'hotel-kanri') {
          return null
        }
        return null
      },
      async execute() {
        throw new Error('not used')
      },
      async transaction() {
        throw new Error('not used')
      },
      async close() {},
    }

    const report = await buildInboundSmokeReport(db, { provider: 'discord', windowHours: 24 })

    expect(report.summary.target_channels).toBe(2)
    expect(report.summary.passed).toBe(1)
    expect(report.summary.incomplete).toBe(1)
    expect(report.channels.find((channel) => channel.name === 'agent-com')?.status).toBe('pass')
    expect(report.channels.find((channel) => channel.name === 'hotel-kanri')?.warnings).toContain('discord_inbound_not_observed_in_window')
    expect(formatInboundSmokeText(report)).toContain('Inbound Smoke Evidence')
    expect(queries.join('\n')).not.toMatch(/INSERT INTO|UPDATE .*SET|DELETE FROM/)
  })

  test('blocks invalid mention evidence instead of treating it as a pass', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM channels c')) {
          return [{
            channel_id: 'agent-com',
            name: 'agent-com',
            members: ['codex-aun'],
            external_id: '1487368919613444156',
            adapter_owner_agent_id: 'agent-com-dev',
          }]
        }
        if (sql.includes('FROM message_queue')) return [{ agent_id: 'unknown-bot', status: 'pending', count: '1' }]
        return []
      },
      async queryOne(sql: string) {
        if (sql.includes('COUNT(DISTINCT am.id)')) return { count: '0' }
        if (sql.includes('FROM agent_messages')) {
          return {
            id: '00000000-0000-4000-8000-000000000002',
            channel_id: 'agent-com',
            author_id: 'ceo-discord',
            input_mentions: ['unknown-bot'],
            created_at: '2026-05-23T00:00:00.000Z',
          }
        }
        return null
      },
      async execute() {
        throw new Error('not used')
      },
      async transaction() {
        throw new Error('not used')
      },
      async close() {},
    }

    const report = await buildInboundSmokeReport(db as any, { provider: 'discord' })

    expect(report.summary.blocked).toBe(1)
    expect(report.blockers[0]).toContain('input_mentions_not_channel_members:unknown-bot')
  })

  test('blocks when a mentioned recipient is not enqueued', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM channels c')) {
          return [{
            channel_id: 'agent-com',
            name: 'agent-com',
            members: ['codex-aun', 'auditor'],
            external_id: '1487368919613444156',
            adapter_owner_agent_id: 'agent-com-dev',
          }]
        }
        if (sql.includes('FROM message_queue')) return [{ agent_id: 'auditor', status: 'pending', count: '1' }]
        return []
      },
      async queryOne(sql: string) {
        if (sql.includes('COUNT(DISTINCT am.id)')) return { count: '0' }
        if (sql.includes('FROM agent_messages')) {
          return {
            id: '00000000-0000-4000-8000-000000000004',
            channel_id: 'agent-com',
            author_id: 'ceo-discord',
            input_mentions: ['codex-aun'],
            created_at: '2026-05-23T00:00:00.000Z',
          }
        }
        return null
      },
      async execute() {
        throw new Error('not used')
      },
      async transaction() {
        throw new Error('not used')
      },
      async close() {},
    }

    const report = await buildInboundSmokeReport(db as any, { provider: 'discord' })

    expect(report.summary.blocked).toBe(1)
    expect(report.blockers).toContain('agent-com:mentioned_recipient_not_enqueued:codex-aun')
    expect(report.blockers).toContain('agent-com:unexpected_enqueued_recipient:auditor')
  })

  test('blocks when any mentioned recipient is missing from queue rows', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM channels c')) {
          return [{
            channel_id: 'agent-com',
            name: 'agent-com',
            members: ['codex-aun', 'auditor'],
            external_id: '1487368919613444156',
            adapter_owner_agent_id: 'agent-com-dev',
          }]
        }
        if (sql.includes('FROM message_queue')) return [{ agent_id: 'codex-aun', status: 'pending', count: '1' }]
        return []
      },
      async queryOne(sql: string) {
        if (sql.includes('COUNT(DISTINCT am.id)')) return { count: '0' }
        if (sql.includes('FROM agent_messages')) {
          return {
            id: '00000000-0000-4000-8000-000000000005',
            channel_id: 'agent-com',
            author_id: 'ceo-discord',
            input_mentions: ['codex-aun', 'auditor'],
            created_at: '2026-05-23T00:00:00.000Z',
          }
        }
        return null
      },
      async execute() {
        throw new Error('not used')
      },
      async transaction() {
        throw new Error('not used')
      },
      async close() {},
    }

    const report = await buildInboundSmokeReport(db as any, { provider: 'discord' })

    expect(report.summary.blocked).toBe(1)
    expect(report.blockers[0]).toContain('mentioned_recipient_not_enqueued:auditor')
  })

  test('blocks bot-authored duplicate evidence', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM channels c')) {
          return [{
            channel_id: 'approvals',
            name: 'approvals',
            members: ['auditor'],
            external_id: '1486096778485825717',
            adapter_owner_agent_id: 'auditor',
          }]
        }
        if (sql.includes('FROM message_queue')) return [{ agent_id: 'auditor', status: 'done', count: '1' }]
        return []
      },
      async queryOne(sql: string) {
        if (sql.includes('COUNT(DISTINCT am.id)')) return { count: '2' }
        if (sql.includes('FROM agent_messages')) {
          return {
            id: '00000000-0000-4000-8000-000000000003',
            channel_id: 'approvals',
            author_id: 'auditor-discord',
            input_mentions: ['auditor'],
            created_at: '2026-05-23T00:00:00.000Z',
          }
        }
        return null
      },
      async execute() {
        throw new Error('not used')
      },
      async transaction() {
        throw new Error('not used')
      },
      async close() {},
    }

    const report = await buildInboundSmokeReport(db as any, { provider: 'discord' })

    expect(report.summary.blocked).toBe(1)
    expect(report.blockers[0]).toContain('bot_authored_duplicate_rows:2')
  })
})
