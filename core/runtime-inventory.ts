import type { DbAdapter } from './db'

type RuntimeFreshness = 'fresh' | 'stale' | 'missing_heartbeat' | 'stopped' | 'unknown'

type RuntimeInventoryOptions = {
  staleMinutes?: number
  expectedCommit?: string | null
  provider?: string
}

export type RuntimeInventoryAgent = {
  agent_id: string
  agent_status: string
  declared_runtime: string
  runtime_instance_count: number
  latest_runtime_instance_id: string | null
  runtime_status: string | null
  runtime_engine: string | null
  runtime_kind: string | null
  session_name: string | null
  process_id: number | null
  port: number | null
  checkout_path: string | null
  commit_sha: string | null
  last_seen_at: string | null
  freshness: RuntimeFreshness
  warnings: string[]
}

export type RuntimeInventoryConnector = {
  connector_instance_id: string
  agent_id: string
  provider: string
  connector_uri: string | null
  status: string
  trust_status: string
  runtime_instance_id: string | null
  runtime_freshness: RuntimeFreshness
  active_binding_count: number
  last_seen_at: string | null
  warnings: string[]
}

export type RuntimeInventoryBinding = {
  channel_binding_id: string
  channel_id: string
  channel_name: string | null
  provider: string
  binding_role: string
  status: string
  connector_instance_id: string | null
  connector_agent_id: string | null
  adapter_owner_agent_id: string | null
  warnings: string[]
}

export type RuntimeInventoryPolicyGap = {
  channel_id: string
  channel_name: string | null
  adapter_owner_agent_id: string
  provider: string
  reason: 'missing_active_binding' | 'active_binding_wrong_owner'
  active_binding_agents: string[]
}

export type RuntimeInventoryReport = {
  ok: true
  generated_at: string
  policy: {
    db_is_source_of_truth: true
    runtime_identity: string
    final_design_guardrail: string
  }
  options: {
    stale_minutes: number
    expected_commit: string | null
    provider: string
  }
  summary: {
    agents: number
    runtime_instances: number
    fresh_runtimes: number
    stale_runtimes: number
    connectors: number
    active_connectors: number
    active_bindings: number
    policy_gaps: number
    blockers: number
  }
  agents: RuntimeInventoryAgent[]
  connectors: RuntimeInventoryConnector[]
  bindings: RuntimeInventoryBinding[]
  policy_gaps: RuntimeInventoryPolicyGap[]
  blockers: string[]
  warnings: string[]
}

function parseTimestampMs(raw: unknown): number | null {
  if (!raw) return null
  if (raw instanceof Date) {
    const ms = raw.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  const text = String(raw)
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? text.replace(' ', 'T')
    : text
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : null
}

function timestampString(raw: unknown): string | null {
  if (!raw) return null
  if (raw instanceof Date) return raw.toISOString()
  return String(raw)
}

function normalizeString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw)
  return value.length > 0 ? value : null
}

function isStoppedStatus(status: string | null): boolean {
  return ['stopped', 'disabled', 'offline', 'disconnected', 'failed'].includes(status ?? '')
}

function classifyRuntime(row: any | null, nowMs: number, staleMs: number): RuntimeFreshness {
  if (!row) return 'unknown'
  const status = normalizeString(row.status)
  if (isStoppedStatus(status) || row.stopped_at) return 'stopped'
  const lastSeen = parseTimestampMs(row.last_seen_at)
  if (lastSeen === null) return 'missing_heartbeat'
  return nowMs - lastSeen > staleMs ? 'stale' : 'fresh'
}

function runtimeWarnings(row: any | null, freshness: RuntimeFreshness, expectedCommit: string | null): string[] {
  const warnings: string[] = []
  if (!row) {
    warnings.push('no_runtime_instance')
    return warnings
  }
  if (freshness === 'stale') warnings.push('runtime_stale')
  if (freshness === 'missing_heartbeat') warnings.push('runtime_missing_heartbeat')
  if (freshness === 'stopped') warnings.push('runtime_stopped')
  if (expectedCommit) {
    const commit = normalizeString(row.commit_sha)
    if (!commit) warnings.push('runtime_commit_missing')
    else if (!commit.startsWith(expectedCommit) && !expectedCommit.startsWith(commit)) warnings.push('runtime_commit_mismatch')
  }
  if (!normalizeString(row.checkout_path)) warnings.push('runtime_checkout_path_missing')
  return warnings
}

function blockerFromWarning(agentId: string, warning: string): string | null {
  if (warning === 'runtime_stale') return `${agentId}:runtime_stale`
  if (warning === 'runtime_commit_mismatch') return `${agentId}:runtime_commit_mismatch`
  return null
}

async function queryAgentRows(db: DbAdapter): Promise<any[]> {
  try {
    return await db.query(
      `SELECT agent_id, agent_type, runtime, status
         FROM agents
        ORDER BY agent_id`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/runtime/i.test(message)) throw err
    return await db.query(
      `SELECT agent_id, agent_type, cli_type AS runtime, status
         FROM agents
        ORDER BY agent_id`,
    )
  }
}

export async function buildRuntimeInventoryReport(
  db: DbAdapter,
  options: RuntimeInventoryOptions = {},
): Promise<RuntimeInventoryReport> {
  const staleMinutes = options.staleMinutes ?? 15
  const expectedCommit = options.expectedCommit ?? null
  const provider = options.provider ?? 'discord'
  const staleMs = staleMinutes * 60_000
  const nowMs = Date.now()

  // The PgAdapter owns a single pg.Client, so keep reads sequential. This is a
  // read-only operator report; deterministic correctness matters more than
  // parallel query speed.
  const agentRows = await queryAgentRows(db)
  const runtimeRows = await db.query(
    `SELECT runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind,
            host_id, session_name, process_id, port, checkout_path, commit_sha,
            endpoint_uri, status, started_at, stopped_at, last_seen_at
       FROM agent_runtime_instances
      ORDER BY agent_id, started_at DESC`,
  )
  const connectorRows = await db.query(
    `SELECT connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri,
            status, trust_status, created_at, updated_at, last_seen_at, disabled_at
       FROM connector_instances
      WHERE provider = $1
      ORDER BY agent_id, created_at DESC`,
    [provider],
  )
  const bindingRows = await db.query(
    `SELECT b.channel_binding_id, b.channel_id, c.name AS channel_name, b.provider,
            b.connector_instance_id, b.binding_role, b.status, b.max_concurrency,
            b.ordering_scope, b.policy_source, ci.agent_id AS connector_agent_id,
            ci.status AS connector_status, ci.runtime_instance_id AS connector_runtime_instance_id,
            p.adapter_owner_agent_id
       FROM channel_connector_bindings b
       LEFT JOIN channels c ON c.id = b.channel_id
       LEFT JOIN connector_instances ci ON ci.connector_instance_id = b.connector_instance_id
       LEFT JOIN channel_routing_policy p ON p.channel_id = b.channel_id
      WHERE b.provider = $1
      ORDER BY c.name, b.channel_id, b.binding_role, b.priority`,
    [provider],
  )
  const policyRows = await db.query(
    `SELECT p.channel_id, c.name AS channel_name, p.adapter_owner_agent_id
       FROM channel_routing_policy p
       LEFT JOIN channels c ON c.id = p.channel_id
      WHERE p.adapter_owner_agent_id IS NOT NULL
      ORDER BY c.name, p.channel_id`,
  )

  const runtimesByAgent = new Map<string, any[]>()
  const runtimeById = new Map<string, any>()
  for (const row of runtimeRows) {
    const agentId = String(row.agent_id)
    const runtimeId = String(row.runtime_instance_id)
    const rows = runtimesByAgent.get(agentId) ?? []
    rows.push(row)
    runtimesByAgent.set(agentId, rows)
    runtimeById.set(runtimeId, row)
  }

  const activeBindingCountByConnector = new Map<string, number>()
  const activeBindingAgentsByChannel = new Map<string, string[]>()
  for (const row of bindingRows) {
    if (row.status !== 'active') continue
    const connectorId = normalizeString(row.connector_instance_id)
    if (connectorId) activeBindingCountByConnector.set(connectorId, (activeBindingCountByConnector.get(connectorId) ?? 0) + 1)
    const agentId = normalizeString(row.connector_agent_id)
    if (agentId) {
      const agents = activeBindingAgentsByChannel.get(String(row.channel_id)) ?? []
      agents.push(agentId)
      activeBindingAgentsByChannel.set(String(row.channel_id), [...new Set(agents)])
    }
  }

  const agents: RuntimeInventoryAgent[] = agentRows.map((row) => {
    const agentId = String(row.agent_id)
    const runtimes = runtimesByAgent.get(agentId) ?? []
    const latest = runtimes[0] ?? null
    const freshness = classifyRuntime(latest, nowMs, staleMs)
    const warnings = runtimeWarnings(latest, freshness, expectedCommit)
    return {
      agent_id: agentId,
      agent_status: String(row.status ?? ''),
      declared_runtime: String(row.runtime ?? ''),
      runtime_instance_count: runtimes.length,
      latest_runtime_instance_id: latest ? String(latest.runtime_instance_id) : null,
      runtime_status: normalizeString(latest?.status),
      runtime_engine: normalizeString(latest?.runtime_engine),
      runtime_kind: normalizeString(latest?.runtime_kind),
      session_name: normalizeString(latest?.session_name),
      process_id: latest?.process_id === null || latest?.process_id === undefined ? null : Number(latest.process_id),
      port: latest?.port === null || latest?.port === undefined ? null : Number(latest.port),
      checkout_path: normalizeString(latest?.checkout_path),
      commit_sha: normalizeString(latest?.commit_sha),
      last_seen_at: timestampString(latest?.last_seen_at),
      freshness,
      warnings,
    }
  })

  const connectors: RuntimeInventoryConnector[] = connectorRows.map((row) => {
    const runtimeId = normalizeString(row.runtime_instance_id)
    const runtime = runtimeId ? runtimeById.get(runtimeId) ?? null : null
    const freshness = runtimeId && runtime ? classifyRuntime(runtime, nowMs, staleMs) : 'unknown'
    const warnings: string[] = []
    if (row.status !== 'active') warnings.push('connector_not_active')
    if (row.disabled_at) warnings.push('connector_disabled')
    if (!runtimeId) warnings.push('connector_without_runtime')
    else if (!runtime) warnings.push('connector_runtime_missing')
    else warnings.push(...runtimeWarnings(runtime, freshness, expectedCommit).map((warning) => `connector_${warning}`))
    return {
      connector_instance_id: String(row.connector_instance_id),
      agent_id: String(row.agent_id),
      provider: String(row.provider),
      connector_uri: normalizeString(row.connector_uri),
      status: String(row.status ?? ''),
      trust_status: String(row.trust_status ?? ''),
      runtime_instance_id: runtimeId,
      runtime_freshness: freshness,
      active_binding_count: activeBindingCountByConnector.get(String(row.connector_instance_id)) ?? 0,
      last_seen_at: timestampString(row.last_seen_at),
      warnings,
    }
  })

  const bindings: RuntimeInventoryBinding[] = bindingRows.map((row) => {
    const warnings: string[] = []
    if (!row.connector_instance_id) warnings.push('binding_without_connector')
    if (!row.connector_agent_id) warnings.push('binding_connector_missing')
    if (row.connector_status && row.connector_status !== 'active') warnings.push('binding_connector_not_active')
    if (row.adapter_owner_agent_id && row.connector_agent_id && row.adapter_owner_agent_id !== row.connector_agent_id) {
      warnings.push('binding_connector_agent_mismatch_policy')
    }
    const runtimeId = normalizeString(row.connector_runtime_instance_id)
    if (!runtimeId) warnings.push('binding_connector_without_runtime')
    else {
      const runtime = runtimeById.get(runtimeId)
      const freshness = runtime ? classifyRuntime(runtime, nowMs, staleMs) : 'unknown'
      if (freshness === 'stale') warnings.push('binding_runtime_stale')
      if (freshness === 'missing_heartbeat') warnings.push('binding_runtime_missing_heartbeat')
    }
    return {
      channel_binding_id: String(row.channel_binding_id),
      channel_id: String(row.channel_id),
      channel_name: normalizeString(row.channel_name),
      provider: String(row.provider),
      binding_role: String(row.binding_role),
      status: String(row.status),
      connector_instance_id: normalizeString(row.connector_instance_id),
      connector_agent_id: normalizeString(row.connector_agent_id),
      adapter_owner_agent_id: normalizeString(row.adapter_owner_agent_id),
      warnings,
    }
  })

  const policyGaps: RuntimeInventoryPolicyGap[] = []
  for (const policy of policyRows) {
    const owner = normalizeString(policy.adapter_owner_agent_id)
    if (!owner) continue
    const activeAgents = activeBindingAgentsByChannel.get(String(policy.channel_id)) ?? []
    if (activeAgents.length === 0) {
      policyGaps.push({
        channel_id: String(policy.channel_id),
        channel_name: normalizeString(policy.channel_name),
        adapter_owner_agent_id: owner,
        provider,
        reason: 'missing_active_binding',
        active_binding_agents: [],
      })
    } else if (!activeAgents.includes(owner)) {
      policyGaps.push({
        channel_id: String(policy.channel_id),
        channel_name: normalizeString(policy.channel_name),
        adapter_owner_agent_id: owner,
        provider,
        reason: 'active_binding_wrong_owner',
        active_binding_agents: activeAgents,
      })
    }
  }

  const blockers = [
    ...agents.flatMap((agent) => agent.warnings.map((warning) => blockerFromWarning(agent.agent_id, warning)).filter((item): item is string => item !== null)),
    ...connectors.flatMap((connector) => connector.warnings
      .filter((warning) => warning === 'connector_runtime_stale' || warning === 'connector_runtime_commit_mismatch')
      .map((warning) => `${connector.agent_id}:${warning}`)),
    ...policyGaps.map((gap) => `${gap.channel_id}:${gap.reason}`),
  ]
  const warnings = [
    ...agents.flatMap((agent) => agent.warnings.map((warning) => `${agent.agent_id}:${warning}`)),
    ...connectors.flatMap((connector) => connector.warnings.map((warning) => `${connector.connector_instance_id}:${warning}`)),
    ...bindings.flatMap((binding) => binding.warnings.map((warning) => `${binding.channel_id}:${warning}`)),
  ]

  return {
    ok: true,
    generated_at: new Date(nowMs).toISOString(),
    policy: {
      db_is_source_of_truth: true,
      runtime_identity: 'agent_id is logical identity; runtime_instance_id is concrete process/session evidence',
      final_design_guardrail: 'read-only inventory; do not infer trust from local path, tmux name, or Discord identity',
    },
    options: {
      stale_minutes: staleMinutes,
      expected_commit: expectedCommit,
      provider,
    },
    summary: {
      agents: agents.length,
      runtime_instances: runtimeRows.length,
      fresh_runtimes: agents.filter((agent) => agent.freshness === 'fresh').length,
      stale_runtimes: agents.filter((agent) => agent.freshness === 'stale').length,
      connectors: connectors.length,
      active_connectors: connectors.filter((connector) => connector.status === 'active').length,
      active_bindings: bindings.filter((binding) => binding.status === 'active').length,
      policy_gaps: policyGaps.length,
      blockers: blockers.length,
    },
    agents,
    connectors,
    bindings,
    policy_gaps: policyGaps,
    blockers,
    warnings,
  }
}

export function formatRuntimeInventoryText(report: RuntimeInventoryReport): string {
  const lines = [
    'Runtime Inventory',
    `Agents: ${report.summary.agents}, runtime instances: ${report.summary.runtime_instances}, fresh: ${report.summary.fresh_runtimes}, stale: ${report.summary.stale_runtimes}`,
    `Connectors: ${report.summary.connectors}, active connectors: ${report.summary.active_connectors}, active bindings: ${report.summary.active_bindings}, policy gaps: ${report.summary.policy_gaps}`,
    '',
    'Runtime Evidence:',
  ]
  for (const agent of report.agents) {
    lines.push(`  ${agent.agent_id}: freshness=${agent.freshness} runtime=${agent.latest_runtime_instance_id ?? '-'} commit=${agent.commit_sha ?? '-'} session=${agent.session_name ?? '-'}${agent.warnings.length ? ` warnings=${agent.warnings.join(',')}` : ''}`)
  }
  lines.push('', 'Connectors:')
  for (const connector of report.connectors) {
    lines.push(`  ${connector.agent_id}/${connector.provider}: status=${connector.status} uri=${connector.connector_uri ?? '-'} runtime=${connector.runtime_instance_id ?? '-'} bindings=${connector.active_binding_count}${connector.warnings.length ? ` warnings=${connector.warnings.join(',')}` : ''}`)
  }
  lines.push('', 'Policy Gaps:')
  if (report.policy_gaps.length === 0) {
    lines.push('  none')
  } else {
    for (const gap of report.policy_gaps) {
      lines.push(`  ${gap.channel_name ?? gap.channel_id}: adapter_owner=${gap.adapter_owner_agent_id} reason=${gap.reason}`)
    }
  }
  if (report.blockers.length > 0) lines.push('', `Blockers: ${report.blockers.join(', ')}`)
  if (report.warnings.length > 0) lines.push('', `Warnings: ${report.warnings.join(', ')}`)
  return `${lines.join('\n')}\n`
}
