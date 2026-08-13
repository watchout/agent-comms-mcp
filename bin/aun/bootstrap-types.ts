export const BOOTSTRAP_STAGES = [
  'B0_LOCK_AND_SNAPSHOT',
  'B1_DEPENDENCY_PREFLIGHT',
  'B2_DB_MIGRATION',
  'B3_AGENT_PROFILE',
  'B4_MCP_REGISTRATION',
  'B5_MEMORY_READINESS',
  'B6_ORDINARY_DAEMON_INSTALL_START',
  'B7_QUEUE_SMOKE',
  'B8_READY_READBACK',
] as const

export type BootstrapStage = typeof BOOTSTRAP_STAGES[number]
export type BootstrapRequestedRuntime = 'auto' | 'codex' | 'claude'
export type BootstrapResolvedRuntime = Exclude<BootstrapRequestedRuntime, 'auto'>
export type BootstrapTerminalStatus =
  | 'PLANNED'
  | 'READY'
  | 'IDEMPOTENT_READY'
  | 'NO_GO'
  | 'ROLLED_BACK'
  | 'PARTIAL_ROLLBACK_NO_GO'

export type BootstrapReasonCode =
  | 'NO_GO_BOOTSTRAP_BUSY'
  | 'NO_GO_PRESTATE_UNREADABLE'
  | 'NO_GO_DEPENDENCY_MISSING'
  | 'NO_GO_VERSION_UNSUPPORTED'
  | 'NO_GO_RUNTIME_UNDETECTED'
  | 'NO_GO_RUNTIME_AMBIGUOUS'
  | 'NO_GO_DB_CONNECT'
  | 'NO_GO_DB_MIGRATION'
  | 'NO_GO_DESTRUCTIVE_MIGRATION_GATE'
  | 'NO_GO_PROFILE_CONFLICT'
  | 'NO_GO_IDENTITY_MISMATCH'
  | 'NO_GO_PORT_CONFLICT'
  | 'NO_GO_MCP_REGISTRATION'
  | 'NO_GO_MCP_READBACK'
  | 'NO_GO_PROVIDER_ADAPTER_MISMATCH'
  | 'NO_GO_PROVIDER_ROOT_AUTHORITY_MISSING'
  | 'NO_GO_PROVIDER_ROOT_CONFLICT'
  | 'NO_GO_PROVIDER_NATIVE_JSON_INVALID'
  | 'NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS'
  | 'NO_GO_MEMORY_RECOVERY'
  | 'NO_GO_RUNTIME_RECEIPT'
  | 'NO_GO_INSTALL_PLAN'
  | 'NO_GO_DAEMON_START'
  | 'NO_GO_PORT_WRONG_IDENTITY'
  | 'NO_GO_TUI_WEDGED'
  | 'NO_GO_QUEUE_ENQUEUE'
  | 'NO_GO_QUEUE_NO_PROGRESS'
  | 'NO_GO_QUEUE_ORDINARY_RECEIVE_UNPROVEN'
  | 'NO_GO_DUPLICATE_CLAIM'
  | 'NO_GO_DUPLICATE_RUNNER'
  | 'NO_GO_SMOKE_NOT_TERMINAL'
  | 'NO_GO_READBACK_STALE'
  | 'NO_GO_READY_PREDICATE_FALSE'
  | 'NO_GO_STAGE_TIMEOUT'
  | 'NO_GO_CHILD_EXIT_UNCONFIRMED'
  | 'NO_GO_RESUME_INPUT_MISMATCH'
  | 'NO_GO_RESUME_REVALIDATION'
  | 'NO_GO_POST_MUTATION_READBACK'
  | 'NO_GO_RUN_NOT_FOUND'
  | 'NO_GO_ROLLBACK_UNVERIFIED'

export type BootstrapCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  pid?: number
}

export type BootstrapMutation = {
  mutation_id: string
  stage: BootstrapStage
  kind: 'db' | 'profile' | 'workspace_authority' | 'configuration_desired' | 'mcp_registration' | 'memory_readiness' | 'daemon' | 'queue_smoke' | 'configuration'
  owner_key: string
  before_digest: string | null
  intended_after_digest: string | null
  actual_after_digest: string | null
  rollback_action: string
  rollback_status: 'not_run' | 'attempting' | 'verified' | 'failed' | 'skipped'
  rollback_payload?: Record<string, unknown>
}

export type BootstrapStageRecord = {
  stage: BootstrapStage
  status: 'pending' | 'planned' | 'passed' | 'failed' | 'rolled_back'
  started_at: string | null
  completed_at: string | null
  reason_codes: BootstrapReasonCode[]
  evidence_refs: string[]
  readiness_predicates: Record<string, boolean>
  readback_digest: string | null
  seal_digest: string | null
}

export type BootstrapRunState = {
  schema_version: 'shirube-v3/aun-bootstrap-run/v1'
  run_id: string
  agent_id: string
  requested_runtime: BootstrapRequestedRuntime
  resolved_runtime: BootstrapResolvedRuntime | null
  input_digest: string
  repo_root: string
  workspace_root: string
  repo_head: string | null
  created_at: string
  updated_at: string
  terminal_status: BootstrapTerminalStatus | null
  lock_release_authorized_at: string | null
  lock_released_at: string | null
  stages: BootstrapStageRecord[]
  mutations: BootstrapMutation[]
  mutation_manifest_digest: string
  readback_bindings: {
    source_run_id: string
    runtime_instance_id: string | null
    queue_id: string | null
  } | null
  evidence_refs: string[]
  safe_D1_readback: BootstrapSafeD1Readback
}

export type BootstrapSafeD1Readback = {
  SHIRUBE_D1_ENABLED: '0'
  SHIRUBE_D1_KILL_SWITCH: '1'
  SHIRUBE_D1_TARGET_ALLOWLIST: '[]'
  STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0'
}

export type BootstrapStageOutcome = {
  ok: boolean
  reasonCodes?: BootstrapReasonCode[]
  evidenceRefs?: string[]
  readinessPredicates?: Record<string, boolean>
  /** Canonical digest of the live native target readback for stage sealing/resume. */
  readbackDigest?: string
  mutation?: Omit<BootstrapMutation, 'mutation_id' | 'stage' | 'rollback_status'>
  /** Ordered mutations performed by one compound stage. */
  mutations?: Array<Omit<BootstrapMutation, 'mutation_id' | 'stage' | 'rollback_status'>>
  resolvedRuntime?: BootstrapResolvedRuntime
}

export type BootstrapStageContext = {
  runId: string
  agentId: string
  requestedRuntime: BootstrapRequestedRuntime
  resolvedRuntime: BootstrapResolvedRuntime | null
  repoRoot: string
  workspaceRoot: string
  repoHead: string | null
  dryRun: boolean
  env: Record<string, string>
  priorState: BootstrapRunState
  abortSignal?: AbortSignal
  /**
   * Persist an exact rollback admission before a stage makes its first
   * protected external mutation. The runner owns the durable journal; stage
   * adapters only describe the intended fence.
   */
  admitRecoveryMutation?: (
    mutation: Omit<BootstrapMutation, 'mutation_id' | 'stage' | 'rollback_status'>,
  ) => void
  /** Remove an admission only after native readback proves no mutation occurred. */
  cancelRecoveryAdmission?: (ownerKey: string) => void
  providerRootAuthority?: {
    existingTarget: boolean
    canonicalSourceField: 'metadata.codex_home' | 'clean_host_default'
    canonicalRoot: string
    canonicalRootDigest: string
    canonicalRealpathDigest: string
    projectionMatches: boolean
    callerMismatch: boolean
    authorityTupleDigest?: string
  }
}

export interface BootstrapExecutionPorts {
  lockAndSnapshot(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  dependencyPreflight(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  migrateDatabase(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  ensureAgentProfile(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  ensureMcpRegistration(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  ensureMemoryReadiness(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  installAndStartDaemon(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  runQueueSmoke(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  readbackReady(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  revalidateStage?(context: BootstrapStageContext, stage: BootstrapStage): Promise<BootstrapStageOutcome>
  rollbackMutation(context: BootstrapStageContext, mutation: BootstrapMutation): Promise<BootstrapStageOutcome>
}

export interface BootstrapRuntimeAdapter {
  readonly runtime: BootstrapResolvedRuntime
  dependencyPreflight(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  planMcpRegistration(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  applyMcpRegistration(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  readbackMcpRegistration(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  planRuntimeStart(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  verifyRuntimeIdentity(context: BootstrapStageContext): Promise<BootstrapStageOutcome>
  rollbackRuntimeRegistration(context: BootstrapStageContext, mutation: BootstrapMutation): Promise<BootstrapStageOutcome>
  finalizeRuntimeRegistration?(context: BootstrapStageContext, mutation: BootstrapMutation): Promise<BootstrapStageOutcome>
}

export type BootstrapOptions = {
  agentId: string
  runtime: BootstrapRequestedRuntime
  dryRun?: boolean
  json?: boolean
  resumeRunId?: string
  rollbackRunId?: string
  home?: string
  repoRoot?: string
  workspaceRoot?: string
  env?: NodeJS.ProcessEnv
}

export type BootstrapResult = {
  schema_version: 'shirube-v3/aun-bootstrap-result/v1'
  run_id: string
  agent_id: string
  requested_runtime: BootstrapRequestedRuntime
  resolved_runtime: BootstrapResolvedRuntime | null
  stage: BootstrapStage
  status: BootstrapTerminalStatus
  reason_codes: BootstrapReasonCode[]
  mutation_manifest_sha256: string
  rollback_manifest_sha256: string
  readiness_predicates: Record<string, boolean>
  evidence_refs: string[]
  safe_D1_readback: BootstrapSafeD1Readback
  next_action: {
    blocking: boolean
    actor_agent_id: string | null
    action: string
    deliver_via: string
    exact_input_refs: string[]
  }
}
