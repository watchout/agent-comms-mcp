import { resolve } from 'node:path'
import {
  RUNTIME_PROVIDER_OBSERVATION_SCHEMA,
  runtimeProviderObservationDigest,
  type RuntimeProviderEngine,
  type RuntimeProviderObservation,
  type RuntimeSurface,
} from './runtime-heartbeat'

export const CURRENT_PROVIDER_LIVENESS_TTL_MS = 30 * 60_000

export const CURRENT_PROVIDER_RESOLUTION_CODES = [
  'RESOLVED',
  'NO_LIVE_PROVIDER',
  'AMBIGUOUS_PROVIDERS',
  'STALE_HEARTBEAT',
  'PROVIDER_UNKNOWN_GENERIC_TUI',
  'ADAPTER_MISSING',
  'WORKSPACE_MISMATCH',
  'SESSION_MISMATCH',
  'HOST_PROCESS_MISMATCH',
  'AGENT_MISSING',
] as const

export type CurrentProviderResolutionCode = typeof CURRENT_PROVIDER_RESOLUTION_CODES[number]

export type CurrentProviderResolutionTuple = {
  agent_id: string
  runtime_instance_id: string | null
  provider_engine: RuntimeProviderEngine | null
  runtime_surface: RuntimeSurface | null
  session: string | null
  workspace: string | null
  observed_at: string | null
  evidence_digest: string | null
  code: CurrentProviderResolutionCode
}

export type CurrentProviderCandidateExclusion = {
  runtime_instance_id: string
  code: Exclude<CurrentProviderResolutionCode, 'RESOLVED' | 'ADAPTER_MISSING' | 'AGENT_MISSING'>
}

export type CurrentProviderResolution = CurrentProviderResolutionTuple & {
  ok: boolean
  checked_at: string
  candidate_count: number
  excluded_candidates: CurrentProviderCandidateExclusion[]
}

export type CurrentProviderResolverDb = {
  query<T = any>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount?: number | null } | T[]>
}

type AgentRow = {
  agent_id: unknown
  home_directory: unknown
  metadata: unknown
}

type RuntimeRow = {
  runtime_instance_id: unknown
  agent_id: unknown
  runtime_engine: unknown
  runtime_kind: unknown
  session_name: unknown
  checkout_path: unknown
  status: unknown
  stopped_at: unknown
  last_seen_at: unknown
  metadata: unknown
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  const valueText = text(value)
  if (!valueText) return null
  const ms = Date.parse(valueText)
  return Number.isFinite(ms) ? ms : null
}

function workspace(value: unknown): string | null {
  const valueText = text(value)
  return valueText ? resolve(valueText) : null
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return text(value) ?? undefined
}

function nullableWorkspace(value: unknown): string | null | undefined {
  const valueText = nullableText(value)
  if (valueText === null || valueText === undefined) return valueText
  return workspace(valueText) ?? undefined
}

function isProviderEngine(value: unknown): value is RuntimeProviderEngine {
  return value === 'claude-code' || value === 'codex'
}

function isRuntimeSurface(value: unknown): value is RuntimeSurface {
  return value === 'tui_session' || value === 'headless_runner' || value === 'service_daemon'
}

export function parseRuntimeProviderObservation(
  value: unknown,
  expected?: { agentId: string; runtimeInstanceId: string },
): RuntimeProviderObservation | null {
  const record = metadataObject(value)
  if (record.schema_version !== RUNTIME_PROVIDER_OBSERVATION_SCHEMA) return null
  const agentId = text(record.agent_id)
  const runtimeInstanceId = text(record.runtime_instance_id)
  const providerEngine = record.provider_engine === null
    ? null
    : isProviderEngine(record.provider_engine)
      ? record.provider_engine
      : undefined
  const runtimeSurface = isRuntimeSurface(record.runtime_surface) ? record.runtime_surface : null
  const hostProcessId = typeof record.host_process_id === 'number'
    && Number.isSafeInteger(record.host_process_id)
    && record.host_process_id > 0
    ? record.host_process_id
    : record.host_process_id === null
      ? null
      : undefined
  const hostProcessImage = nullableText(record.host_process_image)
  const observedSession = nullableText(record.observed_session)
  const observedWorkspace = nullableWorkspace(record.observed_workspace)
  const observedAt = text(record.observed_at)
  const provenance = record.provenance === 'observed' || record.provenance === 'missing'
    ? record.provenance
    : null
  const evidenceDigest = text(record.evidence_digest)
  if (!agentId || !runtimeInstanceId || providerEngine === undefined || !runtimeSurface
    || hostProcessId === undefined || hostProcessImage === undefined
    || observedSession === undefined || observedWorkspace === undefined
    || !observedAt || timestampMs(observedAt) === null || !provenance
    || !evidenceDigest || !/^[0-9a-f]{64}$/.test(evidenceDigest)) {
    return null
  }
  if (expected && (agentId !== expected.agentId || runtimeInstanceId !== expected.runtimeInstanceId)) return null
  if (providerEngine === null && provenance !== 'missing') return null
  if (providerEngine !== null && provenance !== 'observed') return null
  const unsigned: Omit<RuntimeProviderObservation, 'evidence_digest'> = {
    schema_version: RUNTIME_PROVIDER_OBSERVATION_SCHEMA,
    agent_id: agentId,
    runtime_instance_id: runtimeInstanceId,
    provider_engine: providerEngine,
    runtime_surface: runtimeSurface,
    host_process_id: hostProcessId,
    host_process_image: hostProcessImage,
    observed_session: observedSession,
    observed_workspace: observedWorkspace,
    observed_at: new Date(observedAt).toISOString(),
    provenance,
  }
  if (runtimeProviderObservationDigest(unsigned) !== evidenceDigest) return null
  return { ...unsigned, evidence_digest: evidenceDigest }
}

async function rows<T>(db: CurrentProviderResolverDb, sql: string, params?: any[]): Promise<T[]> {
  const result = await db.query<T>(sql, params)
  return Array.isArray(result) ? result : result.rows
}

function failure(
  agentId: string,
  checkedAt: string,
  code: Exclude<CurrentProviderResolutionCode, 'RESOLVED'>,
  excludedCandidates: CurrentProviderCandidateExclusion[],
  candidateCount = 0,
): CurrentProviderResolution {
  return {
    ok: false,
    agent_id: agentId,
    runtime_instance_id: null,
    provider_engine: null,
    runtime_surface: null,
    session: null,
    workspace: null,
    observed_at: null,
    evidence_digest: null,
    code,
    checked_at: checkedAt,
    candidate_count: candidateCount,
    excluded_candidates: excludedCandidates,
  }
}

function runtimeId(row: RuntimeRow): string {
  return text(row.runtime_instance_id) ?? ''
}

function exclusion(
  row: RuntimeRow,
  code: CurrentProviderCandidateExclusion['code'],
): CurrentProviderCandidateExclusion {
  return { runtime_instance_id: runtimeId(row), code }
}

/**
 * Resolve a seat's current provider solely from fresh heartbeat observations.
 * This function is intentionally read-only and deterministic for a fixed DB
 * snapshot and `now`; stored provider preferences are not an input.
 */
export async function resolveCurrentProvider(
  db: CurrentProviderResolverDb,
  agentId: string,
  now: Date,
): Promise<CurrentProviderResolution> {
  const checkedAtMs = now.getTime()
  if (!Number.isFinite(checkedAtMs)) throw new Error('CURRENT_PROVIDER_NOW_INVALID')
  const checkedAt = now.toISOString()
  const agentRows = await rows<AgentRow>(
    db,
    `SELECT agent_id, home_directory, metadata
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  )
  const agent = agentRows[0]
  if (!agent) return failure(agentId, checkedAt, 'AGENT_MISSING', [])

  const agentMetadata = metadataObject(agent.metadata)
  const seatSession = text(agentMetadata.tmux_session)
  const seatWorkspace = workspace(agent.home_directory)
  const runtimeRows = await rows<RuntimeRow>(
    db,
    `SELECT CAST(runtime_instance_id AS TEXT) AS runtime_instance_id, agent_id,
            runtime_engine, runtime_kind, session_name, checkout_path, status,
            stopped_at, last_seen_at, metadata
       FROM agent_runtime_instances
      WHERE agent_id = $1
        AND status IN ('running', 'active')
        AND stopped_at IS NULL
      ORDER BY last_seen_at DESC, runtime_instance_id ASC`,
    [agentId],
  )
  if (runtimeRows.length === 0) return failure(agentId, checkedAt, 'NO_LIVE_PROVIDER', [])

  const exclusions: CurrentProviderCandidateExclusion[] = []
  const freshRows: RuntimeRow[] = []
  for (const row of runtimeRows) {
    const seenAtMs = timestampMs(row.last_seen_at)
    if (seenAtMs === null || Math.max(0, checkedAtMs - seenAtMs) > CURRENT_PROVIDER_LIVENESS_TTL_MS) {
      exclusions.push(exclusion(row, 'STALE_HEARTBEAT'))
      continue
    }
    freshRows.push(row)
  }
  if (freshRows.length === 0) return failure(agentId, checkedAt, 'STALE_HEARTBEAT', exclusions)

  const candidates: Array<{ row: RuntimeRow; observation: RuntimeProviderObservation }> = []
  for (const row of freshRows) {
    const id = runtimeId(row)
    const metadata = metadataObject(row.metadata)
    const observation = parseRuntimeProviderObservation(metadata.provider_observation, {
      agentId,
      runtimeInstanceId: id,
    })
    if (!observation || observation.provider_engine === null || observation.provenance !== 'observed') {
      const genericRuntime = text(row.runtime_engine)?.toLowerCase()
      exclusions.push(exclusion(
        row,
        genericRuntime === 'tui' || genericRuntime === null
          ? 'PROVIDER_UNKNOWN_GENERIC_TUI'
          : 'NO_LIVE_PROVIDER',
      ))
      continue
    }
    if (observation.host_process_id === null || observation.host_process_image === null) {
      exclusions.push(exclusion(row, 'HOST_PROCESS_MISMATCH'))
      continue
    }
    const observationAgeMs = Math.max(0, checkedAtMs - Date.parse(observation.observed_at))
    if (observationAgeMs > CURRENT_PROVIDER_LIVENESS_TTL_MS) {
      exclusions.push(exclusion(row, 'STALE_HEARTBEAT'))
      continue
    }
    const registeredRuntimeSession = text(row.session_name)
    if (!observation.observed_session || observation.observed_session !== registeredRuntimeSession) {
      exclusions.push(exclusion(row, 'HOST_PROCESS_MISMATCH'))
      continue
    }
    if (!seatSession || observation.observed_session !== seatSession) {
      exclusions.push(exclusion(row, 'HOST_PROCESS_MISMATCH'))
      continue
    }
    if (!seatWorkspace || observation.observed_workspace !== seatWorkspace) {
      exclusions.push(exclusion(row, 'WORKSPACE_MISMATCH'))
      continue
    }
    candidates.push({ row, observation })
  }

  exclusions.sort((left, right) => left.runtime_instance_id.localeCompare(right.runtime_instance_id)
    || left.code.localeCompare(right.code))
  if (candidates.length === 0) {
    const codes = new Set(exclusions.map(item => item.code))
    const code: Exclude<CurrentProviderResolutionCode, 'RESOLVED'> = codes.has('HOST_PROCESS_MISMATCH')
      ? 'HOST_PROCESS_MISMATCH'
      : codes.has('SESSION_MISMATCH')
        ? 'SESSION_MISMATCH'
        : codes.has('WORKSPACE_MISMATCH')
          ? 'WORKSPACE_MISMATCH'
          : codes.has('PROVIDER_UNKNOWN_GENERIC_TUI')
            ? 'PROVIDER_UNKNOWN_GENERIC_TUI'
            : codes.has('STALE_HEARTBEAT')
              ? 'STALE_HEARTBEAT'
              : 'NO_LIVE_PROVIDER'
    return failure(agentId, checkedAt, code, exclusions)
  }
  if (candidates.length > 1) {
    return failure(agentId, checkedAt, 'AMBIGUOUS_PROVIDERS', exclusions, candidates.length)
  }

  const selected = candidates[0]
  const observation = selected.observation
  return {
    ok: true,
    agent_id: agentId,
    runtime_instance_id: runtimeId(selected.row),
    provider_engine: observation.provider_engine,
    runtime_surface: observation.runtime_surface,
    session: observation.observed_session,
    workspace: observation.observed_workspace,
    observed_at: observation.observed_at,
    evidence_digest: observation.evidence_digest,
    code: 'RESOLVED',
    checked_at: checkedAt,
    candidate_count: 1,
    excluded_candidates: exclusions,
  }
}
