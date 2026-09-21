import { readCurrentNativeProof } from './runtime-native-proof'
import { inspectHostRuntime, type HostRuntimeInspector } from './host-runtime-observer'
import { durableMemoryMetadata } from './runtime-durable-data'
import { createHash } from 'node:crypto'
import { observeSeatProvider } from './seat-runtime-selection'
import { resolveRuntimeEndpoint } from './runtime-endpoint'
import { validateSeatContextReceipt, seatContextDigest, type SeatContextReceipt } from './seat-context-recovery'
import {
  loadRuntimeMemoryReadyPolicy,
  resolveRuntimeMemoryReadyCurrent,
  type RuntimeMemoryReadyPolicy,
  type SealedBootstrapRuntimeReceipt,
} from './runtime-current-resolver'

export type RuntimeMemoryReadyStatus = 'ready' | 'failed' | 'bypassed'

export type RuntimeMemoryReadySource =
  | 'wasurezu_boot_recovery'
  | 'agent_memory_boot_recovery'
  | 'explicit_operator_bypass'
  | string

export type RuntimeMemoryReadyDb = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null } | T[]>
}

export interface RuntimeMemoryReadyEvidenceInput {
  agent_id: string
  project: string
  runtime_instance_id: string
  profile_revision?: number | null
  profile_source?: string | null
  session_name: string
  port: number
  expected_agent_id: string
  checkout_path?: string | null
  checkout_commit_sha?: string | null
  recovery_command: string
  result_status: RuntimeMemoryReadyStatus
  failure_reason?: string | null
  completed_at: Date | string
  evidence_path?: string | null
  evidence_log_id?: string | null
  valid_until: Date | string
  source: RuntimeMemoryReadySource
  metadata?: Record<string, unknown>
}

export interface RuntimeMemoryReadyCurrentRuntime {
  agent_id: string
  runtime_instance_id: string | null
  profile_revision: number | null
  profile_source: string | null
  session_name: string | null
  port: number | null
  checkout_path: string | null
  commit_sha: string | null
  started_at: string | Date | null
  status: string | null
}

export interface RuntimeMemoryReadyQueueScopeInput {
  queue_id?: string | number | null
  status?: string | null
  action_kind?: string | null
}

export interface RuntimeMemoryReadyGateResult {
  ok: boolean
  gate: 'memory_ready'
  reason:
    | 'ready'
    | 'bypassed'
    | 'agent_missing'
    | 'missing_current_runtime'
    | 'no_current_runtime_for_profile'
    | 'missing_read_model'
    | 'missing_evidence'
    | 'not_ready'
    | 'expired'
    | 'runtime_instance_mismatch'
    | 'expected_agent_id_mismatch'
    | 'project_mismatch'
    | 'project_resolution_failed'
    | 'session_mismatch'
    | 'port_mismatch'
    | 'profile_revision_mismatch'
    | 'profile_source_mismatch'
    | 'registration_profile_mismatch'
    | 'checkout_path_mismatch'
    | 'checkout_commit_mismatch'
    | 'stale_runtime_restore'
    | 'port_identity_mismatch'
    | 'unaudited_bypass'
    | 'bypass_source_mismatch'
    | 'bypass_metadata_missing'
    | 'bypass_metadata_invalid'
    | 'bypass_scope_mismatch'
    | 'bypass_expired'
    | 'read_error'
    | 'context_consumption_missing'
    | 'endpoint_unavailable'
  agent_id: string
  project: string
  checked_at: string
  runtime_instance_id: string | null
  evidence_id: string | number | null
  evidence_path: string | null
  evidence_log_id: string | null
  source: string | null
  valid_until: string | null
  current_runtime: RuntimeMemoryReadyCurrentRuntime | null
  details: Record<string, unknown>
}

export type RuntimeMemoryReadyProjectResolutionSource =
  | 'agent_metadata_override'
  | 'verified_current_runtime_receipt'
  | 'active_primary_workspace'
  | 'canonical_workspace'

export interface RuntimeMemoryReadyProjectResolution {
  agent_id: string
  project: string
  workspace_path: string | null
  source: RuntimeMemoryReadyProjectResolutionSource
}

export class RuntimeMemoryReadyProjectResolutionError extends Error {
  constructor(
    readonly code:
      | 'AGENT_NOT_ENABLED'
      | 'WORKSPACE_AMBIGUOUS'
      | 'WORKSPACE_MISSING'
      | 'WORKSPACE_NOT_ABSOLUTE'
      | 'WORKSPACE_NOT_FOUND'
      | 'WORKSPACE_NOT_DIRECTORY'
      | 'PROJECT_MISSING'
      | 'PROJECT_AMBIGUOUS'
      | 'PROJECT_INVALID',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'RuntimeMemoryReadyProjectResolutionError'
  }
}

interface RuntimeMemoryReadyProjectAgentRow {
  agent_id: string
  profile_enabled: unknown
  disabled_at: unknown
  home_directory: string | null
  metadata: unknown
}

function enabledProfile(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

/** The logical namespace is explicit seat metadata or independently verified
 * current native input. A host-local path never creates a memory project. */
export async function resolveRuntimeMemoryReadyProject(
  db: RuntimeMemoryReadyDb,
  agentId: string,
  options: { now?: Date } = {},
): Promise<RuntimeMemoryReadyProjectResolution> {
  const agents = await queryRows<RuntimeMemoryReadyProjectAgentRow>(
    db,
    `SELECT agent_id, profile_enabled, disabled_at, home_directory, metadata
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  )
  const agent = agents[0] ?? null
  if (!agent || !enabledProfile(agent.profile_enabled) || agent.disabled_at != null) {
    throw new RuntimeMemoryReadyProjectResolutionError(
      'AGENT_NOT_ENABLED',
      `memory-ready project requires one enabled agent row for ${agentId}`,
    )
  }

  const metadata = parseObject(agent.metadata)
  const explicitProject = normalizeText(metadata.memory_project)
  if (Object.prototype.hasOwnProperty.call(metadata, 'memory_project')
    && (!explicitProject || typeof metadata.memory_project !== 'string' || /[:\r\n\0]/.test(explicitProject))) {
    throw new RuntimeMemoryReadyProjectResolutionError('PROJECT_INVALID', `memory-ready logical project is invalid for ${agentId}`)
  }
  if (explicitProject) {
    return {
      agent_id: agentId,
      project: explicitProject,
      workspace_path: null,
      source: 'agent_metadata_override',
    }
  }

  const now = options.now ?? new Date()
  const current = await resolveRuntimeMemoryReadyCurrent(db, {agentId,requestedRuntimeKind:'local_process',now})
  const runtime = current.current_runtime
  const projects = new Set<string>()
  if (current.ok && runtime) {
    const rows = await queryRows<{project:string}>(db,
      `SELECT DISTINCT project FROM runtime_memory_ready_evidence
        WHERE agent_id=$1 AND runtime_instance_id=$2 LIMIT 33`, [agentId,runtime.runtime_instance_id])
    if (rows.length > 32) throw new RuntimeMemoryReadyProjectResolutionError('PROJECT_AMBIGUOUS', `memory-ready logical project selection is unbounded for ${agentId}`)
    for (const row of rows) {
      const project = normalizeText(row.project)
      if (!project || /[:\r\n\0]/.test(project)) continue
      const gate = await evaluateRuntimeMemoryReadyGate(db,{agent_id:agentId,project,now,requested_runtime_kind:'local_process'})
      if (!gate.ok || gate.runtime_instance_id !== runtime.runtime_instance_id) continue
      // The gate has freshly re-read the original native receipt for this project.
      projects.add(project)
    }
  }
  if (projects.size !== 1) throw new RuntimeMemoryReadyProjectResolutionError(
    projects.size > 1 ? 'PROJECT_AMBIGUOUS' : 'PROJECT_MISSING',
    `memory-ready requires one explicit or verified logical project for ${agentId}`,
    {verified_project_count:projects.size})
  return {agent_id:agentId,project:[...projects][0],workspace_path:runtime!.checkout_path,source:'verified_current_runtime_receipt'}

}

interface AgentProfileRow {
  agent_id: string
  profile_revision: number | string | null
  profile_source: string | null
  channel_port: number | string | null
  home_directory: string | null
  metadata: unknown
}

interface RuntimeRow {
  runtime_instance_id: string
  agent_id: string
  session_name: string | null
  port: number | string | null
  checkout_path: string | null
  commit_sha: string | null
  started_at: string | Date | null
  last_seen_at: string | Date | null
  status: string | null
}

interface EvidenceRow {
  id: string | number
  agent_id: string
  project: string
  runtime_instance_id: string
  profile_revision: number | string | null
  profile_source: string | null
  session_name: string | null
  port: number | string | null
  expected_agent_id: string | null
  checkout_path: string | null
  checkout_commit_sha: string | null
  recovery_command: string | null
  result_status: string | null
  failure_reason: string | null
  completed_at: string | Date | null
  evidence_path: string | null
  evidence_log_id: string | null
  valid_until: string | Date | null
  source: string | null
  metadata: unknown
}

async function queryRows<T>(db: RuntimeMemoryReadyDb, sql: string, params?: any[]): Promise<T[]> {
  const result = await db.query<T>(sql, params)
  return Array.isArray(result) ? result : result.rows
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeDateIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value
}

function dateMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function parseObject(value: unknown): Record<string, unknown> {
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

function parseRequiredObject(value: unknown): Record<string, unknown> | null {
  const parsed = parseObject(value)
  return Object.keys(parsed).length > 0 ? parsed : null
}

function firstNonEmptyText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) return normalized
  }
  return null
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return normalizeText(value)
}

function textValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(normalizeIdentifier).filter((item): item is string => !!item)
  const normalized = normalizeIdentifier(value)
  if (!normalized) return []
  try {
    const parsed = JSON.parse(normalized)
    if (Array.isArray(parsed)) return textValues(parsed)
  } catch {}
  return [normalized]
}

function scopeValues(scope: Record<string, unknown>, singleKey: string, pluralKey: string): string[] {
  return [
    ...textValues(scope[singleKey]),
    ...textValues(scope[pluralKey]),
  ]
}

function scopeHasQueueBound(scope: Record<string, unknown>): boolean {
  return scopeValues(scope, 'queue_id', 'queue_ids').length > 0 ||
    scopeValues(scope, 'status', 'statuses').length > 0 ||
    scopeValues(scope, 'action_kind', 'action_kinds').length > 0
}

function scopeConstraintMatches(values: string[], actual: string | null): boolean {
  if (values.length === 0) return true
  return actual !== null && values.includes(actual)
}

function queueScopeMatches(
  scope: Record<string, unknown>,
  current: RuntimeMemoryReadyQueueScopeInput | null | undefined,
): boolean {
  if (!current) return false
  return scopeConstraintMatches(scopeValues(scope, 'queue_id', 'queue_ids'), normalizeIdentifier(current.queue_id)) &&
    scopeConstraintMatches(scopeValues(scope, 'status', 'statuses'), normalizeText(current.status)) &&
    scopeConstraintMatches(scopeValues(scope, 'action_kind', 'action_kinds'), normalizeText(current.action_kind))
}

function fail(
  base: Omit<RuntimeMemoryReadyGateResult, 'ok' | 'reason'>,
  reason: RuntimeMemoryReadyGateResult['reason'],
  details: Record<string, unknown> = {},
): RuntimeMemoryReadyGateResult {
  return { ...base, ok: false, reason, details: { ...base.details, ...details } }
}

function pass(
  base: Omit<RuntimeMemoryReadyGateResult, 'ok' | 'reason'>,
  reason: 'ready' | 'bypassed',
  details: Record<string, unknown> = {},
): RuntimeMemoryReadyGateResult {
  return { ...base, ok: true, reason, details: { ...base.details, ...details } }
}

function validateBypassMetadata(
  evidence: EvidenceRow,
  base: Omit<RuntimeMemoryReadyGateResult, 'ok' | 'reason'>,
  expectedAgentId: string,
  now: Date,
  currentQueueScope: RuntimeMemoryReadyQueueScopeInput | null | undefined,
): RuntimeMemoryReadyGateResult | null {
  if (evidence.source !== 'explicit_operator_bypass') {
    return fail(base, 'bypass_source_mismatch', {
      source: evidence.source,
      required_source: 'explicit_operator_bypass',
    })
  }

  const metadata = parseObject(evidence.metadata)
  const target = parseObject(metadata.target)
  const queueScope = parseRequiredObject(metadata.queue_scope)
  const actor = normalizeText(metadata.actor)
  const reason = normalizeText(metadata.reason)
  const timestamp = normalizeText(metadata.timestamp)
  const targetAgent = firstNonEmptyText(metadata.target_agent, metadata.target_agent_id, target.agent_id)
  const expiresAt = firstNonEmptyText(metadata.expires_at, metadata.expiry, metadata.expiry_at)
  const missing = [
    actor ? null : 'actor',
    reason ? null : 'reason',
    timestamp ? null : 'timestamp',
    targetAgent ? null : 'target_agent',
    queueScope ? null : 'queue_scope',
    expiresAt ? null : 'expires_at',
  ].filter((item): item is string => !!item)

  if (missing.length > 0) {
    return fail(base, 'bypass_metadata_missing', {
      missing,
      required_metadata: ['actor', 'reason', 'timestamp', 'target_agent', 'queue_scope', 'expires_at'],
    })
  }

  const timestampMs = dateMs(timestamp)
  const expiresAtMs = dateMs(expiresAt)
  if (timestampMs === null || expiresAtMs === null || !queueScope || !scopeHasQueueBound(queueScope)) {
    return fail(base, 'bypass_metadata_invalid', {
      timestamp,
      expires_at: expiresAt,
      queue_scope: queueScope,
      requires_bounded_queue_scope: ['queue_id', 'status', 'action_kind'],
    })
  }

  if (expiresAtMs <= now.getTime()) {
    return fail(base, 'bypass_expired', { expires_at: expiresAt })
  }

  if (targetAgent !== expectedAgentId) {
    return fail(base, 'bypass_scope_mismatch', {
      target_agent: targetAgent,
      expected_agent_id: expectedAgentId,
    })
  }

  const scopedAgent = firstNonEmptyText(queueScope.agent_id, queueScope.target_agent, queueScope.target_agent_id)
  if (scopedAgent && scopedAgent !== expectedAgentId) {
    return fail(base, 'bypass_scope_mismatch', {
      queue_scope_agent_id: scopedAgent,
      expected_agent_id: expectedAgentId,
    })
  }

  if (!queueScopeMatches(queueScope, currentQueueScope)) {
    return fail(base, 'bypass_scope_mismatch', {
      queue_scope: queueScope,
      current_queue_scope: currentQueueScope ?? null,
    })
  }

  return null
}

export function runtimeMemoryReadyPostgresSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS runtime_memory_ready_evidence (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  profile_revision INTEGER,
  profile_source TEXT,
  session_name TEXT,
  port INTEGER,
  expected_agent_id TEXT NOT NULL,
  checkout_path TEXT,
  checkout_commit_sha TEXT,
  recovery_command TEXT,
  result_status TEXT NOT NULL CHECK (result_status IN ('ready', 'failed', 'bypassed')),
  failure_reason TEXT,
  completed_at TIMESTAMPTZ NOT NULL,
  evidence_path TEXT,
  evidence_log_id TEXT,
  valid_until TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_latest
  ON runtime_memory_ready_evidence(agent_id, project, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_runtime
  ON runtime_memory_ready_evidence(runtime_instance_id, valid_until DESC);
`
}

export function runtimeMemoryReadySqliteSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS runtime_memory_ready_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  profile_revision INTEGER,
  profile_source TEXT,
  session_name TEXT,
  port INTEGER,
  expected_agent_id TEXT NOT NULL,
  checkout_path TEXT,
  checkout_commit_sha TEXT,
  recovery_command TEXT,
  result_status TEXT NOT NULL CHECK (result_status IN ('ready', 'failed', 'bypassed')),
  failure_reason TEXT,
  completed_at TEXT NOT NULL,
  evidence_path TEXT,
  evidence_log_id TEXT,
  valid_until TEXT NOT NULL,
  source TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_latest
  ON runtime_memory_ready_evidence(agent_id, project, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_memory_ready_runtime
  ON runtime_memory_ready_evidence(runtime_instance_id, valid_until DESC);
`
}

export async function recordRuntimeMemoryReadyEvidence(
  db: RuntimeMemoryReadyDb,
  input: RuntimeMemoryReadyEvidenceInput,
): Promise<{ evidence_id: string | number | null; evidence_log_id: string | null }> {
  // Machine-generated identifiers/reason codes cannot carry an observation or
  // arbitrary exception text under an otherwise permitted column name.
  for(const [key,value] of Object.entries({source:input.source,failure_reason:input.failure_reason,evidence_log_id:input.evidence_log_id})) {
    if(value!=null && (typeof value!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value))) throw new Error(`MEMORY_DURABLE_FIELD_INVALID:${key}`)
  }
  if(input.checkout_commit_sha!=null && !/^[0-9a-f]{40}$/.test(input.checkout_commit_sha))throw new Error('MEMORY_DURABLE_FIELD_INVALID:checkout_commit_sha')
  const projected=durableMemoryMetadata(input.metadata)
  const proof=projected.seat_context_proof as Record<string,string>|undefined
  if(proof && (proof.agent_id!==input.agent_id || proof.project!==input.project || proof.runtime_instance_id!==input.runtime_instance_id))throw new Error('MEMORY_LOGICAL_PROOF_BINDING_MISMATCH')
  const metadata=JSON.stringify(projected)
  const completedAt = normalizeDateIso(input.completed_at) ?? input.completed_at
  const validUntil = normalizeDateIso(input.valid_until) ?? input.valid_until
  const rows = await queryRows<{ id: string | number }>(
    db,
    `INSERT INTO runtime_memory_ready_evidence
       (agent_id, project, runtime_instance_id, profile_revision, profile_source,
        session_name, port, expected_agent_id, checkout_path, checkout_commit_sha,
        recovery_command, result_status, failure_reason, completed_at,
        evidence_path, evidence_log_id, valid_until, source, metadata)
     VALUES
       ($1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18, COALESCE($19::jsonb, '{}'::jsonb))
     RETURNING id`,
    [
      input.agent_id,
      input.project,
      input.runtime_instance_id,
      input.profile_revision ?? null,
      input.profile_source ?? null,
      null,
      null,
      input.expected_agent_id,
      null,
      input.checkout_commit_sha ?? null,
      null,
      input.result_status,
      input.failure_reason ?? null,
      completedAt,
      null,
      input.evidence_log_id ?? null,
      validUntil,
      input.source,
      metadata,
    ],
  )
  const evidenceId = rows[0]?.id ?? null
  const auditRows = await queryRows<{ id: string }>(
    db,
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ('runtime.memory_ready', $1, $2, COALESCE($3::jsonb, '{}'::jsonb), 'default')
     RETURNING id`,
    [
      input.agent_id,
      input.runtime_instance_id,
      JSON.stringify({
        project: input.project,
        runtime_instance_id: input.runtime_instance_id,
        result_status: input.result_status,
        source: input.source,
        evidence_id: evidenceId,
        
        evidence_log_id: input.evidence_log_id ?? null,
      }),
    ],
  ).catch(() => [])
  return {
    evidence_id: evidenceId,
    evidence_log_id: input.evidence_log_id ?? auditRows[0]?.id ?? null,
  }
}

export async function evaluateRuntimeMemoryReadyGate(
  db: RuntimeMemoryReadyDb,
  input: {
    agent_id: string
    project: string
    expected_agent_id?: string | null
    now?: Date
    queue_scope?: RuntimeMemoryReadyQueueScopeInput | null
    policy?: RuntimeMemoryReadyPolicy
    requested_runtime_kind?: string
    selected_bootstrap_receipt?: SealedBootstrapRuntimeReceipt | null
    inspect?: HostRuntimeInspector
    readNativeProof?: typeof readCurrentNativeProof
  },
): Promise<RuntimeMemoryReadyGateResult> {
  const now = input.now ?? new Date()
  const checkedAt = now.toISOString()
  const expectedAgentId = input.expected_agent_id?.trim() || input.agent_id
  const base = {
    gate: 'memory_ready' as const,
    agent_id: input.agent_id,
    project: input.project,
    checked_at: checkedAt,
    runtime_instance_id: null,
    evidence_id: null,
    evidence_path: null,
    evidence_log_id: null,
    source: null,
    valid_until: null,
    current_runtime: null,
    details: {},
  }

  let agent: AgentProfileRow | null = null
  try {
    const agentRows = await queryRows<AgentProfileRow>(
      db,
      `SELECT agent_id, profile_revision, profile_source, channel_port, home_directory, metadata
         FROM agents
        WHERE agent_id = $1
        LIMIT 1`,
      [input.agent_id],
    )
    agent = agentRows[0] ?? null
  } catch (err) {
    return fail(base, 'read_error', { error: (err as Error).message ?? String(err) })
  }
  if (!agent) return fail(base, 'agent_missing')

  // Profile ports are legacy projection. Endpoint ownership is evaluated for
  // the selected runtime, never by looking for another seat at a profile port.

  const policy = input.policy ?? loadRuntimeMemoryReadyPolicy()
  let currentResolution
  try {
    currentResolution = await resolveRuntimeMemoryReadyCurrent(db, {
      agentId: input.agent_id,
      requestedRuntimeKind: input.requested_runtime_kind?.trim() || 'local_process',
      selectedBootstrapReceipt: input.selected_bootstrap_receipt,
      inspect: input.inspect,
      now,
      policy,
    })
  } catch (err) {
    return fail(base, 'read_error', {
      code: 'CURRENT_RUNTIME_RESOLUTION_ERROR',
      error: (err as Error).message ?? String(err),
    })
  }
  if (!currentResolution.ok || !currentResolution.current_runtime) {
    return fail(base, 'no_current_runtime_for_profile', {
      code: currentResolution.code,
      repair_signal: 'RUNTIME_REREGISTRATION_REQUIRED',
      policy: currentResolution.policy,
      profile: currentResolution.profile,
      reap_candidates: currentResolution.reap_candidates.map(candidate => ({
        runtime_instance_id: candidate.runtime_instance_id,
        reason: candidate.reason,
      })),
      ...currentResolution.details,
    })
  }
  const selectedRuntime = currentResolution.current_runtime

  let evidenceRows: EvidenceRow[]
  try {
    evidenceRows = await queryRows<EvidenceRow>(
      db,
      `SELECT id, agent_id, project, runtime_instance_id, profile_revision, profile_source,
              session_name, port, expected_agent_id, checkout_path, checkout_commit_sha,
              recovery_command, result_status, failure_reason, completed_at,
              evidence_path, evidence_log_id, valid_until, source, metadata
         FROM runtime_memory_ready_evidence
        WHERE agent_id = $1
          AND project = $2
          AND NOT EXISTS (
            SELECT 1 FROM agent_runtime_instances evidence_runtime
             WHERE CAST(evidence_runtime.runtime_instance_id AS TEXT) = runtime_memory_ready_evidence.runtime_instance_id
               AND evidence_runtime.runtime_kind <> $3
          )
        ORDER BY completed_at DESC, id DESC
        LIMIT 1`,
      [input.agent_id, input.project, selectedRuntime.runtime_kind],
    )
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    const missing = /runtime_memory_ready_evidence|does not exist|no such table/i.test(msg)
    return fail(base, missing ? 'missing_read_model' : 'read_error', { error: msg })
  }
  const evidence = evidenceRows[0] ?? null
  if (!evidence) return fail(base, 'missing_evidence')

  const withEvidenceBase = {
    ...base,
    evidence_id: evidence.id ?? null,
    evidence_path: evidence.evidence_path ?? null,
    evidence_log_id: evidence.evidence_log_id ?? null,
    source: evidence.source ?? null,
    valid_until: normalizeDateIso(evidence.valid_until),
  }
  if (evidence.project !== input.project) return fail(withEvidenceBase, 'project_mismatch', { evidence_project: evidence.project })
  if (evidence.result_status !== 'ready' && evidence.result_status !== 'bypassed') {
    return fail(withEvidenceBase, 'not_ready', {
      result_status: evidence.result_status,
      failure_reason: evidence.failure_reason,
    })
  }
  const validUntilMs = dateMs(evidence.valid_until)
  if (validUntilMs === null || validUntilMs <= now.getTime()) {
    return fail(withEvidenceBase, 'expired')
  }

  const currentRuntime: RuntimeMemoryReadyCurrentRuntime = {
    agent_id: input.agent_id,
    runtime_instance_id: normalizeText(selectedRuntime.runtime_instance_id),
    profile_revision: normalizeNumber(agent.profile_revision),
    profile_source: normalizeText(agent.profile_source),
    session_name: normalizeText(selectedRuntime.session_name),
    port: normalizeNumber(selectedRuntime.port),
    checkout_path: normalizeText(selectedRuntime.checkout_path),
    commit_sha: normalizeText(selectedRuntime.commit_sha),
    started_at: selectedRuntime.started_at,
    status: normalizeText(selectedRuntime.status),
  }
  const withEvidence = {
    ...withEvidenceBase,
    runtime_instance_id: currentRuntime.runtime_instance_id,
    current_runtime: currentRuntime,
    details: {
      policy: currentResolution.policy,
      resolver_code: currentResolution.code,
      ...currentResolution.details,
    },
  }
  if (!currentRuntime.runtime_instance_id) {
    return fail(withEvidence, 'runtime_instance_mismatch', {
      evidence_runtime_instance_id: evidence.runtime_instance_id,
    })
  }

  // Current observed identity and its recovery receipt are compared below.
  // Historical profile session/path/port differences do not rewrite or reject
  // an otherwise verified replacement of this same seat.
  if (evidence.runtime_instance_id !== currentRuntime.runtime_instance_id) {
    return fail(withEvidence, 'runtime_instance_mismatch', { evidence_runtime_instance_id: evidence.runtime_instance_id })
  }
  if (evidence.expected_agent_id !== expectedAgentId) {
    return fail(withEvidence, 'expected_agent_id_mismatch', {
      evidence_expected_agent_id: evidence.expected_agent_id,
      expected_agent_id: expectedAgentId,
    })
  }
  // Legacy stored session/port/path observations are history, never admission inputs.
  const evidenceRevision = normalizeNumber(evidence.profile_revision)
  if (currentRuntime.profile_revision !== null && evidenceRevision !== null && evidenceRevision !== currentRuntime.profile_revision) {
    return fail(withEvidence, 'profile_revision_mismatch', {
      evidence_profile_revision: evidenceRevision,
      runtime_profile_revision: currentRuntime.profile_revision,
    })
  }
  const evidenceProfileSource = normalizeText(evidence.profile_source)
  if (currentRuntime.profile_source && evidenceProfileSource && evidenceProfileSource !== currentRuntime.profile_source) {
    return fail(withEvidence, 'profile_source_mismatch', {
      evidence_profile_source: evidenceProfileSource,
      runtime_profile_source: currentRuntime.profile_source,
    })
  }
  const evidenceCommit = normalizeText(evidence.checkout_commit_sha)
  if (currentRuntime.commit_sha && evidenceCommit && evidenceCommit !== currentRuntime.commit_sha) {
    return fail(withEvidence, 'checkout_commit_mismatch', {
      evidence_checkout_commit_sha: evidenceCommit,
      runtime_commit_sha: currentRuntime.commit_sha,
    })
  }
  const completedMs = dateMs(evidence.completed_at)
  const startedMs = dateMs(currentRuntime.started_at)
  if (completedMs !== null && startedMs !== null && completedMs < startedMs) {
    return fail(withEvidence, 'stale_runtime_restore', {
      completed_at: normalizeDateIso(evidence.completed_at),
      runtime_started_at: normalizeDateIso(currentRuntime.started_at),
    })
  }
  if (evidence.result_status === 'bypassed') {
    const bypassFailure = validateBypassMetadata(evidence, withEvidence, expectedAgentId, now, input.queue_scope)
    if (bypassFailure) return bypassFailure
  }

  if (evidence.result_status !== 'bypassed') {
    const observation = parseObject(selectedRuntime.metadata).provider_observation
    let receipt: SeatContextReceipt
    try {
      receipt=await (input.readNativeProof ?? readCurrentNativeProof)({agentId:expectedAgentId,project:input.project,
        runtimeInstanceId:currentRuntime.runtime_instance_id,observation})
    } catch {return fail(withEvidence,'context_consumption_missing',{code:'MEMORY_NATIVE_ORIGINAL_READ_REQUIRED'})}
    const proof=parseObject(parseObject(evidence.metadata).seat_context_proof)
    if(proof.agent_id!==expectedAgentId || proof.project!==input.project || proof.runtime_instance_id!==currentRuntime.runtime_instance_id
      || proof.pack_id!==receipt.pack_id || proof.work_digest!==receipt.work_digest
      || proof.invocation_digest!==receipt.invocation_digest) return fail(withEvidence,'context_consumption_missing',{code:'MEMORY_LOGICAL_PROOF_MISMATCH'})
    if (!validateSeatContextReceipt(receipt, {
      agentId: expectedAgentId, project: input.project,
      runtimeInstanceId: currentRuntime.runtime_instance_id,
    })) return fail(withEvidence, 'context_consumption_missing', { code: 'MEMORY_CONTEXT_RECOVERY_REQUIRED' })
    const nativeDelivery = (receipt as SeatContextReceipt).native_delivery
    if (nativeDelivery) {
      const metadata = parseObject(selectedRuntime.metadata)
      const observation = parseObject(metadata.provider_observation)
      const observedRuntimeId = selectedRuntime.runtime_kind === 'bootstrap_bound_provider'
        ? metadata.mcp_runtime_instance_id : currentRuntime.runtime_instance_id
      if (observation.verified !== true || observation.source !== 'process_ancestry'
        || observation.agent_id !== expectedAgentId || observation.runtime_instance_id !== observedRuntimeId
        || observation.provider_pid !== nativeDelivery.provider_pid || observation.provider !== nativeDelivery.target_runtime
        || observation.provider_started_at !== nativeDelivery.provider_started_at
        || (observation.host_session_id && observation.host_session_id !== nativeDelivery.host_session_id)
        || typeof observation.workspace !== 'string'
        || createHash('sha256').update(observation.workspace).digest('hex') !== nativeDelivery.workspace_sha256) {
        return fail(withEvidence, 'context_consumption_missing', { code: 'MEMORY_NATIVE_CONTEXT_PROVENANCE_MISMATCH' })
      }
    }
    const consumedAt = dateMs((receipt as SeatContextReceipt).completed_at)
    if (consumedAt === null || (startedMs !== null && consumedAt < startedMs) || consumedAt > now.getTime()) {
      return fail(withEvidence, 'stale_runtime_restore', { code: 'MEMORY_CONTEXT_RECEIPT_TIME_MISMATCH' })
    }
  }

  // A sealed provider receipt and the MCP listener are different runtime kinds.
  // Local runtime gates bind the exact instance; provider receipts additionally
  // require their sealed MCP instance binding to match the observed endpoint.
  try {
    const endpointRuntimeId = (input.requested_runtime_kind ?? 'local_process') === 'local_process'
      ? currentRuntime.runtime_instance_id
      : normalizeText(selectedRuntime.metadata.mcp_runtime_instance_id)
    if (!endpointRuntimeId) return fail(withEvidence, 'endpoint_unavailable', { code: 'MCP_RUNTIME_BINDING_MISSING' })
    const endpoint = await resolveRuntimeEndpoint(db, {
      agentId: input.agent_id, runtimeInstanceId: endpointRuntimeId, now, inspect:input.inspect,
    })
    if (!endpoint.ok || !endpoint.endpoint || endpoint.endpoint.port !== currentRuntime.port
      || endpoint.endpoint.processId !== parseObject(selectedRuntime.metadata).provider_observation?.process_id
      || endpoint.endpoint.checkoutPath !== currentRuntime.checkout_path
      || endpoint.endpoint.processStartedAt !== parseObject(selectedRuntime.metadata).provider_observation?.process_started_at) {
      return fail(withEvidence, 'endpoint_unavailable', { code: endpoint.code })
    }
  } catch { return fail(withEvidence, 'endpoint_unavailable', { code: 'RUNTIME_ENDPOINT_READ_FAILED' }) }

  // Native transport and OS reads can outlast evidence validity. Re-read the
  // same logical proof at database wall time immediately before admission.
  try {
    const final=await queryRows<EvidenceRow>(db,`SELECT id,result_status,metadata,completed_at,valid_until
      FROM runtime_memory_ready_evidence WHERE id=$1 AND agent_id=$2 AND project=$3
        AND runtime_instance_id=$4 AND valid_until > clock_timestamp()`,
      [evidence.id,input.agent_id,input.project,currentRuntime.runtime_instance_id])
    if(final.length!==1)return fail(withEvidence,'expired')
    if(final[0].result_status!==evidence.result_status || dateMs(final[0].completed_at)!==completedMs
      || seatContextDigest(parseObject(final[0].metadata))!==seatContextDigest(parseObject(evidence.metadata)))return fail(withEvidence,'context_consumption_missing',{code:'MEMORY_LOGICAL_PROOF_CHANGED'})
  } catch {return fail(withEvidence,'read_error',{code:'MEMORY_FINAL_AUTHORITY_UNAVAILABLE'})}
  return pass(
    withEvidence,
    evidence.result_status === 'bypassed' ? 'bypassed' : 'ready',
    { recovery_command: evidence.recovery_command },
  )
}

export function buildWasurezuBootstrapEvidence(input: {
  agent_id: string
  project: string
  runtime_instance_id: string
  profile_revision?: number | null
  profile_source?: string | null
  session_name: string
  port: number
  checkout_path?: string | null
  checkout_commit_sha?: string | null
  completed_at?: Date | string
  valid_for_seconds?: number
  evidence_path?: string | null
  evidence_log_id?: string | null
  recovery_command?: string | null
  recovery_receipt?: SeatContextReceipt | null
}): RuntimeMemoryReadyEvidenceInput {
  const completedAt = input.completed_at ?? new Date()
  const completedMs = dateMs(completedAt) ?? Date.now()
  const validForSeconds = input.valid_for_seconds ?? 1800
  const consumed = validateSeatContextReceipt(input.recovery_receipt, { agentId: input.agent_id, project: input.project, runtimeInstanceId: input.runtime_instance_id })
  return {
    agent_id: input.agent_id,
    project: input.project,
    runtime_instance_id: input.runtime_instance_id,
    profile_revision: input.profile_revision ?? null,
    profile_source: input.profile_source ?? null,
    session_name: input.session_name,
    port: input.port,
    expected_agent_id: input.agent_id,
    checkout_path: input.checkout_path ?? null,
    checkout_commit_sha: input.checkout_commit_sha ?? null,
    recovery_command: input.recovery_command ?? 'mcp__wasurezu__recover_context',
    result_status: consumed ? 'ready' : 'failed',
    failure_reason: consumed ? null : 'MEMORY_CONTEXT_RECOVERY_REQUIRED',
    completed_at: completedAt,
    evidence_path: input.evidence_path ?? null,
    evidence_log_id: input.evidence_log_id ?? null,
    valid_until: new Date(completedMs + validForSeconds * 1000),
    source: input.agent_id === 'wasurezu' || input.agent_id === 'agent-memory'
      ? 'wasurezu_boot_recovery'
      : 'agent_memory_boot_recovery',
    metadata: {
      seat_context_receipt: consumed ? input.recovery_receipt : null,
      bootstrap_without_aun_queue: true,
      live_discord_send: false,
      launchagent_mutation: false,
    },
  }
}


/** Record ordinary readiness only from independently validated current native
 * input. A sealed bootstrap receipt cannot be relabelled to this MCP UUID. */
export async function recordVerifiedNativeRuntimeMemoryReady(db: RuntimeMemoryReadyDb, input: {
  agentId: string; project: string; runtimeInstanceId: string; receipt: SeatContextReceipt
  now?: Date; validForSeconds?: number; observeProvider?: typeof observeSeatProvider; inspect?: HostRuntimeInspector; readNativeProof?: typeof readCurrentNativeProof
}): Promise<{ evidence_id: string | number | null; evidence_log_id: string | null }> {
  const now = input.now ?? new Date()
  if (!validateSeatContextReceipt(input.receipt, input)) throw new Error('MEMORY_NATIVE_RUNTIME_RECEIPT_MISMATCH')
  const native = input.receipt.native_delivery
  if (!native || native.agent_id !== input.agentId || native.project !== input.project
    || native.target_runtime !== input.receipt.target_runtime || native.input_sha256 !== input.receipt.invocation_digest
    || native.work_sha256 !== input.receipt.work_digest || seatContextDigest(native) !== input.receipt.response_digest) {
    throw new Error('MEMORY_NATIVE_RUNTIME_RECEIPT_MISMATCH')
  }
  const resolution = await resolveRuntimeMemoryReadyCurrent(db, {
    agentId: input.agentId, requestedRuntimeKind: 'local_process', now, inspect:input.inspect,
  })
  const runtime = resolution.current_runtime
  if (!resolution.ok || !runtime || runtime.runtime_instance_id !== input.runtimeInstanceId
    || runtime.runtime_kind !== 'local_process' || !runtime.session_name || !runtime.checkout_path) {
    throw new Error('MEMORY_NATIVE_CURRENT_RUNTIME_MISMATCH')
  }
  const endpoint = await resolveRuntimeEndpoint(db, {agentId:input.agentId,runtimeInstanceId:input.runtimeInstanceId,now,inspect:input.inspect})
  if (!endpoint.ok || !endpoint.endpoint || !endpoint.endpoint.processId) throw new Error('MEMORY_NATIVE_ENDPOINT_UNAVAILABLE')
  const observed = (input.observeProvider ?? observeSeatProvider)({agentId:input.agentId,runtimeInstanceId:input.runtimeInstanceId,
    processId:endpoint.endpoint.processId,sessionName:runtime.session_name,workspace:runtime.checkout_path,now})
  const saved = parseObject(parseObject(runtime.metadata).provider_observation)
  if (!observed || observed.verified !== true || observed.provider !== native.target_runtime
    || observed.provider_pid !== native.provider_pid || observed.provider_started_at !== native.provider_started_at
    || (observed.host_session_id && observed.host_session_id !== native.host_session_id)
    || createHash('sha256').update(observed.workspace).digest('hex') !== native.workspace_sha256
    || saved.verified !== true || saved.runtime_instance_id !== input.runtimeInstanceId || saved.agent_id !== input.agentId
    || saved.process_id !== endpoint.endpoint.processId || saved.provider_pid !== observed.provider_pid
    || saved.provider_started_at !== observed.provider_started_at || saved.provider !== observed.provider
    || saved.workspace !== observed.workspace) throw new Error('MEMORY_NATIVE_CURRENT_PROVIDER_MISMATCH')
  const recorded = await recordRuntimeMemoryReadyEvidence(db, buildWasurezuBootstrapEvidence({
    agent_id: input.agentId, project: input.project, runtime_instance_id: input.runtimeInstanceId,
    profile_revision: resolution.profile?.profile_revision ?? null, profile_source: resolution.profile?.profile_source ?? null,
    session_name: runtime.session_name, port: endpoint.endpoint.port, checkout_path: runtime.checkout_path,
    checkout_commit_sha: runtime.commit_sha, completed_at: input.receipt.completed_at,
    valid_for_seconds: input.validForSeconds, recovery_command: 'mcp:tools/call:native_context_delivery', recovery_receipt: input.receipt,
  }))
  const gate = await evaluateRuntimeMemoryReadyGate(db, {agent_id:input.agentId,project:input.project,now,requested_runtime_kind:'local_process',inspect:input.inspect,readNativeProof:input.readNativeProof})
  if (!gate.ok) throw new Error(`MEMORY_NATIVE_ORDINARY_GATE_FAILED:${gate.reason}`)
  return recorded
}
