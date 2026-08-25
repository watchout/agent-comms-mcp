import { describe, expect, test } from 'bun:test'
import {
  ACTIVE_EXECUTION_SEAT_QUERY_VERSION,
  isActiveExecutionSeat,
  listActiveExecutionSeats,
} from '../core/active-execution-seats'
import { measureRuntimeMemoryReadyCoverage } from '../core/runtime-memory-ready-coverage'
import { evaluateRuntimeMemoryReadyGate } from '../core/runtime-memory-ready'
import { parseMemoryReadyCoverageArgs } from '../scripts/operator/memory-ready-coverage'
import { parseRegistryRetirementArgs } from '../scripts/operator/registry-retirement'

const rows = [
  {
    agent_id: 'healthy-idle', agent_type: 'dev', status: 'idle',
    profile_enabled: true, disabled_at: null, metadata: {},
  },
  {
    agent_id: 'healthy-busy', agent_type: 'dev', status: 'busy',
    profile_enabled: 1, disabled_at: null, metadata: '{}',
  },
  {
    agent_id: 'kodama', agent_type: 'dev', status: 'busy',
    profile_enabled: true, disabled_at: null, metadata: { workload: 'shirube-canary' },
  },
  {
    agent_id: 'lead-test-2001c9a4', agent_type: 'org', status: 'retired',
    profile_enabled: false, disabled_at: '2026-08-22T13:00:00.000Z', metadata: { retired: true },
  },
  {
    agent_id: 'retired-metadata', agent_type: 'dev', status: 'idle',
    profile_enabled: true, disabled_at: null, metadata: { retired: true },
  },
  {
    agent_id: 'ceo', agent_type: 'human', status: 'idle',
    profile_enabled: true, disabled_at: null, metadata: {},
  },
  {
    agent_id: 'offline', agent_type: 'dev', status: 'offline',
    profile_enabled: true, disabled_at: null, metadata: {},
  },
]

describe('active execution seat registry definition', () => {
  test('test fixture, retired, human, and offline identities are outside the active set', async () => {
    const db = { query: async () => ({ rows }) }
    const active = await listActiveExecutionSeats(db)

    expect(ACTIVE_EXECUTION_SEAT_QUERY_VERSION).toBe('registry-active-execution-seats/v1')
    expect(active.map(row => row.agent_id)).toEqual(['healthy-idle', 'healthy-busy', 'kodama'])
    expect(rows.map(row => [row.agent_id, isActiveExecutionSeat(row)])).toEqual([
      ['healthy-idle', true],
      ['healthy-busy', true],
      ['kodama', true],
      ['lead-test-2001c9a4', false],
      ['retired-metadata', false],
      ['ceo', false],
      ['offline', false],
    ])
  })

  test('strict coverage uses the same active population without relaxing ready/N', async () => {
    const db = { query: async () => ({ rows }) }
    const report = await measureRuntimeMemoryReadyCoverage(db, {
      now: new Date('2026-08-22T13:10:00.000Z'),
      resolveProject: async (_db, agentId) => ({
        agent_id: agentId,
        project: agentId,
        workspace_path: `/workspace/${agentId}`,
        source: 'canonical_workspace',
      }),
      evaluateGate: async (_db, input) => ({
        ok: input.agent_id === 'healthy-idle',
        gate: 'memory_ready',
        reason: input.agent_id === 'healthy-idle' ? 'ready' : 'missing_evidence',
        agent_id: input.agent_id,
        project: input.project,
        checked_at: input.now.toISOString(),
        runtime_instance_id: null,
        evidence_id: null,
        evidence_path: null,
        evidence_log_id: null,
        source: null,
        valid_until: null,
        current_runtime: null,
        details: {},
      }),
    })

    expect(report).toMatchObject({
      query_version: 'registry-active-execution-seats/v1',
      active: 3,
      ready: 1,
      missing: 2,
      complete: false,
    })
    expect(report.seats.map(seat => [seat.agent_id, seat.ready])).toEqual([
      ['healthy-idle', true],
      ['healthy-busy', false],
      ['kodama', false],
    ])
  })

  test('memory-ready gate fails closed before runtime resolution for a retired row', async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes('FROM agents')) {
          return { rows: [{
            agent_id: 'retired-seat',
            agent_type: 'dev',
            status: 'retired',
            profile_enabled: false,
            disabled_at: '2026-08-22T13:00:00.000Z',
            profile_revision: 1,
            profile_source: 'agent.register',
            channel_port: 8814,
            home_directory: '/workspace/retired-seat',
            metadata: { retired: true },
          }] }
        }
        throw new Error(`unexpected query: ${sql}`)
      },
    }

    const gate = await evaluateRuntimeMemoryReadyGate(db, {
      agent_id: 'retired-seat',
      project: 'retired-seat',
      now: new Date('2026-08-22T13:10:00.000Z'),
    })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('agent_inactive')
  })

  test('operator CLIs require explicit database authority and exact execute confirmations', () => {
    expect(() => parseMemoryReadyCoverageArgs([])).toThrow('explicit PostgreSQL URL')
    expect(parseMemoryReadyCoverageArgs([
      '--database-url',
      'postgresql:///agent_comms_sd_c8_test',
    ])).toEqual({ databaseUrl: 'postgresql:///agent_comms_sd_c8_test' })

    expect(() => parseRegistryRetirementArgs([
      '--action', 'retire',
      '--database-url', 'postgresql:///agent_comms_sd_c8_test',
      '--execute',
    ])).toThrow('exact --confirm-cell')
  })
})
