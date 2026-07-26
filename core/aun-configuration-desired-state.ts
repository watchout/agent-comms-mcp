import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DbAdapter } from './db'

export const AUN_CONFIGURATION_EVENT_TYPE = 'AUN_AGENT_CONFIGURATION_DESIRED_CHANGED' as const
export const AUN_CONFIGURATION_NOTIFY_CHANNEL = 'aun_configuration_desired_changed' as const
const RAW_SECRET = /(?:^|[^a-z])(?:gh[pousr]_|sk-|xox[baprs]-|Bearer\s+)[A-Za-z0-9_./+=-]{8,}/i

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export const AUN_CONFIGURATION_STATUSES = [
  'READY',
  'RECONCILING',
  'DEGRADED_APPROVAL_REQUIRED',
  'DEGRADED_DB_UNAVAILABLE',
  'DRIFTED',
  'NO_GO_STALE_CANDIDATE',
  'NO_GO_PARTIAL_APPLY',
  'NO_GO_ROLLBACK',
] as const

export type AunConfigurationStatus = typeof AUN_CONFIGURATION_STATUSES[number]

export interface AunConfigurationDesiredFields {
  profileEnabled: boolean
  runtimeEnginePreference: string
  canonicalWorkspace: string
  canonicalHome: string
  channelPort: number
  supervisorIdentity: string
  expectedProviderIdentityRef: string
  providerTokenSourceRef: string | null
  ordinaryCommunicationEnrollment: boolean
  ordinaryProjection: Record<string, unknown>
}

export interface AunConfigurationDesiredState extends AunConfigurationDesiredFields {
  agentId: string
  desiredRevision: number
  desiredDigest: string
  releaseCommit: string
  releaseTree: string
  controlRefs: string[]
  updatedAt: string | Date
  updatedBy: string
}

export interface AunConfigurationOutboxEvent {
  eventId: string
  agentId: string
  desiredRevision: number
  desiredDigest: string
  eventType: typeof AUN_CONFIGURATION_EVENT_TYPE
  createdAt: string | Date
  attemptCount: number
  availableAt: string | Date
  deliveredAt: string | Date | null
}

export interface AunConfigurationObservedState {
  hostId: string
  agentId: string
  observedRevision: number
  observedDesiredDigest: string
  candidateDigest: string
  releaseCommit: string
  releaseTree: string
  providerNativeDigest: string
  launchagentPlistDigest: string
  launchctlEnvironmentDigest: string
  runtimeIdentityDigest: string
  reconcileStatus: AunConfigurationStatus
  driftReasonCodes: string[]
  leaseId: string
  fencingToken: number
  observedAt?: string | Date
}

export interface AunConfigurationRestartRequest {
  requestId?: string
  hostId: string
  agentId: string
  fromRevision: number | null
  fromDigest: string | null
  toRevision: number
  toDigest: string
  candidateDigest: string
  rollbackArtifactDigest: string
  exactReleaseCommit: string
  exactReleaseTree: string
  exactControlRefs: string[]
  leaseId: string
  fencingToken: number
  restartBudget: 1
  status?: 'AWAITING_OWNER_DECISION' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'EXECUTING' | 'EXECUTED' | 'FAILED'
  ownerDecisionRef?: string | null
  ownerDecisionExpiresAt?: string | Date | null
  ctoExecutionReceiptRef?: string | null
}

export interface AunConfigurationRestartExecutionClaimInput {
  requestId: string
  hostId: string
  agentId: string
  toRevision: number
  toDigest: string
  candidateDigest: string
  rollbackArtifactDigest: string
  exactReleaseCommit: string
  exactReleaseTree: string
  exactControlRefs: string[]
  executionLeaseId: string
  executionFencingToken: number
  executorAgentId: string
}

export interface AunConfigurationRestartExecutionRecord extends AunConfigurationRestartExecutionClaimInput {
  restartBudget: 1
  status: 'EXECUTING'
  ownerDecisionRef: string
  ownerDecisionExpiresAt: string | Date
  ctoExecutionReceiptRef: string
  executionAttempt: 1
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function canonicalConfigurationJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function configurationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalConfigurationJson(value)).digest('hex')
}

function normalizeControlRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))].sort(compareUtf8)
}

function assertExactDigest(value: string, label: string, length: 40 | 64): void {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) throw new Error(`${label}_INVALID`)
}

function assertReference(value: string | null, label: string): void {
  if (value === null) return
  const trimmed = value.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) throw new Error(`${label}_INVALID`)
  if (/^(?:gh[pousr]_|sk-|xox[baprs]-|Bearer\s+)[A-Za-z0-9_./+=-]{8,}$/i.test(trimmed)) {
    throw new Error('RAW_SECRET_FORBIDDEN')
  }
}

function assertNoRawSecretValue(value: unknown): void {
  if (RAW_SECRET.test(canonicalConfigurationJson(value))) throw new Error('RAW_SECRET_FORBIDDEN')
}

export function canonicalDesiredDocument(
  desired: Omit<AunConfigurationDesiredState, 'desiredRevision' | 'desiredDigest' | 'updatedAt' | 'updatedBy'>,
): Record<string, unknown> {
  if (!desired.agentId.trim()) throw new Error('AGENT_ID_REQUIRED')
  if (!Number.isSafeInteger(desired.channelPort) || desired.channelPort < 1 || desired.channelPort > 65_535) {
    throw new Error('CHANNEL_PORT_INVALID')
  }
  if (!isAbsolute(desired.canonicalWorkspace) || !isAbsolute(desired.canonicalHome)) {
    throw new Error('CANONICAL_PATH_INVALID')
  }
  const providerRepoRoot = desired.ordinaryProjection.provider_repo_root
  const providerConfigRoot = desired.ordinaryProjection.provider_config_root
  const daemonCheckout = desired.ordinaryProjection.daemon_checkout
  if (typeof providerRepoRoot !== 'string' || !isAbsolute(providerRepoRoot)
    || typeof providerConfigRoot !== 'string' || !isAbsolute(providerConfigRoot)
    || typeof daemonCheckout !== 'string' || !isAbsolute(daemonCheckout)) {
    throw new Error('ORDINARY_PROJECTION_ROOTS_INCOMPLETE')
  }
  assertNoRawSecretValue(desired.ordinaryProjection)
  assertExactDigest(desired.releaseCommit, 'RELEASE_COMMIT', 40)
  assertExactDigest(desired.releaseTree, 'RELEASE_TREE', 40)
  assertReference(desired.expectedProviderIdentityRef, 'EXPECTED_PROVIDER_IDENTITY_REF')
  assertReference(desired.providerTokenSourceRef, 'PROVIDER_TOKEN_SOURCE_REF')
  return {
    agent_id: desired.agentId,
    canonical_home: desired.canonicalHome,
    canonical_workspace: desired.canonicalWorkspace,
    channel_port: desired.channelPort,
    control_refs: normalizeControlRefs(desired.controlRefs),
    expected_provider_identity_ref: desired.expectedProviderIdentityRef,
    ordinary_communication_enrollment: desired.ordinaryCommunicationEnrollment,
    ordinary_projection: desired.ordinaryProjection,
    profile_enabled: desired.profileEnabled,
    provider_token_source_ref: desired.providerTokenSourceRef,
    release_commit: desired.releaseCommit,
    release_tree: desired.releaseTree,
    runtime_engine_preference: desired.runtimeEnginePreference,
    supervisor_identity: desired.supervisorIdentity,
  }
}

export function computeDesiredDigest(
  desired: Omit<AunConfigurationDesiredState, 'desiredRevision' | 'desiredDigest' | 'updatedAt' | 'updatedBy'>,
): string {
  return configurationDigest(canonicalDesiredDocument(desired))
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return jsonRecord(JSON.parse(value)) } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try { return stringArray(JSON.parse(value)) } catch { return [] }
  }
  return Array.isArray(value) ? normalizeControlRefs(value.map(String)) : []
}

export function normalizeDesiredStateRow(row: any): AunConfigurationDesiredState {
  const desired: AunConfigurationDesiredState = {
    agentId: String(row.agent_id),
    profileEnabled: row.profile_enabled === true || row.profile_enabled === 1 || row.profile_enabled === '1',
    runtimeEnginePreference: String(row.runtime_engine_preference ?? ''),
    canonicalWorkspace: String(row.canonical_workspace ?? ''),
    canonicalHome: String(row.canonical_home ?? ''),
    channelPort: Number(row.channel_port),
    supervisorIdentity: String(row.supervisor_identity ?? ''),
    expectedProviderIdentityRef: String(row.expected_provider_identity_ref ?? ''),
    providerTokenSourceRef: row.provider_token_source_ref === null || row.provider_token_source_ref === undefined
      ? null
      : String(row.provider_token_source_ref),
    ordinaryCommunicationEnrollment: row.ordinary_communication_enrollment === true
      || row.ordinary_communication_enrollment === 1 || row.ordinary_communication_enrollment === '1',
    ordinaryProjection: jsonRecord(row.ordinary_projection),
    desiredRevision: Number(row.desired_revision),
    desiredDigest: String(row.desired_digest ?? ''),
    releaseCommit: String(row.desired_release_commit ?? ''),
    releaseTree: String(row.desired_release_tree ?? ''),
    controlRefs: stringArray(row.desired_control_refs),
    updatedAt: row.desired_updated_at,
    updatedBy: String(row.desired_updated_by ?? ''),
  }
  if (!Number.isSafeInteger(desired.desiredRevision) || desired.desiredRevision < 1) {
    throw new Error('DESIRED_REVISION_INVALID')
  }
  assertExactDigest(desired.desiredDigest, 'DESIRED_DIGEST', 64)
  const recomputed = computeDesiredDigest(desired)
  if (recomputed !== desired.desiredDigest) throw new Error('DESIRED_DIGEST_MISMATCH')
  return desired
}

export async function readConfigurationDesiredState(
  db: DbAdapter,
  agentId: string,
): Promise<AunConfigurationDesiredState | null> {
  const row = await db.queryOne<any>(
    `SELECT agent_id, profile_enabled, runtime_engine_preference,
            canonical_workspace, canonical_home, channel_port, supervisor_identity,
            expected_provider_identity_ref, provider_token_source_ref,
            ordinary_communication_enrollment, ordinary_projection,
            desired_revision, desired_digest, desired_release_commit, desired_release_tree,
            desired_control_refs, desired_updated_at, desired_updated_by
       FROM agents
      WHERE agent_id = $1`,
    [agentId],
  )
  return row ? normalizeDesiredStateRow(row) : null
}

export async function listPendingConfigurationEvents(
  db: DbAdapter,
  limit = 100,
): Promise<AunConfigurationOutboxEvent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('OUTBOX_LIMIT_INVALID')
  const rows = await db.query<any>(
    `SELECT event_id, agent_id, desired_revision, desired_digest, event_type,
            created_at, attempt_count, available_at, delivered_at
       FROM aun_configuration_desired_outbox
      WHERE delivered_at IS NULL AND available_at <= now()
      ORDER BY desired_revision ASC, agent_id ASC
      LIMIT $1`,
    [limit],
  )
  return rows.map((row) => ({
    eventId: String(row.event_id),
    agentId: String(row.agent_id),
    desiredRevision: Number(row.desired_revision),
    desiredDigest: String(row.desired_digest),
    eventType: AUN_CONFIGURATION_EVENT_TYPE,
    createdAt: row.created_at,
    attemptCount: Number(row.attempt_count ?? 0),
    availableAt: row.available_at,
    deliveredAt: row.delivered_at ?? null,
  }))
}

export async function markConfigurationEventDelivered(
  db: DbAdapter,
  eventId: string,
  desiredRevision: number,
  desiredDigest: string,
): Promise<boolean> {
  const result = await db.execute(
    `UPDATE aun_configuration_desired_outbox
        SET delivered_at = now(), attempt_count = attempt_count + 1
      WHERE event_id = $1 AND desired_revision = $2 AND desired_digest = $3
        AND delivered_at IS NULL`,
    [eventId, desiredRevision, desiredDigest],
  )
  return result.rowCount === 1
}

export async function recordConfigurationObservedState(
  db: DbAdapter,
  state: AunConfigurationObservedState,
): Promise<boolean> {
  const row = await db.queryOne<{ recorded: boolean }>(
    `INSERT INTO aun_configuration_observed_state (
       host_id, agent_id, observed_revision, observed_desired_digest, candidate_digest,
       release_commit, release_tree, provider_native_digest, launchagent_plist_digest,
       launchctl_environment_digest, runtime_identity_digest, reconcile_status,
       drift_reason_codes, lease_id, fencing_token, observed_at
     )
     SELECT $1::text, $2::text, $3::bigint, $4::text, $5::text,
            $6::text, $7::text, $8::text, $9::text, $10::text, $11::text,
            $12::text, $13::jsonb, $14::uuid, $15::bigint,
            COALESCE($16::timestamptz, now())
      WHERE EXISTS (
        SELECT 1 FROM control_plane_leases
         WHERE lease_id = $14 AND fencing_token = $15
           AND lease_scope_type = 'runtime_instance'
           AND lease_scope_id = 'configuration-reconciler:' || $1::text
           AND lease_purpose = 'maintenance'
           AND status = 'active' AND expires_at > now()
      )
        AND EXISTS (
        SELECT 1 FROM agents
         WHERE agent_id = $2::text
           AND desired_revision = $3::bigint
           AND desired_digest = $4::text
      )
     ON CONFLICT (host_id, agent_id) DO UPDATE SET
       observed_revision = EXCLUDED.observed_revision,
       observed_desired_digest = EXCLUDED.observed_desired_digest,
       candidate_digest = EXCLUDED.candidate_digest,
       release_commit = EXCLUDED.release_commit,
       release_tree = EXCLUDED.release_tree,
       provider_native_digest = EXCLUDED.provider_native_digest,
       launchagent_plist_digest = EXCLUDED.launchagent_plist_digest,
       launchctl_environment_digest = EXCLUDED.launchctl_environment_digest,
       runtime_identity_digest = EXCLUDED.runtime_identity_digest,
       reconcile_status = EXCLUDED.reconcile_status,
       drift_reason_codes = EXCLUDED.drift_reason_codes,
       lease_id = EXCLUDED.lease_id,
       fencing_token = EXCLUDED.fencing_token,
       observed_at = EXCLUDED.observed_at
     WHERE aun_configuration_observed_state.observed_revision <= EXCLUDED.observed_revision
     RETURNING true AS recorded`,
    [
      state.hostId, state.agentId, state.observedRevision, state.observedDesiredDigest,
      state.candidateDigest, state.releaseCommit, state.releaseTree, state.providerNativeDigest,
      state.launchagentPlistDigest, state.launchctlEnvironmentDigest, state.runtimeIdentityDigest,
      state.reconcileStatus, JSON.stringify(state.driftReasonCodes), state.leaseId,
      state.fencingToken, state.observedAt ?? null,
    ],
  )
  return row?.recorded === true
}

export async function createConfigurationRestartRequest(
  db: DbAdapter,
  input: AunConfigurationRestartRequest,
): Promise<string> {
  const requestId = input.requestId ?? randomUUID()
  const row = await db.queryOne<{ request_id: string }>(
    `INSERT INTO aun_configuration_restart_requests (
       request_id, host_id, agent_id, from_revision, from_digest, to_revision, to_digest,
       candidate_digest, rollback_artifact_digest, exact_release_commit, exact_release_tree,
       exact_control_refs, lease_id, fencing_token, restart_budget, status,
       owner_decision_ref, cto_execution_receipt_ref
     ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$15::uuid,$16::bigint,
              1,'AWAITING_OWNER_DECISION',$13,$14
       WHERE EXISTS (
         SELECT 1 FROM control_plane_leases
          WHERE lease_id = $15::uuid AND fencing_token = $16::bigint
            AND lease_scope_type = 'runtime_instance'
            AND lease_scope_id = 'configuration-reconciler:' || $2::text
            AND status = 'active' AND expires_at > now()
       )
         AND EXISTS (
         SELECT 1 FROM agents
          WHERE agent_id = $3::text AND desired_revision = $6::bigint AND desired_digest = $7::text
       )
     ON CONFLICT (host_id, agent_id, to_revision, to_digest, candidate_digest)
     DO UPDATE SET request_id = aun_configuration_restart_requests.request_id
     RETURNING request_id`,
    [
      requestId, input.hostId, input.agentId, input.fromRevision, input.fromDigest,
      input.toRevision, input.toDigest, input.candidateDigest, input.rollbackArtifactDigest,
      input.exactReleaseCommit, input.exactReleaseTree, JSON.stringify(normalizeControlRefs(input.exactControlRefs)),
      input.ownerDecisionRef ?? null, input.ctoExecutionReceiptRef ?? null,
      input.leaseId, input.fencingToken,
    ],
  )
  if (!row) throw new Error('RESTART_REQUEST_FENCE_REJECTED')
  return String(row.request_id)
}

export async function claimApprovedConfigurationRestartExecution(
  db: DbAdapter,
  input: AunConfigurationRestartExecutionClaimInput,
): Promise<AunConfigurationRestartExecutionRecord | null> {
  const refs = normalizeControlRefs(input.exactControlRefs)
  const row = await db.queryOne<any>(
    `UPDATE aun_configuration_restart_requests r
        SET status = 'EXECUTING',
            execution_lease_id = $11::uuid,
            execution_fencing_token = $12::bigint,
            execution_attempts = 1,
            execution_started_at = now(),
            updated_at = now()
       FROM control_plane_leases l, agents a
      WHERE r.request_id = $1::uuid
        AND r.host_id = $2::text AND r.agent_id = $3::text
        AND r.to_revision = $4::bigint AND r.to_digest = $5::text
        AND r.candidate_digest = $6::text AND r.rollback_artifact_digest = $7::text
        AND r.exact_release_commit = $8::text AND r.exact_release_tree = $9::text
        AND r.exact_control_refs = $10::jsonb
        AND r.restart_budget = 1 AND r.status = 'APPROVED'
        AND r.execution_attempts = 0
        AND NULLIF(btrim(r.owner_decision_ref), '') IS NOT NULL
        AND r.owner_decision_expires_at > now()
        AND NULLIF(btrim(r.cto_execution_receipt_ref), '') IS NOT NULL
        AND a.agent_id = r.agent_id
        AND a.desired_revision = r.to_revision AND a.desired_digest = r.to_digest
        AND l.lease_id = $11::uuid AND l.fencing_token = $12::bigint
        AND l.lease_scope_type = 'runtime_instance'
        AND l.lease_scope_id = 'configuration-restart:' || r.host_id || ':' || r.agent_id
        AND l.lease_purpose = 'maintenance'
        AND l.holder_agent_id = $13::text
        AND l.status = 'active' AND l.expires_at > now()
      RETURNING r.request_id, r.host_id, r.agent_id, r.to_revision, r.to_digest,
                r.candidate_digest, r.rollback_artifact_digest, r.exact_release_commit,
                r.exact_release_tree, r.exact_control_refs, r.restart_budget, r.status,
                r.owner_decision_ref, r.owner_decision_expires_at,
                r.cto_execution_receipt_ref, r.execution_lease_id,
                r.execution_fencing_token, r.execution_attempts`,
    [
      input.requestId, input.hostId, input.agentId, input.toRevision, input.toDigest,
      input.candidateDigest, input.rollbackArtifactDigest, input.exactReleaseCommit,
      input.exactReleaseTree, JSON.stringify(refs), input.executionLeaseId,
      input.executionFencingToken, input.executorAgentId,
    ],
  )
  if (!row) return null
  return {
    requestId: String(row.request_id), hostId: String(row.host_id), agentId: String(row.agent_id),
    toRevision: Number(row.to_revision), toDigest: String(row.to_digest),
    candidateDigest: String(row.candidate_digest),
    rollbackArtifactDigest: String(row.rollback_artifact_digest),
    exactReleaseCommit: String(row.exact_release_commit), exactReleaseTree: String(row.exact_release_tree),
    exactControlRefs: stringArray(row.exact_control_refs),
    executionLeaseId: String(row.execution_lease_id),
    executionFencingToken: Number(row.execution_fencing_token), executorAgentId: input.executorAgentId,
    restartBudget: 1, status: 'EXECUTING', ownerDecisionRef: String(row.owner_decision_ref),
    ownerDecisionExpiresAt: row.owner_decision_expires_at,
    ctoExecutionReceiptRef: String(row.cto_execution_receipt_ref), executionAttempt: 1,
  }
}

export async function verifyConfigurationRestartExecutionClaim(
  db: DbAdapter,
  claim: AunConfigurationRestartExecutionRecord,
): Promise<boolean> {
  const row = await db.queryOne<{ current: boolean }>(
    `SELECT true AS current
       FROM aun_configuration_restart_requests r
       JOIN agents a ON a.agent_id = r.agent_id
       JOIN control_plane_leases l ON l.lease_id = r.execution_lease_id
      WHERE r.request_id = $1::uuid AND r.status = 'EXECUTING'
        AND r.execution_attempts = 1 AND r.execution_lease_id = $2::uuid
        AND r.execution_fencing_token = $3::bigint
        AND r.host_id = $5::text AND r.agent_id = $6::text
        AND r.to_revision = $7::bigint AND r.to_digest = $8::text
        AND r.candidate_digest = $9::text AND r.rollback_artifact_digest = $10::text
        AND r.exact_release_commit = $11::text AND r.exact_release_tree = $12::text
        AND r.exact_control_refs = $13::jsonb
        AND r.owner_decision_ref = $14::text AND r.cto_execution_receipt_ref = $15::text
        AND r.owner_decision_expires_at > now()
        AND a.desired_revision = r.to_revision AND a.desired_digest = r.to_digest
        AND l.fencing_token = r.execution_fencing_token
        AND l.holder_agent_id = $4::text
        AND l.lease_scope_type = 'runtime_instance'
        AND l.lease_scope_id = 'configuration-restart:' || r.host_id || ':' || r.agent_id
        AND l.lease_purpose = 'maintenance'
        AND l.status = 'active' AND l.expires_at > now()`,
    [
      claim.requestId, claim.executionLeaseId, claim.executionFencingToken, claim.executorAgentId,
      claim.hostId, claim.agentId, claim.toRevision, claim.toDigest, claim.candidateDigest,
      claim.rollbackArtifactDigest, claim.exactReleaseCommit, claim.exactReleaseTree,
      JSON.stringify(normalizeControlRefs(claim.exactControlRefs)), claim.ownerDecisionRef,
      claim.ctoExecutionReceiptRef,
    ],
  )
  return row?.current === true
}

export async function completeConfigurationRestartExecution(
  db: DbAdapter,
  claim: AunConfigurationRestartExecutionRecord,
  input: { status: 'EXECUTED' | 'FAILED'; terminalReceiptDigest: string; reasonCode: string | null },
): Promise<boolean> {
  assertExactDigest(input.terminalReceiptDigest, 'TERMINAL_RECEIPT_DIGEST', 64)
  const result = await db.execute(
    `UPDATE aun_configuration_restart_requests
        SET status = $4::text, terminal_receipt_digest = $5::text,
            terminal_reason_code = $6::text, terminal_at = now(), updated_at = now()
      WHERE request_id = $1::uuid AND status = 'EXECUTING' AND execution_attempts = 1
        AND execution_lease_id = $2::uuid AND execution_fencing_token = $3::bigint
        AND terminal_receipt_digest IS NULL`,
    [
      claim.requestId, claim.executionLeaseId, claim.executionFencingToken,
      input.status, input.terminalReceiptDigest, input.reasonCode,
    ],
  )
  return result.rowCount === 1
}
