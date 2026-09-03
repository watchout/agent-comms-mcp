import { describe, expect, test } from 'bun:test'
import {
  buildRuntimeProviderObservation,
  runtimeProviderObservationDigest,
} from '../core/runtime-heartbeat'
import {
  resolveCurrentProvider,
} from '../core/runtime-current-provider-resolver'

const NOW = new Date('2026-09-03T00:30:00.000Z')
const ARC_WORKSPACE = '/Users/yuji/Developer/iyasaka-arc'

function observation(input: {
  runtimeInstanceId?: string
  image?: string | null
  session?: string | null
  workspace?: string | null
  observedAt?: string
}) {
  return buildRuntimeProviderObservation({
    agentId: 'arc',
    runtimeInstanceId: input.runtimeInstanceId ?? 'runtime-arc-claude',
    hostProcessId: 13_848,
    hostProcessImage: input.image === undefined ? '/usr/local/bin/claude' : input.image,
    observedSession: input.session === undefined ? 'discord-arc' : input.session,
    observedWorkspace: input.workspace === undefined ? ARC_WORKSPACE : input.workspace,
    observedAt: input.observedAt ?? '2026-09-03T00:29:00.000Z',
  })
}

function runtimeRow(overrides: Record<string, unknown> = {}) {
  const runtimeInstanceId = String(overrides.runtime_instance_id ?? 'runtime-arc-claude')
  const providerObservation = overrides.provider_observation ?? observation({ runtimeInstanceId })
  return {
    runtime_instance_id: runtimeInstanceId,
    agent_id: 'arc',
    runtime_engine: 'TUI',
    runtime_kind: 'local_process',
    session_name: 'discord-arc',
    checkout_path: ARC_WORKSPACE,
    status: 'running',
    stopped_at: null,
    last_seen_at: '2026-09-03T00:29:00.000Z',
    metadata: { provider_observation: providerObservation },
    ...overrides,
  }
}

function resolverDb(runtimeRows: any[]) {
  const calls: string[] = []
  return {
    calls,
    db: {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) {
          return {
            rows: [{
              agent_id: 'arc',
              home_directory: ARC_WORKSPACE,
              metadata: { tmux_session: 'discord-arc' },
            }],
          }
        }
        if (sql.includes('FROM agent_runtime_instances')) return { rows: runtimeRows }
        throw new Error(`unexpected query: ${sql}`)
      },
    } as any,
  }
}

describe('task completion current-provider resolver', () => {
  test('resolved-tuple-complete and evidence-digest-recomputes', async () => {
    const providerObservation = observation({})
    const fixture = resolverDb([runtimeRow({ provider_observation: providerObservation })])

    const result = await resolveCurrentProvider(fixture.db, 'arc', NOW)

    expect(result).toMatchObject({
      ok: true,
      agent_id: 'arc',
      runtime_instance_id: 'runtime-arc-claude',
      provider_engine: 'claude-code',
      runtime_surface: 'tui_session',
      session: 'discord-arc',
      workspace: ARC_WORKSPACE,
      observed_at: '2026-09-03T00:29:00.000Z',
      evidence_digest: providerObservation.evidence_digest,
      code: 'RESOLVED',
      candidate_count: 1,
    })
    for (const field of [
      'agent_id',
      'runtime_instance_id',
      'provider_engine',
      'runtime_surface',
      'session',
      'workspace',
      'observed_at',
      'evidence_digest',
      'code',
    ] as const) {
      expect(result[field]).not.toBeNull()
    }
    const { evidence_digest: _digest, ...unsigned } = providerObservation
    expect(result.evidence_digest).toBe(runtimeProviderObservationDigest(unsigned))
    expect(fixture.calls.join('\n')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i)
    expect(fixture.calls.join('\n')).not.toContain('runtime_engine_preference')
  })

  test('deterministic-replay', async () => {
    const rows = [runtimeRow()]
    const first = await resolveCurrentProvider(resolverDb(rows).db, 'arc', NOW)
    const second = await resolveCurrentProvider(resolverDb(rows).db, 'arc', NOW)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.evidence_digest).toBe(second.evidence_digest)
  })

  test('arc-measured-misattributed-instance-excluded', async () => {
    const row = runtimeRow({
      provider_observation: observation({
        image: '/opt/homebrew/bin/codex',
        session: 'discord-dev-001',
        workspace: '/Users/yuji/Developer/agent-comms-mcp',
      }),
    })

    const result = await resolveCurrentProvider(resolverDb([row]).db, 'arc', NOW)

    expect(result).toMatchObject({
      ok: false,
      code: 'HOST_PROCESS_MISMATCH',
      candidate_count: 0,
      runtime_instance_id: null,
      provider_engine: null,
    })
    expect(result.excluded_candidates).toEqual([{
      runtime_instance_id: 'runtime-arc-claude',
      code: 'HOST_PROCESS_MISMATCH',
    }])
  })

  test('workspace-differs-excluded', async () => {
    const row = runtimeRow({
      provider_observation: observation({ workspace: '/Users/yuji/Developer/codex' }),
    })

    const result = await resolveCurrentProvider(resolverDb([row]).db, 'arc', NOW)

    expect(result.code).toBe('WORKSPACE_MISMATCH')
    expect(result.candidate_count).toBe(0)
  })

  test('stale or multiple provider observations fail closed', async () => {
    const stale = runtimeRow({
      last_seen_at: '2026-09-02T23:00:00.000Z',
      provider_observation: observation({ observedAt: '2026-09-02T23:00:00.000Z' }),
    })
    expect((await resolveCurrentProvider(resolverDb([stale]).db, 'arc', NOW)).code).toBe('STALE_HEARTBEAT')

    const secondId = 'runtime-arc-codex'
    const second = runtimeRow({
      runtime_instance_id: secondId,
      provider_observation: observation({ runtimeInstanceId: secondId, image: '/usr/local/bin/codex' }),
    })
    const ambiguous = await resolveCurrentProvider(resolverDb([runtimeRow(), second]).db, 'arc', NOW)
    expect(ambiguous.code).toBe('AMBIGUOUS_PROVIDERS')
    expect(ambiguous.candidate_count).toBe(2)
  })
})
