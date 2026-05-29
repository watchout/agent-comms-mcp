import { createHash } from 'node:crypto'
import type { DbAdapter } from './db'
import { parseJsonObject, profileExclusionReason, normalizeText } from './profile-classification'
import type { TmuxPaneSnapshot } from './tmux-runtime-inspector'

export type RuntimeCleanupClassification =
  | 'active'
  | 'disabled-profile-residue'
  | 'stale-heartbeat'
  | 'orphan-listener'
  | 'duplicate-tmux'
  | 'unknown-risk'

export type RuntimeCleanupRisk = 'none' | 'low' | 'review' | 'unknown-risk'

export type RuntimeCleanupActionKind = 'noop' | 'stop_runtime' | 'kill_process' | 'kill_tmux_session'

export type PortListenerSnapshot = {
  pid: number
  port: number
  command?: string | null
}

export type RuntimeCleanupAction = {
  kind: RuntimeCleanupActionKind
  reason: string
  runtime_instance_id?: string | null
  pid?: number | null
  port?: number | null
  tmux_session?: string | null
}

export type RuntimeCleanupTarget = {
  target_id: string
  classification: RuntimeCleanupClassification
  risk: RuntimeCleanupRisk
  agent_id: string | null
  runtime_instance_id: string | null
  pid: number | null
  port: number | null
  tmux_session: string | null
  evidence: Record<string, unknown>
  actions: RuntimeCleanupAction[]
}

export type RuntimeCleanupReport = {
  ok: true
  dry_run: boolean
  generated_at: string
  plan_hash: string
  policy: {
    default_mode: 'dry-run'
    execute_requires_plan_hash: true
    unknown_risk_requires_override: true
    terminal_queue_state_preserved: true
  }
  options: {
    stale_minutes: number
    include_disabled_profiles: boolean
    include_test_profiles: boolean
  }
  summary: {
    targets: number
    cleanup_targets: number
    executable_actions: number
    unknown_risk_targets: number
  }
  targets: RuntimeCleanupTarget[]
  blockers: string[]
}

export type RuntimeCleanupPlanOptions = {
  staleMinutes?: number
  includeDisabledProfiles?: boolean
  includeTestProfiles?: boolean
  now?: Date
  tmuxPanes?: TmuxPaneSnapshot[]
  portListeners?: PortListenerSnapshot[]
}

export type RuntimeCleanupExecuteOptions = RuntimeCleanupPlanOptions & {
  confirmHash: string
  allowUnknownRisk?: boolean
  killProcess?: (pid: number) => Promise<void> | void
  killTmuxSession?: (session: string) => Promise<void> | void
}

type AgentRow = {
  agent_id: string
  agent_type: string | null
  status: string | null
  runtime: string | null
  metadata: unknown
  channel_port: number | null
  profile_enabled: unknown
  disabled_at: unknown
}

type RuntimeRow = {
  runtime_instance_id: string
  agent_id: string
  runtime_engine: string | null
  runtime_kind: string | null
  session_name: string | null
  process_id: number | null
  port: number | null
  checkout_path: string | null
  commit_sha: string | null
  status: string | null
  started_at: string | null
  stopped_at: string | null
  last_seen_at: string | null
  metadata: unknown
}

const LIVE_RUNTIME_STATUSES = new Set(['active', 'idle', 'online', 'running'])

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) out[key] = stableValue(child)
    }
    return out
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function planHash(report: Omit<RuntimeCleanupReport, 'plan_hash'>): string {
  const canonical = {
    options: report.options,
    policy: report.policy,
    targets: report.targets.map((target) => ({
      target_id: target.target_id,
      classification: target.classification,
      risk: target.risk,
      agent_id: target.agent_id,
      runtime_instance_id: target.runtime_instance_id,
      pid: target.pid,
      port: target.port,
      tmux_session: target.tmux_session,
      evidence: target.evidence,
      actions: target.actions,
    })),
  }
  return createHash('sha256').update(stableJson(canonical)).digest('hex')
}

function numberOrNull(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function isLiveRuntime(row: RuntimeRow): boolean {
  return !row.stopped_at && LIVE_RUNTIME_STATUSES.has(String(row.status ?? '').toLowerCase())
}

function runtimeIsStale(row: RuntimeRow, nowMs: number, staleMinutes: number): boolean {
  if (!isLiveRuntime(row)) return false
  const lastSeen = normalizeText(row.last_seen_at)
  if (!lastSeen) return true
  const lastSeenMs = Date.parse(lastSeen)
  if (!Number.isFinite(lastSeenMs)) return true
  return nowMs - lastSeenMs > staleMinutes * 60_000
}

function tmuxSessionFor(agent: AgentRow, runtimeRows: RuntimeRow[]): string | null {
  const metadata = parseJsonObject(agent.metadata)
  return normalizeText(metadata.tmux_session) ?? normalizeText(runtimeRows.find(isLiveRuntime)?.session_name)
}

function supervisorTypeFor(agent: AgentRow, tmuxSession: string | null): string {
  const metadata = parseJsonObject(agent.metadata)
  return normalizeText(metadata.supervisor_type)?.toLowerCase() ?? (tmuxSession ? 'tmux' : 'unknown')
}

function listenersForPort(port: number | null, listeners: PortListenerSnapshot[]): PortListenerSnapshot[] {
  if (!port) return []
  return listeners.filter((listener) => listener.port === port)
}

function uniqueActions(actions: RuntimeCleanupAction[]): RuntimeCleanupAction[] {
  const seen = new Set<string>()
  const out: RuntimeCleanupAction[] = []
  for (const action of actions) {
    const key = stableJson(action)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(action)
  }
  return out
}

function firstPid(target: RuntimeCleanupTarget): number | null {
  const actionPid = target.actions.find((action) => action.pid)?.pid
  return actionPid ?? target.pid
}

function sortTargets(targets: RuntimeCleanupTarget[]): RuntimeCleanupTarget[] {
  return [...targets].sort((a, b) => a.target_id.localeCompare(b.target_id))
}

function targetHasExecutableAction(target: RuntimeCleanupTarget): boolean {
  return target.actions.some((action) => action.kind !== 'noop')
}

function cleanupTarget(
  input: Omit<RuntimeCleanupTarget, 'actions'> & { actions: RuntimeCleanupAction[] },
): RuntimeCleanupTarget {
  return {
    ...input,
    pid: input.pid ?? firstPid(input as RuntimeCleanupTarget),
    actions: uniqueActions(input.actions),
  }
}

async function queryRows<T>(db: DbAdapter, sql: string, params?: unknown[]): Promise<T[]> {
  return await db.query<T>(sql, params)
}

async function loadAgents(db: DbAdapter): Promise<AgentRow[]> {
  return await queryRows<AgentRow>(
    db,
    `SELECT agent_id, agent_type, status, runtime, metadata, channel_port, profile_enabled, disabled_at
       FROM agents
      WHERE agent_type <> 'human'
      ORDER BY agent_id`,
  )
}

async function loadRuntimes(db: DbAdapter): Promise<RuntimeRow[]> {
  return await queryRows<RuntimeRow>(
    db,
    `SELECT runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id,
            port, checkout_path, commit_sha, status, started_at, stopped_at, last_seen_at, metadata
       FROM agent_runtime_instances
      ORDER BY agent_id, started_at DESC`,
  ).catch(() => [])
}

export function parseLsofTcpListeners(output: string): PortListenerSnapshot[] {
  const listeners: PortListenerSnapshot[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('COMMAND ')) continue
    const parts = trimmed.split(/\s+/)
    const pid = Number.parseInt(parts[1] ?? '', 10)
    const name = parts.slice(8).join(' ')
    const portMatch = name.match(/(?:TCP\s+.*:|:)(\d+)\s+\(LISTEN\)/)
    const port = Number.parseInt(portMatch?.[1] ?? '', 10)
    if (!Number.isFinite(pid) || !Number.isFinite(port)) continue
    listeners.push({ pid, port, command: parts[0] ?? null })
  }
  return listeners
}

export async function buildRuntimeCleanupReport(
  db: DbAdapter,
  options: RuntimeCleanupPlanOptions = {},
  dryRun = true,
): Promise<RuntimeCleanupReport> {
  const staleMinutes = options.staleMinutes ?? 15
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const includeDisabledProfiles = options.includeDisabledProfiles ?? false
  const includeTestProfiles = options.includeTestProfiles ?? false
  const tmuxPanes = options.tmuxPanes ?? []
  const portListeners = options.portListeners ?? []
  const agents = await loadAgents(db)
  const runtimes = await loadRuntimes(db)

  const runtimeByAgent = new Map<string, RuntimeRow[]>()
  for (const runtime of runtimes) {
    const rows = runtimeByAgent.get(runtime.agent_id) ?? []
    rows.push(runtime)
    runtimeByAgent.set(runtime.agent_id, rows)
  }

  const activeAgentByPort = new Map<number, string[]>()
  const allAgentByPort = new Map<number, string[]>()
  const activeOwnersByTmux = new Map<string, string[]>()
  const allOwnersByTmux = new Map<string, string[]>()
  const candidatePorts = new Set<number>()

  for (const runtime of runtimes) {
    const port = numberOrNull(runtime.port)
    if (port) candidatePorts.add(port)
  }

  for (const agent of agents) {
    const agentRuntimes = runtimeByAgent.get(agent.agent_id) ?? []
    const exclusionReason = profileExclusionReason(agent, { includeDisabledProfiles, includeTestProfiles })
    const port = numberOrNull(agent.channel_port) ?? numberOrNull(agentRuntimes.find((row) => row.port)?.port)
    const tmuxSession = tmuxSessionFor(agent, agentRuntimes)
    if (port) {
      candidatePorts.add(port)
      const all = allAgentByPort.get(port) ?? []
      all.push(agent.agent_id)
      allAgentByPort.set(port, all)
      if (!exclusionReason) {
        const active = activeAgentByPort.get(port) ?? []
        active.push(agent.agent_id)
        activeAgentByPort.set(port, active)
      }
    }
    if (tmuxSession) {
      const all = allOwnersByTmux.get(tmuxSession) ?? []
      all.push(agent.agent_id)
      allOwnersByTmux.set(tmuxSession, all)
      if (!exclusionReason) {
        const active = activeOwnersByTmux.get(tmuxSession) ?? []
        active.push(agent.agent_id)
        activeOwnersByTmux.set(tmuxSession, active)
      }
    }
  }

  const targets: RuntimeCleanupTarget[] = []
  const coveredListenerKeys = new Set<string>()

  for (const agent of agents) {
    const agentRuntimes = runtimeByAgent.get(agent.agent_id) ?? []
    const liveRuntimes = agentRuntimes.filter(isLiveRuntime)
    const latestLive = liveRuntimes[0] ?? null
    const metadata = parseJsonObject(agent.metadata)
    const tmuxSession = tmuxSessionFor(agent, agentRuntimes)
    const port = numberOrNull(agent.channel_port) ?? numberOrNull(latestLive?.port)
    const matchingListeners = listenersForPort(port, portListeners)
    for (const listener of matchingListeners) coveredListenerKeys.add(`${listener.port}:${listener.pid}`)
    const matchingTmuxPanes = tmuxSession
      ? tmuxPanes.filter((pane) => pane.session_name === tmuxSession)
      : []
    const exclusionReason = profileExclusionReason(agent, { includeDisabledProfiles, includeTestProfiles })

    if (exclusionReason) {
      const hasResidue = liveRuntimes.length > 0 || matchingListeners.length > 0 || matchingTmuxPanes.length > 0
      if (!hasResidue) continue
      const actions: RuntimeCleanupAction[] = liveRuntimes.map((runtime) => ({
        kind: 'stop_runtime',
        runtime_instance_id: runtime.runtime_instance_id,
        reason: `${exclusionReason}_live_runtime`,
      }))
      for (const listener of matchingListeners) {
        actions.push({
          kind: 'kill_process',
          pid: listener.pid,
          port: listener.port,
          reason: `${exclusionReason}_port_listener`,
        })
      }
      if (tmuxSession && matchingTmuxPanes.length > 0 && supervisorTypeFor(agent, tmuxSession) === 'tmux') {
        actions.push({
          kind: 'kill_tmux_session',
          tmux_session: tmuxSession,
          reason: `${exclusionReason}_tmux_session`,
        })
      }
      targets.push(cleanupTarget({
        target_id: `agent:${agent.agent_id}:disabled-profile-residue`,
        classification: 'disabled-profile-residue',
        risk: 'low',
        agent_id: agent.agent_id,
        runtime_instance_id: latestLive?.runtime_instance_id ?? null,
        pid: numberOrNull(latestLive?.process_id) ?? matchingListeners[0]?.pid ?? null,
        port,
        tmux_session: tmuxSession,
        evidence: {
          agent_id: agent.agent_id,
          profile_exclusion: exclusionReason,
          profile_enabled: agent.profile_enabled,
          disabled_at: agent.disabled_at ?? null,
          status: agent.status ?? null,
          metadata,
          runtime_instance_ids: liveRuntimes.map((runtime) => runtime.runtime_instance_id),
          runtime_statuses: liveRuntimes.map((runtime) => runtime.status),
          runtime_process_ids: liveRuntimes.map((runtime) => runtime.process_id).filter((pid) => pid !== null),
          listener_pids: matchingListeners.map((listener) => listener.pid),
          tmux_pane_pids: matchingTmuxPanes.map((pane) => pane.pane_pid),
        },
        actions,
      }))
      continue
    }

    const staleRuntimes = liveRuntimes.filter((runtime) => runtimeIsStale(runtime, nowMs, staleMinutes))
    if (staleRuntimes.length > 0) {
      const actions: RuntimeCleanupAction[] = staleRuntimes.map((runtime) => ({
        kind: 'stop_runtime',
        runtime_instance_id: runtime.runtime_instance_id,
        reason: 'runtime_heartbeat_stale',
      }))
      const listenerPids = new Set(matchingListeners.map((listener) => listener.pid))
      const runtimePids = new Set(staleRuntimes.map((runtime) => numberOrNull(runtime.process_id)).filter((pid): pid is number => pid !== null))
      const tmuxStillObserved = tmuxSession ? matchingTmuxPanes.length > 0 : false
      if (!tmuxStillObserved) {
        for (const listener of matchingListeners) {
          if (runtimePids.size === 0 || runtimePids.has(listener.pid)) {
            actions.push({
              kind: 'kill_process',
              pid: listener.pid,
              port: listener.port,
              reason: 'stale_runtime_port_listener',
            })
          }
        }
      }
      const unknownRisk = listenerPids.size > 0 && runtimePids.size > 0 && [...listenerPids].some((pid) => !runtimePids.has(pid))
      targets.push(cleanupTarget({
        target_id: `agent:${agent.agent_id}:stale-heartbeat`,
        classification: unknownRisk ? 'unknown-risk' : 'stale-heartbeat',
        risk: unknownRisk ? 'unknown-risk' : 'review',
        agent_id: agent.agent_id,
        runtime_instance_id: staleRuntimes[0]?.runtime_instance_id ?? null,
        pid: numberOrNull(staleRuntimes[0]?.process_id) ?? matchingListeners[0]?.pid ?? null,
        port,
        tmux_session: tmuxSession,
        evidence: {
          agent_id: agent.agent_id,
          runtime_instance_ids: staleRuntimes.map((runtime) => runtime.runtime_instance_id),
          runtime_statuses: staleRuntimes.map((runtime) => runtime.status),
          last_seen_at: staleRuntimes.map((runtime) => runtime.last_seen_at),
          runtime_process_ids: staleRuntimes.map((runtime) => runtime.process_id).filter((pid) => pid !== null),
          listener_pids: matchingListeners.map((listener) => listener.pid),
          tmux_observed: tmuxStillObserved,
          stale_minutes: staleMinutes,
        },
        actions: unknownRisk ? [{ kind: 'noop', reason: 'listener_pid_does_not_match_runtime_pid' }] : actions,
      }))
      continue
    }

    if (latestLive) {
      targets.push(cleanupTarget({
        target_id: `agent:${agent.agent_id}:active`,
        classification: 'active',
        risk: 'none',
        agent_id: agent.agent_id,
        runtime_instance_id: latestLive.runtime_instance_id,
        pid: numberOrNull(latestLive.process_id),
        port,
        tmux_session: tmuxSession,
        evidence: {
          agent_id: agent.agent_id,
          runtime_instance_id: latestLive.runtime_instance_id,
          runtime_status: latestLive.status,
          last_seen_at: latestLive.last_seen_at,
          process_id: latestLive.process_id,
          port,
          tmux_session: tmuxSession,
          listener_pids: matchingListeners.map((listener) => listener.pid),
          tmux_pane_pids: matchingTmuxPanes.map((pane) => pane.pane_pid),
        },
        actions: [{ kind: 'noop', reason: 'fresh_active_runtime' }],
      }))
    }
  }

  for (const listener of portListeners) {
    if (!candidatePorts.has(listener.port)) continue
    const key = `${listener.port}:${listener.pid}`
    if (coveredListenerKeys.has(key)) continue
    const activeOwners = activeAgentByPort.get(listener.port) ?? []
    const allOwners = allAgentByPort.get(listener.port) ?? []
    if (activeOwners.length > 0) {
      targets.push(cleanupTarget({
        target_id: `listener:${listener.port}:${listener.pid}:unknown-risk`,
        classification: 'unknown-risk',
        risk: 'unknown-risk',
        agent_id: activeOwners[0] ?? null,
        runtime_instance_id: null,
        pid: listener.pid,
        port: listener.port,
        tmux_session: null,
        evidence: {
          listener_pid: listener.pid,
          port: listener.port,
          listener_command: listener.command ?? null,
          active_port_owners: activeOwners,
          all_port_owners: allOwners,
        },
        actions: [{ kind: 'noop', reason: 'listener_port_has_active_owner' }],
      }))
    } else if (allOwners.length === 0) {
      targets.push(cleanupTarget({
        target_id: `listener:${listener.port}:${listener.pid}:orphan-listener`,
        classification: 'orphan-listener',
        risk: 'low',
        agent_id: null,
        runtime_instance_id: null,
        pid: listener.pid,
        port: listener.port,
        tmux_session: null,
        evidence: {
          listener_pid: listener.pid,
          port: listener.port,
          listener_command: listener.command ?? null,
          active_port_owners: [],
          all_port_owners: [],
        },
        actions: [{
          kind: 'kill_process',
          pid: listener.pid,
          port: listener.port,
          reason: 'port_listener_without_profile_or_runtime_owner',
        }],
      }))
    }
  }

  for (const [tmuxSession, owners] of activeOwnersByTmux.entries()) {
    if (owners.length <= 1) continue
    targets.push(cleanupTarget({
      target_id: `tmux:${tmuxSession}:duplicate`,
      classification: 'duplicate-tmux',
      risk: 'unknown-risk',
      agent_id: owners[0] ?? null,
      runtime_instance_id: null,
      pid: null,
      port: null,
      tmux_session: tmuxSession,
      evidence: {
        tmux_session: tmuxSession,
        active_owners: owners,
        all_owners: allOwnersByTmux.get(tmuxSession) ?? owners,
      },
      actions: [{ kind: 'noop', reason: 'duplicate_active_tmux_session_requires_manual_owner_decision' }],
    }))
  }

  const sortedTargets = sortTargets(targets)
  const executableActions = sortedTargets.flatMap((target) => target.actions).filter((action) => action.kind !== 'noop')
  const blockers = sortedTargets
    .filter((target) => target.risk === 'unknown-risk' || target.classification === 'unknown-risk')
    .map((target) => `${target.target_id}:unknown-risk`)

  const withoutHash: Omit<RuntimeCleanupReport, 'plan_hash'> = {
    ok: true,
    dry_run: dryRun,
    generated_at: now.toISOString(),
    policy: {
      default_mode: 'dry-run',
      execute_requires_plan_hash: true,
      unknown_risk_requires_override: true,
      terminal_queue_state_preserved: true,
    },
    options: {
      stale_minutes: staleMinutes,
      include_disabled_profiles: includeDisabledProfiles,
      include_test_profiles: includeTestProfiles,
    },
    summary: {
      targets: sortedTargets.length,
      cleanup_targets: sortedTargets.filter(targetHasExecutableAction).length,
      executable_actions: executableActions.length,
      unknown_risk_targets: blockers.length,
    },
    targets: sortedTargets,
    blockers,
  }

  return {
    ...withoutHash,
    plan_hash: planHash(withoutHash),
  }
}

async function auditCleanupTarget(db: DbAdapter, target: RuntimeCleanupTarget, planHashValue: string, dryRun: boolean): Promise<void> {
  await db.execute(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      'runtime.cleanup_target',
      target.agent_id,
      target.target_id,
      JSON.stringify({
        plan_hash: planHashValue,
        dry_run: dryRun,
        classification: target.classification,
        risk: target.risk,
        pid: target.pid,
        port: target.port,
        tmux_session: target.tmux_session,
        runtime_instance_id: target.runtime_instance_id,
        evidence: target.evidence,
        actions: target.actions,
      }),
      'default',
    ],
  )
}

export async function executeRuntimeCleanup(
  db: DbAdapter,
  options: RuntimeCleanupExecuteOptions,
): Promise<RuntimeCleanupReport> {
  const report = await buildRuntimeCleanupReport(db, options, false)
  if (!options.confirmHash || options.confirmHash !== report.plan_hash) {
    throw new Error(`PLAN_HASH_MISMATCH: expected --confirm ${report.plan_hash}`)
  }
  const unknownRiskTargets = report.targets.filter(
    (target) => target.classification === 'unknown-risk' || target.risk === 'unknown-risk',
  )
  if (unknownRiskTargets.length > 0 && !options.allowUnknownRisk) {
    throw new Error(`UNKNOWN_RISK_REFUSED: ${unknownRiskTargets.map((target) => target.target_id).join(', ')}`)
  }

  for (const target of report.targets) {
    const executable = target.actions.filter((action) => action.kind !== 'noop')
    if (executable.length === 0) continue
    for (const action of executable) {
      if (action.kind === 'stop_runtime' && action.runtime_instance_id) {
        await db.execute(
          `UPDATE agent_runtime_instances
              SET status = 'stopped',
                  stopped_at = COALESCE(stopped_at, NOW())
            WHERE runtime_instance_id = $1
              AND stopped_at IS NULL`,
          [action.runtime_instance_id],
        )
      } else if (action.kind === 'kill_process' && action.pid) {
        if (!options.killProcess) throw new Error(`KILL_PROCESS_DEPENDENCY_MISSING: ${action.pid}`)
        await options.killProcess(action.pid)
      } else if (action.kind === 'kill_tmux_session' && action.tmux_session) {
        if (!options.killTmuxSession) throw new Error(`KILL_TMUX_DEPENDENCY_MISSING: ${action.tmux_session}`)
        await options.killTmuxSession(action.tmux_session)
      }
    }
    await auditCleanupTarget(db, target, report.plan_hash, false)
  }

  await db.execute(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      'runtime.cleanup_execute',
      null,
      report.plan_hash,
      JSON.stringify({
        plan_hash: report.plan_hash,
        executable_actions: report.summary.executable_actions,
        cleanup_targets: report.summary.cleanup_targets,
        unknown_risk_targets: report.summary.unknown_risk_targets,
      }),
      'default',
    ],
  )
  return report
}

export function formatRuntimeCleanupText(report: RuntimeCleanupReport): string {
  const lines = [
    'Runtime Cleanup Plan',
    `Mode: ${report.dry_run ? 'dry-run' : 'execute'}`,
    `Plan hash: ${report.plan_hash}`,
    `Targets: ${report.summary.targets}, cleanup targets: ${report.summary.cleanup_targets}, actions: ${report.summary.executable_actions}, unknown-risk: ${report.summary.unknown_risk_targets}`,
    '',
  ]
  for (const target of report.targets) {
    const actionSummary = target.actions.map((action) => action.kind).join(',') || 'none'
    lines.push(
      `${target.target_id}: class=${target.classification} risk=${target.risk} agent=${target.agent_id ?? '-'} pid=${target.pid ?? '-'} port=${target.port ?? '-'} tmux=${target.tmux_session ?? '-'} actions=${actionSummary}`,
    )
  }
  if (report.blockers.length > 0) {
    lines.push('')
    lines.push(`Blockers: ${report.blockers.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}
