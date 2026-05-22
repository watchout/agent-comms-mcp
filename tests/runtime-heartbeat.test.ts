import { describe, expect, test } from 'bun:test'
import {
  heartbeatRuntimeInstance,
  inferRuntimeSessionName,
  parseRuntimePort,
} from '../core/runtime-heartbeat'

describe('runtime heartbeat evidence', () => {
  test('upserts runtime instance and links active connector rows', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: '00000000-0000-4000-8000-000000000001',
              agent_id: 'agent-com-dev',
              status: 'running',
              last_seen_at: '2026-05-23T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('UPDATE connector_instances')) {
          return { rows: [{ connector_instance_id: 'connector-1' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(db, {
      runtimeInstanceId: '00000000-0000-4000-8000-000000000001',
      agentId: 'agent-com-dev',
      runtimeEngine: 'claude-code',
      sessionName: 'discord-agent-com',
      processId: 123,
      port: 8795,
      checkoutPath: '/repo',
      metadata: { source: 'test' },
    })

    expect(result.ok).toBe(true)
    expect(result.runtime_instance_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(result.connector_rows_updated).toBe(1)
    expect(calls.join('\n')).toContain('INSERT INTO agent_runtime_instances')
    expect(calls.join('\n')).toContain('UPDATE connector_instances')
  })

  test('infers session name and port from runtime environment', () => {
    expect(inferRuntimeSessionName({ DISCORD_STATE_DIR: '/tmp/channels/discord-hotel' })).toBe('discord-hotel')
    expect(parseRuntimePort({ WEBHOOK_PORT: '8811' })).toBe(8811)
  })
})
