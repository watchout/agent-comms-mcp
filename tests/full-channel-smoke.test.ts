import { describe, expect, test } from 'bun:test'
import {
  buildFullChannelSmokeReport,
  formatFullChannelSmokeText,
  FULL_CHANNEL_SMOKE_FAILURE_CLASSES,
  type FullChannelSmokeOptions,
} from '../core/full-channel-smoke'

/**
 * NORM-060 full-channel smoke runner tests (#582).
 * Mock-DB driven (no real DB) following tests/inbound-smoke.test.ts. Each test
 * starts from a single healthy channel scenario and overrides one dimension to
 * exercise a specific #581/NORM-050 failure class or the exclusion / execute paths.
 */

type Scenario = {
  agents?: any[]
  runtimes?: any[]
  workers?: any[]
  leases?: any[]
  endpoints?: any[]
  deliveryOwnerChannels?: any[]
  targetChannels?: any[]
  latestInbound?: any | null
  queueRows?: any[]
  outbound?: any[]
  outboundByMessage?: Record<string, any[]>
  auditEventTypes?: any[]
  unregisteredAuditRows?: number
  // reconcile: observed-missing inbound external channels
  observedMissing?: any[]
  // execute poll override: rows returned by `SELECT agent_id, status FROM message_queue WHERE message_id = $1`
  executePollRows?: (messageId: string) => any[]
}

function healthy(): Scenario {
  return {
    agents: [
      { agent_id: 'hotel-dev', status: 'idle', agent_type: 'dev', profile_enabled: true, disabled_at: null, metadata: {} },
    ],
    runtimes: [{ agent_id: 'hotel-dev', status: 'active', stopped_at: null }],
    workers: [],
    leases: [{ holder_agent_id: 'hotel-dev', lease_purpose: 'worker' }],
    endpoints: [{ agent_id: 'hotel-dev' }],
    deliveryOwnerChannels: [{ channel_id: 'hotel-kanri' }],
    targetChannels: [
      {
        channel_id: 'hotel-kanri',
        name: 'hotel-kanri',
        members: ['hotel-dev'],
        external_id: 'EID1',
        adapter_owner_agent_id: 'hotel-dev',
        primary_agent_id: 'hotel-dev',
        outbound_allowlist: ['hotel-dev'],
      },
    ],
    latestInbound: {
      id: 'M1',
      channel_id: 'hotel-kanri',
      author_id: 'ceo-discord',
      author_bot: false,
      discord_message_id: 'D1',
      input_mentions: ['hotel-dev'],
      created_at: '2026-05-29T00:00:00.000Z',
    },
    queueRows: [{ status: 'done', count: '1', any_claimed: '1' }],
    outbound: [{ consumer_agent_id: 'hotel-dev', channel_external_id: 'EID1', status: 'sent', last_error: null, count: '1' }],
    auditEventTypes: [],
    unregisteredAuditRows: 0,
    observedMissing: [],
  }
}

function makeDb(s: Scenario) {
  const executed: Array<{ sql: string; params?: any[] }> = []
  const route = (sql: string, params?: any[]): any[] => {
    // --- buildAgentEvidence ---
    if (sql.includes('COALESCE(profile_enabled, true) AS profile_enabled')) return s.agents ?? []
    if (sql.includes('FROM agent_runtime_instances')) return s.runtimes ?? []
    if (sql.includes('FROM worker_activity')) return s.workers ?? []
    if (sql.includes('FROM control_plane_leases')) return s.leases ?? []
    if (sql.includes('FROM agent_endpoints')) return s.endpoints ?? []
    // --- delivery owner ---
    if (sql.includes('FROM channel_connector_bindings b') && sql.includes('JOIN connector_instances')) {
      return s.deliveryOwnerChannels ?? []
    }
    // --- target channels ---
    if (sql.includes('FROM channels c') && sql.includes('p.primary_agent_id')) return s.targetChannels ?? []
    // --- reconcile: observed missing external channels ---
    if (sql.includes('GROUP BY COALESCE(metadata')) {
      return (s.observedMissing ?? []).map((m) => ({
        external_channel_id: m.external_channel_id,
        message_count: String(m.message_count ?? 1),
        latest_created_at: m.latest_created_at ?? '2026-05-29T00:00:00.000Z',
      }))
    }
    // reconcile buildObservation (only runs when observedMissing present)
    if (sql.includes('SELECT id, content, metadata, input_mentions, created_at')) return []
    // reconcile registrationState: channels by id
    if (sql.includes('SELECT id FROM channels WHERE id = $1')) return [] // not registered
    if (sql.includes('FROM channel_adapters WHERE platform = $1 AND external_id = $2')) return []
    if (sql.includes('FROM thread_adapters')) return []
    // reconcile inferSingleAdapterOwner
    if (sql.includes('FROM connector_instances')) return []
    if (sql.includes('FROM agent_ui_bindings')) return []
    if (sql.includes('provider_token_source_ref')) return []
    if (sql.includes('WHERE agent_id = $1') && sql.includes('LIMIT 1')) return [{ agent_id: params?.[0] }]
    // --- unregistered audit rows ---
    if (sql.includes("event_type = 'inbound.channel_unregistered'")) {
      return [{ count: String(s.unregisteredAuditRows ?? 0) }]
    }
    // --- execute poll (no agent_id filter, no GROUP BY) ---
    if (sql.includes('SELECT agent_id, status FROM message_queue WHERE message_id = $1')) {
      return s.executePollRows ? s.executePollRows(String(params?.[0])) : []
    }
    // --- queue rows for agent ---
    if (sql.includes('FROM message_queue') && sql.includes('AND agent_id = $2') && sql.includes('GROUP BY status')) {
      return s.queueRows ?? []
    }
    // --- outbound ---
    if (sql.includes('FROM outbound_queue') && sql.includes('message_id = $1')) {
      return s.outboundByMessage?.[String(params?.[0])] ?? s.outbound ?? []
    }
    // --- audit event types ---
    if (sql.includes('FROM audit_log') && sql.includes('GROUP BY event_type')) {
      return s.auditEventTypes ?? []
    }
    // --- latest inbound ---
    if (sql.includes('FROM agent_messages') && sql.includes('discord_message_id, input_mentions') && sql.includes('LIMIT 1')) {
      return s.latestInbound ? [s.latestInbound] : []
    }
    return []
  }
  return {
    async query(sql: string, params?: any[]) {
      return route(sql, params)
    },
    async queryOne(sql: string, params?: any[]) {
      const rows = route(sql, params)
      return rows[0] ?? null
    },
    async execute(sql: string, params?: any[]) {
      executed.push({ sql, params })
      return { rowCount: 1 }
    },
    async transaction(fn: (tx: any) => Promise<any>) {
      return fn(this)
    },
    async close() {},
    __executed: executed,
  }
}

async function run(s: Scenario, opts: FullChannelSmokeOptions = {}) {
  return buildFullChannelSmokeReport(makeDb(s) as any, {
    nowMs: () => Date.parse('2026-05-29T01:00:00.000Z'),
    sleepMs: async () => {},
    ...opts,
  })
}

describe('NORM-060 full-channel smoke runner', () => {
  test('dry-run is read-only and passes a fully-observed healthy channel', async () => {
    const report = await run(healthy())
    expect(report.mode).toBe('dry_run')
    expect(report.policy.read_only).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.summary.target_channels).toBe(1)
    expect(report.summary.passed).toBe(1)
    expect(report.summary.failure_count).toBe(0)
    const channel = report.channels[0]
    expect(channel.status).toBe('pass')
    const target = channel.targets.find((t) => t.agent_id === 'hotel-dev')!
    expect(target.lifecycle.terminal_reached).toBe(true)
    expect(target.lifecycle.outbound_terminal).toBe(true)
    expect(target.failures).toHaveLength(0)
  })

  test('report shape carries the NORM-050 failure model contract (POST_MERGE evidence shape)', async () => {
    const report = await run(healthy())
    expect(report.policy.consumes_norm_050_failure_model).toBe(true)
    expect(report.policy.excludes_disabled_test_by_default).toBe(true)
    expect(report.policy.dry_run_default).toBe(true)
    expect(report.policy.failure_classes).toEqual(FULL_CHANNEL_SMOKE_FAILURE_CLASSES)
    expect(report.policy.failure_classes).toHaveLength(8)
    // failures_by_class has all 8 keys
    expect(Object.keys(report.summary.failures_by_class).sort()).toEqual([...FULL_CHANNEL_SMOKE_FAILURE_CLASSES].sort())
    expect(report.plan_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(report.policy.smoke_requires.length).toBeGreaterThanOrEqual(7)
    expect(formatFullChannelSmokeText(report)).toContain('NORM-060 Full-Channel Smoke')
  })

  test('failure class: offline_runtime when no live runtime or worker activity', async () => {
    const s = healthy()
    s.runtimes = []
    s.workers = []
    const report = await run(s)
    const target = report.channels[0].targets[0]
    expect(target.status).toBe('blocked')
    const f = target.failures.find((x) => x.failure_class === 'offline_runtime')!
    expect(f).toBeDefined()
    expect(f.evidence.source_table).toBe('agent_runtime_instances')
    expect(f.evidence.matched_rows).toBe(0)
    expect(report.summary.failures_by_class.offline_runtime).toBe(1)
  })

  test('failure class: no_endpoint_lease when runtime present but no lease/endpoint', async () => {
    const s = healthy()
    s.leases = []
    s.endpoints = []
    const report = await run(s)
    const target = report.channels[0].targets[0]
    expect(target.failures.some((x) => x.failure_class === 'no_endpoint_lease')).toBe(true)
    expect(target.failures.some((x) => x.failure_class === 'offline_runtime')).toBe(false)
  })

  test('failure class: missing_delivery_owner when no connector-backed outbound consumer', async () => {
    const s = healthy()
    s.deliveryOwnerChannels = []
    const report = await run(s)
    const target = report.channels[0].targets[0]
    const f = target.failures.find((x) => x.failure_class === 'missing_delivery_owner')!
    expect(f).toBeDefined()
    expect(f.evidence.source_table).toBe('channel_connector_bindings')
  })

  test('failure class: missing_member when a mention is not a channel member', async () => {
    const s = healthy()
    s.latestInbound = { ...s.latestInbound, input_mentions: ['hotel-dev', 'stranger'] }
    const report = await run(s)
    const channel = report.channels[0]
    const f = channel.failures.find((x) => x.failure_class === 'missing_member')!
    expect(f).toBeDefined()
    expect((f.evidence.cite as any).non_member_mentions).toContain('stranger')
    expect(channel.status).toBe('blocked')
  })

  test('failure class: duplicate_routing when >1 queue row for one (message, agent)', async () => {
    const s = healthy()
    s.queueRows = [{ status: 'done', count: '2', any_claimed: '1' }]
    const report = await run(s)
    const target = report.channels[0].targets[0]
    const f = target.failures.find((x) => x.failure_class === 'duplicate_routing')!
    expect(f).toBeDefined()
    expect(f.evidence.matched_rows).toBe(2)
  })

  test('reply-path outbound evidence follows message_queue.replied_with', async () => {
    const s = healthy()
    s.queueRows = [{ status: 'replied', count: '1', any_claimed: '1', queue_row_id: '42', replied_with: 'R1' }]
    s.outbound = []
    s.outboundByMessage = {
      M1: [],
      R1: [{ consumer_agent_id: 'hotel-dev', channel_external_id: 'EID1', status: 'sent', last_error: null, count: '1' }],
    }
    const report = await run(s)
    const target = report.channels[0].targets[0]
    expect(target.status).toBe('pass')
    expect(target.lifecycle.queue_row_id).toBe('42')
    expect(target.lifecycle.reply_message_id).toBe('R1')
    expect(target.lifecycle.outbound_message_id).toBe('R1')
    expect(target.lifecycle.outbound_terminal).toBe(true)
  })

  test('reply-path without outbound terminal evidence remains incomplete', async () => {
    const s = healthy()
    s.queueRows = [{ status: 'replied', count: '1', any_claimed: '1', queue_row_id: '42', replied_with: 'R1' }]
    s.outbound = []
    s.outboundByMessage = { R1: [] }
    const report = await run(s)
    expect(report.channels[0].status).toBe('incomplete')
    expect(report.channels[0].targets[0].status).toBe('incomplete')
  })

  test('failure class: send_feedback_mismatch when outbound terminal channel != target channel', async () => {
    const s = healthy()
    s.outbound = [{ consumer_agent_id: 'hotel-dev', channel_external_id: 'WRONG', status: 'sent', last_error: null, count: '1' }]
    const report = await run(s)
    const target = report.channels[0].targets[0]
    const f = target.failures.find((x) => x.failure_class === 'send_feedback_mismatch')!
    expect(f).toBeDefined()
    expect((f.evidence.cite as any).observed_channel_external_id).toBe('WRONG')
  })

  test('failure class: send_feedback_mismatch from send_reject audit evidence', async () => {
    const s = healthy()
    s.auditEventTypes = [{ event_type: 'send_reject', count: '3' }]
    const report = await run(s)
    const target = report.channels[0].targets[0]
    expect(target.failures.some((x) => x.failure_class === 'send_feedback_mismatch')).toBe(true)
  })

  test('failure class: unregistered_channel consumes reconcile observed-missing + inbound.channel_unregistered audit', async () => {
    const s = healthy()
    s.observedMissing = [{ external_channel_id: '99999', message_count: 4, latest_created_at: '2026-05-28T00:00:00.000Z' }]
    s.unregisteredAuditRows = 4
    const report = await run(s)
    expect(report.summary.unregistered_channels).toBe(1)
    const u = report.unregistered_channels[0]
    expect(u.external_channel_id).toBe('99999')
    expect(u.audit_evidence_rows).toBe(4)
    expect(u.recommended_action).toContain('channel reconcile')
    const f = report.failures.find((x) => x.failure_class === 'unregistered_channel')!
    expect(f).toBeDefined()
    expect(report.summary.failures_by_class.unregistered_channel).toBe(1)
  })

  test('disabled and test profiles are excluded by default, included on flags', async () => {
    const s = healthy()
    s.agents = [
      { agent_id: 'hotel-dev', status: 'idle', agent_type: 'dev', profile_enabled: true, disabled_at: null, metadata: {} },
      { agent_id: 'dead-dev', status: 'idle', agent_type: 'dev', profile_enabled: false, disabled_at: null, metadata: {} },
      { agent_id: '__roundtrip__', status: 'idle', agent_type: 'dev', profile_enabled: true, disabled_at: null, metadata: {} },
    ]
    s.targetChannels = [
      {
        channel_id: 'hotel-kanri',
        name: 'hotel-kanri',
        members: ['hotel-dev', 'dead-dev', '__roundtrip__'],
        external_id: 'EID1',
        adapter_owner_agent_id: 'hotel-dev',
        primary_agent_id: 'hotel-dev',
        outbound_allowlist: ['hotel-dev'],
      },
    ]
    const def = await run(s)
    const channel = def.channels[0]
    expect(channel.excluded_agents.sort()).toEqual(['__roundtrip__', 'dead-dev'])
    expect(channel.expected_target_agents).toEqual(['hotel-dev'])
    expect(def.summary.excluded_agents).toBe(2)

    const incl = await run(s, { includeDisabled: true, includeTest: true })
    expect(incl.channels[0].expected_target_agents.sort()).toEqual(['__roundtrip__', 'dead-dev', 'hotel-dev'])
    expect(incl.channels[0].excluded_agents).toHaveLength(0)
  })

  test('human channel members are excluded from queue smoke targets', async () => {
    const s = healthy()
    s.agents = [
      { agent_id: 'hotel-dev', status: 'idle', agent_type: 'dev', profile_enabled: true, disabled_at: null, metadata: {} },
      { agent_id: 'ceo', status: 'idle', agent_type: 'human', profile_enabled: true, disabled_at: null, metadata: {} },
    ]
    s.targetChannels = [
      {
        channel_id: 'hotel-kanri',
        name: 'hotel-kanri',
        members: ['hotel-dev', 'ceo'],
        external_id: 'EID1',
        adapter_owner_agent_id: 'hotel-dev',
        primary_agent_id: 'hotel-dev',
        outbound_allowlist: ['hotel-dev'],
      },
    ]
    s.latestInbound = { ...s.latestInbound, input_mentions: ['hotel-dev', 'ceo'] }
    s.executePollRows = () => [{ agent_id: 'hotel-dev', status: 'done' }]

    const plan = await run(s)
    const channel = plan.channels[0]
    expect(channel.expected_target_agents).toEqual(['hotel-dev'])
    expect(channel.excluded_agents).toEqual(['ceo'])
    expect(channel.targets.find((target) => target.agent_id === 'ceo')?.excluded_reason).toBe('human_agent_no_queue')
    expect(channel.targets.some((target) => target.agent_id === 'ceo' && target.failures.some((failure) => failure.failure_class === 'offline_runtime'))).toBe(false)

    const db = makeDb(s)
    await buildFullChannelSmokeReport(db as any, {
      nowMs: () => Date.parse('2026-05-29T01:00:00.000Z'),
      sleepMs: async () => {},
      mode: 'execute',
      confirmPlanHash: plan.plan_hash,
      timeoutMs: 0,
      sqlDialect: 'postgres',
    })
    const queueWrites = (db as any).__executed.filter((e: any) => e.sql.includes('INSERT INTO message_queue'))
    expect(queueWrites.map((write: any) => write.params[0])).toEqual(['hotel-dev'])
  })

  test('bounded execute requires confirm plan hash (operator approval)', async () => {
    const report = await run(healthy(), { mode: 'execute', confirmPlanHash: 'wrong-hash', timeoutMs: 0 })
    expect(report.ok).toBe(false)
    expect(report.error).toBe('OPERATOR_APPROVAL_REQUIRED')
    expect(report.execute).toBeUndefined()
  })

  test('bounded execute injects a probe and classifies timeout when not terminal in window', async () => {
    const s = healthy()
    // probe queue rows stay pending -> never terminal
    s.executePollRows = (messageId) => [{ agent_id: 'hotel-dev', status: 'pending' }]
    const plan = await run(s)
    const report = await run(s, { mode: 'execute', confirmPlanHash: plan.plan_hash, timeoutMs: 0 })
    expect(report.ok).toBe(true)
    expect(report.run_id).toMatch(/^norm060-/)
    expect(report.execute).toBeDefined()
    expect(report.execute!.injected_targets.length).toBe(1)
    expect(report.execute!.timed_out_targets.length).toBe(1)
    const target = report.channels[0].targets.find((t) => t.agent_id === 'hotel-dev')!
    expect(target.failures.some((x) => x.failure_class === 'timeout')).toBe(true)
    expect(report.summary.failures_by_class.timeout).toBe(1)
  })

  test('bounded execute reaches terminal evidence -> no timeout', async () => {
    const s = healthy()
    s.executePollRows = (messageId) => [{ agent_id: 'hotel-dev', status: 'done' }]
    const plan = await run(s)
    const report = await run(s, { mode: 'execute', confirmPlanHash: plan.plan_hash, timeoutMs: 0 })
    expect(report.execute!.timed_out_targets.length).toBe(0)
    expect(report.summary.failures_by_class.timeout).toBe(0)
  })

  test('execute injects synthetic inbound + queue + audit rows (probe writes)', async () => {
    const s = healthy()
    s.executePollRows = () => [{ agent_id: 'hotel-dev', status: 'done' }]
    const plan = await run(s)
    const db = makeDb(s)
    await buildFullChannelSmokeReport(db as any, {
      nowMs: () => Date.parse('2026-05-29T01:00:00.000Z'),
      sleepMs: async () => {},
      mode: 'execute',
      confirmPlanHash: plan.plan_hash,
      timeoutMs: 0,
      sqlDialect: 'postgres',
    })
    const writes = (db as any).__executed.map((e: any) => e.sql)
    expect(writes.some((sql: string) => sql.includes('INSERT INTO agent_messages'))).toBe(true)
    expect(writes.some((sql: string) => sql.includes('INSERT INTO message_queue'))).toBe(true)
    expect(writes.some((sql: string) => sql.includes("'smoke.full_channel_execute'"))).toBe(true)
    const inboundWrite = (db as any).__executed.find((e: any) => e.sql.includes('INSERT INTO agent_messages'))
    expect(inboundWrite.params[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(inboundWrite.params[5]).toEqual(['hotel-dev'])
  })
})
