import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import {
  buildRuntimeHealthDimensionInputs,
  collectRuntimeHealthReports,
  commandHasAgentId,
  findCrashedAgents,
  findRuntimeProfileIssues,
  loadDbProfileSessions,
  type ReadOnlyQueryClient,
  type RuntimeHealthSnapshot,
  type RuntimeObservationProbes,
} from '../../bin/aun-watchdog'
import { evaluateRuntimeHealth } from '../../core/runtime-health-monitor'

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('watchdog legacy read-only heartbeat/profile detection', () => {
  let client: Client
  const TEST_PREFIX = `test-watchdog-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
  })

  afterAll(async () => {
    await client.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
    await client.end()
  })

  async function seedAgent(options: {
    id: string
    status: string
    lastSeenSecondsAgo: number | null
    agentType?: string
  }): Promise<void> {
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at)
       VALUES ($1, $1, $2, 'mcp', $3,
               CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(secs => $4) END)
       ON CONFLICT (agent_id) DO UPDATE
       SET status = EXCLUDED.status,
           last_seen_at = EXCLUDED.last_seen_at,
           agent_type = EXCLUDED.agent_type`,
      [options.id, options.agentType ?? 'dev', options.status, options.lastSeenSecondsAgo],
    )
  }

  test('stale heartbeat is observed while fresh heartbeat is not', async () => {
    const stale = `${TEST_PREFIX}-stale`
    const fresh = `${TEST_PREFIX}-fresh`
    await seedAgent({ id: stale, status: 'busy', lastSeenSecondsAgo: 360 })
    await seedAgent({ id: fresh, status: 'idle', lastSeenSecondsAgo: 30 })
    const crashed = await findCrashedAgents(client)
    expect(crashed.some((agent) => agent.agentId === stale)).toBe(true)
    expect(crashed.some((agent) => agent.agentId === fresh)).toBe(false)
  })

  test('offline, disabled, human, system, and profile-disabled rows are excluded', async () => {
    const fixtures = [
      { suffix: 'offline', status: 'offline', agentType: 'dev' },
      { suffix: 'disabled', status: 'disabled', agentType: 'dev' },
      { suffix: 'human', status: 'online', agentType: 'human' },
      { suffix: 'system', status: 'online', agentType: 'system' },
    ]
    for (const fixture of fixtures) {
      await seedAgent({
        id: `${TEST_PREFIX}-${fixture.suffix}`,
        status: fixture.status,
        agentType: fixture.agentType,
        lastSeenSecondsAgo: 600,
      })
    }
    const profileDisabled = `${TEST_PREFIX}-profile-disabled`
    await seedAgent({ id: profileDisabled, status: 'idle', lastSeenSecondsAgo: 600 })
    await client.query(`UPDATE agents SET profile_enabled = false WHERE agent_id = $1`, [profileDisabled])

    const crashed = await findCrashedAgents(client)
    for (const fixture of fixtures) {
      expect(crashed.some((agent) => agent.agentId === `${TEST_PREFIX}-${fixture.suffix}`)).toBe(false)
    }
    expect(crashed.some((agent) => agent.agentId === profileDisabled)).toBe(false)
  })

  test('DB profile remains the session and port source of truth', async () => {
    const agentId = `${TEST_PREFIX}-profile`
    await client.query(
      `INSERT INTO agents
         (agent_id, display_name, agent_type, runtime, status, last_seen_at,
          metadata, home_directory, channel_port, profile_enabled)
       VALUES
         ($1, $1, 'dev', 'TUI', 'idle', now(),
          jsonb_build_object('tmux_session', $2::text), $3, $4, true)`,
      [agentId, `${TEST_PREFIX}-session`, `/tmp/${TEST_PREFIX}`, 19001],
    )
    const sessions = await loadDbProfileSessions(client)
    expect(sessions.get(agentId)).toEqual({
      session: `${TEST_PREFIX}-session`,
      projectDir: `/tmp/${TEST_PREFIX}`,
      port: '19001',
      source: 'agents.profile',
    })
  })

  test('seven-dimension SELECT executes on migrated PostgreSQL without writes', async () => {
    const agentId = `${TEST_PREFIX}-projection`
    await client.query(
      `INSERT INTO agents
         (agent_id, display_name, agent_type, runtime, status, last_seen_at,
          metadata, home_directory, channel_port, profile_enabled)
       VALUES
         ($1, $1, 'dev', 'TUI', 'idle', now(),
          jsonb_build_object('tmux_session', $2::text), $3, $4, true)`,
      [agentId, `${TEST_PREFIX}-projection-session`, `/tmp/${TEST_PREFIX}`, 19002],
    )
    const reports = await collectRuntimeHealthReports(client, {
      supervisorSession: () => ({
        probe_result: 'ok', state: 'HEALTHY', reason_code: 'SUPERVISOR_SESSION_PRESENT',
      }),
      endpointIdentity: (_port, expectedAgentId) => ({
        probe_result: 'ok', state: 'HEALTHY', reason_code: 'ENDPOINT_EXPECTED_IDENTITY_PRESENT', observed_identity: expectedAgentId,
      }),
      uiRunnerSurface: () => ({
        probe_result: 'ok', state: 'HEALTHY', reason_code: 'UI_RUNNER_SURFACE_PRESENT',
      }),
    })
    const report = reports.find((candidate) => candidate.agent_id === agentId)
    expect(report?.dimensions).toHaveLength(7)
    expect(report?.aggregate_state).toBe('UNKNOWN')
    expect(report?.mutation_performed).toBe(false)
  })
})

describe('watchdog read-only supervisor and endpoint probes', () => {
  type WatchdogSession = { session: string; projectDir: string; port: string; source: 'agents.profile' }
  const profile = (session: string, port = '8810'): WatchdogSession => ({
    session,
    projectDir: '/tmp',
    port,
    source: 'agents.profile',
  })

  test('session and endpoint issues remain separately visible', () => {
    const registry = new Map<string, WatchdogSession>([
      ['missing-session', profile('missing')],
      ['wrong-endpoint', profile('present', '8811')],
      ['healthy', profile('healthy', '8812')],
    ])
    const issues = findRuntimeProfileIssues(registry, {
      hasTmuxSession: (session) => session !== 'missing',
      portHasExpectedAgent: (_port, agentId) => agentId !== 'wrong-endpoint',
    })
    expect(issues.map((issue) => [issue.agentId, issue.reason])).toEqual([
      ['missing-session', 'tmux_session_missing'],
      ['wrong-endpoint', 'port_missing_expected_agent'],
    ])
  })

  test('exact AGENT_ID matching rejects expected-id lookalikes', () => {
    expect(commandHasAgentId('/opt/bun server.ts AGENT_ID=arc', 'arc')).toBe(true)
    expect(commandHasAgentId('/opt/bun server.ts AGENT_ID="arc"', 'arc')).toBe(true)
    expect(commandHasAgentId('/opt/bun server.ts AGENT_COM_EXPECTED_AGENT_ID=arc', 'arc')).toBe(false)
    expect(commandHasAgentId('/opt/bun server.ts AGENT_ID=cto', 'arc')).toBe(false)
  })
})

describe('watchdog seven-dimension edge projection', () => {
  const NOW_MS = Date.parse('2026-07-21T10:00:00.000Z')
  const NOW = new Date(NOW_MS).toISOString()

  function healthySnapshot(): RuntimeHealthSnapshot {
    return {
      agentId: 'arc',
      agentStatus: 'idle',
      agentLastSeenAt: NOW,
      profileSessionName: 'discord-arc',
      runtimeSessionName: 'discord-arc',
      supervisorType: 'tmux',
      profilePort: '8810',
      runtimePort: '8810',
      expectedProviderIdentity: '{"provider":"discord"}',
      runtimeInstanceId: 'runtime-arc-1',
      runtimeStatus: 'running',
      runtimeLastSeenAt: NOW,
      runtimeEndpointUri: 'http://127.0.0.1:8810',
      liveRuntimeCount: 1,
      pendingQueueCount: 0,
      actionablePendingCount: 0,
      activeClaimCount: 0,
      unboundActiveClaimCount: 0,
      memoryReady: true,
      discordConnectorCount: 1,
      discordConnectorStatus: 'active',
      discordConnectorLastSeenAt: NOW,
    }
  }

  function healthyProbes(): RuntimeObservationProbes {
    return {
      supervisorSession: () => ({
        probe_result: 'ok', state: 'HEALTHY', reason_code: 'SUPERVISOR_SESSION_PRESENT',
      }),
      endpointIdentity: (_port, expectedAgentId) => ({
        probe_result: 'ok', state: 'HEALTHY', reason_code: 'ENDPOINT_EXPECTED_IDENTITY_PRESENT', observed_identity: expectedAgentId,
      }),
      uiRunnerSurface: () => ({
        probe_result: 'ok', state: 'HEALTHY', reason_code: 'UI_RUNNER_SURFACE_PRESENT',
      }),
    }
  }

  test('fresh heartbeat cannot mask a wrong endpoint identity', () => {
    const probes = healthyProbes()
    probes.endpointIdentity = () => ({
      probe_result: 'ok',
      state: 'DOWN',
      reason_code: 'ENDPOINT_IDENTITY_MISMATCH',
      observed_identity: 'cto',
    })
    const dimensions = buildRuntimeHealthDimensionInputs(healthySnapshot(), probes, NOW_MS)
    const endpoint = dimensions.find((dimension) => dimension.dimension === 'endpoint_identity')
    expect(endpoint).toMatchObject({
      declared_state: 'DOWN',
      expected_identity: 'arc',
      observed_identity: 'cto',
    })
  })

  test('same-agent profile/runtime session-port drift fails closed without probing profile values', () => {
    const probeCalls = { supervisor: [] as string[], endpoint: [] as string[], ui: [] as string[] }
    const probes: RuntimeObservationProbes = {
      supervisorSession: (session) => {
        probeCalls.supervisor.push(session)
        return { probe_result: 'ok', state: 'HEALTHY', reason_code: 'SUPERVISOR_SESSION_PRESENT' }
      },
      endpointIdentity: (port, expectedAgentId) => {
        probeCalls.endpoint.push(port)
        return {
          probe_result: 'ok',
          state: 'HEALTHY',
          reason_code: 'ENDPOINT_EXPECTED_IDENTITY_PRESENT',
          observed_identity: expectedAgentId,
        }
      },
      uiRunnerSurface: (session) => {
        probeCalls.ui.push(session)
        return { probe_result: 'ok', state: 'HEALTHY', reason_code: 'UI_RUNNER_SURFACE_PRESENT' }
      },
    }
    const snapshot = {
      ...healthySnapshot(),
      profileSessionName: 'profile-old-session',
      runtimeSessionName: 'runtime-new-session',
      profilePort: '8810',
      runtimePort: '9999',
      runtimeEndpointUri: 'http://127.0.0.1:9999',
    }

    const dimensions = buildRuntimeHealthDimensionInputs(snapshot, probes, NOW_MS)
    expect(dimensions.find((candidate) => candidate.dimension === 'supervisor_session')).toMatchObject({
      declared_state: 'UNKNOWN',
      reason_code: 'RUNTIME_PROFILE_SESSION_MISMATCH',
    })
    expect(dimensions.find((candidate) => candidate.dimension === 'endpoint_identity')).toMatchObject({
      declared_state: 'UNKNOWN',
      reason_code: 'RUNTIME_PROFILE_PORT_MISMATCH',
    })
    expect(dimensions.find((candidate) => candidate.dimension === 'ui_runner_reachability')).toMatchObject({
      declared_state: 'UNKNOWN',
      reason_code: 'RUNTIME_PROFILE_SESSION_MISMATCH',
    })
    expect(probeCalls).toEqual({ supervisor: [], endpoint: [], ui: [] })
  })

  test('agent-wide claim without selected runtime ownership stays UNKNOWN', () => {
    const snapshot = {
      ...healthySnapshot(),
      pendingQueueCount: 1,
      actionablePendingCount: 1,
      activeClaimCount: 0,
      unboundActiveClaimCount: 1,
    }
    const presentation = buildRuntimeHealthDimensionInputs(snapshot, healthyProbes(), NOW_MS)
      .find((candidate) => candidate.dimension === 'runtime_presentation_claim')
    expect(presentation).toMatchObject({
      declared_state: 'UNKNOWN',
      reason_code: 'CLAIM_RUNTIME_OWNERSHIP_UNPROVEN',
    })
    expect(presentation?.evidence_refs).toContain('db:message_queue:arc:runtime=runtime-arc-1:active_claims=0')
  })

  test('fresh runtime heartbeat cannot mask a stale agent heartbeat', () => {
    const snapshot = {
      ...healthySnapshot(),
      agentLastSeenAt: new Date(NOW_MS - 301_000).toISOString(),
      runtimeLastSeenAt: NOW,
    }
    const report = evaluateRuntimeHealth({
      agent_id: snapshot.agentId,
      runtime_instance_id: snapshot.runtimeInstanceId,
      dimensions: buildRuntimeHealthDimensionInputs(snapshot, healthyProbes(), NOW_MS),
    }, NOW_MS)
    expect(report.dimensions[0]).toMatchObject({
      state: 'UNKNOWN',
      reason_code: 'EVIDENCE_STALE',
    })
    expect(report.aggregate_state).toBe('UNKNOWN')
  })

  test('multiple live runtime instances cannot produce HEALTHY', () => {
    const snapshot = {
      ...healthySnapshot(),
      liveRuntimeCount: 2,
    }
    const report = evaluateRuntimeHealth({
      agent_id: snapshot.agentId,
      runtime_instance_id: snapshot.runtimeInstanceId,
      dimensions: buildRuntimeHealthDimensionInputs(snapshot, healthyProbes(), NOW_MS),
    }, NOW_MS)
    expect(report.dimensions[0]).toMatchObject({
      state: 'DEGRADED',
      reason_code: 'MULTIPLE_LIVE_RUNTIME_INSTANCES',
    })
    expect(report.aggregate_state).toBe('DEGRADED')
  })

  test('queued but not actionable and not presented stays distinct from provider projection', () => {
    const snapshot = {
      ...healthySnapshot(),
      pendingQueueCount: 1,
      actionablePendingCount: 1,
      activeClaimCount: 0,
      memoryReady: false,
    }
    const dimensions = buildRuntimeHealthDimensionInputs(snapshot, healthyProbes(), NOW_MS)
    expect(dimensions.find((dimension) => dimension.dimension === 'queue_actionable_receive')).toMatchObject({
      declared_state: 'DEGRADED',
      reason_code: 'QUEUE_PLACED_NOT_ACTIONABLE',
    })
    expect(dimensions.find((dimension) => dimension.dimension === 'runtime_presentation_claim')).toMatchObject({
      declared_state: 'UNKNOWN',
      reason_code: 'QUEUE_NOT_PRESENTED_OR_CLAIMED',
    })
    expect(dimensions.find((dimension) => dimension.dimension === 'provider_projection')).toMatchObject({
      declared_state: 'HEALTHY',
      reason_code: 'DISCORD_PROJECTION_FRESH',
    })
  })

  test('injected edge spies and SQL guard prove observation has zero mutation calls', async () => {
    const sqlCalls: string[] = []
    const probeCalls = { supervisor: 0, endpoint: 0, ui: 0 }
    const rawRow = {
      agent_id: 'arc',
      agent_status: 'idle',
      agent_last_seen_at: NOW,
      metadata: { tmux_session: 'discord-arc', supervisor_type: 'tmux' },
      channel_port: 8810,
      expected_provider_identity: '{"provider":"discord"}',
      runtime_instance_id: 'runtime-arc-1',
      runtime_status: 'running',
      runtime_last_seen_at: NOW,
      runtime_session_name: 'discord-arc',
      runtime_port: 8810,
      endpoint_uri: 'http://127.0.0.1:8810',
      live_runtime_count: 1,
      pending_queue_count: 0,
      actionable_pending_count: 0,
      active_claim_count: 0,
      unbound_active_claim_count: 0,
      memory_ready: true,
      discord_connector_count: 1,
      discord_connector_status: 'active',
      discord_connector_last_seen_at: NOW,
    }
    const client: ReadOnlyQueryClient = {
      query: async (sql) => {
        sqlCalls.push(sql)
        if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`mutation SQL refused: ${sql}`)
        return { rows: [rawRow] } as never
      },
    }
    const probes: RuntimeObservationProbes = {
      supervisorSession: () => {
        probeCalls.supervisor++
        return { probe_result: 'ok', state: 'HEALTHY', reason_code: 'SUPERVISOR_SESSION_PRESENT' }
      },
      endpointIdentity: (_port, expectedAgentId) => {
        probeCalls.endpoint++
        return {
          probe_result: 'ok',
          state: 'HEALTHY',
          reason_code: 'ENDPOINT_EXPECTED_IDENTITY_PRESENT',
          observed_identity: expectedAgentId,
        }
      },
      uiRunnerSurface: () => {
        probeCalls.ui++
        return { probe_result: 'ok', state: 'HEALTHY', reason_code: 'UI_RUNNER_SURFACE_PRESENT' }
      },
    }

    const reports = await collectRuntimeHealthReports(client, probes, NOW_MS)
    expect(reports).toHaveLength(1)
    expect(reports[0].aggregate_state).toBe('HEALTHY')
    expect(reports[0].mutation_performed).toBe(false)
    expect(sqlCalls).toHaveLength(1)
    expect(sqlCalls[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
    expect(sqlCalls[0]).toContain('mq.claimed_by = a.agent_id')
    expect(sqlCalls[0]).toContain('mq.claimed_runtime_instance_id::text = runtime.runtime_instance_id::text')
    expect(sqlCalls[0]).toContain('mq.claimed_runtime_instance_id::text IS DISTINCT FROM runtime.runtime_instance_id::text')
    expect(probeCalls).toEqual({ supervisor: 1, endpoint: 1, ui: 1 })
  })
})

describe('watchdog static negative mutation surface', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', 'bin', 'aun-watchdog.ts'), 'utf-8')
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  test('restart script, executable spawn, DB writes, and provider/host mutations are absent', () => {
    expect(executableSource).not.toContain('restart-bot.sh')
    expect(executableSource).not.toMatch(/\bspawn\s*\(/)
    expect(executableSource).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
    expect(executableSource).not.toMatch(/send-keys|launchctl|systemctl|outbound_queue|audit_log/i)
    expect(source).toContain('DIRECT_RESTART_REMOVED')
    expect(source).toContain('direct_restart_enabled: false')
  })
})
