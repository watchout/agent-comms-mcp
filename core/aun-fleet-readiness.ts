import type { DbAdapter } from './db'
import {
  normalizeText,
  parseJsonObject as parseProfileJsonObject,
  profileExclusionReason,
  type ProfileExclusionReason,
} from './profile-classification'
import {
  evaluateFleetCheckoutDrift,
  normalizeApprovedCheckoutRoots,
  type FleetCheckoutDriftReason,
  type FleetCheckoutDriftResult,
} from './fleet-checkout-drift'

export type AunFleetReadinessClass = 'ready' | 'activation_candidate' | 'excluded'

export type AunFleetReadinessOptions = {
  denylist?: string[] | null
  smokeRunId?: string | null
  requireSmoke?: boolean
  operatorAgentId?: string
  activeStatuses?: string[]
  includeDisabledProfiles?: boolean
  includeTestProfiles?: boolean
  approvedCommit?: string | null
  approvedCheckoutRoots?: string[] | null
  driftExclusions?: AunFleetDriftExclusion[] | null
  now?: Date
}

export type AunFleetDriftExclusion = {
  agent_id?: string | null
  target_agent?: string | null
  actor?: string | null
  reason?: string | null
  expires_at?: string | null
  scope?: string | null
}

export type AunFleetApprovedExclusion = {
  agent_id: string
  actor: string
  reason: string
  expires_at: string
  scope: string
}

export type AunFleetSmokeEvidence = {
  run_id: string
  request_queue_id: string | number | null
  request_status: string | null
  request_terminal: boolean
  ack_required: boolean
  ack_queue_status: string | null
  ack_agent_message_seen: boolean
  passed: boolean
}

export type AunFleetAgentReadiness = {
  agent_id: string
  status: string
  runtime: string
  tmux_session: string | null
  channel_count: number
  channels: string[]
  runtime_instance_count: number
  live_runtime_instance_count: number
  active_queue_count: number
  denied: boolean
  profile_excluded_reason: ProfileExclusionReason
  active_status: boolean
  runtime_evidence: boolean
  checkout_drift: {
    ok: boolean
    approved_commit: string | null
    approved_checkout_roots: string[]
    runtime_count: number
    reasons: FleetCheckoutDriftReason[]
    runtimes: FleetCheckoutDriftResult[]
  }
  approved_exclusion: AunFleetApprovedExclusion | null
  smoke: AunFleetSmokeEvidence | null
  readiness: AunFleetReadinessClass
  blockers: string[]
  actions: string[]
}

export type AunFleetReadinessReport = {
  ok: true
  generated_at: string
  policy: {
    db_is_source_of_truth: true
    final_design_guardrail: string
  }
  options: {
    denylist_count: number
    smoke_run_id: string | null
    require_smoke: boolean
    operator_agent_id: string
    active_statuses: string[]
    include_disabled_profiles: boolean
    include_test_profiles: boolean
    approved_commit: string | null
    approved_checkout_roots: string[]
    drift_exclusion_count: number
  }
  summary: {
    agents: number
    ready: number
    activation_candidates: number
    excluded: number
    blockers: number
  }
  agents: AunFleetAgentReadiness[]
  blockers: string[]
}

const DEFAULT_ACTIVE_STATUSES = ['idle', 'busy', 'online']
const TERMINAL_QUEUE_STATUSES = new Set(['done', 'replied', 'skipped'])
const LIVE_RUNTIME_STATUSES = new Set(['active', 'idle', 'online', 'running'])

function normalizeString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value.length > 0 ? value : null
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => normalizeString(item)).filter((item): item is string => item !== null)
  }
  if (typeof raw !== 'string') return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return toStringArray(parsed)
  } catch {}
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function smokeTargetFromContent(content: string, runId: string): string | null {
  const match = content.match(new RegExp(`AUN send/receive smoke ${escapeRegExp(runId)} for ([^.\\n]+)\\.`))
  return match?.[1]?.trim() || null
}

function smokeAckSeen(content: string, agentId: string, runId: string): boolean {
  return content.includes(`ACK-${agentId}-${runId}`)
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function actionForBlocker(blocker: string): string {
  switch (blocker) {
    case 'denied_by_state_daemon':
      return 'remove from STATE_DAEMON_AGENT_DENYLIST in a reviewed PR before activation'
    case 'disabled_profile_excluded':
      return 'pass --include-disabled only for an explicit reviewed disabled-profile audit'
    case 'test_profile_excluded':
      return 'pass --include-test only for an explicit reviewed test-profile audit'
    case 'no_channel_membership':
      return 'add explicit channel membership and routing metadata'
    case 'inactive_status':
      return 'perform operator-approved context-preserving activation'
    case 'no_runtime_evidence':
      return 'add tmux metadata or runtime heartbeat evidence'
    case 'runtime_commit_missing':
      return 'restart under an approved checkout that records commit evidence'
    case 'runtime_commit_mismatch':
      return 'restart under the approved deployed commit before recovery can count this agent'
    case 'runtime_checkout_path_missing':
      return 'record runtime checkout_path heartbeat evidence before recovery can count this agent'
    case 'runtime_checkout_path_unapproved':
      return 'restart under the approved fleet checkout root'
    case 'runtime_dirty_checkout':
      return 'replace dirty runtime checkout with a clean approved checkout or attach a bounded exclusion'
    case 'approved_fleet_exclusion':
      return 'review exclusion actor/reason/expiry before counting this agent outside the required fleet'
    case 'smoke_missing':
      return 'run AUN smoke from the operator identity and record ACK evidence'
    case 'smoke_request_not_terminal':
      return 'ensure receiver closes the request queue after final reply'
    case 'smoke_ack_missing':
      return 'verify ACK projection into codex-aun queue or agent_messages'
    case 'active_queue_not_drained':
      return 'drain the operator queue before counting the operator identity ready'
    default:
      return 'investigate readiness blocker'
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function validDriftExclusion(
  agentId: string,
  exclusions: AunFleetDriftExclusion[],
  now: Date,
): AunFleetApprovedExclusion | null {
  for (const exclusion of exclusions) {
    const target = normalizeString(exclusion.agent_id ?? exclusion.target_agent)
    if (target !== agentId) continue
    const actor = normalizeString(exclusion.actor)
    const reason = normalizeString(exclusion.reason)
    const expiresAt = normalizeString(exclusion.expires_at)
    const scope = normalizeString(exclusion.scope)
    if (!actor || !reason || !expiresAt || !scope) continue
    if (!['fleet_checkout_drift', 'fleet_recovery', 'all'].includes(scope)) continue
    const expiresMs = Date.parse(expiresAt)
    if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) continue
    return { agent_id: agentId, actor, reason, expires_at: new Date(expiresMs).toISOString(), scope }
  }
  return null
}

async function queryRows(db: DbAdapter, sql: string, params?: unknown[]): Promise<any[]> {
  return await db.query(sql, params)
}

export async function buildAunFleetReadinessReport(
  db: DbAdapter,
  options: AunFleetReadinessOptions = {},
): Promise<AunFleetReadinessReport> {
  const denylist = new Set((options.denylist ?? []).map((item) => item.trim()).filter(Boolean))
  const smokeRunId = normalizeString(options.smokeRunId)
  const requireSmoke = options.requireSmoke ?? smokeRunId !== null
  const operatorAgentId = options.operatorAgentId ?? 'codex-aun'
  const activeStatuses = options.activeStatuses ?? DEFAULT_ACTIVE_STATUSES
  const includeDisabledProfiles = options.includeDisabledProfiles ?? false
  const includeTestProfiles = options.includeTestProfiles ?? false
  const activeStatusSet = new Set(activeStatuses)
  const approvedCommit = normalizeString(options.approvedCommit)
  const approvedCheckoutRoots = normalizeApprovedCheckoutRoots(options.approvedCheckoutRoots)
  const driftPolicyActive = approvedCommit !== null || approvedCheckoutRoots.length > 0
  const driftExclusions = options.driftExclusions ?? []
  const now = options.now ?? new Date()

  const agentRows = await queryRows(
    db,
    `SELECT agent_id, agent_type, status, runtime, metadata, profile_enabled, disabled_at
       FROM agents
      ORDER BY agent_id`,
  )
  const channelRows = await queryRows(
    db,
    `SELECT id, name, members
       FROM channels
      ORDER BY name, id`,
  )
  const runtimeRows = await queryRows(
    db,
    `SELECT runtime_instance_id, agent_id, status, stopped_at, checkout_path, commit_sha, last_seen_at, metadata
       FROM agent_runtime_instances
      ORDER BY agent_id, started_at DESC`,
  )
  const activeQueueRows = await queryRows(
    db,
    `SELECT agent_id
       FROM message_queue
      WHERE status IN ('pending','received','in_progress')`,
  )

  const channelsByAgent = new Map<string, string[]>()
  for (const channel of channelRows) {
    const channelLabel = normalizeString(channel.name) ?? String(channel.id)
    for (const member of toStringArray(channel.members)) {
      const channels = channelsByAgent.get(member) ?? []
      channels.push(channelLabel)
      channelsByAgent.set(member, channels)
    }
  }

  const runtimeCountByAgent = new Map<string, number>()
  const liveRuntimeCountByAgent = new Map<string, number>()
  const liveRuntimeRowsByAgent = new Map<string, any[]>()
  for (const runtime of runtimeRows) {
    const agentId = String(runtime.agent_id)
    increment(runtimeCountByAgent, agentId)
    const status = String(runtime.status ?? '')
    if (!runtime.stopped_at && LIVE_RUNTIME_STATUSES.has(status)) {
      increment(liveRuntimeCountByAgent, agentId)
      const rows = liveRuntimeRowsByAgent.get(agentId) ?? []
      rows.push(runtime)
      liveRuntimeRowsByAgent.set(agentId, rows)
    }
  }

  const activeQueueCountByAgent = new Map<string, number>()
  for (const row of activeQueueRows) {
    increment(activeQueueCountByAgent, String(row.agent_id))
  }

  const smokeByAgent = new Map<string, AunFleetSmokeEvidence>()
  if (smokeRunId) {
    const like = `%${smokeRunId}%`
    const queueRows = await queryRows(
      db,
      `SELECT id, agent_id, status, payload, created_at
         FROM message_queue
        WHERE payload LIKE $1
        ORDER BY created_at`,
      [like],
    )
    const messageRows = await queryRows(
      db,
      `SELECT id, author_id, content, created_at
         FROM agent_messages
        WHERE content LIKE $1
        ORDER BY created_at`,
      [like],
    )

    for (const row of queueRows) {
      const payload = parseJsonObject(row.payload)
      const content = String(payload.content ?? '')
      const target = smokeTargetFromContent(content, smokeRunId)
      if (target) {
        const current = smokeByAgent.get(target) ?? {
          run_id: smokeRunId,
          request_queue_id: null,
          request_status: null,
          request_terminal: false,
          ack_required: true,
          ack_queue_status: null,
          ack_agent_message_seen: false,
          passed: false,
        }
        current.request_queue_id = row.id
        current.request_status = String(row.status ?? '')
        current.request_terminal = TERMINAL_QUEUE_STATUSES.has(current.request_status)
        smokeByAgent.set(target, current)
      }

      const authorId = normalizeString(payload.author_id)
      if (String(row.agent_id) === operatorAgentId && authorId && smokeAckSeen(content, authorId, smokeRunId)) {
        const current = smokeByAgent.get(authorId) ?? {
          run_id: smokeRunId,
          request_queue_id: null,
          request_status: null,
          request_terminal: false,
          ack_required: true,
          ack_queue_status: null,
          ack_agent_message_seen: false,
          passed: false,
        }
        current.ack_queue_status = String(row.status ?? '')
        smokeByAgent.set(authorId, current)
      }
    }

    for (const row of messageRows) {
      const authorId = normalizeString(row.author_id)
      const content = String(row.content ?? '')
      if (!authorId || !smokeAckSeen(content, authorId, smokeRunId)) continue
      const current = smokeByAgent.get(authorId) ?? {
        run_id: smokeRunId,
        request_queue_id: null,
        request_status: null,
        request_terminal: false,
        ack_required: true,
        ack_queue_status: null,
        ack_agent_message_seen: false,
        passed: false,
      }
      current.ack_agent_message_seen = true
      smokeByAgent.set(authorId, current)
    }

    for (const row of queueRows) {
      const payload = parseJsonObject(row.payload)
      if (normalizeString(payload.smoke_run_id) !== smokeRunId) continue
      const agentId = String(row.agent_id)
      const current = smokeByAgent.get(agentId) ?? {
        run_id: smokeRunId,
        request_queue_id: null,
        request_status: null,
        request_terminal: false,
        ack_required: false,
        ack_queue_status: null,
        ack_agent_message_seen: false,
        passed: false,
      }
      current.request_queue_id = row.id
      current.request_status = String(row.status ?? '')
      current.request_terminal = TERMINAL_QUEUE_STATUSES.has(current.request_status)
      current.ack_required = false
      smokeByAgent.set(agentId, current)
    }

    for (const [agentId, smoke] of smokeByAgent) {
      const ackTerminal = smoke.ack_queue_status ? TERMINAL_QUEUE_STATUSES.has(smoke.ack_queue_status) : false
      smoke.passed = smoke.request_terminal && (!smoke.ack_required || ackTerminal || smoke.ack_agent_message_seen)
      smokeByAgent.set(agentId, smoke)
    }
  }

  const agents: AunFleetAgentReadiness[] = agentRows.map((row) => {
    const agentId = String(row.agent_id)
    const metadata = parseProfileJsonObject(row.metadata)
    const tmuxSession = normalizeText(metadata.tmux_session)
    const status = String(row.status ?? '')
    const runtime = String(row.runtime ?? '')
    const channels = channelsByAgent.get(agentId) ?? []
    const runtimeInstanceCount = runtimeCountByAgent.get(agentId) ?? 0
    const liveRuntimeInstanceCount = liveRuntimeCountByAgent.get(agentId) ?? 0
    const liveRuntimeRows = liveRuntimeRowsByAgent.get(agentId) ?? []
    const checkoutDriftRuntimes = liveRuntimeRows.map((runtimeRow) => evaluateFleetCheckoutDrift(runtimeRow, {
      approvedCommit,
      approvedCheckoutRoots,
    }))
    const checkoutDriftReasons = unique(checkoutDriftRuntimes.flatMap((drift) => drift.reasons))
    const checkoutDriftOk = (!driftPolicyActive || liveRuntimeRows.length > 0) && checkoutDriftReasons.length === 0
    const activeQueueCount = activeQueueCountByAgent.get(agentId) ?? 0
    const denied = denylist.has(agentId)
    const approvedExclusion = validDriftExclusion(agentId, driftExclusions, now)
    const profileExcludedReason = profileExclusionReason(row, {
      includeDisabledProfiles,
      includeTestProfiles,
    })
    const activeStatus = activeStatusSet.has(status)
    const runtimeEvidence = liveRuntimeInstanceCount > 0 || (!driftPolicyActive && tmuxSession !== null)
    const smoke = smokeByAgent.get(agentId) ?? null
    const blockers: string[] = []

    if (approvedExclusion) {
      blockers.push('approved_fleet_exclusion')
    } else if (denied) {
      blockers.push('denied_by_state_daemon')
    } else if (profileExcludedReason === 'disabled_profile') {
      blockers.push('disabled_profile_excluded')
    } else if (profileExcludedReason === 'test_profile') {
      blockers.push('test_profile_excluded')
    } else {
      if (channels.length === 0) blockers.push('no_channel_membership')
      if (!activeStatus) blockers.push('inactive_status')
      if (!runtimeEvidence) blockers.push('no_runtime_evidence')
      if (runtimeEvidence && !checkoutDriftOk) blockers.push(...checkoutDriftReasons)
    }

    if (!approvedExclusion && !denied && !profileExcludedReason && requireSmoke) {
      if (agentId === operatorAgentId && smoke === null) {
        if (activeQueueCount > 0) blockers.push('active_queue_not_drained')
      } else if (!smoke) {
        blockers.push('smoke_missing')
      } else {
        if (!smoke.request_terminal) blockers.push('smoke_request_not_terminal')
        const ackTerminal = smoke.ack_queue_status ? TERMINAL_QUEUE_STATUSES.has(smoke.ack_queue_status) : false
        if (smoke.ack_required && !ackTerminal && !smoke.ack_agent_message_seen) blockers.push('smoke_ack_missing')
      }
    }

    const readiness: AunFleetReadinessClass = approvedExclusion || denied || profileExcludedReason !== null
      ? 'excluded'
      : blockers.length === 0
        ? 'ready'
        : 'activation_candidate'

    return {
      agent_id: agentId,
      status,
      runtime,
      tmux_session: tmuxSession,
      channel_count: channels.length,
      channels,
      runtime_instance_count: runtimeInstanceCount,
      live_runtime_instance_count: liveRuntimeInstanceCount,
      active_queue_count: activeQueueCount,
      denied,
      profile_excluded_reason: profileExcludedReason,
      active_status: activeStatus,
      runtime_evidence: runtimeEvidence,
      checkout_drift: {
        ok: checkoutDriftOk,
        approved_commit: approvedCommit,
        approved_checkout_roots: approvedCheckoutRoots,
        runtime_count: liveRuntimeRows.length,
        reasons: checkoutDriftReasons,
        runtimes: checkoutDriftRuntimes,
      },
      approved_exclusion: approvedExclusion,
      smoke,
      readiness,
      blockers: unique(blockers),
      actions: unique(blockers.map(actionForBlocker)),
    }
  })

  const blockers = agents.flatMap((agent) => agent.blockers.map((blocker) => `${agent.agent_id}:${blocker}`))

  return {
    ok: true,
    generated_at: now.toISOString(),
    policy: {
      db_is_source_of_truth: true,
      final_design_guardrail: 'read-only readiness report; do not infer readiness from Discord visibility alone',
    },
    options: {
      denylist_count: denylist.size,
      smoke_run_id: smokeRunId,
      require_smoke: requireSmoke,
      operator_agent_id: operatorAgentId,
      active_statuses: activeStatuses,
      include_disabled_profiles: includeDisabledProfiles,
      include_test_profiles: includeTestProfiles,
      approved_commit: approvedCommit,
      approved_checkout_roots: approvedCheckoutRoots,
      drift_exclusion_count: driftExclusions.length,
    },
    summary: {
      agents: agents.length,
      ready: agents.filter((agent) => agent.readiness === 'ready').length,
      activation_candidates: agents.filter((agent) => agent.readiness === 'activation_candidate').length,
      excluded: agents.filter((agent) => agent.readiness === 'excluded').length,
      blockers: blockers.length,
    },
    agents,
    blockers,
  }
}

export function formatAunFleetReadinessText(report: AunFleetReadinessReport): string {
  const lines = [
    'AUN Fleet Readiness',
    `Agents: ${report.summary.agents}, ready: ${report.summary.ready}, activation candidates: ${report.summary.activation_candidates}, excluded: ${report.summary.excluded}`,
    `Smoke: ${report.options.smoke_run_id ?? 'not required'}${report.options.require_smoke ? ' (required)' : ''}`,
    '',
  ]

  for (const klass of ['ready', 'activation_candidate', 'excluded'] as const) {
    const rows = report.agents.filter((agent) => agent.readiness === klass)
    lines.push(`${klass.replace('_', ' ').toUpperCase()} (${rows.length})`)
    if (rows.length === 0) {
      lines.push('  none')
      lines.push('')
      continue
    }
    for (const agent of rows) {
      const smoke = agent.smoke
        ? ` smoke=${agent.smoke.passed ? 'pass' : 'incomplete'}`
        : report.options.require_smoke && agent.agent_id !== report.options.operator_agent_id
          ? ' smoke=missing'
          : ''
      const blockers = agent.blockers.length ? ` blockers=${agent.blockers.join(',')}` : ''
      lines.push(
        `  ${agent.agent_id}: status=${agent.status} channels=${agent.channel_count} runtime=${agent.tmux_session ?? (agent.live_runtime_instance_count > 0 ? 'runtime-instance' : '-')}${smoke}${blockers}`,
      )
    }
    lines.push('')
  }

  if (report.blockers.length > 0) {
    lines.push(`Blockers: ${report.blockers.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}
