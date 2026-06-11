import type { BotStatusDbRow } from './bot-status-db'

export interface BotLifecycleEntry {
  session?: string | null
  agentId: string
  port?: number | null
  supervisorType?: string | null
}

export interface CleanupPortDeps {
  hasTmuxSession: (session: string) => boolean
  getProcessOnPort: (port: number) => string[]
}

export type CleanupPortAction = 'skip' | 'kill' | 'active' | 'free' | 'clean'

export interface CleanupPortEvaluation {
  action: CleanupPortAction
  reason: string
  pids: string[]
}

export function normalizedSupervisorType(entry: Pick<BotLifecycleEntry, 'session' | 'supervisorType'>): string {
  const explicit = typeof entry.supervisorType === 'string' && entry.supervisorType.trim()
    ? entry.supervisorType.trim().toLowerCase()
    : ''
  if (explicit) return explicit
  return entry.session ? 'tmux' : 'unknown'
}

export function endpointLeaseGateFailure(
  entry: Pick<BotLifecycleEntry, 'agentId'>,
  dbRow: BotStatusDbRow | undefined,
): string | null {
  if (!dbRow) return 'endpoint lease evidence unavailable'

  const active = dbRow.active_connector_count
  const runtimeLinked = dbRow.runtime_linked_connector_count
  const leaseCovered = dbRow.active_endpoint_lease_count
  if (active === 0) return null

  if (runtimeLinked < active) {
    return `endpoint lease gate blocked: state=missing_runtime active_connectors=${active} runtime_linked=${runtimeLinked} active_leases=${leaseCovered}`
  }
  if (leaseCovered < active) {
    return `endpoint lease gate blocked: state=missing_lease active_connectors=${active} runtime_linked=${runtimeLinked} active_leases=${leaseCovered}`
  }
  if (dbRow.endpoint_lease_state !== 'ok') {
    return `endpoint lease gate blocked: state=${dbRow.endpoint_lease_state} active_connectors=${active} runtime_linked=${runtimeLinked} active_leases=${leaseCovered}`
  }
  return null
}

export function destructiveLifecycleGateFailure(
  entry: BotLifecycleEntry,
  dbRow: BotStatusDbRow | undefined,
): string | null {
  const endpointFailure = endpointLeaseGateFailure(entry, dbRow)
  if (endpointFailure) return endpointFailure

  const supervisorType = normalizedSupervisorType(entry)
  if (supervisorType !== 'tmux') {
    return `unsupported_supervisor_for_restart_cleanup: supervisor_type=${supervisorType}`
  }
  if (!entry.session) return 'missing_tmux_session'
  return null
}

export function evaluateCleanupPort(
  entry: BotLifecycleEntry,
  dbRow: BotStatusDbRow | undefined,
  deps: CleanupPortDeps,
): CleanupPortEvaluation {
  if (!entry.port || entry.port <= 0) {
    return { action: 'skip', reason: 'missing_channel_port', pids: [] }
  }

  const supervisorType = normalizedSupervisorType(entry)
  if (supervisorType !== 'tmux') {
    return {
      action: 'skip',
      reason: `unsupported_supervisor_for_restart_cleanup: supervisor_type=${supervisorType}`,
      pids: [],
    }
  }
  if (!entry.session) {
    return { action: 'skip', reason: 'missing_tmux_session', pids: [] }
  }

  const sessionExists = deps.hasTmuxSession(entry.session)
  const pids = deps.getProcessOnPort(entry.port)
  if (!sessionExists && pids.length > 0) {
    const gateFailure = endpointLeaseGateFailure(entry, dbRow)
    if (gateFailure) return { action: 'skip', reason: gateFailure, pids }
    return { action: 'kill', reason: 'tmux_session_absent_with_port_owner', pids }
  }
  if (sessionExists && pids.length > 0) return { action: 'active', reason: 'active_tmux_session', pids }
  if (!sessionExists && pids.length === 0) return { action: 'free', reason: 'tmux_session_absent_port_free', pids }
  return { action: 'clean', reason: 'port_clean', pids }
}
