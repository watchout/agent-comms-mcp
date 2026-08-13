import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export type RuntimeMemoryReadyStatus = 'ready' | 'failed' | 'bypassed'

export type RuntimeMemoryReadySource =
  | 'wasurezu_boot_recovery'
  | 'agent_memory_boot_recovery'
  | 'explicit_operator_bypass'
  | string

export type RuntimeMemoryReadyDb = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null } | T[]>
}

export type RuntimeMemoryReadyProjectSource =
  | 'active_primary_workspace'
  | 'canonical_workspace'
  | 'home_directory'

export type RuntimeMemoryReadyProjectResolutionErrorCode =
  | 'agent_mapping_missing'
  | 'primary_workspace_ambiguous'
  | 'workspace_path_missing'
  | 'workspace_path_invalid'
  | 'workspace_path_not_found'
  | 'workspace_path_not_directory'
  | 'workspace_path_realpath_failed'
  | 'workspace_resolution_drift'
  | 'authority_tuple_missing'
  | 'authority_tuple_invalid'
  | 'authority_tuple_drift'
  | 'workspace_resolution_token_invalid'
  | 'project_override_ambiguous'
  | 'project_override_mismatch'

export class RuntimeMemoryReadyProjectResolutionError extends Error {
  constructor(
    readonly code: RuntimeMemoryReadyProjectResolutionErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: runtime memory-ready project resolution failed`)
    this.name = 'RuntimeMemoryReadyProjectResolutionError'
  }
}

export interface RuntimeMemoryReadyProjectResolution {
  readonly agent_id: string
  readonly project: string
  /** Canonical realpath retained under the established field name. */
  readonly workspace_path: string
  readonly canonical_workspace_path: string
  readonly workspace_id: string | null
  readonly source: RuntimeMemoryReadyProjectSource
  readonly explicit_project: string | null
  /** Fresh authority digest populated only by a successful memory-ready gate. */
  readonly authority_tuple_digest?: string | null
}

interface RuntimeMemoryReadyProjectAgentRow {
  agent_id: string
  canonical_workspace?: string | null
  home_directory?: string | null
}

interface RuntimeMemoryReadyPrimaryWorkspaceRow {
  workspace_id: string
  local_path: string | null
}

function normalizedProjectOverride(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function canonicalWorkspacePath(
  agentId: string,
  workspacePath: string,
  source: RuntimeMemoryReadyProjectSource,
): string {
  if (!isAbsolute(workspacePath)) {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_invalid', {
      agent_id: agentId,
      workspace_path: workspacePath,
      source,
    })
  }
  if (!existsSync(workspacePath)) {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_not_found', {
      agent_id: agentId,
      workspace_path: workspacePath,
      source,
    })
  }
  let canonicalPath: string
  try {
    canonicalPath = realpathSync(workspacePath)
  } catch (error) {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_realpath_failed', {
      agent_id: agentId,
      workspace_path: workspacePath,
      source,
      error: (error as Error)?.message ?? String(error),
    })
  }
  if (!isAbsolute(canonicalPath)) {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_invalid', {
      agent_id: agentId,
      workspace_path: workspacePath,
      canonical_workspace_path: canonicalPath,
      source,
    })
  }
  try {
    if (!statSync(canonicalPath).isDirectory()) {
      throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_not_directory', {
        agent_id: agentId,
        workspace_path: workspacePath,
        canonical_workspace_path: canonicalPath,
        source,
      })
    }
  } catch (error) {
    if (error instanceof RuntimeMemoryReadyProjectResolutionError) throw error
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_realpath_failed', {
      agent_id: agentId,
      workspace_path: workspacePath,
      canonical_workspace_path: canonicalPath,
      source,
      error: (error as Error)?.message ?? String(error),
    })
  }
  return canonicalPath
}

const RUNTIME_MEMORY_READY_RESOLUTION_IDENTITY_FIELDS = [
  'agent_id',
  'project',
  'source',
  'workspace_id',
  'canonical_workspace_path',
] as const

/** Fail closed when the authoritative workspace changes after the pre-gate. */
export function assertRuntimeMemoryReadyProjectResolutionCurrent(
  expected: RuntimeMemoryReadyProjectResolution,
  current: RuntimeMemoryReadyProjectResolution,
): void {
  const changed_fields = RUNTIME_MEMORY_READY_RESOLUTION_IDENTITY_FIELDS.filter(
    (field) => expected[field] !== current[field],
  )
  if (changed_fields.length === 0) return
  throw new RuntimeMemoryReadyProjectResolutionError('workspace_resolution_drift', {
    agent_id: expected.agent_id,
    changed_fields,
    expected: Object.fromEntries(
      RUNTIME_MEMORY_READY_RESOLUTION_IDENTITY_FIELDS.map((field) => [field, expected[field]]),
    ),
    current: Object.fromEntries(
      RUNTIME_MEMORY_READY_RESOLUTION_IDENTITY_FIELDS.map((field) => [field, current[field]]),
    ),
  })
}

/** Parse the immutable pre-gate token propagated to a runner child. */
export function runtimeMemoryReadyProjectResolutionFromEnv(
  env: Record<string, string | undefined>,
): RuntimeMemoryReadyProjectResolution | null {
  const raw = env.AUN_MEMORY_READY_RESOLUTION_JSON?.trim()
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_resolution_token_invalid', {
      reason: 'invalid_json',
      error: (error as Error)?.message ?? String(error),
    })
  }
  const token = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const agentId = normalizedProjectOverride(token?.agent_id)
  const project = normalizedProjectOverride(token?.project)
  const workspacePath = normalizedProjectOverride(token?.workspace_path)
  const canonicalPath = normalizedProjectOverride(token?.canonical_workspace_path)
  const source = normalizedProjectOverride(token?.source)
  const workspaceId = token?.workspace_id === null
    ? null
    : normalizedProjectOverride(token?.workspace_id)
  const explicitProject = token?.explicit_project === null
    ? null
    : normalizedProjectOverride(token?.explicit_project)
  const authorityTupleDigest = token?.authority_tuple_digest === null
    ? null
    : normalizedProjectOverride(token?.authority_tuple_digest)
  if (
    !agentId
    || !project
    || !workspacePath
    || !canonicalPath
    || workspacePath !== canonicalPath
    || !isAbsolute(canonicalPath)
    || basename(canonicalPath) !== project
    || !source
    || (token?.workspace_id !== null && !workspaceId)
    || (token?.explicit_project !== null && token?.explicit_project !== undefined && !explicitProject)
    || !authorityTupleDigest
  ) {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_resolution_token_invalid', {
      reason: 'invalid_shape',
      agent_id: agentId,
      project,
      workspace_path: workspacePath,
      canonical_workspace_path: canonicalPath,
      workspace_id: workspaceId,
      source,
    })
  }
  return Object.freeze({
    agent_id: agentId,
    project,
    workspace_path: workspacePath,
    canonical_workspace_path: canonicalPath,
    workspace_id: workspaceId,
    source,
    explicit_project: explicitProject,
    authority_tuple_digest: authorityTupleDigest,
  })
}

export function runtimeMemoryReadyProjectOverrideFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  const candidates = [
    normalizedProjectOverride(env.AGENT_MEMORY_PROJECT),
    normalizedProjectOverride(env.AGENT_COMMS_MEMORY_READY_PROJECT),
  ].filter((value): value is string => value !== null)
  const unique = [...new Set(candidates)]
  if (unique.length > 1) {
    throw new RuntimeMemoryReadyProjectResolutionError('project_override_ambiguous', {
      configured_projects: unique,
    })
  }
  return unique[0] ?? null
}

/**
 * Resolve the memory-readiness project from the same target workspace basename
 * used by bootstrap/recovery. A single active primary binding is authoritative;
 * canonical_workspace (or its legacy home_directory projection) is the only
 * fallback. Explicit project env is an equality assertion, never a way to
 * select evidence from a different project.
 */
export async function resolveRuntimeMemoryReadyProject(
  db: RuntimeMemoryReadyDb,
  input: { agent_id: string; explicit_project?: string | null; require_enabled?: boolean },
): Promise<RuntimeMemoryReadyProjectResolution> {
  const enabledPredicate = input.require_enabled === false
    ? ''
    : `
        AND a.profile_enabled = true
        AND a.disabled_at IS NULL`
  const agentRows = await queryRows<RuntimeMemoryReadyProjectAgentRow>(
    db,
    `SELECT a.*
       FROM agents a
      WHERE a.agent_id = $1
      ${enabledPredicate}
      LIMIT 2`,
    [input.agent_id],
  )
  if (agentRows.length !== 1) {
    throw new RuntimeMemoryReadyProjectResolutionError('agent_mapping_missing', {
      agent_id: input.agent_id,
      enabled_agent_rows: agentRows.length,
    })
  }

  const primaryRows = await queryRows<RuntimeMemoryReadyPrimaryWorkspaceRow>(
    db,
    `SELECT w.workspace_id, w.local_path
       FROM agent_workspace_bindings b
       JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
      WHERE b.agent_id = $1
        AND b.active = true
        AND b.binding_role = 'primary'
      ORDER BY w.workspace_id
      LIMIT 2`,
    [input.agent_id],
  )
  if (primaryRows.length > 1) {
    throw new RuntimeMemoryReadyProjectResolutionError('primary_workspace_ambiguous', {
      agent_id: input.agent_id,
      workspace_ids: primaryRows.map((row) => row.workspace_id),
    })
  }

  const agent = agentRows[0]!
  const primaryPath = normalizedProjectOverride(primaryRows[0]?.local_path)
  const canonicalPath = normalizedProjectOverride(agent.canonical_workspace)
  const legacyHomePath = normalizedProjectOverride(agent.home_directory)
  const workspacePath = primaryRows.length === 1
    ? primaryPath
    : canonicalPath ?? legacyHomePath
  const source: RuntimeMemoryReadyProjectSource = primaryRows.length === 1
    ? 'active_primary_workspace'
    : canonicalPath
      ? 'canonical_workspace'
      : 'home_directory'
  if (!workspacePath) {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_missing', {
      agent_id: input.agent_id,
      primary_binding_present: primaryRows.length === 1,
      canonical_workspace_present: canonicalPath !== null,
      home_directory_present: legacyHomePath !== null,
    })
  }
  const resolvedWorkspacePath = canonicalWorkspacePath(input.agent_id, workspacePath, source)
  const project = basename(resolvedWorkspacePath)
  if (!project || project === '.' || project === '..') {
    throw new RuntimeMemoryReadyProjectResolutionError('workspace_path_invalid', {
      agent_id: input.agent_id,
      workspace_path: workspacePath,
      canonical_workspace_path: resolvedWorkspacePath,
      source,
    })
  }

  const explicitProject = normalizedProjectOverride(input.explicit_project)
  if (explicitProject && explicitProject !== project) {
    throw new RuntimeMemoryReadyProjectResolutionError('project_override_mismatch', {
      agent_id: input.agent_id,
      configured_project: explicitProject,
      derived_project: project,
      workspace_path: resolvedWorkspacePath,
      source,
    })
  }
  return Object.freeze({
    agent_id: input.agent_id,
    project,
    workspace_path: resolvedWorkspacePath,
    canonical_workspace_path: resolvedWorkspacePath,
    workspace_id: primaryRows[0]?.workspace_id ?? null,
    source,
    explicit_project: explicitProject,
  })
}

export interface RuntimeMemoryReadyAuthoritySnapshot {
  schema: 'aun.runtime-memory-authority.v1'
  tuple_digest: string
  agent_id: string
  project: string
  workspace_id: string
  workspace_realpath: string
  workspace_owner_uid: number
  workspace_owner_gid: number
  runtime_instance_id: string
  profile_revision: number
  profile_source: string
  session_name: string
  port: number
  runtime_engine: string
  runtime_kind: string
  transport_digest: string
  git_toplevel_realpath: string
  git_commit_sha: string
  git_tree_sha: string
  git_clean: true
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
  message_id?: string | number | null
  created_at?: string | Date | null
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
    | 'missing_read_model'
    | 'missing_evidence'
    | 'not_ready'
    | 'expired'
    | 'runtime_instance_mismatch'
    | 'expected_agent_id_mismatch'
    | 'project_mismatch'
    | 'project_resolution_failed'
    | 'authority_tuple_invalid'
    | 'authority_tuple_mismatch'
    | 'queue_scope_mismatch'
    | 'session_mismatch'
    | 'port_mismatch'
    | 'profile_revision_mismatch'
    | 'profile_source_mismatch'
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
  /** Immutable authoritative workspace token captured by the pre-gate. */
  project_resolution?: RuntimeMemoryReadyProjectResolution | null
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
  workspace_id: string | null
  runtime_engine: string | null
  runtime_kind: string | null
  host_id: string | null
  session_name: string | null
  port: number | string | null
  checkout_path: string | null
  commit_sha: string | null
  endpoint_uri: string | null
  started_at: string | Date | null
  last_seen_at: string | Date | null
  status: string | null
  metadata: unknown
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

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function trustedGit(workspace: string, args: string[]): string {
  try {
    return execFileSync('/usr/bin/git', [
      '--no-optional-locks',
      '--no-replace-objects',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'diff.external=',
      '-C', workspace,
      ...args,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        HOME: '/var/empty',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }).trim()
  } catch (error) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'trusted_git_failed',
      workspace,
      git_args: args,
      error: (error as Error)?.message ?? String(error),
    })
  }
}

function requiredText(value: unknown, field: string): string {
  const normalized = normalizeText(value)
  if (normalized) return normalized
  throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
    reason: 'required_field_missing',
    field,
  })
}

function requiredNumber(value: unknown, field: string): number {
  const normalized = normalizeNumber(value)
  if (normalized !== null) return normalized
  throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
    reason: 'required_field_missing',
    field,
  })
}

function requiredInteger(
  value: unknown,
  field: string,
  input: { min: number; max?: number },
): number {
  const normalized = normalizeNumber(value)
  if (normalized !== null && Number.isSafeInteger(normalized)
    && normalized >= input.min && (input.max === undefined || normalized <= input.max)) return normalized
  throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
    reason: 'required_integer_invalid',
    field,
    value: normalized,
    min: input.min,
    max: input.max ?? null,
  })
}

/**
 * Capture the complete per-target authority tuple from authoritative DB, FS,
 * runtime and git sources. No caller-supplied path or nullable fallback is
 * accepted here.
 */
export async function captureRuntimeMemoryReadyAuthority(
  db: RuntimeMemoryReadyDb,
  expected: RuntimeMemoryReadyProjectResolution,
): Promise<RuntimeMemoryReadyAuthoritySnapshot> {
  const currentResolution = await resolveRuntimeMemoryReadyProject(db, {
    agent_id: expected.agent_id,
    explicit_project: expected.explicit_project,
    require_enabled: false,
  })
  assertRuntimeMemoryReadyProjectResolutionCurrent(expected, currentResolution)
  if (currentResolution.source !== 'active_primary_workspace' || !currentResolution.workspace_id) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'active_primary_workspace_required',
      source: currentResolution.source,
      workspace_id: currentResolution.workspace_id,
    })
  }

  const agentRows = await queryRows<AgentProfileRow>(
    db,
    `SELECT agent_id, profile_revision, profile_source, channel_port, home_directory, metadata
       FROM agents
      WHERE agent_id = $1
        AND profile_enabled = true
        AND disabled_at IS NULL
      LIMIT 2`,
    [expected.agent_id],
  )
  if (agentRows.length !== 1) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'enabled_agent_profile_cardinality',
      rows: agentRows.length,
    })
  }
  const runtimeRows = await queryRows<RuntimeRow>(
    db,
    `SELECT runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind,
            host_id, session_name, port, checkout_path, commit_sha, endpoint_uri,
            started_at, last_seen_at, status, metadata
       FROM agent_runtime_instances
      WHERE agent_id = $1
        AND status IN ('running', 'active')
      ORDER BY COALESCE(last_seen_at, started_at) DESC, started_at DESC
      LIMIT 2`,
    [expected.agent_id],
  )
  if (runtimeRows.length !== 1) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'active_runtime_cardinality',
      rows: runtimeRows.length,
    })
  }
  const agent = agentRows[0]!
  const runtime = runtimeRows[0]!
  const runtimeWorkspaceId = requiredText(runtime.workspace_id, 'runtime.workspace_id')
  if (runtimeWorkspaceId !== currentResolution.workspace_id) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'runtime_workspace_id_mismatch',
      expected_workspace_id: currentResolution.workspace_id,
      runtime_workspace_id: runtimeWorkspaceId,
    })
  }
  const checkoutPath = requiredText(runtime.checkout_path, 'runtime.checkout_path')
  if (!isAbsolute(checkoutPath) || !existsSync(checkoutPath)) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'runtime_checkout_invalid',
      checkout_path: checkoutPath,
    })
  }
  const checkoutRealpath = canonicalWorkspacePath(expected.agent_id, checkoutPath, 'active_primary_workspace')
  if (checkoutRealpath !== currentResolution.canonical_workspace_path) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'runtime_checkout_realpath_mismatch',
      runtime_checkout_realpath: checkoutRealpath,
      workspace_realpath: currentResolution.canonical_workspace_path,
    })
  }

  const gitToplevel = trustedGit(currentResolution.canonical_workspace_path, ['rev-parse', '--show-toplevel'])
  const gitToplevelRealpath = canonicalWorkspacePath(expected.agent_id, gitToplevel, 'active_primary_workspace')
  if (gitToplevelRealpath !== currentResolution.canonical_workspace_path) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'git_toplevel_realpath_mismatch',
      git_toplevel_realpath: gitToplevelRealpath,
      workspace_realpath: currentResolution.canonical_workspace_path,
    })
  }
  const gitCommit = trustedGit(gitToplevelRealpath, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const gitTree = trustedGit(gitToplevelRealpath, ['rev-parse', '--verify', 'HEAD^{tree}'])
  const dirty = trustedGit(gitToplevelRealpath, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'git_worktree_dirty',
    })
  }
  const runtimeCommit = requiredText(runtime.commit_sha, 'runtime.commit_sha')
  if (runtimeCommit !== gitCommit) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'runtime_commit_mismatch',
      runtime_commit_sha: runtimeCommit,
      git_commit_sha: gitCommit,
    })
  }

  const runtimeMetadata = parseObject(runtime.metadata)
  const transportTuple = {
    runtime_engine: requiredText(runtime.runtime_engine, 'runtime.runtime_engine'),
    runtime_kind: requiredText(runtime.runtime_kind, 'runtime.runtime_kind'),
    host_id: normalizeText(runtime.host_id),
    endpoint_uri: normalizeText(runtime.endpoint_uri),
    runtime_transport_token: requiredText(
      runtimeMetadata.transport_tuple_digest ?? runtimeMetadata.tuple_digest,
      'runtime.metadata.transport_tuple_digest|tuple_digest',
    ),
  }
  const owner = statSync(currentResolution.canonical_workspace_path)
  const tupleWithoutDigest = {
    schema: 'aun.runtime-memory-authority.v1' as const,
    agent_id: expected.agent_id,
    project: currentResolution.project,
    workspace_id: currentResolution.workspace_id,
    workspace_realpath: currentResolution.canonical_workspace_path,
    workspace_owner_uid: owner.uid,
    workspace_owner_gid: owner.gid,
    runtime_instance_id: requiredText(runtime.runtime_instance_id, 'runtime.runtime_instance_id'),
    profile_revision: requiredInteger(agent.profile_revision, 'agent.profile_revision', { min: 0 }),
    profile_source: requiredText(agent.profile_source, 'agent.profile_source'),
    session_name: requiredText(runtime.session_name, 'runtime.session_name'),
    port: requiredInteger(runtime.port, 'runtime.port', { min: 1, max: 65_535 }),
    runtime_engine: transportTuple.runtime_engine,
    runtime_kind: transportTuple.runtime_kind,
    transport_digest: digestJson(transportTuple),
    git_toplevel_realpath: gitToplevelRealpath,
    git_commit_sha: gitCommit,
    git_tree_sha: gitTree,
    git_clean: true as const,
  }
  if (requiredInteger(agent.channel_port, 'agent.channel_port', { min: 1, max: 65_535 }) !== tupleWithoutDigest.port) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'agent_runtime_port_mismatch',
      agent_port: normalizeNumber(agent.channel_port),
      runtime_port: tupleWithoutDigest.port,
    })
  }
  return Object.freeze({ ...tupleWithoutDigest, tuple_digest: digestJson(tupleWithoutDigest) })
}

/** Re-read every authority source immediately before a protected boundary. */
export async function assertRuntimeMemoryReadyAuthorityCurrent(
  db: RuntimeMemoryReadyDb,
  expected: RuntimeMemoryReadyProjectResolution,
): Promise<RuntimeMemoryReadyAuthoritySnapshot> {
  const expectedDigest = normalizeText(expected.authority_tuple_digest)
  if (!expectedDigest) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_missing', {
      agent_id: expected.agent_id,
    })
  }
  const current = await captureRuntimeMemoryReadyAuthority(db, expected)
  if (current.tuple_digest !== expectedDigest) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_drift', {
      agent_id: expected.agent_id,
      expected_authority_tuple_digest: expectedDigest,
      current_authority_tuple_digest: current.tuple_digest,
    })
  }
  return current
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
    scopeValues(scope, 'message_id', 'message_ids').length > 0 ||
    textValues(scope.created_at).length > 0 ||
    textValues(scope.created_after).length > 0 ||
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
  const hasCreatedAfter = Object.prototype.hasOwnProperty.call(scope, 'created_after')
  const hasCreatedAt = Object.prototype.hasOwnProperty.call(scope, 'created_at')
  const createdAt = dateMs(current.created_at)
  const createdAfter = dateMs(scope.created_after)
  if ((hasCreatedAfter && createdAfter === null) || (hasCreatedAt && dateMs(scope.created_at) === null)) return false
  if (createdAfter !== null && (createdAt === null || createdAt < createdAfter)) return false
  return scopeConstraintMatches(scopeValues(scope, 'queue_id', 'queue_ids'), normalizeIdentifier(current.queue_id)) &&
    scopeConstraintMatches(scopeValues(scope, 'message_id', 'message_ids'), normalizeIdentifier(current.message_id)) &&
    scopeConstraintMatches(textValues(scope.created_at), normalizeDateIso(current.created_at)) &&
    scopeConstraintMatches(scopeValues(scope, 'status', 'statuses'), normalizeText(current.status)) &&
    scopeConstraintMatches(scopeValues(scope, 'action_kind', 'action_kinds'), normalizeText(current.action_kind))
}

function exactReadyQueueScopeMatches(
  scope: Record<string, unknown>,
  current: RuntimeMemoryReadyQueueScopeInput | null | undefined,
): boolean {
  if (!current) return false
  const queueIds = scopeValues(scope, 'queue_id', 'queue_ids')
  const messageIds = scopeValues(scope, 'message_id', 'message_ids')
  const currentMessageId = normalizeIdentifier(current.message_id)
  // A queue-scoped ready receipt is an incarnation fence, not a broad
  // allowlist. The creation lower bound is mandatory so a recycled/imported
  // queue identity cannot inherit older evidence.
  return queueIds.length === 1
    && (currentMessageId === null ? messageIds.length === 0 : messageIds.length === 1)
    && Object.prototype.hasOwnProperty.call(scope, 'created_after')
    && dateMs(scope.created_after) !== null
    && queueScopeMatches(scope, current)
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
  session_name TEXT NOT NULL,
  port INTEGER NOT NULL,
  expected_agent_id TEXT NOT NULL,
  checkout_path TEXT,
  checkout_commit_sha TEXT,
  recovery_command TEXT NOT NULL,
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
  session_name TEXT NOT NULL,
  port INTEGER NOT NULL,
  expected_agent_id TEXT NOT NULL,
  checkout_path TEXT,
  checkout_commit_sha TEXT,
  recovery_command TEXT NOT NULL,
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
  const resolution = await resolveRuntimeMemoryReadyProject(db, {
    agent_id: input.agent_id,
    explicit_project: input.project,
    require_enabled: false,
  })
  const authority = await captureRuntimeMemoryReadyAuthority(db, resolution)
  const suppliedIdentity = {
    runtime_instance_id: normalizeText(input.runtime_instance_id),
    profile_revision: normalizeNumber(input.profile_revision),
    profile_source: normalizeText(input.profile_source),
    session_name: normalizeText(input.session_name),
    port: normalizeNumber(input.port),
    expected_agent_id: normalizeText(input.expected_agent_id),
    checkout_path: normalizeText(input.checkout_path),
    checkout_commit_sha: normalizeText(input.checkout_commit_sha),
  }
  const expectedIdentity = {
    runtime_instance_id: authority.runtime_instance_id,
    profile_revision: authority.profile_revision,
    profile_source: authority.profile_source,
    session_name: authority.session_name,
    port: authority.port,
    expected_agent_id: authority.agent_id,
    checkout_path: authority.workspace_realpath,
    checkout_commit_sha: authority.git_commit_sha,
  }
  const identityDrift = Object.keys(expectedIdentity).filter(
    (field) => suppliedIdentity[field as keyof typeof suppliedIdentity] !== expectedIdentity[field as keyof typeof expectedIdentity],
  )
  if (identityDrift.length > 0) {
    throw new RuntimeMemoryReadyProjectResolutionError('authority_tuple_invalid', {
      reason: 'evidence_input_authority_mismatch',
      changed_fields: identityDrift,
      supplied: suppliedIdentity,
      expected: expectedIdentity,
    })
  }
  const metadata = JSON.stringify({
    ...(input.metadata ?? {}),
    memory_ready_authority: authority,
  })
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
      input.session_name,
      input.port,
      input.expected_agent_id,
      authority.workspace_realpath,
      authority.git_commit_sha,
      input.recovery_command,
      input.result_status,
      input.failure_reason ?? null,
      completedAt,
      input.evidence_path ?? null,
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
        evidence_path: input.evidence_path ?? null,
        evidence_log_id: input.evidence_log_id ?? null,
        authority_tuple_digest: authority.tuple_digest,
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
    project_resolution?: RuntimeMemoryReadyProjectResolution | null
    /** Select one durable receipt exactly when a caller owns its insert ID. */
    evidence_id?: string | number | null
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
    project_resolution: null as RuntimeMemoryReadyProjectResolution | null,
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

  const expectedPort = normalizeNumber(agent.channel_port)
  if (expectedPort !== null) {
    let occupants: RuntimeRow[]
    try {
      occupants = await queryRows<RuntimeRow>(
        db,
        `SELECT runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind, host_id,
                session_name, port, checkout_path, commit_sha, endpoint_uri,
                started_at, last_seen_at, status, metadata
           FROM agent_runtime_instances
          WHERE port = $1
            AND status IN ('running', 'active')
          ORDER BY agent_id, runtime_instance_id`,
        [expectedPort],
      )
    } catch (error) {
      return fail(base, 'read_error', {
        reason: 'active_port_occupant_read_failed',
        expected_port: expectedPort,
        error: (error as Error)?.message ?? String(error),
      })
    }
    if (occupants.length !== 1 || occupants[0]?.agent_id !== input.agent_id) {
      return fail(base, 'port_identity_mismatch', {
        expected_port: expectedPort,
        occupant_count: occupants.length,
        occupants: occupants.map((row) => ({
          agent_id: row.agent_id,
          runtime_instance_id: row.runtime_instance_id,
        })),
      })
    }
  }

  let authority: RuntimeMemoryReadyAuthoritySnapshot
  try {
    const resolution = input.project_resolution ?? await resolveRuntimeMemoryReadyProject(db, {
      agent_id: input.agent_id,
      explicit_project: input.project,
      require_enabled: false,
    })
    if (resolution.project !== input.project || resolution.agent_id !== input.agent_id) {
      return fail(base, 'project_mismatch', {
        resolved_project: resolution.project,
        resolved_agent_id: resolution.agent_id,
      })
    }
    authority = await captureRuntimeMemoryReadyAuthority(db, resolution)
    base.project_resolution = Object.freeze({
      ...resolution,
      authority_tuple_digest: authority.tuple_digest,
    })
    base.details = {
      authority_tuple_digest: authority.tuple_digest,
      workspace_id: authority.workspace_id,
      workspace_realpath: authority.workspace_realpath,
      git_commit_sha: authority.git_commit_sha,
      git_tree_sha: authority.git_tree_sha,
    }
  } catch (error) {
    const authorityError = error instanceof RuntimeMemoryReadyProjectResolutionError ? error : null
    return fail(base, 'authority_tuple_invalid', {
      authority_code: authorityError?.code ?? 'authority_tuple_read_error',
      ...(authorityError?.details ?? {}),
      error: (error as Error)?.message ?? String(error),
    })
  }

  const runtimeRows = await queryRows<RuntimeRow>(
    db,
    `SELECT runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind, host_id,
            session_name, port, checkout_path, commit_sha, endpoint_uri,
            started_at, last_seen_at, status, metadata
       FROM agent_runtime_instances
      WHERE agent_id = $1
        AND status IN ('running', 'active')
      ORDER BY COALESCE(last_seen_at, started_at) DESC, started_at DESC
      LIMIT 1`,
    [input.agent_id],
  ).catch(() => [])
  const runtime = runtimeRows[0] ?? null
  if (!runtime) return fail(base, 'missing_current_runtime')

  const currentRuntime: RuntimeMemoryReadyCurrentRuntime = {
    agent_id: input.agent_id,
    runtime_instance_id: normalizeText(runtime.runtime_instance_id),
    profile_revision: normalizeNumber(agent.profile_revision),
    profile_source: normalizeText(agent.profile_source),
    session_name: normalizeText(runtime.session_name),
    port: normalizeNumber(runtime.port),
    checkout_path: authority.workspace_realpath,
    commit_sha: authority.git_commit_sha,
    started_at: runtime.started_at,
    status: normalizeText(runtime.status),
  }
  const withRuntime = {
    ...base,
    runtime_instance_id: currentRuntime.runtime_instance_id,
    current_runtime: currentRuntime,
  }
  if (!currentRuntime.runtime_instance_id) return fail(withRuntime, 'missing_current_runtime')

  let evidenceRows: EvidenceRow[]
  try {
    const evidenceIdClause = input.evidence_id === undefined || input.evidence_id === null
      ? ''
      : ' AND id = $3'
    evidenceRows = await queryRows<EvidenceRow>(
      db,
      `SELECT id, agent_id, project, runtime_instance_id, profile_revision, profile_source,
              session_name, port, expected_agent_id, checkout_path, checkout_commit_sha,
              recovery_command, result_status, failure_reason, completed_at,
              evidence_path, evidence_log_id, valid_until, source, metadata
         FROM runtime_memory_ready_evidence
        WHERE agent_id = $1
          AND project = $2${evidenceIdClause}
        ORDER BY completed_at DESC, id DESC
        LIMIT 1`,
      input.evidence_id === undefined || input.evidence_id === null
        ? [input.agent_id, input.project]
        : [input.agent_id, input.project, input.evidence_id],
    )
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    const missing = /runtime_memory_ready_evidence|does not exist|no such table/i.test(msg)
    return fail(withRuntime, missing ? 'missing_read_model' : 'read_error', { error: msg })
  }
  const evidence = evidenceRows[0] ?? null
  if (!evidence) return fail(withRuntime, 'missing_evidence')

  const withEvidence = {
    ...withRuntime,
    evidence_id: evidence.id ?? null,
    evidence_path: evidence.evidence_path ?? null,
    evidence_log_id: evidence.evidence_log_id ?? null,
    source: evidence.source ?? null,
    valid_until: normalizeDateIso(evidence.valid_until),
  }
  if (evidence.project !== input.project) return fail(withEvidence, 'project_mismatch', { evidence_project: evidence.project })
  if (evidence.result_status !== 'ready' && evidence.result_status !== 'bypassed') {
    return fail(withEvidence, 'not_ready', {
      result_status: evidence.result_status,
      failure_reason: evidence.failure_reason,
    })
  }
  const validUntilMs = dateMs(evidence.valid_until)
  if (validUntilMs === null || validUntilMs <= now.getTime()) {
    return fail(withEvidence, 'expired')
  }
  if (evidence.runtime_instance_id !== currentRuntime.runtime_instance_id) {
    return fail(withEvidence, 'runtime_instance_mismatch', { evidence_runtime_instance_id: evidence.runtime_instance_id })
  }
  if (evidence.expected_agent_id !== expectedAgentId) {
    return fail(withEvidence, 'expected_agent_id_mismatch', {
      evidence_expected_agent_id: evidence.expected_agent_id,
      expected_agent_id: expectedAgentId,
    })
  }
  const evidenceMetadata = parseObject(evidence.metadata)
  const evidenceQueueScope = parseRequiredObject(evidenceMetadata.queue_scope)
  if (evidence.result_status !== 'bypassed' && evidenceQueueScope && !exactReadyQueueScopeMatches(evidenceQueueScope, input.queue_scope)) {
    return fail(withEvidence, 'queue_scope_mismatch', {
      evidence_queue_scope: evidenceQueueScope,
      current_queue_scope: input.queue_scope ?? null,
    })
  }
  const evidenceAuthority = parseRequiredObject(evidenceMetadata.memory_ready_authority)
  const authorityFields: Array<keyof RuntimeMemoryReadyAuthoritySnapshot> = [
    'schema', 'tuple_digest', 'agent_id', 'project', 'workspace_id', 'workspace_realpath',
    'workspace_owner_uid', 'workspace_owner_gid', 'runtime_instance_id', 'profile_revision',
    'profile_source', 'session_name', 'port', 'runtime_engine', 'runtime_kind',
    'transport_digest', 'git_toplevel_realpath', 'git_commit_sha', 'git_tree_sha', 'git_clean',
  ]
  const authorityMismatches = !evidenceAuthority
    ? authorityFields
    : authorityFields.filter((field) => evidenceAuthority[field] !== authority[field])
  if (authorityMismatches.length > 0) {
    return fail(withEvidence, 'authority_tuple_mismatch', {
      changed_fields: authorityMismatches,
      evidence_authority_tuple_digest: normalizeText(evidenceAuthority?.tuple_digest),
      current_authority_tuple_digest: authority.tuple_digest,
    })
  }
  const evidenceSession = normalizeText(evidence.session_name)
  if (evidenceSession !== currentRuntime.session_name || evidenceSession !== authority.session_name) {
    return fail(withEvidence, 'session_mismatch', {
      evidence_session_name: evidenceSession,
      runtime_session_name: currentRuntime.session_name,
    })
  }
  const evidencePort = normalizeNumber(evidence.port)
  if (evidencePort !== currentRuntime.port || evidencePort !== authority.port) {
    return fail(withEvidence, 'port_mismatch', {
      evidence_port: evidencePort,
      runtime_port: currentRuntime.port,
    })
  }
  const evidenceRevision = normalizeNumber(evidence.profile_revision)
  if (evidenceRevision !== currentRuntime.profile_revision || evidenceRevision !== authority.profile_revision) {
    return fail(withEvidence, 'profile_revision_mismatch', {
      evidence_profile_revision: evidenceRevision,
      runtime_profile_revision: currentRuntime.profile_revision,
    })
  }
  const evidenceProfileSource = normalizeText(evidence.profile_source)
  if (evidenceProfileSource !== currentRuntime.profile_source || evidenceProfileSource !== authority.profile_source) {
    return fail(withEvidence, 'profile_source_mismatch', {
      evidence_profile_source: evidenceProfileSource,
      runtime_profile_source: currentRuntime.profile_source,
    })
  }
  const evidenceCheckoutPath = normalizeText(evidence.checkout_path)
  if (evidenceCheckoutPath !== currentRuntime.checkout_path || evidenceCheckoutPath !== authority.workspace_realpath) {
    return fail(withEvidence, 'checkout_path_mismatch', {
      evidence_checkout_path: evidenceCheckoutPath,
      runtime_checkout_path: currentRuntime.checkout_path,
    })
  }
  const evidenceCommit = normalizeText(evidence.checkout_commit_sha)
  if (evidenceCommit !== currentRuntime.commit_sha || evidenceCommit !== authority.git_commit_sha) {
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
}): RuntimeMemoryReadyEvidenceInput {
  const completedAt = input.completed_at ?? new Date()
  const completedMs = dateMs(completedAt) ?? Date.now()
  const validForSeconds = input.valid_for_seconds ?? 1800
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
    result_status: 'ready',
    failure_reason: null,
    completed_at: completedAt,
    evidence_path: input.evidence_path ?? null,
    evidence_log_id: input.evidence_log_id ?? null,
    valid_until: new Date(completedMs + validForSeconds * 1000),
    source: input.agent_id === 'wasurezu' || input.agent_id === 'agent-memory'
      ? 'wasurezu_boot_recovery'
      : 'agent_memory_boot_recovery',
    metadata: {
      bootstrap_without_aun_queue: true,
      live_discord_send: false,
      launchagent_mutation: false,
    },
  }
}
