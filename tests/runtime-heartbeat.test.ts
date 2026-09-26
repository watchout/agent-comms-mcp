import { describe, expect, test } from 'bun:test'
import {
  deterministicWorkspaceId,
  hasRuntimeConnectorIdentityEvidence,
  heartbeatRuntimeInstance,
  inferRuntimeSessionName,
  resolveRuntimeSessionName,
  inferWorkspaceName,
  normalizeCheckoutPath,
  parseRuntimePort,
  RuntimeRegistrationProfileError,
} from '../core/runtime-heartbeat'

describe('runtime heartbeat evidence', () => {
  test('upserts runtime instance and connector rows from connector evidence', async () => {
    const calls: string[] = []
    let reconcileInput: { agentId: string; observedRuntimeInstanceId?: string | null } | null = null
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              org_id: 'default',
              home_directory: '/repo',
              profile_revision: 1,
              profile_source: 'test',
              metadata: { tmux_session: 'discord-agent-com' },
            }],
            rowCount: 1,
          }
        }
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

    const result = await heartbeatRuntimeInstance(
      db,
      {
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
      },
      {
        reconcileMemoryReadyIdentity: async (_db, input) => {
          reconcileInput = input
          return {
            agent_id: input.agentId,
            observed_runtime_instance_id: input.observedRuntimeInstanceId ?? null,
            current_runtime_instance_id: input.observedRuntimeInstanceId ?? null,
            previous_evidence_runtime_instance_id: 'previous-runtime',
            status: 'REFRESHED',
            code: 'EVIDENCE_BINDING_REFRESHED',
            evidence_id: 42,
            evidence_log_id: 'audit-42',
            details: {},
          }
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(result.runtime_instance_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(result.workspace_id).toBe('local:workspace-1')
    expect(result.connector_rows_upserted).toBe(1)
    expect(result.connector_rows_updated).toBe(0)
    expect(result.endpoint_lease_id).toBe('lease-1')
    expect(result.memory_ready_identity?.status).toBe('REFRESHED')
    expect(reconcileInput).toEqual({
      agentId: 'agent-com-dev',
      observedRuntimeInstanceId: '00000000-0000-4000-8000-000000000001',
      requestedRuntimeKind: 'local_process',
    })
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
          return {
            rows: [{
              org_id: 'default',
              home_directory: '/work/aun',
              profile_revision: 1,
              profile_source: 'test',
              metadata: { tmux_session: 'discord-aun' },
            }],
            rowCount: 1,
          }
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
          return {
            rows: [{
              org_id: 'default',
              home_directory: '/work/agent-com-dev',
              profile_revision: 1,
              profile_source: 'test',
              metadata: { tmux_session: 'discord-agent-com' },
            }],
            rowCount: 1,
          }
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
          return {
            rows: [{
              org_id: 'default',
              home_directory: '/work/agent-com-dev',
              profile_revision: 1,
              profile_source: 'test',
              metadata: { tmux_session: 'discord-agent-com' },
            }],
            rowCount: 1,
          }
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
              metadata: { tmux_session: 'discord-agent-memory' },
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
      ambientSessionName: 'ambient-server-session',
      ambientCheckoutPath: runtimeCheckout,
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
    expect(runtimeInsertParams?.[6]).toBe('discord-agent-memory')
    expect(runtimeInsertParams?.[9]).toBe(profileHome)
    expect(JSON.parse(runtimeInsertParams?.[12])).toMatchObject({
      source: 'test',
      registration_metadata_provenance: {
        schema_version: 'runtime-registration-metadata-provenance/v2',
        agent_id: 'agent-mem-dev',
        profile_found: true,
        resolution_status: 'resolved',
        missing_fields: [],
        session_name: {
          source: 'registered',
          effective_value: 'discord-agent-memory',
          registered_value: 'discord-agent-memory',
          ambient_value: 'ambient-server-session',
          mismatch: true,
        },
        checkout_path: {
          source: 'registered',
          effective_value: profileHome,
          registered_value: profileHome,
          ambient_value: runtimeCheckout,
          mismatch: true,
        },
      },
    })
    expect(result.registration_metadata_provenance).toEqual(
      JSON.parse(runtimeInsertParams?.[12]).registration_metadata_provenance,
    )
  })

  test('registers the codex-cto MCP runtime from its seat profile without PWD or TMUX metadata', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = {
      async query(sql: string, params: any[] = []) {
        calls.push({ sql, params })
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              org_id: 'default',
              home_directory: '/Users/yuji/Developer/codex',
              profile_revision: 12,
              profile_source: 'registered-seat',
              metadata: JSON.stringify({ tmux_session: 'discord-cto' }),
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO agent_workspaces')) {
          return { rows: [{ workspace_id: 'local:codex-cto' }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO agent_workspace_bindings')) return { rows: [], rowCount: 1 }
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: 'eb785a47-81fb-4907-83a4-0cac5b62fce6',
              agent_id: 'codex-cto',
              status: 'running',
              last_seen_at: '2026-08-23T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('SELECT lease_id, fencing_token, expires_at')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT COALESCE(MAX(fencing_token), 0)')) {
          return { rows: [{ max_token: 0 }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO control_plane_leases')) {
          return {
            rows: [{
              lease_id: 'lease-codex-cto',
              heartbeat_at: '2026-08-23T00:00:00.000Z',
              expires_at: '2026-08-23T00:10:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(
      db,
      {
        runtimeInstanceId: 'eb785a47-81fb-4907-83a4-0cac5b62fce6',
        agentId: 'codex-cto',
        runtimeEngine: 'TUI',
        runtimeKind: 'local_process',
        ambientSessionName: null,
        ambientCheckoutPath: null,
        processId: 35296,
        port: 8808,
        metadata: { source: 'server.ts' },
      },
      {
        reconcileMemoryReadyIdentity: async (_db, input) => ({
          agent_id: input.agentId,
          observed_runtime_instance_id: input.observedRuntimeInstanceId ?? null,
          current_runtime_instance_id: input.observedRuntimeInstanceId ?? null,
          previous_evidence_runtime_instance_id: null,
          status: 'UNCHANGED',
          code: 'EVIDENCE_ALREADY_CURRENT',
          evidence_id: 1,
          evidence_log_id: null,
          details: {},
        }),
      },
    )

    const runtimeInsert = calls.find(call => call.sql.includes('INSERT INTO agent_runtime_instances'))
    expect(runtimeInsert?.params[6]).toBe('discord-cto')
    expect(runtimeInsert?.params[9]).toBe('/Users/yuji/Developer/codex')
    expect(JSON.parse(runtimeInsert?.params[12]).registration_metadata_provenance).toEqual({
      schema_version: 'runtime-registration-metadata-provenance/v2',
      agent_id: 'codex-cto',
      profile_found: true,
      resolution_status: 'resolved',
      missing_fields: [],
      session_name: {
        source: 'registered',
        effective_value: 'discord-cto',
        registered_value: 'discord-cto',
        ambient_value: null,
        mismatch: false,
      },
      checkout_path: {
        source: 'registered',
        effective_value: '/Users/yuji/Developer/codex',
        registered_value: '/Users/yuji/Developer/codex',
        ambient_value: null,
        mismatch: false,
      },
    })
    expect(result.registration_metadata_provenance.session_name.source).toBe('registered')
    expect(result.registration_metadata_provenance.checkout_path.source).toBe('registered')

    await heartbeatRuntimeInstance(db, {
      runtimeInstanceId: '00000000-0000-4000-8000-000000000099',
      agentId: 'codex-cto',
      runtimeEngine: 'codex',
      runtimeKind: 'bootstrap_bound_provider',
      sessionName: 'sealed-bootstrap-session',
      checkoutPath: '/tmp/sealed-bootstrap-checkout',
      processId: 40000,
      port: 9808,
      metadata: { source: 'provider' },
    })
    const bootstrapInsert = calls.filter(call => call.sql.includes('INSERT INTO agent_runtime_instances')).at(-1)
    expect(bootstrapInsert?.params[6]).toBe('sealed-bootstrap-session')
    expect(bootstrapInsert?.params[9]).toBe('/tmp/sealed-bootstrap-checkout')
    expect(JSON.parse(bootstrapInsert?.params[12]).registration_metadata_provenance).toMatchObject({
      session_name: {
        source: 'ambient',
        effective_value: 'sealed-bootstrap-session',
        registered_value: 'discord-cto',
      },
      checkout_path: {
        source: 'ambient',
        effective_value: '/tmp/sealed-bootstrap-checkout',
        registered_value: '/Users/yuji/Developer/codex',
      },
    })
  })

  test('fails closed before runtime writes when the registered profile cannot be found', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) return { rows: [], rowCount: 0 }
        throw new Error(`unexpected write after missing profile: ${sql}`)
      },
    }

    let failure: unknown
    try {
      await heartbeatRuntimeInstance(db, {
        runtimeInstanceId: '00000000-0000-4000-8000-000000000090',
        agentId: 'missing-profile',
        runtimeEngine: 'TUI',
        runtimeKind: 'local_process',
        ambientSessionName: 'ambient-session',
        ambientCheckoutPath: '/ambient/checkout',
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(RuntimeRegistrationProfileError)
    expect((failure as RuntimeRegistrationProfileError).toJSON()).toMatchObject({
      schema_version: 'runtime-registration-profile-error/v1',
      code: 'RUNTIME_REGISTRATION_PROFILE_INCOMPLETE',
      agent_id: 'missing-profile',
      runtime_kind: 'local_process',
      reason: 'PROFILE_NOT_FOUND',
      missing_fields: ['agent_profile'],
      registration_metadata_provenance: {
        profile_found: false,
        resolution_status: 'incomplete',
        missing_fields: ['agent_profile'],
        session_name: {
          source: 'missing',
          effective_value: null,
          registered_value: null,
          ambient_value: 'ambient-session',
        },
        checkout_path: {
          source: 'missing',
          effective_value: null,
          registered_value: null,
          ambient_value: '/ambient/checkout',
        },
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('disabled_at IS NULL')
  })

  test('fails closed with exact missing registered fields instead of ambient fallback', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              org_id: 'default',
              home_directory: null,
              profile_revision: 1,
              profile_source: 'test',
              metadata: {},
            }],
            rowCount: 1,
          }
        }
        throw new Error(`unexpected write after incomplete profile: ${sql}`)
      },
    }

    let failure: unknown
    try {
      await heartbeatRuntimeInstance(db, {
        runtimeInstanceId: '00000000-0000-4000-8000-000000000091',
        agentId: 'incomplete-profile',
        runtimeEngine: 'TUI',
        runtimeKind: 'local_process',
        ambientSessionName: 'ambient-session',
        ambientCheckoutPath: '/ambient/checkout',
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(RuntimeRegistrationProfileError)
    expect((failure as RuntimeRegistrationProfileError).toJSON()).toMatchObject({
      reason: 'PROFILE_FIELDS_MISSING',
      missing_fields: ['home_directory', 'metadata.tmux_session'],
      registration_metadata_provenance: {
        profile_found: true,
        resolution_status: 'incomplete',
        missing_fields: ['home_directory', 'metadata.tmux_session'],
        session_name: { source: 'missing', effective_value: null, ambient_value: 'ambient-session' },
        checkout_path: { source: 'missing', effective_value: null, ambient_value: '/ambient/checkout' },
      },
    })
    expect(calls).toHaveLength(1)
  })

  test('keeps a configured normal seat on registered authority without mismatch', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const db = {
      async query(sql: string, params: any[] = []) {
        calls.push({ sql, params })
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              org_id: 'default',
              home_directory: '/Users/yuji/Developer/hotel',
              profile_revision: 3,
              profile_source: 'agent.profile.set',
              metadata: { tmux_session: 'discord-hotel' },
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO agent_workspaces')) return { rows: [{ workspace_id: 'local:hotel' }], rowCount: 1 }
        if (sql.includes('INSERT INTO agent_workspace_bindings')) return { rows: [], rowCount: 1 }
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: '00000000-0000-4000-8000-000000000092',
              agent_id: 'hotel-dev',
              status: 'running',
              last_seen_at: '2026-08-23T00:00:00.000Z',
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('SELECT lease_id, fencing_token, expires_at')) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT COALESCE(MAX(fencing_token), 0)')) return { rows: [{ max_token: 0 }], rowCount: 1 }
        if (sql.includes('INSERT INTO control_plane_leases')) {
          return {
            rows: [{
              lease_id: 'lease-hotel',
              heartbeat_at: '2026-08-23T00:00:00.000Z',
              expires_at: '2026-08-23T00:10:00.000Z',
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(
      db,
      {
        runtimeInstanceId: '00000000-0000-4000-8000-000000000092',
        agentId: 'hotel-dev',
        runtimeEngine: 'TUI',
        runtimeKind: 'local_process',
        ambientSessionName: 'discord-hotel',
        ambientCheckoutPath: '/Users/yuji/Developer/hotel',
      },
      {
        reconcileMemoryReadyIdentity: async (_db, input) => ({
          agent_id: input.agentId,
          observed_runtime_instance_id: input.observedRuntimeInstanceId ?? null,
          current_runtime_instance_id: input.observedRuntimeInstanceId ?? null,
          previous_evidence_runtime_instance_id: input.observedRuntimeInstanceId ?? null,
          status: 'UNCHANGED',
          code: 'EVIDENCE_ALREADY_CURRENT',
          evidence_id: 1,
          evidence_log_id: null,
          details: {},
        }),
      },
    )

    expect(result.registration_metadata_provenance).toMatchObject({
      schema_version: 'runtime-registration-metadata-provenance/v2',
      profile_found: true,
      resolution_status: 'resolved',
      missing_fields: [],
      session_name: { source: 'registered', effective_value: 'discord-hotel', mismatch: false },
      checkout_path: { source: 'registered', effective_value: '/Users/yuji/Developer/hotel', mismatch: false },
    })
  })

  test('infers session name and port from runtime environment', () => {
    expect(inferRuntimeSessionName({ DISCORD_STATE_DIR: '/tmp/channels/discord-hotel' })).toBe('discord-hotel')

    // TMUX_PANE is a pane identifier, not a session name. Recording it verbatim made
    // agent_runtime_instances.session_name disagree with the seat's registered
    // metadata.tmux_session, and the memory_ready gate compares exactly those two, so
    // affected seats failed with session_mismatch and never received their queue rows.
    expect(resolveRuntimeSessionName({ TMUX_PANE: '%1008' }, () => 'discord-auditor')).toBe('discord-auditor')

    // An explicit override still wins over the pane lookup.
    expect(
      resolveRuntimeSessionName({ AGENT_COM_RUNTIME_SESSION: 'discord-arc', TMUX_PANE: '%1008' }, () => 'other'),
    ).toBe('discord-arc')

    // Without tmux the pane id is still returned, which is no worse than before and
    // keeps a machine with no tmux working.
    expect(resolveRuntimeSessionName({ TMUX_PANE: '%1008' }, () => null)).toBe('%1008')

    // A pane takes precedence over the state directory fallback.
    expect(
      resolveRuntimeSessionName({ TMUX_PANE: '%42', DISCORD_STATE_DIR: '/tmp/channels/discord-hotel' }, () => 'discord-auditor'),
    ).toBe('discord-auditor')
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
