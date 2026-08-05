import type { BotStatusDbRow } from './bot-status-db'
import type {
  RuntimeInventoryAgent,
  RuntimeInventoryConnector,
  RuntimeInventoryPolicyGap,
  RuntimeInventoryReport,
} from './runtime-inventory'
import type { StateDaemonRuntimeReadiness } from './state-daemon-readiness'

type GoNoGo = 'GO' | 'NO_GO'
type Severity = 'blocker' | 'warning'
export type CommunicationReadinessMode = 'complete' | 'queue-consumer'

export type CommunicationReadinessFinding = {
  code: string
  severity: Severity
  message: string
  agent_id?: string | null
  evidence?: Record<string, unknown>
}

export type CommunicationReadinessAgent = {
  agent_id: string
  status: string | null
  declared_runtime: string | null
  health_state: string | null
  pending_count: number
  active_claim_count: number
  oldest_pending_at: string | null
  pending_age_minutes: number | null
  runtime_freshness: RuntimeInventoryAgent['freshness'] | null
  runtime_status: string | null
  runtime_instance_id: string | null
  runtime_last_seen_at: string | null
  endpoint_lease_state: BotStatusDbRow['endpoint_lease_state']
  active_connector_count: number
  runtime_linked_connector_count: number
  active_endpoint_lease_count: number
  blocker_codes: string[]
  warning_codes: string[]
}

export type CommunicationReadinessReport = {
  ok: boolean
  go_no_go: GoNoGo
  generated_at: string
  issue_ref: '#722'
  options: {
    mode: CommunicationReadinessMode
    agent_ids: string[]
    stale_pending_minutes: number
    runtime_stale_minutes: number
  }
  policy: {
    read_only: true
    no_db_mutation: true
    no_state_daemon_restart: true
    no_launchctl_mutation: true
    no_discord_live_write: true
    no_next_inbox_fifo_drain: true
    no_prompt_driven_processing: true
    no_live_smoke: true
  }
  state_daemon: {
    ready: boolean
    status: string
    pid: number | null
    script: string | null
    working_directory: string | null
    codex_runner_enabled: boolean
    queue_work_scheduler_enabled: boolean
    runner_enabled: boolean
    agent_allowlist: string[]
    agent_denylist: string[]
    blocker_codes: string[]
  }
  summary: {
    agents: number
    pending_total: number
    active_claim_total: number
    agents_with_open_queue: number
    active_enabled_pending_over_slo: number
    runtime_blocked_agents: number
    endpoint_lease_blocked_agents: number
    policy_gaps: number
    blockers: number
    warnings: number
  }
  agents: CommunicationReadinessAgent[]
  policy_gaps: RuntimeInventoryPolicyGap[]
  blockers: CommunicationReadinessFinding[]
  warnings: CommunicationReadinessFinding[]
  recommended_next_commands: string[]
  mutation_performed: false
  restart_performed: false
}

export type CommunicationReadinessOptions = {
  mode?: CommunicationReadinessMode
  agentIds?: string[] | null
  stalePendingMinutes?: number
  runtimeStaleMinutes?: number
  now?: Date
}

function parseCsv(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((part) => part.trim()).filter(Boolean)
}

function envEnabled(raw: string | null | undefined): boolean {
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function isActiveEnabledStatus(status: string | null): boolean {
  return status === 'idle' || status === 'online' || status === 'busy'
}

function minutesSince(raw: string | null, now: Date): number | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((now.getTime() - ms) / 60_000))
}

function finding(
  code: string,
  severity: Severity,
  message: string,
  extra: Omit<CommunicationReadinessFinding, 'code' | 'severity' | 'message'> = {},
): CommunicationReadinessFinding {
  return { code, severity, message, ...extra }
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

function relevantPolicyGaps(gaps: RuntimeInventoryPolicyGap[], agentIds: string[]): RuntimeInventoryPolicyGap[] {
  if (agentIds.length === 0) return gaps
  return gaps.filter((gap) => {
    return agentIds.includes(gap.adapter_owner_agent_id)
      || gap.active_binding_agents.some((agentId) => agentIds.includes(agentId))
  })
}

function connectorsByAgent(connectors: RuntimeInventoryConnector[]): Map<string, RuntimeInventoryConnector[]> {
  const out = new Map<string, RuntimeInventoryConnector[]>()
  for (const connector of connectors) {
    const rows = out.get(connector.agent_id) ?? []
    rows.push(connector)
    out.set(connector.agent_id, rows)
  }
  return out
}

export function buildCommunicationReadinessReport(
  botStatusRows: Iterable<BotStatusDbRow>,
  runtimeInventory: RuntimeInventoryReport,
  stateDaemon: StateDaemonRuntimeReadiness,
  options: CommunicationReadinessOptions = {},
): CommunicationReadinessReport {
  const now = options.now ?? new Date()
  const mode = options.mode ?? 'complete'
  const completeMode = mode === 'complete'
  const stalePendingMinutes = options.stalePendingMinutes ?? 15
  const runtimeStaleMinutes = options.runtimeStaleMinutes ?? runtimeInventory.options.stale_minutes
  const agentIds = [...new Set((options.agentIds ?? []).filter(Boolean))]
  const agentIdSet = new Set(agentIds)
  const selected = (agentId: string) => agentIdSet.size === 0 || agentIdSet.has(agentId)
  const runtimeAgents = new Map(runtimeInventory.agents.map((agent) => [agent.agent_id, agent]))
  const connectorMap = connectorsByAgent(runtimeInventory.connectors)
  const rows = Array.from(botStatusRows).filter((row) => selected(row.agent_id))
  const allowlist = parseCsv(stateDaemon.environment.agent_allowlist)
  const denylist = parseCsv(stateDaemon.environment.agent_denylist)
  const codexRunnerEnabled = envEnabled(stateDaemon.environment.codex_runner_enabled)
  const queueWorkSchedulerEnabled = envEnabled(stateDaemon.environment.queue_work_scheduler_enabled)
  const runnerEnabled = codexRunnerEnabled || queueWorkSchedulerEnabled
  const blockers: CommunicationReadinessFinding[] = []
  const warnings: CommunicationReadinessFinding[] = []
  const stateDaemonBlockerCodes: string[] = []

  if (stateDaemon.status !== 'ok') {
    addUnique(stateDaemonBlockerCodes, 'STATE_DAEMON_TRANSPORT_NOT_READY')
    blockers.push(finding('STATE_DAEMON_TRANSPORT_NOT_READY', 'blocker', 'state-daemon transport is not ready', {
      evidence: {
        status: stateDaemon.status,
        launchd_loaded: stateDaemon.launchd.loaded,
        launchd_running: stateDaemon.launchd.running,
        pid: stateDaemon.process.pid,
      },
    }))
  }
  if (!runnerEnabled) {
    addUnique(stateDaemonBlockerCodes, 'STATE_DAEMON_RUNNER_DISABLED')
    blockers.push(finding('STATE_DAEMON_RUNNER_DISABLED', 'blocker', 'no autonomous queue consumer is enabled in state-daemon', {
      evidence: {
        codex_runner_enabled: stateDaemon.environment.codex_runner_enabled,
        queue_work_scheduler_enabled: stateDaemon.environment.queue_work_scheduler_enabled,
      },
    }))
  }

  const agents: CommunicationReadinessAgent[] = rows.map((row) => {
    const runtime = runtimeAgents.get(row.agent_id) ?? null
    const connectors = connectorMap.get(row.agent_id) ?? []
    const blockerCodes: string[] = []
    const warningCodes: string[] = []
    const pendingAgeMinutes = minutesSince(row.oldest_pending_at, now)
    const openQueue = row.pending_count > 0 || row.active_claim_count > 0
    const activeEnabled = isActiveEnabledStatus(row.status)

    if (row.pending_count > 0 && activeEnabled && pendingAgeMinutes !== null && pendingAgeMinutes >= stalePendingMinutes) {
      addUnique(blockerCodes, 'ACTIVE_PENDING_OVER_SLO')
      blockers.push(finding('ACTIVE_PENDING_OVER_SLO', 'blocker', 'active enabled agent has pending queue rows over the SLO', {
        agent_id: row.agent_id,
        evidence: {
          status: row.status,
          pending_count: row.pending_count,
          oldest_pending_at: row.oldest_pending_at,
          pending_age_minutes: pendingAgeMinutes,
          stale_pending_minutes: stalePendingMinutes,
        },
      }))
    }

    if (row.pending_count > 0 && !activeEnabled) {
      addUnique(blockerCodes, 'OPEN_QUEUE_AGENT_NOT_ACTIVE')
      blockers.push(finding('OPEN_QUEUE_AGENT_NOT_ACTIVE', 'blocker', 'agent has pending queue rows but is not active enabled', {
        agent_id: row.agent_id,
        evidence: {
          status: row.status,
          pending_count: row.pending_count,
          oldest_pending_at: row.oldest_pending_at,
        },
      }))
    }

    if (row.active_claim_count > 0) {
      addUnique(warningCodes, 'ACTIVE_CLAIM_OPEN')
      warnings.push(finding('ACTIVE_CLAIM_OPEN', 'warning', 'agent has open active queue claims; verify they are fresh before activation', {
        agent_id: row.agent_id,
        evidence: {
          active_claim_count: row.active_claim_count,
        },
      }))
    }

    if (allowlist.length > 0 && openQueue && !allowlist.includes(row.agent_id)) {
      addUnique(blockerCodes, 'OPEN_QUEUE_AGENT_NOT_ALLOWLISTED')
      blockers.push(finding('OPEN_QUEUE_AGENT_NOT_ALLOWLISTED', 'blocker', 'open queue row is outside the current state-daemon allowlist', {
        agent_id: row.agent_id,
        evidence: {
          allowlist,
          pending_count: row.pending_count,
          active_claim_count: row.active_claim_count,
        },
      }))
    }
    if (denylist.includes(row.agent_id) && openQueue) {
      addUnique(blockerCodes, 'OPEN_QUEUE_AGENT_DENYLISTED')
      blockers.push(finding('OPEN_QUEUE_AGENT_DENYLISTED', 'blocker', 'open queue row targets a state-daemon denylisted agent', {
        agent_id: row.agent_id,
        evidence: {
          denylist,
          pending_count: row.pending_count,
          active_claim_count: row.active_claim_count,
        },
      }))
    }

    if (runtime?.declared_runtime === 'discord' && row.pending_count > 0) {
      addUnique(blockerCodes, 'HUMAN_OR_DISCORD_TARGET_PENDING')
      blockers.push(finding('HUMAN_OR_DISCORD_TARGET_PENDING', 'blocker', 'pending rows target a non-bot Discord/human runtime', {
        agent_id: row.agent_id,
        evidence: {
          declared_runtime: runtime.declared_runtime,
          pending_count: row.pending_count,
        },
      }))
    }

    const runtimeFreshness = runtime?.freshness ?? null
    if (completeMode && (activeEnabled || openQueue) && runtimeFreshness !== 'fresh') {
      addUnique(blockerCodes, 'RUNTIME_NOT_FRESH')
      blockers.push(finding('RUNTIME_NOT_FRESH', 'blocker', 'agent runtime evidence is not fresh for communication processing', {
        agent_id: row.agent_id,
        evidence: {
          runtime_freshness: runtimeFreshness,
          runtime_status: runtime?.runtime_status ?? null,
          runtime_last_seen_at: runtime?.last_seen_at ?? null,
          runtime_stale_minutes: runtimeStaleMinutes,
          warnings: runtime?.warnings ?? ['no_runtime_inventory_row'],
        },
      }))
    }

    const hasActiveConnector = row.active_connector_count > 0 || connectors.some((connector) => connector.status === 'active')
    if (completeMode && (activeEnabled || openQueue) && hasActiveConnector && row.endpoint_lease_state !== 'ok') {
      addUnique(blockerCodes, 'ENDPOINT_LEASE_NOT_READY')
      blockers.push(finding('ENDPOINT_LEASE_NOT_READY', 'blocker', 'active connector endpoint lease is not ready', {
        agent_id: row.agent_id,
        evidence: {
          endpoint_lease_state: row.endpoint_lease_state,
          active_connector_count: row.active_connector_count,
          runtime_linked_connector_count: row.runtime_linked_connector_count,
          active_endpoint_lease_count: row.active_endpoint_lease_count,
        },
      }))
    }

    return {
      agent_id: row.agent_id,
      status: row.status,
      declared_runtime: runtime?.declared_runtime ?? null,
      health_state: row.health_state,
      pending_count: row.pending_count,
      active_claim_count: row.active_claim_count,
      oldest_pending_at: row.oldest_pending_at,
      pending_age_minutes: pendingAgeMinutes,
      runtime_freshness: runtimeFreshness,
      runtime_status: runtime?.runtime_status ?? null,
      runtime_instance_id: runtime?.latest_runtime_instance_id ?? null,
      runtime_last_seen_at: runtime?.last_seen_at ?? null,
      endpoint_lease_state: row.endpoint_lease_state,
      active_connector_count: row.active_connector_count,
      runtime_linked_connector_count: row.runtime_linked_connector_count,
      active_endpoint_lease_count: row.active_endpoint_lease_count,
      blocker_codes: blockerCodes,
      warning_codes: warningCodes,
    }
  })

  const policyGaps = completeMode ? relevantPolicyGaps(runtimeInventory.policy_gaps, agentIds) : []
  for (const gap of policyGaps) {
    blockers.push(finding('OUTBOUND_POLICY_GAP', 'blocker', 'outbound channel policy does not match active connector binding evidence', {
      evidence: {
        channel_id: gap.channel_id,
        channel_name: gap.channel_name,
        adapter_owner_agent_id: gap.adapter_owner_agent_id,
        reason: gap.reason,
        active_binding_agents: gap.active_binding_agents,
      },
    }))
  }

  if (rows.length === 0) {
    warnings.push(finding('NO_AGENT_ROWS', 'warning', 'no agent status rows matched the communication readiness scope'))
  }

  const pendingTotal = agents.reduce((sum, agent) => sum + agent.pending_count, 0)
  const activeClaimTotal = agents.reduce((sum, agent) => sum + agent.active_claim_count, 0)
  const activePendingOverSlo = agents.filter((agent) => agent.blocker_codes.includes('ACTIVE_PENDING_OVER_SLO')).length
  const runtimeBlocked = agents.filter((agent) => agent.blocker_codes.includes('RUNTIME_NOT_FRESH')).length
  const endpointBlocked = agents.filter((agent) => agent.blocker_codes.includes('ENDPOINT_LEASE_NOT_READY')).length
  const ok = blockers.length === 0

  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: now.toISOString(),
    issue_ref: '#722',
    options: {
      mode,
      agent_ids: agentIds,
      stale_pending_minutes: stalePendingMinutes,
      runtime_stale_minutes: runtimeStaleMinutes,
    },
    policy: {
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_discord_live_write: true,
      no_next_inbox_fifo_drain: true,
      no_prompt_driven_processing: true,
      no_live_smoke: true,
    },
    state_daemon: {
      ready: stateDaemonBlockerCodes.length === 0,
      status: stateDaemon.status,
      pid: stateDaemon.process.pid,
      script: stateDaemon.paths.script,
      working_directory: stateDaemon.paths.working_directory,
      codex_runner_enabled: codexRunnerEnabled,
      queue_work_scheduler_enabled: queueWorkSchedulerEnabled,
      runner_enabled: runnerEnabled,
      agent_allowlist: allowlist,
      agent_denylist: denylist,
      blocker_codes: stateDaemonBlockerCodes,
    },
    summary: {
      agents: agents.length,
      pending_total: pendingTotal,
      active_claim_total: activeClaimTotal,
      agents_with_open_queue: agents.filter((agent) => agent.pending_count > 0 || agent.active_claim_count > 0).length,
      active_enabled_pending_over_slo: activePendingOverSlo,
      runtime_blocked_agents: runtimeBlocked,
      endpoint_lease_blocked_agents: endpointBlocked,
      policy_gaps: policyGaps.length,
      blockers: blockers.length,
      warnings: warnings.length,
    },
    agents,
    policy_gaps: policyGaps,
    blockers,
    warnings,
    recommended_next_commands: ok
      ? []
      : mode === 'queue-consumer'
        ? [
            'Keep live activation blocked until protected review authorizes an exact target/fence.',
            'Use complete mode separately before claiming Discord or endpoint readiness.',
          ]
        : [
          'Keep live activation blocked until protected review authorizes an exact target/fence.',
          'Repair or explicitly exclude reported communication blockers before broad rollout.',
        ],
    mutation_performed: false,
    restart_performed: false,
  }
}

export function formatCommunicationReadinessText(report: CommunicationReadinessReport): string {
  const lines = [
    'AUN Communication Readiness',
    `Generated: ${report.generated_at}`,
    `Result: ${report.go_no_go}`,
    `Mode: ${report.options.mode}`,
    `Scope: ${report.options.agent_ids.length > 0 ? report.options.agent_ids.join(',') : 'all agents'}`,
    `State daemon: status=${report.state_daemon.status} runner=${report.state_daemon.runner_enabled} codex=${report.state_daemon.codex_runner_enabled} queue_work_scheduler=${report.state_daemon.queue_work_scheduler_enabled}`,
    `Queue: agents=${report.summary.agents} open_agents=${report.summary.agents_with_open_queue} pending=${report.summary.pending_total} active_claims=${report.summary.active_claim_total}`,
    `Blockers: total=${report.summary.blockers} active_pending_over_slo=${report.summary.active_enabled_pending_over_slo} runtime=${report.summary.runtime_blocked_agents} endpoint_lease=${report.summary.endpoint_lease_blocked_agents} policy_gaps=${report.summary.policy_gaps}`,
    `Mutation performed: ${report.mutation_performed}`,
    `Restart performed: ${report.restart_performed}`,
  ]
  const blockedAgents = report.agents.filter((agent) => agent.blocker_codes.length > 0 || agent.warning_codes.length > 0)
  if (blockedAgents.length > 0) {
    lines.push('', 'Agents:')
    for (const agent of blockedAgents) {
      const codes = [...agent.blocker_codes, ...agent.warning_codes.map((code) => `warn:${code}`)].join(',')
      lines.push(`- ${agent.agent_id}: status=${agent.status ?? '-'} pending=${agent.pending_count} active_claims=${agent.active_claim_count} runtime=${agent.runtime_freshness ?? '-'} endpoint=${agent.endpoint_lease_state} codes=${codes}`)
    }
  }
  if (report.policy_gaps.length > 0) {
    lines.push('', 'Policy gaps:')
    for (const gap of report.policy_gaps) {
      lines.push(`- ${gap.channel_name ?? gap.channel_id}: adapter_owner=${gap.adapter_owner_agent_id} reason=${gap.reason} active=${gap.active_binding_agents.join(',') || '-'}`)
    }
  }
  if (report.blockers.length > 0) {
    lines.push('', 'Blockers:')
    for (const blocker of report.blockers) {
      lines.push(`- ${blocker.code}${blocker.agent_id ? ` agent=${blocker.agent_id}` : ''}: ${blocker.message}`)
    }
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) {
      lines.push(`- ${warning.code}${warning.agent_id ? ` agent=${warning.agent_id}` : ''}: ${warning.message}`)
    }
  }
  return `${lines.join('\n')}\n`
}
