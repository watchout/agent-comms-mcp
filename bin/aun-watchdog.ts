#!/usr/bin/env bun
/**
 * AUN runtime-health observer and local alert planner.
 *
 * Monitoring M1 is read-only. It observes DB/runtime evidence, emits JSON
 * reports to stderr, and keeps alert dedupe/rate-limit history in process
 * memory only. The former startup-safety preflight restart path is disabled:
 * this process must not send TUI input, spawn recovery, write the database,
 * enqueue work, notify a provider, or mutate a supervisor.
 *
 * Environment:
 *   AUN_WATCHDOG_POLL_SEC               default 30
 *   AUN_WATCHDOG_CRASH_THRESHOLD_SEC    default 300; evidence freshness limit
 *   DATABASE_URL                        required; observations are SELECT-only
 */

import { Client } from 'pg'
import { spawnSync } from 'node:child_process'
import {
  evaluateRuntimeHealth,
  planRuntimeHealthAlert,
  type RuntimeHealthAlertEmission,
  type RuntimeHealthDimensionInput,
  type RuntimeHealthProbeResult,
  type RuntimeHealthReport,
  type RuntimeHealthState,
} from '../core/runtime-health-monitor'

const DATABASE_URL = process.env.DATABASE_URL
const POLL_SEC = parseInt(process.env.AUN_WATCHDOG_POLL_SEC ?? '30', 10)
const CRASH_THRESHOLD_SEC = parseInt(process.env.AUN_WATCHDOG_CRASH_THRESHOLD_SEC ?? '300', 10)

interface CrashedAgent {
  agentId: string
  lastSeenAt: Date | null
  status: string | null
}

interface WatchdogSession {
  session: string
  projectDir: string
  port: string
  source: 'agents.profile'
}

interface RuntimeProfileIssue {
  agentId: string
  session: string
  reason: 'tmux_session_missing' | 'port_missing_expected_agent'
  detail: string
}

interface RuntimeLivenessChecks {
  hasTmuxSession(sessionName: string): boolean
  portHasExpectedAgent(port: string, agentId: string): boolean
}

interface ReadOnlyQueryClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}

interface RuntimeHealthSnapshot {
  agentId: string
  agentStatus: string | null
  agentLastSeenAt: string | null
  profileSessionName: string
  runtimeSessionName: string
  supervisorType: string
  profilePort: string
  runtimePort: string
  expectedProviderIdentity: string
  runtimeInstanceId: string | null
  runtimeStatus: string | null
  runtimeLastSeenAt: string | null
  runtimeEndpointUri: string | null
  liveRuntimeCount: number
  pendingQueueCount: number
  actionablePendingCount: number
  activeClaimCount: number
  unboundActiveClaimCount: number
  memoryReady: boolean
  discordConnectorCount: number
  discordConnectorStatus: string | null
  discordConnectorLastSeenAt: string | null
}

interface ObservationProbe {
  probe_result: RuntimeHealthProbeResult
  state: RuntimeHealthState
  reason_code: string
  observed_identity?: string | null
}

interface RuntimeObservationProbes {
  supervisorSession(sessionName: string): ObservationProbe
  endpointIdentity(port: string, expectedAgentId: string): ObservationProbe
  uiRunnerSurface(sessionName: string): ObservationProbe
}

const alertHistory: RuntimeHealthAlertEmission[] = []

function logJson(kind: string, value: unknown): void {
  process.stderr.write(`${new Date().toISOString()} | ${kind} | ${JSON.stringify(value)}\n`)
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

function endpointUriPort(endpointUri: string | null): string {
  if (!endpointUri) return ''
  try {
    const parsed = new URL(endpointUri)
    if (parsed.port) return parsed.port
    if (parsed.protocol === 'http:') return '80'
    if (parsed.protocol === 'https:') return '443'
  } catch {
    return ''
  }
  return ''
}

function parseCount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function expectedProviderName(value: string): string | null {
  const normalized = value.trim()
  if (!normalized || normalized === '{}' || normalized === 'null') return null
  try {
    const parsed = JSON.parse(normalized) as unknown
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim().toLowerCase()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const provider = (parsed as Record<string, unknown>).provider
      return typeof provider === 'string' && provider.trim() ? provider.trim().toLowerCase() : null
    }
  } catch {
    return /^[a-z][a-z0-9_-]*$/i.test(normalized) ? normalized.toLowerCase() : null
  }
  return null
}

function oldestRequiredObservation(first: string | null, second: string | null): string | null {
  if (!first || !second) return null
  const firstMs = Date.parse(first)
  const secondMs = Date.parse(second)
  if (!Number.isFinite(firstMs)) return first
  if (!Number.isFinite(secondMs)) return second
  return firstMs <= secondMs ? first : second
}

async function loadDbProfileSessions(client: ReadOnlyQueryClient): Promise<Map<string, WatchdogSession>> {
  const result = await client.query<{
    agent_id: string
    home_directory: string | null
    channel_port: number | string | null
    metadata: unknown
  }>(
    `SELECT agent_id, home_directory, channel_port, metadata
       FROM agents
      WHERE agent_type NOT IN ('human', 'system')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
        AND status IS DISTINCT FROM 'disabled'
      ORDER BY agent_id`,
  )
  const sessions = new Map<string, WatchdogSession>()
  for (const row of result.rows) {
    const metadata = parseMetadata(row.metadata)
    const session = typeof metadata.tmux_session === 'string' ? metadata.tmux_session.trim() : ''
    if (!session) continue
    sessions.set(row.agent_id, {
      session,
      projectDir: row.home_directory ?? '',
      port: row.channel_port === null || row.channel_port === undefined ? '' : String(row.channel_port),
      source: 'agents.profile',
    })
  }
  return sessions
}

async function findCrashedAgents(client: ReadOnlyQueryClient): Promise<CrashedAgent[]> {
  const result = await client.query<{
    agent_id: string
    last_seen_at: Date | null
    status: string | null
  }>(
    `SELECT agent_id, last_seen_at, status
       FROM agents
      WHERE agent_type NOT IN ('human', 'system')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
        AND status IS DISTINCT FROM 'offline'
        AND status IS DISTINCT FROM 'observer'
        AND status IS DISTINCT FROM 'disabled'
        AND (
          last_seen_at IS NULL
          OR last_seen_at < now() - make_interval(secs => $1)
        )`,
    [CRASH_THRESHOLD_SEC],
  )
  return result.rows.map((row) => ({
    agentId: row.agent_id,
    lastSeenAt: row.last_seen_at,
    status: row.status,
  }))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function commandHasAgentId(command: string, agentId: string): boolean {
  const escapedAgentId = escapeRegExp(agentId)
  const assignment = new RegExp(`(?:^|\\s)AGENT_ID=(?:"${escapedAgentId}"|'${escapedAgentId}'|${escapedAgentId})(?=\\s|$)`)
  return assignment.test(command.trim())
}

function observedAgentId(command: string): string | null {
  const match = command.match(/(?:^|\s)AGENT_ID=(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function probeTimedOut(result: ReturnType<typeof spawnSync>): boolean {
  return !!result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT'
}

function hasTmuxSession(sessionName: string): boolean {
  if (!sessionName) return false
  return spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf-8', timeout: 3000 }).status === 0
}

function portHasExpectedAgent(port: string, agentId: string): boolean {
  return endpointIdentityProbe(port, agentId).state === 'HEALTHY'
}

const runtimeLivenessChecks: RuntimeLivenessChecks = {
  hasTmuxSession,
  portHasExpectedAgent,
}

function findRuntimeProfileIssues(
  registry: Map<string, WatchdogSession>,
  checks: RuntimeLivenessChecks = runtimeLivenessChecks,
): RuntimeProfileIssue[] {
  const issues: RuntimeProfileIssue[] = []
  for (const [agentId, profile] of registry) {
    if (!profile.session) continue
    if (!checks.hasTmuxSession(profile.session)) {
      issues.push({
        agentId,
        session: profile.session,
        reason: 'tmux_session_missing',
        detail: `tmux session ${profile.session} is missing`,
      })
      continue
    }
    if (profile.port && !checks.portHasExpectedAgent(profile.port, agentId)) {
      issues.push({
        agentId,
        session: profile.session,
        reason: 'port_missing_expected_agent',
        detail: `port ${profile.port} has no bun server.ts with the expected AGENT_ID`,
      })
    }
  }
  return issues
}

// Compatibility marker for the superseded source-level guard. The executable
// direct-restart implementation is gone; this function is never called and
// always fails closed.
function attemptRestart(): never {
  /* Historical executable removed: spawn('bash', [RESTART_SCRIPT, sessionName]) */
  throw new Error('DIRECT_RESTART_REMOVED')
}

function supervisorSessionProbe(sessionName: string): ObservationProbe {
  const result = spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf-8', timeout: 3000 })
  if (probeTimedOut(result)) return { probe_result: 'timeout', state: 'UNKNOWN', reason_code: 'SUPERVISOR_PROBE_TIMEOUT' }
  if (result.error) return { probe_result: 'exception', state: 'UNKNOWN', reason_code: 'SUPERVISOR_PROBE_EXCEPTION' }
  return result.status === 0
    ? { probe_result: 'ok', state: 'HEALTHY', reason_code: 'SUPERVISOR_SESSION_PRESENT' }
    : { probe_result: 'ok', state: 'DOWN', reason_code: 'SUPERVISOR_SESSION_MISSING' }
}

function endpointIdentityProbe(port: string, expectedAgentId: string): ObservationProbe {
  if (!/^\d+$/.test(port)) {
    return { probe_result: 'ok', state: 'UNKNOWN', reason_code: 'ENDPOINT_PORT_INVALID' }
  }
  const lsofResult = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8', timeout: 3000 })
  if (probeTimedOut(lsofResult)) return { probe_result: 'timeout', state: 'UNKNOWN', reason_code: 'ENDPOINT_PROBE_TIMEOUT' }
  if (lsofResult.error) return { probe_result: 'exception', state: 'UNKNOWN', reason_code: 'ENDPOINT_PROBE_EXCEPTION' }
  const pids = (lsofResult.stdout ?? '').trim().split(/\s+/).filter(Boolean)
  if (lsofResult.status !== 0 || pids.length === 0) {
    return { probe_result: 'ok', state: 'DOWN', reason_code: 'ENDPOINT_PORT_UNBOUND' }
  }

  let mismatchedIdentity: string | null = null
  for (const pid of pids) {
    const psResult = spawnSync('ps', ['eww', '-p', pid, '-o', 'command='], { encoding: 'utf-8', timeout: 3000 })
    if (probeTimedOut(psResult)) return { probe_result: 'timeout', state: 'UNKNOWN', reason_code: 'ENDPOINT_IDENTITY_PROBE_TIMEOUT' }
    if (psResult.error) return { probe_result: 'exception', state: 'UNKNOWN', reason_code: 'ENDPOINT_IDENTITY_PROBE_EXCEPTION' }
    const command = psResult.stdout ?? ''
    if (command.includes('bun') && command.includes('server.ts') && commandHasAgentId(command, expectedAgentId)) {
      return {
        probe_result: 'ok',
        state: 'HEALTHY',
        reason_code: 'ENDPOINT_EXPECTED_IDENTITY_PRESENT',
        observed_identity: expectedAgentId,
      }
    }
    mismatchedIdentity = observedAgentId(command) ?? mismatchedIdentity
  }
  return {
    probe_result: 'ok',
    state: 'DOWN',
    reason_code: mismatchedIdentity ? 'ENDPOINT_IDENTITY_MISMATCH' : 'ENDPOINT_PROCESS_UNEXPECTED',
    observed_identity: mismatchedIdentity,
  }
}

function uiRunnerSurfaceProbe(sessionName: string): ObservationProbe {
  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', sessionName, '-F', '#{pane_dead}\t#{pane_current_command}'],
    { encoding: 'utf-8', timeout: 3000 },
  )
  if (probeTimedOut(result)) return { probe_result: 'timeout', state: 'UNKNOWN', reason_code: 'UI_RUNNER_PROBE_TIMEOUT' }
  if (result.error) return { probe_result: 'exception', state: 'UNKNOWN', reason_code: 'UI_RUNNER_PROBE_EXCEPTION' }
  if (result.status !== 0) return { probe_result: 'ok', state: 'DOWN', reason_code: 'UI_RUNNER_SESSION_MISSING' }

  const panes = (result.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (panes.some((line) => line.startsWith('1\t'))) {
    return { probe_result: 'ok', state: 'DOWN', reason_code: 'UI_RUNNER_PANE_DEAD' }
  }
  const knownSurface = panes.some((line) => /\t(codex|claude|bun|node)(?:\s|$)/i.test(line))
  return knownSurface
    ? { probe_result: 'ok', state: 'HEALTHY', reason_code: 'UI_RUNNER_SURFACE_PRESENT' }
    : { probe_result: 'ok', state: 'UNKNOWN', reason_code: 'UI_RUNNER_SURFACE_UNCONFIRMED' }
}

const runtimeObservationProbes: RuntimeObservationProbes = {
  supervisorSession: supervisorSessionProbe,
  endpointIdentity: endpointIdentityProbe,
  uiRunnerSurface: uiRunnerSurfaceProbe,
}

async function loadRuntimeHealthSnapshots(client: ReadOnlyQueryClient): Promise<RuntimeHealthSnapshot[]> {
  const result = await client.query<{
    agent_id: string
    agent_status: string | null
    agent_last_seen_at: Date | string | null
    metadata: unknown
    channel_port: number | string | null
    expected_provider_identity: string | null
    runtime_instance_id: string | null
    runtime_status: string | null
    runtime_last_seen_at: Date | string | null
    runtime_session_name: string | null
    runtime_port: number | string | null
    endpoint_uri: string | null
    live_runtime_count: number | string
    pending_queue_count: number | string
    actionable_pending_count: number | string
    active_claim_count: number | string
    unbound_active_claim_count: number | string
    memory_ready: boolean
    discord_connector_count: number | string
    discord_connector_status: string | null
    discord_connector_last_seen_at: Date | string | null
  }>(
    `SELECT a.agent_id,
            a.status AS agent_status,
            a.last_seen_at AS agent_last_seen_at,
            a.metadata,
            a.channel_port,
            COALESCE(a.expected_provider_identity::text, '') AS expected_provider_identity,
            runtime.runtime_instance_id::text,
            runtime.status AS runtime_status,
            runtime.last_seen_at AS runtime_last_seen_at,
            runtime.session_name AS runtime_session_name,
            runtime.port AS runtime_port,
            runtime.endpoint_uri,
            COALESCE(runtime_count.live_runtime_count, 0) AS live_runtime_count,
            COALESCE(queue.pending_queue_count, 0) AS pending_queue_count,
            COALESCE(queue.actionable_pending_count, 0) AS actionable_pending_count,
            COALESCE(queue.active_claim_count, 0) AS active_claim_count,
            COALESCE(queue.unbound_active_claim_count, 0) AS unbound_active_claim_count,
            EXISTS (
              SELECT 1
                FROM runtime_memory_ready_evidence ready
               WHERE ready.agent_id = a.agent_id
                 AND ready.runtime_instance_id::text = runtime.runtime_instance_id::text
                 AND ready.result_status = 'ready'
                 AND ready.valid_until > now()
            ) AS memory_ready,
            COALESCE(discord.connector_count, 0) AS discord_connector_count,
            discord.connector_status AS discord_connector_status,
            discord.connector_last_seen_at
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT runtime_instance_id, status, last_seen_at, session_name, port, endpoint_uri
           FROM agent_runtime_instances
          WHERE agent_id = a.agent_id
          ORDER BY started_at DESC
          LIMIT 1
       ) runtime ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS live_runtime_count
           FROM agent_runtime_instances
          WHERE agent_id = a.agent_id
            AND status IN ('running', 'ready')
       ) runtime_count ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE mq.status = 'pending') AS pending_queue_count,
                count(*) FILTER (
                  WHERE mq.status = 'pending'
                    AND COALESCE(NULLIF(mq.payload::jsonb->>'message_type', ''), am.message_type, 'unknown')
                        IN ('instruction', 'request', 'question')
                ) AS actionable_pending_count,
                count(*) FILTER (
                  WHERE mq.status IN ('received', 'in_progress')
                    AND mq.claimed_by = a.agent_id
                    AND mq.claimed_runtime_instance_id::text = runtime.runtime_instance_id::text
                    AND (mq.claim_expires_at IS NULL OR mq.claim_expires_at > now())
                ) AS active_claim_count,
                count(*) FILTER (
                  WHERE mq.status IN ('received', 'in_progress')
                    AND mq.claimed_by = a.agent_id
                    AND mq.claimed_runtime_instance_id::text IS DISTINCT FROM runtime.runtime_instance_id::text
                    AND (mq.claim_expires_at IS NULL OR mq.claim_expires_at > now())
                ) AS unbound_active_claim_count
           FROM message_queue mq
           LEFT JOIN agent_messages am ON am.id::text = mq.message_id
          WHERE mq.agent_id = a.agent_id
       ) queue ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS connector_count,
                (array_agg(status ORDER BY last_seen_at DESC NULLS LAST))[1] AS connector_status,
                max(last_seen_at) AS connector_last_seen_at
           FROM connector_instances
          WHERE agent_id = a.agent_id
            AND provider = 'discord'
            AND disabled_at IS NULL
       ) discord ON true
      WHERE a.agent_type NOT IN ('human', 'system')
        AND COALESCE(a.profile_enabled, true) = true
        AND a.disabled_at IS NULL
        AND a.status IS DISTINCT FROM 'disabled'
      ORDER BY a.agent_id`,
  )

  return result.rows.map((row) => {
    const metadata = parseMetadata(row.metadata)
    return {
      agentId: row.agent_id,
      agentStatus: row.agent_status,
      agentLastSeenAt: toIso(row.agent_last_seen_at),
      profileSessionName: typeof metadata.tmux_session === 'string' ? metadata.tmux_session.trim() : '',
      runtimeSessionName: row.runtime_session_name?.trim() ?? '',
      supervisorType: typeof metadata.supervisor_type === 'string' ? metadata.supervisor_type.trim().toLowerCase() : '',
      profilePort: row.channel_port === null || row.channel_port === undefined ? '' : String(row.channel_port),
      runtimePort: row.runtime_port === null || row.runtime_port === undefined ? '' : String(row.runtime_port),
      expectedProviderIdentity: row.expected_provider_identity ?? '',
      runtimeInstanceId: row.runtime_instance_id,
      runtimeStatus: row.runtime_status,
      runtimeLastSeenAt: toIso(row.runtime_last_seen_at),
      runtimeEndpointUri: row.endpoint_uri,
      liveRuntimeCount: parseCount(row.live_runtime_count),
      pendingQueueCount: parseCount(row.pending_queue_count),
      actionablePendingCount: parseCount(row.actionable_pending_count),
      activeClaimCount: parseCount(row.active_claim_count),
      unboundActiveClaimCount: parseCount(row.unbound_active_claim_count),
      memoryReady: Boolean(row.memory_ready),
      discordConnectorCount: parseCount(row.discord_connector_count),
      discordConnectorStatus: row.discord_connector_status,
      discordConnectorLastSeenAt: toIso(row.discord_connector_last_seen_at),
    }
  })
}

function dimension(
  name: RuntimeHealthDimensionInput['dimension'],
  state: RuntimeHealthState,
  reasonCode: string,
  observedAt: string | null,
  evidenceRefs: string[],
  extra: Partial<RuntimeHealthDimensionInput> = {},
): RuntimeHealthDimensionInput {
  return {
    dimension: name,
    applicability: 'APPLICABLE',
    declared_state: state,
    reason_code: reasonCode,
    observed_at: observedAt,
    freshness_limit_seconds: CRASH_THRESHOLD_SEC,
    evidence_refs: evidenceRefs,
    ...extra,
  }
}

function buildRuntimeHealthDimensionInputs(
  snapshot: RuntimeHealthSnapshot,
  probes: RuntimeObservationProbes = runtimeObservationProbes,
  nowMs = Date.now(),
): RuntimeHealthDimensionInput[] {
  const observedNow = new Date(nowMs).toISOString()
  const runtimeObservedAt = oldestRequiredObservation(snapshot.agentLastSeenAt, snapshot.runtimeLastSeenAt)
  const runtimeState: RuntimeHealthState = !snapshot.runtimeInstanceId
    ? 'UNKNOWN'
    : snapshot.liveRuntimeCount > 1
      ? 'DEGRADED'
      : snapshot.agentStatus === 'offline' || snapshot.agentStatus === 'disconnected'
        ? 'DOWN'
        : snapshot.runtimeStatus === 'running' || snapshot.runtimeStatus === 'ready'
          ? 'HEALTHY'
          : snapshot.runtimeStatus === 'failed' || snapshot.runtimeStatus === 'stopped'
            ? 'DOWN'
            : 'UNKNOWN'
  const runtimeReason = !snapshot.runtimeInstanceId
    ? 'RUNTIME_INSTANCE_MISSING'
    : snapshot.liveRuntimeCount > 1
      ? 'MULTIPLE_LIVE_RUNTIME_INSTANCES'
      : snapshot.agentStatus === 'offline' || snapshot.agentStatus === 'disconnected'
        ? `AGENT_STATE_${snapshot.agentStatus.toUpperCase()}`
        : runtimeState === 'HEALTHY'
          ? 'AGENT_HEARTBEAT_AND_RUNTIME_FRESH'
          : `RUNTIME_STATE_${(snapshot.runtimeStatus ?? 'UNKNOWN').toUpperCase()}`

  const sessionProfileMismatch = Boolean(
    snapshot.runtimeInstanceId
    && snapshot.profileSessionName
    && snapshot.runtimeSessionName
    && snapshot.profileSessionName !== snapshot.runtimeSessionName,
  )

  let supervisor = dimension(
    'supervisor_session',
    'UNKNOWN',
    snapshot.runtimeInstanceId ? 'RUNTIME_SESSION_BINDING_MISSING' : 'RUNTIME_INSTANCE_MISSING',
    observedNow,
    [`db:agent_runtime_instances:${snapshot.runtimeInstanceId ?? 'none'}:session_name`],
  )
  if (sessionProfileMismatch) {
    supervisor = dimension(
      'supervisor_session',
      'UNKNOWN',
      'RUNTIME_PROFILE_SESSION_MISMATCH',
      observedNow,
      [
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:session_name=${snapshot.runtimeSessionName}`,
        `db:agents:${snapshot.agentId}:tmux_session=${snapshot.profileSessionName}`,
      ],
    )
  } else if (snapshot.runtimeInstanceId && snapshot.runtimeSessionName) {
    const probe = probes.supervisorSession(snapshot.runtimeSessionName)
    supervisor = dimension(
      'supervisor_session',
      probe.state,
      probe.reason_code,
      observedNow,
      [`probe:tmux:${snapshot.runtimeSessionName}`, `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:session_name`],
      { probe_result: probe.probe_result },
    )
  } else if (snapshot.runtimeInstanceId && snapshot.supervisorType === 'none' && !snapshot.profileSessionName) {
    supervisor = dimension(
      'supervisor_session',
      'HEALTHY',
      'NOT_APPLICABLE_CONFIRMED',
      observedNow,
      [
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:session_name=none`,
        `db:agents:${snapshot.agentId}:supervisor_type=none`,
      ],
      {
        applicability: 'NOT_APPLICABLE',
        applicability_evidence_refs: [
          `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:session_name=none`,
          `db:agents:${snapshot.agentId}:supervisor_type=none`,
        ],
      },
    )
  }

  const uriPort = endpointUriPort(snapshot.runtimeEndpointUri)
  const selectedRuntimePort = snapshot.runtimePort || uriPort
  const runtimeEndpointMismatch = Boolean(snapshot.runtimePort && uriPort && snapshot.runtimePort !== uriPort)
  const profileRuntimePortMismatch = Boolean(
    snapshot.profilePort
    && selectedRuntimePort
    && snapshot.profilePort !== selectedRuntimePort,
  )

  let endpoint = dimension(
    'endpoint_identity',
    'UNKNOWN',
    snapshot.runtimeInstanceId ? 'RUNTIME_ENDPOINT_BINDING_MISSING' : 'RUNTIME_INSTANCE_MISSING',
    observedNow,
    [`db:agent_runtime_instances:${snapshot.runtimeInstanceId ?? 'none'}:endpoint`],
  )
  if (snapshot.runtimeInstanceId && runtimeEndpointMismatch) {
    endpoint = dimension(
      'endpoint_identity',
      'UNKNOWN',
      'RUNTIME_PORT_ENDPOINT_URI_MISMATCH',
      observedNow,
      [
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:port=${snapshot.runtimePort}`,
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:endpoint_uri=${snapshot.runtimeEndpointUri}`,
      ],
    )
  } else if (snapshot.runtimeInstanceId && profileRuntimePortMismatch) {
    endpoint = dimension(
      'endpoint_identity',
      'UNKNOWN',
      'RUNTIME_PROFILE_PORT_MISMATCH',
      observedNow,
      [
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:port=${selectedRuntimePort}`,
        `db:agents:${snapshot.agentId}:channel_port=${snapshot.profilePort}`,
      ],
    )
  } else if (snapshot.runtimeInstanceId && selectedRuntimePort) {
    const probe = probes.endpointIdentity(selectedRuntimePort, snapshot.agentId)
    endpoint = dimension(
      'endpoint_identity',
      probe.state,
      probe.reason_code,
      observedNow,
      [
        `probe:tcp:${selectedRuntimePort}`,
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:port=${selectedRuntimePort}`,
      ],
      {
        probe_result: probe.probe_result,
        expected_identity: snapshot.agentId,
        observed_identity: probe.observed_identity ?? null,
      },
    )
  }

  const queueState: RuntimeHealthState = snapshot.pendingQueueCount === 0
    ? 'HEALTHY'
    : snapshot.actionablePendingCount === 0
      ? 'DEGRADED'
      : snapshot.memoryReady
        ? 'HEALTHY'
        : 'DEGRADED'
  const queueReason = snapshot.pendingQueueCount === 0
    ? 'QUEUE_EMPTY_OBSERVED'
    : snapshot.actionablePendingCount === 0
      ? 'QUEUE_PLACED_NON_ACTIONABLE'
      : snapshot.memoryReady
        ? 'QUEUE_PLACED_AND_RECEIVE_ACTIONABLE'
        : 'QUEUE_PLACED_NOT_ACTIONABLE'
  const queueEvidence = [
    `db:message_queue:${snapshot.agentId}:pending=${snapshot.pendingQueueCount}`,
    `db:message_queue:${snapshot.agentId}:actionable_pending=${snapshot.actionablePendingCount}`,
    `db:runtime_memory_ready_evidence:${snapshot.runtimeInstanceId ?? 'none'}:${snapshot.memoryReady ? 'ready' : 'not_ready'}`,
  ]

  const presentation = snapshot.actionablePendingCount === 0
    ? dimension(
      'runtime_presentation_claim',
      'HEALTHY',
      'NOT_APPLICABLE_CONFIRMED',
      observedNow,
      [`db:message_queue:${snapshot.agentId}:actionable_pending=0`],
      {
        applicability: 'NOT_APPLICABLE',
        applicability_evidence_refs: [`db:message_queue:${snapshot.agentId}:actionable_pending=0`],
      },
    )
    : snapshot.runtimeInstanceId && snapshot.activeClaimCount > 0
      ? dimension(
        'runtime_presentation_claim',
        'HEALTHY',
        'RUNTIME_CLAIM_PRESENT',
        observedNow,
        [`db:message_queue:${snapshot.agentId}:runtime=${snapshot.runtimeInstanceId}:active_claims=${snapshot.activeClaimCount}`],
      )
      : dimension(
        'runtime_presentation_claim',
        'UNKNOWN',
        snapshot.unboundActiveClaimCount > 0
          ? 'CLAIM_RUNTIME_OWNERSHIP_UNPROVEN'
          : 'QUEUE_NOT_PRESENTED_OR_CLAIMED',
        observedNow,
        [
          `db:message_queue:${snapshot.agentId}:runtime=${snapshot.runtimeInstanceId ?? 'none'}:active_claims=0`,
          `db:message_queue:${snapshot.agentId}:unbound_active_claims=${snapshot.unboundActiveClaimCount}`,
        ],
      )

  let ui = dimension(
    'ui_runner_reachability',
    'UNKNOWN',
    'UI_RUNNER_EVIDENCE_MISSING',
    observedNow,
    [],
  )
  if (sessionProfileMismatch) {
    ui = dimension(
      'ui_runner_reachability',
      'UNKNOWN',
      'RUNTIME_PROFILE_SESSION_MISMATCH',
      observedNow,
      [
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:session_name=${snapshot.runtimeSessionName}`,
        `db:agents:${snapshot.agentId}:tmux_session=${snapshot.profileSessionName}`,
      ],
    )
  } else if (snapshot.runtimeInstanceId && snapshot.runtimeSessionName) {
    const probe = probes.uiRunnerSurface(snapshot.runtimeSessionName)
    ui = dimension(
      'ui_runner_reachability',
      probe.state,
      probe.reason_code,
      observedNow,
      [`probe:ui-runner:${snapshot.runtimeSessionName}`, `db:agent_runtime_instances:${snapshot.runtimeInstanceId}:session_name`],
      { probe_result: probe.probe_result },
    )
  }

  const expectedProvider = expectedProviderName(snapshot.expectedProviderIdentity)
  const expectsDiscord = snapshot.discordConnectorCount > 0 || expectedProvider === 'discord'
  const positiveNonDiscord = expectedProvider !== null && expectedProvider !== 'discord'
  let provider = dimension(
    'provider_projection',
    'UNKNOWN',
    'PROVIDER_APPLICABILITY_UNKNOWN',
    observedNow,
    [],
    { applicability: 'UNKNOWN' },
  )
  if (expectsDiscord) {
    const active = ['active', 'connected', 'running', 'ready'].includes((snapshot.discordConnectorStatus ?? '').toLowerCase())
    provider = dimension(
      'provider_projection',
      active ? 'HEALTHY' : snapshot.discordConnectorStatus ? 'DOWN' : 'UNKNOWN',
      active ? 'DISCORD_PROJECTION_FRESH' : snapshot.discordConnectorStatus ? 'DISCORD_PROJECTION_UNAVAILABLE' : 'DISCORD_PROJECTION_EVIDENCE_MISSING',
      snapshot.discordConnectorLastSeenAt,
      [`db:connector_instances:${snapshot.agentId}:discord`],
    )
  } else if (positiveNonDiscord) {
    provider = dimension(
      'provider_projection',
      'HEALTHY',
      'NOT_APPLICABLE_CONFIRMED',
      observedNow,
      [`db:agents:${snapshot.agentId}:expected_provider_identity`],
      {
        applicability: 'NOT_APPLICABLE',
        applicability_evidence_refs: [`db:agents:${snapshot.agentId}:expected_provider_identity`],
      },
    )
  }

  return [
    dimension(
      'agent_runtime',
      runtimeState,
      runtimeReason,
      runtimeObservedAt,
      [
        `db:agents:${snapshot.agentId}:last_seen_at`,
        `db:agent_runtime_instances:${snapshot.runtimeInstanceId ?? 'none'}:last_seen_at`,
        `db:agent_runtime_instances:${snapshot.agentId}:live_count=${snapshot.liveRuntimeCount}`,
      ],
    ),
    supervisor,
    endpoint,
    dimension(
      'queue_actionable_receive',
      queueState,
      queueReason,
      observedNow,
      queueEvidence,
    ),
    presentation,
    ui,
    provider,
  ]
}

async function collectRuntimeHealthReports(
  client: ReadOnlyQueryClient,
  probes: RuntimeObservationProbes = runtimeObservationProbes,
  nowMs = Date.now(),
): Promise<RuntimeHealthReport[]> {
  const snapshots = await loadRuntimeHealthSnapshots(client)
  return snapshots.map((snapshot) => evaluateRuntimeHealth({
    agent_id: snapshot.agentId,
    runtime_instance_id: snapshot.runtimeInstanceId,
    dimensions: buildRuntimeHealthDimensionInputs(snapshot, probes, nowMs),
  }, nowMs, CRASH_THRESHOLD_SEC))
}

async function tickOnce(
  client: ReadOnlyQueryClient,
  probes: RuntimeObservationProbes = runtimeObservationProbes,
  nowMs = Date.now(),
): Promise<RuntimeHealthReport[]> {
  const reports = await collectRuntimeHealthReports(client, probes, nowMs)
  for (const report of reports) {
    logJson('runtime-health', report)
    const plan = planRuntimeHealthAlert(report, alertHistory, nowMs)
    logJson('runtime-health-alert-plan', plan)
    if (plan.action === 'EMIT') {
      alertHistory.push({
        agent_id: plan.agent_id,
        dedupe_key: plan.dedupe_key,
        emitted_at: plan.observed_at,
      })
    }
  }
  return reports
}

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    logJson('fatal', { reason_code: 'DATABASE_URL_REQUIRED' })
    process.exit(1)
  }
  logJson('startup', {
    mode: 'observe_alert_only',
    poll_seconds: POLL_SEC,
    freshness_limit_seconds: CRASH_THRESHOLD_SEC,
    direct_restart_enabled: false,
    mutation_performed: false,
  })
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()

  let stopping = false
  const stop = () => {
    stopping = true
    client.end().catch(() => {})
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  while (!stopping) {
    try {
      await tickOnce(client)
    } catch (error) {
      logJson('tick-error', { reason_code: 'OBSERVATION_EXCEPTION', message: String(error) })
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, POLL_SEC * 1000))
  }
}

export {
  alertHistory,
  buildRuntimeHealthDimensionInputs,
  collectRuntimeHealthReports,
  commandHasAgentId,
  findCrashedAgents,
  findRuntimeProfileIssues,
  loadDbProfileSessions,
  loadRuntimeHealthSnapshots,
  tickOnce,
}

export type {
  ObservationProbe,
  ReadOnlyQueryClient,
  RuntimeHealthSnapshot,
  RuntimeObservationProbes,
}

if (import.meta.main) {
  main().catch((error) => {
    logJson('fatal', { reason_code: 'WATCHDOG_FATAL', message: String(error) })
    process.exit(1)
  })
}
