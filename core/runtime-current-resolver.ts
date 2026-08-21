import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const RUNTIME_MEMORY_READY_POLICY_SCHEMA = 'runtime-memory-ready-policy/v1' as const
export const DEFAULT_RUNTIME_MEMORY_READY_POLICY_PATH = join(
  import.meta.dir,
  '..',
  'config',
  'runtime-memory-ready-policy.json',
)

export type RuntimeCurrentResolverDb = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null } | T[]>
}

export type RuntimeMemoryReadyPolicyGroup = {
  runtime_kind: string
  source: string
  heartbeat_interval_ms: number
}

export type RuntimeMemoryReadyPolicy = {
  schema_version: typeof RUNTIME_MEMORY_READY_POLICY_SCHEMA
  default_liveness_ttl_ms: number
  default_reap_ttl_ms: number
  backoff: {
    base_ms: number
    cap_ms: number
  }
  groups: RuntimeMemoryReadyPolicyGroup[]
  readback: {
    path: string
    sha256: string
  }
}

export type RuntimeCurrentProfile = {
  agent_id: string
  runtime_kind: string | null
  session_name: string | null
  home_directory: string | null
  channel_port: number | null
  profile_revision: number | null
  profile_source: string | null
  metadata: Record<string, unknown>
}

export type RuntimeCurrentInstance = {
  runtime_instance_id: string
  agent_id: string
  runtime_engine: string | null
  runtime_kind: string | null
  source: string
  session_name: string | null
  port: number | null
  checkout_path: string | null
  commit_sha: string | null
  started_at: string | Date | null
  last_seen_at: string | Date | null
  status: string | null
  metadata: Record<string, unknown>
  liveness_ttl_ms: number
  reap_ttl_ms: number
  heartbeat_age_ms: number | null
  profile_match: boolean
  live: boolean
}

export type RuntimeStaleReapCandidate = {
  runtime_instance_id: string
  agent_id: string
  runtime_kind: string
  source: string
  observed_status: string
  observed_last_seen_at: string | Date
  reason: 'absolute' | 'superseded'
  heartbeat_age_ms: number
  liveness_ttl_ms: number
  reap_ttl_ms: number
}

export type RuntimeCurrentResolution = {
  ok: boolean
  code:
    | 'RESOLVED'
    | 'AGENT_MISSING'
    | 'PROFILE_TUPLE_INCOMPLETE'
    | 'NO_CURRENT_RUNTIME_FOR_PROFILE'
    | 'NO_BOOTSTRAP_BOUND_ROW'
  agent_id: string
  requested_runtime_kind: string
  checked_at: string
  profile: RuntimeCurrentProfile | null
  current_runtime: RuntimeCurrentInstance | null
  runtime_rows: RuntimeCurrentInstance[]
  reap_candidates: RuntimeStaleReapCandidate[]
  policy: RuntimeMemoryReadyPolicy['readback'] & { schema_version: string }
  details: Record<string, unknown>
}

export type SealedBootstrapRuntimeReceipt = {
  runtime_instance_id: string
  runtime_engine: string
  session_name: string
  checkout_path: string
}

export type RuntimeCurrentResolverInput = {
  agentId: string
  requestedRuntimeKind: string
  selectedBootstrapReceipt?: SealedBootstrapRuntimeReceipt | null
  now?: Date
  policy?: RuntimeMemoryReadyPolicy
}

type AgentRow = {
  agent_id: string
  runtime: unknown
  channel_port: unknown
  home_directory: unknown
  profile_revision: unknown
  profile_source: unknown
  metadata: unknown
}

type RuntimeRow = {
  runtime_instance_id: unknown
  agent_id: unknown
  runtime_engine: unknown
  runtime_kind: unknown
  session_name: unknown
  port: unknown
  checkout_path: unknown
  commit_sha: unknown
  started_at: unknown
  last_seen_at: unknown
  status: unknown
  metadata: unknown
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
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
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  const normalized = text(value)
  if (!normalized) return null
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`RUNTIME_MEMORY_READY_POLICY_INVALID: ${field} must be a positive integer`)
  }
  return Number(value)
}

export function parseRuntimeMemoryReadyPolicy(raw: string, path = '<memory>'): RuntimeMemoryReadyPolicy {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('RUNTIME_MEMORY_READY_POLICY_INVALID: JSON parse failed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RUNTIME_MEMORY_READY_POLICY_INVALID: root must be an object')
  }
  if (parsed.schema_version !== RUNTIME_MEMORY_READY_POLICY_SCHEMA) {
    throw new Error(`RUNTIME_MEMORY_READY_POLICY_UNSUPPORTED: ${String(parsed.schema_version ?? '')}`)
  }
  const defaultLiveness = positiveInteger(parsed.default_liveness_ttl_ms, 'default_liveness_ttl_ms')
  const defaultReap = positiveInteger(parsed.default_reap_ttl_ms, 'default_reap_ttl_ms')
  if (defaultReap < 86_400_000) {
    throw new Error('RUNTIME_MEMORY_READY_POLICY_INVALID: default_reap_ttl_ms must be at least 24h')
  }
  const backoffBase = positiveInteger(parsed.backoff?.base_ms, 'backoff.base_ms')
  const backoffCap = positiveInteger(parsed.backoff?.cap_ms, 'backoff.cap_ms')
  if (backoffCap < backoffBase) {
    throw new Error('RUNTIME_MEMORY_READY_POLICY_INVALID: backoff.cap_ms must be >= base_ms')
  }
  if (!Array.isArray(parsed.groups)) {
    throw new Error('RUNTIME_MEMORY_READY_POLICY_INVALID: groups must be an array')
  }
  const seen = new Set<string>()
  const groups = parsed.groups.map((entry: any, index: number): RuntimeMemoryReadyPolicyGroup => {
    const runtimeKind = text(entry?.runtime_kind)
    const source = text(entry?.source)
    if (!runtimeKind || !source) {
      throw new Error(`RUNTIME_MEMORY_READY_POLICY_INVALID: groups[${index}] key is incomplete`)
    }
    const key = `${runtimeKind}\u0000${source}`
    if (seen.has(key)) {
      throw new Error(`RUNTIME_MEMORY_READY_POLICY_INVALID: duplicate group ${runtimeKind}/${source}`)
    }
    seen.add(key)
    return {
      runtime_kind: runtimeKind,
      source,
      heartbeat_interval_ms: positiveInteger(entry.heartbeat_interval_ms, `groups[${index}].heartbeat_interval_ms`),
    }
  })
  return {
    schema_version: RUNTIME_MEMORY_READY_POLICY_SCHEMA,
    default_liveness_ttl_ms: defaultLiveness,
    default_reap_ttl_ms: defaultReap,
    backoff: { base_ms: backoffBase, cap_ms: backoffCap },
    groups,
    readback: {
      path: resolve(path),
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
  }
}

export function loadRuntimeMemoryReadyPolicy(
  path = process.env.RUNTIME_MEMORY_READY_POLICY_FILE?.trim() || DEFAULT_RUNTIME_MEMORY_READY_POLICY_PATH,
): RuntimeMemoryReadyPolicy {
  return parseRuntimeMemoryReadyPolicy(readFileSync(path, 'utf8'), path)
}

function policyForGroup(
  policy: RuntimeMemoryReadyPolicy,
  runtimeKind: string,
  source: string,
): { livenessTtlMs: number; reapTtlMs: number } {
  const group = policy.groups.find(entry => entry.runtime_kind === runtimeKind && entry.source === source)
  if (!group) {
    return {
      livenessTtlMs: policy.default_liveness_ttl_ms,
      reapTtlMs: policy.default_reap_ttl_ms,
    }
  }
  return {
    livenessTtlMs: group.heartbeat_interval_ms * 6,
    reapTtlMs: Math.max(86_400_000, group.heartbeat_interval_ms * 12),
  }
}

async function rows<T>(db: RuntimeCurrentResolverDb, sql: string, params?: any[]): Promise<T[]> {
  const result = await db.query<T>(sql, params)
  return Array.isArray(result) ? result : result.rows
}

export async function resolveRuntimeMemoryReadyCurrent(
  db: RuntimeCurrentResolverDb,
  input: RuntimeCurrentResolverInput,
): Promise<RuntimeCurrentResolution> {
  const now = input.now ?? new Date()
  const policy = input.policy ?? loadRuntimeMemoryReadyPolicy()
  const requestedRuntimeKind = text(input.requestedRuntimeKind)
  if (!requestedRuntimeKind) {
    throw new Error('RUNTIME_MEMORY_READY_KIND_REQUIRED')
  }
  const bootstrapSelection = requestedRuntimeKind === 'bootstrap_bound_provider'
    ? input.selectedBootstrapReceipt ?? null
    : null
  const policyReadback = { schema_version: policy.schema_version, ...policy.readback }
  const agentRows = await rows<AgentRow>(
    db,
    `SELECT agent_id, runtime, channel_port, home_directory, profile_revision, profile_source, metadata
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [input.agentId],
  )
  const agent = agentRows[0]
  if (!agent) {
    return {
      ok: false,
      code: 'AGENT_MISSING',
      agent_id: input.agentId,
      requested_runtime_kind: requestedRuntimeKind,
      checked_at: now.toISOString(),
      profile: null,
      current_runtime: null,
      runtime_rows: [],
      reap_candidates: [],
      policy: policyReadback,
      details: {},
    }
  }
  const metadata = object(agent.metadata)
  const profile: RuntimeCurrentProfile = {
    agent_id: input.agentId,
    runtime_kind: text(agent.runtime),
    session_name: text(metadata.tmux_session),
    home_directory: text(agent.home_directory),
    channel_port: number(agent.channel_port),
    profile_revision: number(agent.profile_revision),
    profile_source: text(agent.profile_source),
    metadata,
  }
  const runtimeRows = await rows<RuntimeRow>(
    db,
    `SELECT CAST(runtime_instance_id AS TEXT) AS runtime_instance_id, agent_id,
            runtime_engine, runtime_kind, session_name, port, checkout_path, commit_sha,
            started_at, last_seen_at, status, metadata
       FROM agent_runtime_instances
      WHERE agent_id = $1
        AND runtime_kind = $2
        AND status IN ('running', 'active')
      ORDER BY last_seen_at DESC, started_at DESC, runtime_instance_id ASC`,
    [input.agentId, requestedRuntimeKind],
  )
  const nowMs = now.getTime()
  const normalized = runtimeRows.map((row): RuntimeCurrentInstance => {
    const rowMetadata = object(row.metadata)
    const runtimeKind = text(row.runtime_kind) ?? 'unknown'
    const runtimeEngine = text(row.runtime_engine)
    const source = text(rowMetadata.source) ?? runtimeEngine ?? 'unknown'
    const ttl = policyForGroup(policy, runtimeKind, source)
    const seenMs = timestampMs(row.last_seen_at)
    const age = seenMs === null ? null : Math.max(0, nowMs - seenMs)
    const instance: RuntimeCurrentInstance = {
      runtime_instance_id: text(row.runtime_instance_id) ?? '',
      agent_id: text(row.agent_id) ?? input.agentId,
      runtime_engine: runtimeEngine,
      runtime_kind: runtimeKind,
      source,
      session_name: text(row.session_name),
      port: number(row.port),
      checkout_path: text(row.checkout_path),
      commit_sha: text(row.commit_sha),
      started_at: row.started_at as string | Date | null,
      last_seen_at: row.last_seen_at as string | Date | null,
      status: text(row.status),
      metadata: rowMetadata,
      liveness_ttl_ms: ttl.livenessTtlMs,
      reap_ttl_ms: ttl.reapTtlMs,
      heartbeat_age_ms: age,
      profile_match: false,
      live: age !== null && age <= ttl.livenessTtlMs,
    }
    instance.profile_match = bootstrapSelection
      ? Boolean(
          instance.runtime_instance_id === bootstrapSelection.runtime_instance_id &&
          instance.runtime_engine === bootstrapSelection.runtime_engine &&
          instance.session_name === bootstrapSelection.session_name &&
          instance.checkout_path === bootstrapSelection.checkout_path,
        )
      : Boolean(
          profile.runtime_kind &&
          profile.session_name &&
          profile.home_directory &&
          instance.runtime_engine === profile.runtime_kind &&
          instance.session_name === profile.session_name &&
          instance.checkout_path === profile.home_directory,
        )
    return instance
  })

  const freshGroup = new Set(
    normalized
      .filter(row => row.live)
      .map(row => `${row.runtime_kind}\u0000${row.source}`),
  )
  const reapCandidates: RuntimeStaleReapCandidate[] = []
  for (const row of normalized) {
    if (row.heartbeat_age_ms === null || row.last_seen_at === null || !row.status || !row.runtime_kind) continue
    const group = `${row.runtime_kind}\u0000${row.source}`
    const absolute = row.heartbeat_age_ms > row.reap_ttl_ms
    const superseded = !row.live && freshGroup.has(group)
    if (!absolute && !superseded) continue
    reapCandidates.push({
      runtime_instance_id: row.runtime_instance_id,
      agent_id: row.agent_id,
      runtime_kind: row.runtime_kind,
      source: row.source,
      observed_status: row.status,
      observed_last_seen_at: row.last_seen_at,
      reason: absolute ? 'absolute' : 'superseded',
      heartbeat_age_ms: row.heartbeat_age_ms,
      liveness_ttl_ms: row.liveness_ttl_ms,
      reap_ttl_ms: row.reap_ttl_ms,
    })
  }

  const tupleMissing = requestedRuntimeKind === 'bootstrap_bound_provider'
    ? [
        bootstrapSelection?.runtime_instance_id ? null : 'sealed_receipt.runtime_instance_id',
        bootstrapSelection?.runtime_engine ? null : 'sealed_receipt.runtime_engine',
        bootstrapSelection?.session_name ? null : 'sealed_receipt.session_name',
        bootstrapSelection?.checkout_path ? null : 'sealed_receipt.checkout_path',
      ].filter((value): value is string => value !== null)
    : [
        profile.runtime_kind ? null : 'runtime_kind',
        profile.session_name ? null : 'session',
        profile.home_directory ? null : 'home',
      ].filter((value): value is string => value !== null)
  const current = normalized.find(row => row.live && row.profile_match) ?? null
  const code = requestedRuntimeKind === 'bootstrap_bound_provider'
    ? current
      ? 'RESOLVED' as const
      : 'NO_BOOTSTRAP_BOUND_ROW' as const
    : tupleMissing.length > 0
      ? 'PROFILE_TUPLE_INCOMPLETE' as const
      : current
        ? 'RESOLVED' as const
        : 'NO_CURRENT_RUNTIME_FOR_PROFILE' as const
  return {
    ok: current !== null && tupleMissing.length === 0,
    code,
    agent_id: input.agentId,
    requested_runtime_kind: requestedRuntimeKind,
    checked_at: now.toISOString(),
    profile,
    current_runtime: tupleMissing.length === 0 ? current : null,
    runtime_rows: normalized,
    reap_candidates: reapCandidates,
    policy: policyReadback,
    details: {
      missing_profile_fields: tupleMissing,
      bootstrap_receipt_bound: bootstrapSelection !== null,
      active_runtime_rows: normalized.length,
      live_runtime_rows: normalized.filter(row => row.live).length,
      live_profile_matches: normalized.filter(row => row.live && row.profile_match).length,
    },
  }
}

export async function reapRuntimeMemoryReadyStaleRows(
  db: RuntimeCurrentResolverDb,
  candidates: RuntimeStaleReapCandidate[],
  now = new Date(),
): Promise<Array<RuntimeStaleReapCandidate & { reaped: boolean }>> {
  const results: Array<RuntimeStaleReapCandidate & { reaped: boolean }> = []
  for (const candidate of candidates) {
    const updated = await rows<{ runtime_instance_id: string }>(
      db,
      `UPDATE agent_runtime_instances
          SET status = 'stopped', stopped_at = $4
        WHERE CAST(runtime_instance_id AS TEXT) = $1
          AND status = $2
          AND last_seen_at = $3
        RETURNING CAST(runtime_instance_id AS TEXT) AS runtime_instance_id`,
      [candidate.runtime_instance_id, candidate.observed_status, candidate.observed_last_seen_at, now.toISOString()],
    )
    results.push({ ...candidate, reaped: updated.length === 1 })
  }
  return results
}
