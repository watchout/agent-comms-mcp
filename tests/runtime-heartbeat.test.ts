import { describe, expect, test } from 'bun:test'
import {
  deterministicWorkspaceId,
  hasRuntimeConnectorIdentityEvidence,
  heartbeatRuntimeInstance,
  inferRuntimeSessionName,
  inferWorkspaceName,
  normalizeCheckoutPath,
  parseRuntimePort,
} from '../core/runtime-heartbeat'

describe('runtime heartbeat evidence', () => {
  test('upserts runtime instance and connector rows from connector evidence', async () => {
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
        if (sql.includes('SELECT lease_id, fencing_token, expires_at')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('SELECT COALESCE(MAX(fencing_token), 0)')) {
          return { rows: [{ max_token: 0 }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO control_plane_leases')) {
          return {
            rows: [{
              lease_id: 'lease-1',
              heartbeat_at: '2026-05-23T00:00:00.000Z',
              expires_at: '2026-05-23T00:10:00.000Z',
            }],
            rowCount: 1,
          }
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
    expect(result.connector_rows_updated).toBe(0)
    expect(result.endpoint_lease_id).toBe('lease-1')
    expect(calls.join('\n')).toContain('INSERT INTO agent_workspaces')
    expect(calls.join('\n')).toContain('INSERT INTO agent_workspace_bindings')
    expect(calls.join('\n')).toContain('INSERT INTO agent_runtime_instances')
    expect(calls.join('\n')).toContain('INSERT INTO connector_instances')
    expect(calls.join('\n')).not.toContain('UPDATE connector_instances')
    expect(calls.join('\n')).toContain('INSERT INTO control_plane_leases')
  })

  test('does not attach existing connector rows without connector evidence', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = {
      async query(sql: string, params: any[] = []) {
        calls.push({ sql, params })
        if (sql.includes('FROM agents')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: '00000000-0000-4000-8000-000000000004',
              agent_id: 'aun',
              status: 'running',
              last_seen_at: '2026-06-05T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO connector_instances')) {
          throw new Error('connector rows must not be upserted without connector evidence')
        }
        if (sql.includes('UPDATE connector_instances')) {
          throw new Error('connector rows must not be updated without connector evidence')
        }
        if (sql.includes('SELECT lease_id, fencing_token, expires_at')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('SELECT COALESCE(MAX(fencing_token), 0)')) {
          return { rows: [{ max_token: 0 }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO control_plane_leases')) {
          return {
            rows: [{
              lease_id: 'lease-without-connector',
              heartbeat_at: '2026-06-05T00:00:00.000Z',
              expires_at: '2026-06-05T00:10:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(db, {
      runtimeInstanceId: '00000000-0000-4000-8000-000000000004',
      agentId: 'aun',
      runtimeEngine: 'TUI',
      runtimeKind: 'local_process',
      processId: 98282,
      endpointUri: 'http://127.0.0.1:8802',
      metadata: { source: 'test-without-connector' },
    })

    expect(result.connector_rows_upserted).toBe(0)
    expect(result.connector_rows_updated).toBe(0)
    expect(result.endpoint_lease_id).toBe('lease-without-connector')
    const leaseInsert = calls.find((call) => call.sql.includes('INSERT INTO control_plane_leases'))
    expect(leaseInsert?.params[4]).toBeNull()
  })

  test('renews an existing runtime endpoint lease on heartbeat', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = {
      async query(sql: string, params: any[] = []) {
        calls.push({ sql, params })
        if (sql.includes('FROM agents')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: '00000000-0000-4000-8000-000000000003',
              agent_id: 'agent-com-dev',
              status: 'running',
              last_seen_at: '2026-05-23T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO connector_instances')) {
          return { rows: [{ connector_instance_id: 'connector-2' }], rowCount: 1 }
        }
        if (sql.includes('UPDATE connector_instances')) {
          return { rows: [{ connector_instance_id: 'connector-2' }], rowCount: 1 }
        }
        if (sql.includes('SELECT lease_id, fencing_token, expires_at')) {
          return {
            rows: [{
              lease_id: 'lease-2',
              fencing_token: 7,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('UPDATE control_plane_leases')) {
          return {
            rows: [{
              lease_id: 'lease-2',
              heartbeat_at: '2026-05-23T00:00:00.000Z',
              expires_at: '2026-05-23T00:10:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(db, {
      runtimeInstanceId: '00000000-0000-4000-8000-000000000003',
      agentId: 'agent-com-dev',
      runtimeEngine: 'claude-code',
      processId: 456,
      port: 8795,
      endpointUri: 'http://127.0.0.1:8795',
      connectorProvider: 'discord',
      connectorUri: 'discord://agents/agent-com-dev',
    })

    expect(result.endpoint_lease_id).toBe('lease-2')
    const leaseUpdate = calls.find((call) => call.sql.includes('UPDATE control_plane_leases'))
    expect(leaseUpdate?.params.slice(0, 5)).toEqual([
      'lease-2',
      7,
      'agent-com-dev',
      '00000000-0000-4000-8000-000000000003',
      'connector-2',
    ])
    expect(calls.some((call) => call.sql.includes('INSERT INTO control_plane_leases'))).toBe(false)
  })

  test('expires stale runtime endpoint lease before takeover with next fencing token', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const runtimeInstanceId = '00000000-0000-4000-8000-000000000004'
    const db = {
      async query(sql: string, params: any[] = []) {
        calls.push({ sql, params })
        if (sql.includes('FROM agents')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: runtimeInstanceId,
              agent_id: 'agent-com-dev',
              status: 'running',
              last_seen_at: '2026-05-23T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO connector_instances')) {
          return { rows: [{ connector_instance_id: 'connector-3' }], rowCount: 1 }
        }
        if (sql.includes('UPDATE connector_instances')) {
          return { rows: [{ connector_instance_id: 'connector-3' }], rowCount: 1 }
        }
        if (sql.includes('SELECT lease_id, fencing_token, expires_at')) {
          return {
            rows: [{
              lease_id: 'lease-stale',
              fencing_token: 7,
              expires_at: new Date(Date.now() - 60_000).toISOString(),
            }],
            rowCount: 1,
          }
        }
        if (sql.includes("SET status = 'expired'")) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT COALESCE(MAX(fencing_token), 0)')) {
          return { rows: [{ max_token: 7 }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO control_plane_leases')) {
          return {
            rows: [{
              lease_id: 'lease-takeover',
              heartbeat_at: '2026-05-23T00:00:00.000Z',
              expires_at: '2026-05-23T00:10:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(db, {
      runtimeInstanceId,
      agentId: 'agent-com-dev',
      runtimeEngine: 'claude-code',
      processId: 789,
      port: 8795,
      endpointUri: 'http://127.0.0.1:8795',
      connectorProvider: 'discord',
      connectorUri: 'discord://agents/agent-com-dev',
    })

    expect(result.endpoint_lease_id).toBe('lease-takeover')
    const expireIndex = calls.findIndex((call) => call.sql.includes("SET status = 'expired'"))
    const insertIndex = calls.findIndex((call) => call.sql.includes('INSERT INTO control_plane_leases'))
    expect(expireIndex).toBeGreaterThan(-1)
    expect(insertIndex).toBeGreaterThan(expireIndex)
    expect(calls[expireIndex].params.slice(0, 2)).toEqual([runtimeInstanceId, 'worker'])
    expect(calls[insertIndex].params[5]).toBe(8)
  })

  test('uses agent profile home_directory as the canonical workspace when present', async () => {
    const profileHome = '/Users/yuji/Developer/agent-memory'
    const runtimeCheckout = '/Users/yuji/Developer/codex-aun/agent-comms-mcp-main'
    const expectedWorkspaceId = deterministicWorkspaceId('default', profileHome)
    let workspaceInsertParams: any[] | null = null
    let runtimeInsertParams: any[] | null = null
    const db = {
      async query(sql: string, params: any[] = []) {
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              org_id: 'default',
              home_directory: profileHome,
              profile_revision: 7,
              profile_source: 'agent.profile.set',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO agent_workspaces')) {
          workspaceInsertParams = params
          return {
            rows: [{ workspace_id: expectedWorkspaceId }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO agent_workspace_bindings')) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          runtimeInsertParams = params
          return {
            rows: [{
              runtime_instance_id: '00000000-0000-4000-8000-000000000002',
              agent_id: 'agent-mem-dev',
              status: 'running',
              last_seen_at: '2026-05-23T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('UPDATE connector_instances')) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(db, {
      runtimeInstanceId: '00000000-0000-4000-8000-000000000002',
      agentId: 'agent-mem-dev',
      runtimeEngine: 'codex',
      checkoutPath: runtimeCheckout,
      metadata: { source: 'test' },
    })

    expect(result.workspace_id).toBe(expectedWorkspaceId)
    expect(workspaceInsertParams?.[3]).toBe(profileHome)
    expect(JSON.parse(workspaceInsertParams?.[4])).toMatchObject({
      source: 'runtime_heartbeat',
      agent_id: 'agent-mem-dev',
      workspace_path_source: 'agent_profile.home_directory',
      profile_revision: 7,
      profile_source: 'agent.profile.set',
      runtime_checkout_path: runtimeCheckout,
    })
    expect(runtimeInsertParams?.[2]).toBe(expectedWorkspaceId)
    expect(runtimeInsertParams?.[9]).toBe(runtimeCheckout)
  })

  test('infers session name and port from runtime environment', () => {
    expect(inferRuntimeSessionName({ DISCORD_STATE_DIR: '/tmp/channels/discord-hotel' })).toBe('discord-hotel')
    expect(parseRuntimePort({ WEBHOOK_PORT: '8811' })).toBe(8811)
    expect(hasRuntimeConnectorIdentityEvidence({
      DISCORD_STATE_DIR: '/tmp/channels/discord-aun',
      WEBHOOK_PORT: '8811',
    })).toBe(true)
    expect(hasRuntimeConnectorIdentityEvidence({
      AGENT_COM_RUNTIME_SESSION: 'discord-aun',
      AUN_WEBHOOK_PORT: '8811',
    })).toBe(true)
    expect(hasRuntimeConnectorIdentityEvidence({
      TMUX_PANE: '%12',
      WEBHOOK_PORT: '8811',
    })).toBe(false)
    expect(hasRuntimeConnectorIdentityEvidence({
      DISCORD_STATE_DIR: '/tmp/channels/discord-aun',
    })).toBe(false)
  })

  test('derives stable local workspace identity from checkout path', () => {
    const normalized = normalizeCheckoutPath('/tmp/../tmp/hotel')
    expect(normalized).toBe('/tmp/hotel')
    expect(inferWorkspaceName(normalized, 'fallback')).toBe('hotel')
    expect(deterministicWorkspaceId('default', normalized!)).toMatch(/^local:[0-9a-f]{16}$/)
    expect(deterministicWorkspaceId('default', normalized!)).toBe(deterministicWorkspaceId('default', normalized!))
  })
})
