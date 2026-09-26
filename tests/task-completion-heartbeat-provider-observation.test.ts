import { describe, expect, test } from 'bun:test'
import {
  buildRuntimeProviderObservation,
  heartbeatRuntimeInstance,
  observeRuntimeProvider,
} from '../core/runtime-heartbeat'

const OBSERVED_AT = new Date('2026-09-03T00:29:00.000Z')

function build(image: string | null) {
  return buildRuntimeProviderObservation({
    agentId: 'arc',
    runtimeInstanceId: 'runtime-arc',
    hostProcessId: 13_848,
    hostProcessImage: image,
    observedSession: image?.includes('launchd') ? null : 'discord-arc',
    observedWorkspace: image?.includes('launchd') ? null : '/Users/yuji/Developer/iyasaka-arc',
    observedAt: OBSERVED_AT,
  })
}

describe('task completion heartbeat provider observation', () => {
  test('parent-claude-observed', () => {
    expect(build('/usr/local/bin/claude')).toMatchObject({
      provider_engine: 'claude-code',
      provenance: 'observed',
      host_process_id: 13_848,
      host_process_image: '/usr/local/bin/claude',
      runtime_surface: 'tui_session',
    })
  })

  test('parent-codex-observed', () => {
    expect(build('/opt/homebrew/bin/codex')).toMatchObject({
      provider_engine: 'codex',
      provenance: 'observed',
      host_process_id: 13_848,
      runtime_surface: 'tui_session',
    })
  })

  test('parent-launchd-missing', () => {
    expect(build('/sbin/launchd')).toMatchObject({
      provider_engine: null,
      provenance: 'missing',
      host_process_id: 13_848,
      host_process_image: '/sbin/launchd',
      observed_session: null,
      observed_workspace: null,
      runtime_surface: 'service_daemon',
    })
  })

  test('session-and-workspace-from-host-pid', () => {
    const inspected: Array<[string, number]> = []
    const result = observeRuntimeProvider(
      { agentId: 'arc', runtimeInstanceId: 'runtime-arc' },
      {
        parentProcessId: 13_848,
        readProcessImage(pid) {
          inspected.push(['image', pid])
          return '/usr/local/bin/claude'
        },
        resolveProcessSession(pid) {
          inspected.push(['session', pid])
          return 'discord-arc'
        },
        readProcessWorkspace(pid) {
          inspected.push(['workspace', pid])
          return '/Users/yuji/Developer/iyasaka-arc'
        },
        now: OBSERVED_AT,
      },
    )

    expect(inspected).toEqual([
      ['image', 13_848],
      ['session', 13_848],
      ['workspace', 13_848],
    ])
    expect(result).toMatchObject({
      provider_engine: 'claude-code',
      host_process_id: 13_848,
      observed_session: 'discord-arc',
      observed_workspace: '/Users/yuji/Developer/iyasaka-arc',
    })
  })

  test('heartbeat stores the observation in existing metadata without changing runtime_engine', async () => {
    const calls: Array<{ sql: string; params: any[] }> = []
    const providerObservation = build('/usr/local/bin/claude')
    const db = {
      async query(sql: string, params: any[] = []) {
        calls.push({ sql, params })
        if (sql.includes('FROM agents')) return { rows: [], rowCount: 0 }
        if (sql.includes('INSERT INTO agent_runtime_instances')) {
          return {
            rows: [{
              runtime_instance_id: 'runtime-arc',
              agent_id: 'arc',
              status: 'running',
              last_seen_at: OBSERVED_AT.toISOString(),
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('SELECT COALESCE(MAX(fencing_token), 0)')) {
          return { rows: [{ max_token: 0 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const result = await heartbeatRuntimeInstance(
      db,
      {
        runtimeInstanceId: 'runtime-arc',
        agentId: 'arc',
        runtimeEngine: 'TUI',
        runtimeKind: 'local_process',
        sessionName: 'discord-arc',
        processId: 99_001,
        checkoutPath: '/Users/yuji/Developer/iyasaka-arc',
        metadata: { source: 'server.ts' },
      },
      {
        observeProvider: () => providerObservation,
        reconcileMemoryReadyIdentity: async () => ({
          agent_id: 'arc',
          observed_runtime_instance_id: 'runtime-arc',
          current_runtime_instance_id: 'runtime-arc',
          previous_evidence_runtime_instance_id: null,
          status: 'UNCHANGED',
          code: 'EVIDENCE_ALREADY_CURRENT',
          evidence_id: 1,
          evidence_log_id: null,
          details: {},
        }),
      },
    )

    const upsert = calls.find(call => call.sql.includes('INSERT INTO agent_runtime_instances'))
    expect(upsert?.params[3]).toBe('TUI')
    expect(JSON.parse(upsert?.params[12]).provider_observation).toEqual(providerObservation)
    expect(result.provider_observation).toEqual(providerObservation)
    expect(calls.map(call => call.sql).join('\n')).not.toMatch(/ALTER\s+TABLE/i)
  })
})
