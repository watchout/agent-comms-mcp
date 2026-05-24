import { describe, expect, test } from 'bun:test'
import {
  deterministicWorkspaceId,
  heartbeatRuntimeInstance,
  inferRuntimeSessionName,
  inferWorkspaceName,
  normalizeCheckoutPath,
  parseRuntimePort,
} from '../core/runtime-heartbeat'

describe('runtime heartbeat evidence', () => {
  test('upserts runtime instance and links active connector rows', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('INSERT INTO agent_workspaces')) {
          return {
            rows: [{ workspace_id: 'local:workspace-1' }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO agent_workspace_bindings')) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO connector_instances')) {
          return { rows: [{ connector_instance_id: 'connector-1' }], rowCount: 1 }
        }
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
      connectorProvider: 'discord',
      connectorUri: 'discord://agents/agent-com-dev',
      connectorMetadata: { token_fingerprint: 'fingerprint' },
      metadata: { source: 'test' },
    })

    expect(result.ok).toBe(true)
    expect(result.runtime_instance_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(result.workspace_id).toBe('local:workspace-1')
    expect(result.connector_rows_upserted).toBe(1)
    expect(result.connector_rows_updated).toBe(1)
    expect(calls.join('\n')).toContain('INSERT INTO agent_workspaces')
    expect(calls.join('\n')).toContain('INSERT INTO agent_workspace_bindings')
    expect(calls.join('\n')).toContain('INSERT INTO agent_runtime_instances')
    expect(calls.join('\n')).toContain('INSERT INTO connector_instances')
    expect(calls.join('\n')).toContain('UPDATE connector_instances')
  })

  test('infers session name and port from runtime environment', () => {
    expect(inferRuntimeSessionName({ DISCORD_STATE_DIR: '/tmp/channels/discord-hotel' })).toBe('discord-hotel')
    expect(parseRuntimePort({ WEBHOOK_PORT: '8811' })).toBe(8811)
  })

  test('derives stable local workspace identity from checkout path', () => {
    const normalized = normalizeCheckoutPath('/tmp/../tmp/hotel')
    expect(normalized).toBe('/tmp/hotel')
    expect(inferWorkspaceName(normalized, 'fallback')).toBe('hotel')
    expect(deterministicWorkspaceId('default', normalized!)).toMatch(/^local:[0-9a-f]{16}$/)
    expect(deterministicWorkspaceId('default', normalized!)).toBe(deterministicWorkspaceId('default', normalized!))
  })
})
