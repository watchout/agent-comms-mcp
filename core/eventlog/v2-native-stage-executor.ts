import type { DbAdapter } from '../db/adapter'
import { canonicalJson, sha256Utf8 } from './transport-contract'
import { parseEventPayload } from './types'
import {
  activeTurnProjection,
  deliveryTruthView,
  openTurnCount,
  rebuildActiveTurnProjection,
  rebuildDeliveryTruthView,
} from './views'
import { pendingV2NativeInternalHandoffs } from './internal-handoff'
import { routeV2NativeMessage, type V2NativeRouteCommitPoint } from './v2-native-routing'
import { runV2NativeMeshTick, type V2NativeMeshDbFactory, type V2NativeMeshSeatBinding } from './worker'
import {
  canonicalV2NativeStageBindingSha256,
  decodeV2NativeStageBinding,
  deriveV2NativeMeshScopeAndFence,
  verifyV2NativeStageOwnerDecision,
  V2NativeStageBindingError,
  type V2NativeStageBaselinesV1,
  type V2NativeStageBindingV1,
  type V2NativeStageCommandV1,
  type V2NativeStageEnabledRowV1,
  type V2NativeStageMigrationV1,
  type V2NativeVerifiedStageAuthorityV1,
} from './v2-native-stage-binding'
import type { V2NativeMeshExecutionFence, V2NativeMeshScopeV1 } from './v2-native-ingress'
import { v2NativeMeshScopeSha256 } from './v2-native-ingress'

export const V2_NATIVE_STAGE_EVIDENCE_SCHEMA_VERSION = 'aun-v2-native-stage-evidence/v1' as const

export type V2NativeStageStopReason =
  | 'BASE_OR_TREE_DRIFT'
  | 'STAGE_BINDING_MISSING_OR_INVALID'
  | 'OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH'
  | 'STAGE_MEMBERSHIP_DRIFT'
  | 'ENABLED_SNAPSHOT_DRIFT'
  | 'RUNTIME_BINDING_DRIFT'
  | 'DATABASE_OR_MIGRATION_DRIFT'
  | 'COMMAND_CATALOG_DRIFT'
  | 'DEADLINE_EXPIRED'
  | 'V1_TRAVERSAL_DETECTED'
  | 'PROVIDER_OR_EXTERNAL_EFFECT_DETECTED'
  | 'WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION'
  | 'MATRIX_COUNT_MISMATCH'
  | 'CRASH_RECOVERY_AMBIGUOUS'
  | 'REPLAY_BYTE_MISMATCH'
  | 'RESIDUAL_OPEN_WORK'
  | 'EVIDENCE_INCOMPLETE_OR_STALE'

export interface V2NativeStagePreflightInputV1 {
  binding: unknown
  binding_url: string
  binding_sha256: string
  owner_decision_body: string
  owner_decision_url: string
  owner_decision_body_sha256: string
  exact_implementation_main_sha: string
  exact_implementation_main_tree: string
  now?: Date
}

export interface V2NativeStageExecutionPlanV1 {
  schema_version: 'aun-v2-native-stage-execution-plan/v1'
  binding: V2NativeStageBindingV1
  exact_binding_sha256: string
  authority: V2NativeVerifiedStageAuthorityV1
  scope: V2NativeMeshScopeV1
  fence: V2NativeMeshExecutionFence
  stage_member_rows: V2NativeStageEnabledRowV1[]
  crash_hooks_enabled: false
  activation_performed: false
  preflight_effects: {
    event_log_mutations: 0
    model_invocations: 0
    provider_invocations: 0
    V1_invocations: 0
    checkout_mutations: 0
    process_mutations: 0
    migration_mutations: 0
    external_send_attempts: 0
  }
  revalidation_input: Omit<V2NativeStagePreflightInputV1, 'now'>
}

export interface V2NativeStageDatabaseReadbackV1 {
  database_identity_sha256: string
  migration: V2NativeStageMigrationV1
  baselines: V2NativeStageBaselinesV1
}

export interface V2NativeStageOfflineReadbackV1 {
  exact_implementation_main_sha: string
  exact_implementation_main_tree: string
  stage_member_rows: V2NativeStageEnabledRowV1[]
  command_catalog: V2NativeStageCommandV1[]
}

export interface V2NativeStageSeatBindingV1 extends V2NativeMeshSeatBinding {
  commandId: string
}

export interface V2NativeStageEventIdentityV1 {
  run_id: string
  stage_id: V2NativeStageBindingV1['stage_id']
  turn_id: string | null
  message_id: string | null
  reply_id: string | null
  delivery_id: string | null
  claim_epoch: number | null
  runtime_instance_id: string | null
  event_id: string
  seq: number
  payload_sha256: string
  occurred_at: string
}

export interface V2NativeStageMatrixCountsV1 {
  member_count: number
  directed_requests: number
  terminal_replies: number
  fanout_parents: number
  fanout_children: number
  correlated_reply_edges: number
  missing: number
  duplicates: number
  unexpected_recipients: number
  wrong_queue_mutations: number
  foreign_owner_mutations: number
  open_turns_after_drain: number
  pending_internal_deliveries_after_drain: number
  V1_invocations: number
  provider_attempts: number
  provider_effects: number
  external_send_attempts: number
}

interface V2NativeStageCrashReceiptCommonV1 {
  schema_version: 'aun-v2-native-crash-boundary-receipt/v1'
  run_id: string
  stage_id: 'S2_SELECTED_ENABLED' | 'S3_ALL_ENABLED'
  subject_agent_id: string
  crashed_runtime_instance_id: string
  supervisor_evidence_ref: string
  occurred_at: string
  rto_ms: number
  rpo_events: 0
  loss: 0
  duplicate_terminal: 0
  automatic_retry: 0
}

export type V2NativeStageCrashBoundaryReceiptV1 =
  | (V2NativeStageCrashReceiptCommonV1 & {
      boundary: 'before_claim'
      eventual_claims: 1
    })
  | (V2NativeStageCrashReceiptCommonV1 & {
      boundary: 'after_claim'
      claim_epoch_before: number
      claim_epoch_after: number
      stale_holder_terminal: 0
    })
  | (V2NativeStageCrashReceiptCommonV1 & {
      boundary: 'after_completion_enqueue'
      completion_cardinality: 1
      enqueue_cardinality: 1
      reply_delivery_cardinality: 1
    })
  | (V2NativeStageCrashReceiptCommonV1 & {
      boundary: 'after_delivery_claim'
      delivery_unknown: 1
      reconciliation_cas_winners: 1
    })

export interface V2NativeStageEvidenceV1 {
  schema_version: typeof V2_NATIVE_STAGE_EVIDENCE_SCHEMA_VERSION
  stage_binding_url: string
  stage_binding_sha256: string
  exact_implementation_main_sha: string
  exact_implementation_main_tree: string
  database_identity_sha256: string
  migration_version_and_receipt: {
    required: boolean
    version: string | null
    receipt_ref: string | null
  }
  enabled_snapshot_url_sha256_cardinality: {
    artifact_url: string
    canonical_json_sha256: string
    cardinality: number
  }
  stage_membership_sha256: string
  supervisor_process_identities: V2NativeStageBindingV1['supervisor_processes']
  command_receipts: Array<{
    command_id: string
    executable_sha256: string
    status: 'BOUND_NOT_STARTED_BY_EXECUTOR' | 'EXECUTED_BY_BOUND_SEAT'
  }>
  direct_fanout_correlated_matrix_counts: V2NativeStageMatrixCountsV1
  crash_boundary_receipts: V2NativeStageCrashBoundaryReceiptV1[]
  replay_before_after_sha256: {
    before: string
    after: string
    byte_equal: boolean
  }
  V1_provider_external_baseline_and_delta: {
    before: Pick<V2NativeStageBaselinesV1, 'V1_message_queue_row_count' | 'V1_agent_messages_row_count' | 'V1_outbound_queue_row_count' | 'provider_attempt_count' | 'provider_effect_count' | 'external_send_attempt_count'>
    delta: {
      V1_message_queue_row_count: number
      V1_agent_messages_row_count: number
      V1_outbound_queue_row_count: number
      provider_attempt_count: number
      provider_effect_count: number
      external_send_attempt_count: number
    }
  }
  wrong_target_wrong_queue_foreign_owner_zero_mutation: {
    wrong_target: number
    wrong_queue: number
    foreign_owner: number
  }
  open_turn_and_pending_delivery_residual_queries: {
    open_turns: number
    pending_internal_deliveries: number
  }
  checkout_and_runtime_drift_report: {
    drift_count: number
    checked_agent_ids: string[]
  }
  implementation_audit_ref: string | null
  scenario_verification_ref: string | null
  stage_result_url_and_body_sha256: {
    durable_url: string | null
    body_sha256: string | null
  }
  event_identities: V2NativeStageEventIdentityV1[]
  terminal_result:
    | { kind: 'MEASURED_PENDING_INDEPENDENT_GATES'; stop_reason: 'EVIDENCE_INCOMPLETE_OR_STALE'; auto_advance: false }
    | { kind: 'ROLLBACK_REQUEST'; stop_reason: V2NativeStageStopReason; auto_advance: false; error: string }
    | { kind: 'ACCEPT_STAGE'; stop_reason: null; auto_advance: false }
}

export interface V2NativeStageExecutionPortsV1 {
  seats: V2NativeStageSeatBindingV1[]
  /** Re-read the exact durable binding and owner-decision sources; no cached bytes. */
  readDurableAuthority: (plan: V2NativeStageExecutionPlanV1) => V2NativeStagePreflightInputV1 | Promise<V2NativeStagePreflightInputV1>
  readOfflineState: (plan: V2NativeStageExecutionPlanV1) => V2NativeStageOfflineReadbackV1 | Promise<V2NativeStageOfflineReadbackV1>
  openBoundDatabase: (binding: V2NativeStageBindingV1) => Promise<DbAdapter>
  readDatabaseState: (db: DbAdapter, binding: V2NativeStageBindingV1) => Promise<V2NativeStageDatabaseReadbackV1>
  dbFactory?: V2NativeMeshDbFactory
  closeDatabase?: (db: DbAdapter) => Promise<void>
  routeMessage?: typeof routeV2NativeMessage
  runMeshTick?: typeof runV2NativeMeshTick
  maxDrainTicks?: number
  enableCrashHooks?: boolean
  runCrashScenario?: (input: {
    plan: V2NativeStageExecutionPlanV1
    db: DbAdapter
    mutationFence: () => Promise<void>
  }) => Promise<V2NativeStageCrashBoundaryReceiptV1[]>
  onCommitPoint?: (point: V2NativeRouteCommitPoint) => void | Promise<void>
  /** Test-only drift seam; full authority/state revalidation brackets the callback. */
  onMeshMutationBoundary?: (boundary: string) => void | Promise<void>
  now?: () => Date
}

export interface V2NativeStageExecutionResultV1 {
  ok: boolean
  result: 'MEASURED_PENDING_INDEPENDENT_GATES' | 'ROLLBACK_REQUEST'
  plan: V2NativeStageExecutionPlanV1
  evidence: V2NativeStageEvidenceV1
}

class V2NativeStageExecutionError extends Error {
  constructor(readonly stopReason: V2NativeStageStopReason, message: string) {
    super(`${stopReason}: ${message}`)
  }
}

const EVIDENCE_FIELDS = [
  'schema_version', 'stage_binding_url', 'stage_binding_sha256', 'exact_implementation_main_sha',
  'exact_implementation_main_tree', 'database_identity_sha256', 'migration_version_and_receipt',
  'enabled_snapshot_url_sha256_cardinality', 'stage_membership_sha256', 'supervisor_process_identities',
  'command_receipts', 'direct_fanout_correlated_matrix_counts', 'crash_boundary_receipts',
  'replay_before_after_sha256', 'V1_provider_external_baseline_and_delta',
  'wrong_target_wrong_queue_foreign_owner_zero_mutation', 'open_turn_and_pending_delivery_residual_queries',
  'checkout_and_runtime_drift_report', 'implementation_audit_ref', 'scenario_verification_ref',
  'stage_result_url_and_body_sha256', 'event_identities', 'terminal_result',
] as const
const MATRIX_FIELDS = [
  'member_count', 'directed_requests', 'terminal_replies', 'fanout_parents', 'fanout_children',
  'correlated_reply_edges', 'missing', 'duplicates', 'unexpected_recipients', 'wrong_queue_mutations',
  'foreign_owner_mutations', 'open_turns_after_drain', 'pending_internal_deliveries_after_drain',
  'V1_invocations', 'provider_attempts', 'provider_effects', 'external_send_attempts',
] as const
const FORBIDDEN_COUNTER_FIELDS = [
  'V1_message_queue_row_count', 'V1_agent_messages_row_count', 'V1_outbound_queue_row_count',
  'provider_attempt_count', 'provider_effect_count', 'external_send_attempt_count',
] as const
const EVENT_IDENTITY_FIELDS = [
  'run_id', 'stage_id', 'turn_id', 'message_id', 'reply_id', 'delivery_id', 'claim_epoch',
  'runtime_instance_id', 'event_id', 'seq', 'payload_sha256', 'occurred_at',
] as const
const CRASH_RECEIPT_COMMON_FIELDS = [
  'schema_version', 'run_id', 'stage_id', 'boundary', 'subject_agent_id',
  'crashed_runtime_instance_id', 'supervisor_evidence_ref', 'occurred_at',
  'rto_ms', 'rpo_events', 'loss', 'duplicate_terminal', 'automatic_retry',
] as const
const CRASH_BOUNDARY_FIELDS = {
  before_claim: ['eventual_claims'],
  after_claim: ['claim_epoch_before', 'claim_epoch_after', 'stale_holder_terminal'],
  after_completion_enqueue: ['completion_cardinality', 'enqueue_cardinality', 'reply_delivery_cardinality'],
  after_delivery_claim: ['delivery_unknown', 'reconciliation_cas_winners'],
} as const
const S3_CRASH_BOUNDARIES = [
  'before_claim', 'after_claim', 'after_completion_enqueue', 'after_delivery_claim',
] as const

function evidenceFailure(message: string): never {
  stop('EVIDENCE_INCOMPLETE_OR_STALE', message)
}

function evidenceRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) evidenceFailure(`${name} must be an object`)
}

function evidenceExact(value: unknown, fields: readonly string[], name: string): asserts value is Record<string, unknown> {
  evidenceRecord(value, name)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    evidenceFailure(`${name} fields differ`)
  }
}

function evidenceString(value: unknown, field: string, nullable = false): asserts value is string | null {
  if (nullable && value === null) return
  if (typeof value !== 'string' || value === '') evidenceFailure(`${field} must be ${nullable ? 'a string or null' : 'a non-empty string'}`)
}

function evidenceSha(value: unknown, field: string, length: 40 | 64 = 64, nullable = false): void {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) evidenceFailure(`${field} must be lowercase ${length}-hex`)
}

function evidenceInteger(value: unknown, field: string, nonnegative = true, nullable = false): void {
  if (nullable && value === null) return
  if (!Number.isSafeInteger(value) || (nonnegative && (value as number) < 0)) evidenceFailure(`${field} must be ${nullable ? 'null or ' : ''}a ${nonnegative ? 'non-negative ' : ''}integer`)
}

function decodeCrashBoundaryReceipt(
  value: unknown,
  index: number,
  expectedPlan?: V2NativeStageExecutionPlanV1,
): V2NativeStageCrashBoundaryReceiptV1 {
  evidenceRecord(value, `crash_boundary_receipts[${index}]`)
  const boundary = value.boundary
  if (!S3_CRASH_BOUNDARIES.includes(boundary as typeof S3_CRASH_BOUNDARIES[number])) {
    evidenceFailure(`crash_boundary_receipts[${index}].boundary differs`)
  }
  const boundaryFields = CRASH_BOUNDARY_FIELDS[boundary as keyof typeof CRASH_BOUNDARY_FIELDS]
  evidenceExact(value, [...CRASH_RECEIPT_COMMON_FIELDS, ...boundaryFields], `crash_boundary_receipts[${index}]`)
  const receipt = value as unknown as V2NativeStageCrashBoundaryReceiptV1
  if (receipt.schema_version !== 'aun-v2-native-crash-boundary-receipt/v1') evidenceFailure(`crash_boundary_receipts[${index}].schema_version differs`)
  if (!['S2_SELECTED_ENABLED', 'S3_ALL_ENABLED'].includes(receipt.stage_id)) evidenceFailure(`crash_boundary_receipts[${index}].stage_id differs`)
  for (const field of ['run_id', 'subject_agent_id', 'crashed_runtime_instance_id', 'supervisor_evidence_ref', 'occurred_at'] as const) {
    evidenceString(receipt[field], `crash_boundary_receipts[${index}].${field}`)
  }
  if (!Number.isFinite(Date.parse(receipt.occurred_at)) || !receipt.occurred_at.endsWith('Z')) evidenceFailure(`crash_boundary_receipts[${index}].occurred_at must be RFC3339 UTC`)
  evidenceInteger(receipt.rto_ms, `crash_boundary_receipts[${index}].rto_ms`)
  if (receipt.rto_ms > 30_000) evidenceFailure(`crash_boundary_receipts[${index}].rto_ms exceeds 30000`)
  for (const field of ['rpo_events', 'loss', 'duplicate_terminal', 'automatic_retry'] as const) {
    if (receipt[field] !== 0) evidenceFailure(`crash_boundary_receipts[${index}].${field} must be zero`)
  }
  if (receipt.boundary === 'before_claim') {
    if (receipt.eventual_claims !== 1) evidenceFailure(`crash_boundary_receipts[${index}].eventual_claims must be one`)
  } else if (receipt.boundary === 'after_claim') {
    evidenceInteger(receipt.claim_epoch_before, `crash_boundary_receipts[${index}].claim_epoch_before`)
    evidenceInteger(receipt.claim_epoch_after, `crash_boundary_receipts[${index}].claim_epoch_after`)
    if (receipt.claim_epoch_after !== receipt.claim_epoch_before + 1 || receipt.stale_holder_terminal !== 0) {
      evidenceFailure(`crash_boundary_receipts[${index}] claim recovery differs`)
    }
  } else if (receipt.boundary === 'after_completion_enqueue') {
    if (receipt.completion_cardinality !== 1 || receipt.enqueue_cardinality !== 1 || receipt.reply_delivery_cardinality !== 1) {
      evidenceFailure(`crash_boundary_receipts[${index}] completion/enqueue/delivery cardinality differs`)
    }
  } else if (receipt.delivery_unknown !== 1 || receipt.reconciliation_cas_winners !== 1) {
    evidenceFailure(`crash_boundary_receipts[${index}] delivery reconciliation differs`)
  }
  if (expectedPlan) {
    if (
      receipt.run_id !== expectedPlan.binding.run_id ||
      receipt.stage_id !== expectedPlan.binding.stage_id ||
      !expectedPlan.binding.stage_members.agent_ids.includes(receipt.subject_agent_id)
    ) evidenceFailure(`crash_boundary_receipts[${index}] is not bound to the exact stage`)
    const row = expectedPlan.stage_member_rows.find(candidate => candidate.agent_id === receipt.subject_agent_id)
    if (receipt.crashed_runtime_instance_id !== row?.runtime_instance_id) evidenceFailure(`crash_boundary_receipts[${index}] runtime identity differs`)
  }
  return receipt
}

function validateCompleteCrashReceiptSet(
  receipts: V2NativeStageCrashBoundaryReceiptV1[],
  plan: V2NativeStageExecutionPlanV1,
): void {
  if (plan.binding.stage_id === 'S1_TWO_AGENT') {
    if (receipts.length !== 0) evidenceFailure('S1 crash_boundary_receipts must be empty')
    return
  }
  const expected = plan.binding.stage_id === 'S2_SELECTED_ENABLED' ? ['after_claim'] : [...S3_CRASH_BOUNDARIES]
  const actual = receipts.map(receipt => receipt.boundary)
  if (canonicalJson(actual) !== canonicalJson(expected)) evidenceFailure(`${plan.binding.stage_id} crash boundary set differs`)
}

function validateCrashReceiptsForExecution(
  value: unknown,
  plan: V2NativeStageExecutionPlanV1,
): V2NativeStageCrashBoundaryReceiptV1[] {
  try {
    if (!Array.isArray(value)) evidenceFailure('crash scenario result must be an array')
    const receipts = value.map((receipt, index) => decodeCrashBoundaryReceipt(receipt, index, plan))
    validateCompleteCrashReceiptSet(receipts, plan)
    return receipts
  } catch (error) {
    stop('CRASH_RECOVERY_AMBIGUOUS', error instanceof Error ? error.message : String(error))
  }
}

/** Strict runtime validation for immutable stage evidence, including ACCEPT gating. */
export function decodeV2NativeStageEvidence(
  value: unknown,
  expectedPlan?: V2NativeStageExecutionPlanV1,
): V2NativeStageEvidenceV1 {
  evidenceExact(value, EVIDENCE_FIELDS, 'V2NativeStageEvidenceV1')
  const evidence = value as unknown as V2NativeStageEvidenceV1
  if (evidence.schema_version !== V2_NATIVE_STAGE_EVIDENCE_SCHEMA_VERSION) evidenceFailure('evidence schema_version differs')
  evidenceString(evidence.stage_binding_url, 'stage_binding_url')
  let bindingUrl: URL
  try { bindingUrl = new URL(evidence.stage_binding_url) } catch { return evidenceFailure('stage_binding_url must be absolute') }
  if (bindingUrl.protocol !== 'https:' || bindingUrl.hash === '') evidenceFailure('stage_binding_url must be a durable https URL with a fragment')
  evidenceSha(evidence.stage_binding_sha256, 'stage_binding_sha256')
  evidenceSha(evidence.exact_implementation_main_sha, 'exact_implementation_main_sha', 40)
  evidenceSha(evidence.exact_implementation_main_tree, 'exact_implementation_main_tree', 40)
  evidenceSha(evidence.database_identity_sha256, 'database_identity_sha256')

  evidenceExact(evidence.migration_version_and_receipt, ['required', 'version', 'receipt_ref'], 'migration_version_and_receipt')
  if (typeof evidence.migration_version_and_receipt.required !== 'boolean') evidenceFailure('migration required must be boolean')
  evidenceString(evidence.migration_version_and_receipt.version, 'migration version', true)
  evidenceString(evidence.migration_version_and_receipt.receipt_ref, 'migration receipt_ref', true)
  evidenceExact(evidence.enabled_snapshot_url_sha256_cardinality, ['artifact_url', 'canonical_json_sha256', 'cardinality'], 'enabled_snapshot_url_sha256_cardinality')
  evidenceString(evidence.enabled_snapshot_url_sha256_cardinality.artifact_url, 'enabled snapshot artifact_url')
  evidenceSha(evidence.enabled_snapshot_url_sha256_cardinality.canonical_json_sha256, 'enabled snapshot sha256')
  evidenceInteger(evidence.enabled_snapshot_url_sha256_cardinality.cardinality, 'enabled snapshot cardinality')
  evidenceSha(evidence.stage_membership_sha256, 'stage_membership_sha256')

  if (!Array.isArray(evidence.supervisor_process_identities) || evidence.supervisor_process_identities.length === 0) evidenceFailure('supervisor_process_identities must be non-empty')
  for (const [index, unit] of evidence.supervisor_process_identities.entries()) {
    evidenceExact(unit, [
      'unit_kind', 'agent_id_or_dispatcher_id', 'runtime_instance_id', 'pid', 'process_start_time',
      'executable_realpath', 'executable_sha256', 'checkout_sha', 'database_identity_sha256',
    ], `supervisor_process_identities[${index}]`)
    if (!['seat', 'outbox', 'reconciler'].includes(unit.unit_kind)) evidenceFailure(`supervisor_process_identities[${index}].unit_kind differs`)
    evidenceInteger(unit.pid, `supervisor_process_identities[${index}].pid`)
    evidenceSha(unit.executable_sha256, `supervisor_process_identities[${index}].executable_sha256`)
    evidenceSha(unit.checkout_sha, `supervisor_process_identities[${index}].checkout_sha`, 40)
    evidenceSha(unit.database_identity_sha256, `supervisor_process_identities[${index}].database_identity_sha256`)
  }
  if (!Array.isArray(evidence.command_receipts) || evidence.command_receipts.length === 0) evidenceFailure('command_receipts must be non-empty')
  for (const [index, receipt] of evidence.command_receipts.entries()) {
    evidenceExact(receipt, ['command_id', 'executable_sha256', 'status'], `command_receipts[${index}]`)
    evidenceString(receipt.command_id, `command_receipts[${index}].command_id`)
    evidenceSha(receipt.executable_sha256, `command_receipts[${index}].executable_sha256`)
    if (!['BOUND_NOT_STARTED_BY_EXECUTOR', 'EXECUTED_BY_BOUND_SEAT'].includes(receipt.status)) evidenceFailure(`command_receipts[${index}].status differs`)
  }

  evidenceExact(evidence.direct_fanout_correlated_matrix_counts, MATRIX_FIELDS, 'direct_fanout_correlated_matrix_counts')
  for (const field of MATRIX_FIELDS) evidenceInteger(evidence.direct_fanout_correlated_matrix_counts[field], `matrix.${field}`, !['V1_invocations', 'provider_attempts', 'provider_effects', 'external_send_attempts'].includes(field))
  if (!Array.isArray(evidence.crash_boundary_receipts)) evidenceFailure('crash_boundary_receipts must be an array')
  const decodedCrashReceipts = evidence.crash_boundary_receipts.map((receipt, index) => decodeCrashBoundaryReceipt(receipt, index, expectedPlan))
  evidenceExact(evidence.replay_before_after_sha256, ['before', 'after', 'byte_equal'], 'replay_before_after_sha256')
  evidenceSha(evidence.replay_before_after_sha256.before, 'replay before')
  evidenceSha(evidence.replay_before_after_sha256.after, 'replay after')
  if (typeof evidence.replay_before_after_sha256.byte_equal !== 'boolean') evidenceFailure('replay byte_equal must be boolean')

  evidenceExact(evidence.V1_provider_external_baseline_and_delta, ['before', 'delta'], 'V1_provider_external_baseline_and_delta')
  for (const section of ['before', 'delta'] as const) {
    const counters = evidence.V1_provider_external_baseline_and_delta[section]
    evidenceExact(counters, FORBIDDEN_COUNTER_FIELDS, `forbidden counters ${section}`)
    for (const field of FORBIDDEN_COUNTER_FIELDS) evidenceInteger(counters[field], `${section}.${field}`, section === 'before')
  }
  evidenceExact(evidence.wrong_target_wrong_queue_foreign_owner_zero_mutation, ['wrong_target', 'wrong_queue', 'foreign_owner'], 'wrong target counters')
  for (const field of ['wrong_target', 'wrong_queue', 'foreign_owner'] as const) evidenceInteger(evidence.wrong_target_wrong_queue_foreign_owner_zero_mutation[field], field)
  evidenceExact(evidence.open_turn_and_pending_delivery_residual_queries, ['open_turns', 'pending_internal_deliveries'], 'residual queries')
  evidenceInteger(evidence.open_turn_and_pending_delivery_residual_queries.open_turns, 'open_turns')
  evidenceInteger(evidence.open_turn_and_pending_delivery_residual_queries.pending_internal_deliveries, 'pending_internal_deliveries')
  evidenceExact(evidence.checkout_and_runtime_drift_report, ['drift_count', 'checked_agent_ids'], 'drift report')
  evidenceInteger(evidence.checkout_and_runtime_drift_report.drift_count, 'drift_count')
  if (!Array.isArray(evidence.checkout_and_runtime_drift_report.checked_agent_ids) || evidence.checkout_and_runtime_drift_report.checked_agent_ids.length < 2) evidenceFailure('checked_agent_ids must contain at least two identities')
  evidenceString(evidence.implementation_audit_ref, 'implementation_audit_ref', true)
  evidenceString(evidence.scenario_verification_ref, 'scenario_verification_ref', true)
  evidenceExact(evidence.stage_result_url_and_body_sha256, ['durable_url', 'body_sha256'], 'stage_result_url_and_body_sha256')
  evidenceString(evidence.stage_result_url_and_body_sha256.durable_url, 'stage result durable_url', true)
  evidenceSha(evidence.stage_result_url_and_body_sha256.body_sha256, 'stage result body_sha256', 64, true)

  if (!Array.isArray(evidence.event_identities)) evidenceFailure('event_identities must be an array')
  for (const [index, event] of evidence.event_identities.entries()) {
    evidenceExact(event, EVENT_IDENTITY_FIELDS, `event_identities[${index}]`)
    evidenceString(event.run_id, `event_identities[${index}].run_id`)
    if (!['S1_TWO_AGENT', 'S2_SELECTED_ENABLED', 'S3_ALL_ENABLED'].includes(event.stage_id)) evidenceFailure(`event_identities[${index}].stage_id differs`)
    for (const field of ['turn_id', 'message_id', 'reply_id', 'delivery_id', 'runtime_instance_id'] as const) evidenceString(event[field], `event_identities[${index}].${field}`, true)
    evidenceInteger(event.claim_epoch, `event_identities[${index}].claim_epoch`, true, true)
    evidenceString(event.event_id, `event_identities[${index}].event_id`)
    evidenceInteger(event.seq, `event_identities[${index}].seq`)
    evidenceSha(event.payload_sha256, `event_identities[${index}].payload_sha256`)
    evidenceString(event.occurred_at, `event_identities[${index}].occurred_at`)
  }

  const terminal = evidence.terminal_result
  if (terminal.kind === 'ROLLBACK_REQUEST') {
    evidenceExact(terminal, ['kind', 'stop_reason', 'auto_advance', 'error'], 'terminal_result')
    evidenceString(terminal.stop_reason, 'terminal stop_reason')
    evidenceString(terminal.error, 'terminal error')
  } else if (terminal.kind === 'MEASURED_PENDING_INDEPENDENT_GATES') {
    evidenceExact(terminal, ['kind', 'stop_reason', 'auto_advance'], 'terminal_result')
    if (terminal.stop_reason !== 'EVIDENCE_INCOMPLETE_OR_STALE') evidenceFailure('pending evidence stop_reason differs')
  } else if (terminal.kind === 'ACCEPT_STAGE') {
    evidenceExact(terminal, ['kind', 'stop_reason', 'auto_advance'], 'terminal_result')
    const counts = evidence.direct_fanout_correlated_matrix_counts
    const edges = counts.member_count * (counts.member_count - 1)
    if (
      terminal.stop_reason !== null ||
      evidence.implementation_audit_ref === null || evidence.scenario_verification_ref === null ||
      evidence.stage_result_url_and_body_sha256.durable_url === null || evidence.stage_result_url_and_body_sha256.body_sha256 === null ||
      !evidence.replay_before_after_sha256.byte_equal ||
      counts.directed_requests !== edges || counts.terminal_replies !== edges || counts.fanout_parents !== counts.member_count ||
      counts.fanout_children !== edges || counts.correlated_reply_edges !== edges ||
      counts.missing !== 0 || counts.duplicates !== 0 || counts.unexpected_recipients !== 0 ||
      counts.wrong_queue_mutations !== 0 || counts.foreign_owner_mutations !== 0 || counts.open_turns_after_drain !== 0 ||
      counts.pending_internal_deliveries_after_drain !== 0 || counts.V1_invocations !== 0 || counts.provider_attempts !== 0 ||
      counts.provider_effects !== 0 || counts.external_send_attempts !== 0 ||
      evidence.checkout_and_runtime_drift_report.drift_count !== 0
    ) evidenceFailure('ACCEPT_STAGE is missing exact counts, independent gates, replay, result refs, or zero drift')
  } else {
    evidenceFailure('terminal_result kind differs')
  }
  if (terminal.auto_advance !== false) evidenceFailure('auto_advance must be false')

  if (expectedPlan) {
    if (terminal.kind !== 'ROLLBACK_REQUEST') validateCompleteCrashReceiptSet(decodedCrashReceipts, expectedPlan)
    const expectedCommands = expectedPlan.binding.command_catalog.map(command => ({
      command_id: command.command_id,
      executable_sha256: command.executable_sha256,
    }))
    const actualCommands = evidence.command_receipts.map(command => ({
      command_id: command.command_id,
      executable_sha256: command.executable_sha256,
    }))
    if (
      evidence.stage_binding_url !== expectedPlan.revalidation_input.binding_url ||
      evidence.stage_binding_sha256 !== expectedPlan.exact_binding_sha256 ||
      evidence.exact_implementation_main_sha !== expectedPlan.binding.exact_implementation_main_sha ||
      evidence.exact_implementation_main_tree !== expectedPlan.binding.exact_implementation_main_tree ||
      evidence.database_identity_sha256 !== expectedPlan.binding.database.identity_sha256 ||
      evidence.stage_membership_sha256 !== expectedPlan.binding.stage_members.membership_sha256 ||
      evidence.direct_fanout_correlated_matrix_counts.member_count !== expectedPlan.binding.stage_members.cardinality ||
      !same(evidence.migration_version_and_receipt, {
        required: expectedPlan.binding.migration.required,
        version: expectedPlan.binding.migration.version,
        receipt_ref: expectedPlan.binding.migration.receipt_ref,
      }) ||
      !same(evidence.enabled_snapshot_url_sha256_cardinality, {
        artifact_url: expectedPlan.binding.frozen_enabled_snapshot.artifact_url,
        canonical_json_sha256: expectedPlan.binding.frozen_enabled_snapshot.canonical_json_sha256,
        cardinality: expectedPlan.binding.frozen_enabled_snapshot.cardinality,
      }) ||
      !same(evidence.supervisor_process_identities, expectedPlan.binding.supervisor_processes) ||
      !same(actualCommands, expectedCommands) ||
      !same(evidence.checkout_and_runtime_drift_report.checked_agent_ids, expectedPlan.binding.stage_members.agent_ids) ||
      evidence.event_identities.some(event => event.run_id !== expectedPlan.binding.run_id || event.stage_id !== expectedPlan.binding.stage_id)
    ) evidenceFailure('evidence differs from the exact execution plan')
  }
  return evidence
}

function stop(reason: V2NativeStageStopReason, message: string): never {
  throw new V2NativeStageExecutionError(reason, message)
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function baselineForbidden(baseline: V2NativeStageBaselinesV1) {
  return {
    V1_message_queue_row_count: baseline.V1_message_queue_row_count,
    V1_agent_messages_row_count: baseline.V1_agent_messages_row_count,
    V1_outbound_queue_row_count: baseline.V1_outbound_queue_row_count,
    provider_attempt_count: baseline.provider_attempt_count,
    provider_effect_count: baseline.provider_effect_count,
    external_send_attempt_count: baseline.external_send_attempt_count,
  }
}

function baselineDelta(before: V2NativeStageBaselinesV1, after: V2NativeStageBaselinesV1) {
  const left = baselineForbidden(before)
  const right = baselineForbidden(after)
  return {
    V1_message_queue_row_count: right.V1_message_queue_row_count - left.V1_message_queue_row_count,
    V1_agent_messages_row_count: right.V1_agent_messages_row_count - left.V1_agent_messages_row_count,
    V1_outbound_queue_row_count: right.V1_outbound_queue_row_count - left.V1_outbound_queue_row_count,
    provider_attempt_count: right.provider_attempt_count - left.provider_attempt_count,
    provider_effect_count: right.provider_effect_count - left.provider_effect_count,
    external_send_attempt_count: right.external_send_attempt_count - left.external_send_attempt_count,
  }
}

function stopReasonFor(error: unknown): V2NativeStageStopReason {
  if (error instanceof V2NativeStageExecutionError) return error.stopReason
  if (error instanceof V2NativeStageBindingError) return error.code
  return 'EVIDENCE_INCOMPLETE_OR_STALE'
}

export function preflightV2NativeStage(input: V2NativeStagePreflightInputV1): V2NativeStageExecutionPlanV1 {
  let bindingUrl: URL
  try { bindingUrl = new URL(input.binding_url) } catch { stop('STAGE_BINDING_MISSING_OR_INVALID', 'binding_url must be an absolute durable URL') }
  if (bindingUrl.protocol !== 'https:' || bindingUrl.hash === '') stop('STAGE_BINDING_MISSING_OR_INVALID', 'binding_url must be a durable https URL with a fragment')
  const binding = clone(decodeV2NativeStageBinding(input.binding))
  if (
    binding.exact_implementation_main_sha !== input.exact_implementation_main_sha ||
    binding.exact_implementation_main_tree !== input.exact_implementation_main_tree
  ) stop('BASE_OR_TREE_DRIFT', 'explicit implementation SHA/tree differs from binding')
  const bindingSha = canonicalV2NativeStageBindingSha256(binding)
  if (bindingSha !== input.binding_sha256) stop('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'explicit binding digest differs')
  const authority = verifyV2NativeStageOwnerDecision({
    binding,
    exactBindingSha256: input.binding_sha256,
    ownerDecisionBody: input.owner_decision_body,
    ownerDecisionUrl: input.owner_decision_url,
    ownerDecisionBodySha256: input.owner_decision_body_sha256,
    now: input.now,
  })
  const { scope, fence } = deriveV2NativeMeshScopeAndFence(binding)
  const stageMemberRows = binding.frozen_enabled_snapshot.rows.filter(row => binding.stage_members.agent_ids.includes(row.agent_id))
  return {
    schema_version: 'aun-v2-native-stage-execution-plan/v1',
    binding,
    exact_binding_sha256: bindingSha,
    authority,
    scope,
    fence,
    stage_member_rows: stageMemberRows,
    crash_hooks_enabled: false,
    activation_performed: false,
    preflight_effects: {
      event_log_mutations: 0,
      model_invocations: 0,
      provider_invocations: 0,
      V1_invocations: 0,
      checkout_mutations: 0,
      process_mutations: 0,
      migration_mutations: 0,
      external_send_attempts: 0,
    },
    revalidation_input: {
      binding,
      binding_url: input.binding_url,
      binding_sha256: input.binding_sha256,
      owner_decision_body: input.owner_decision_body,
      owner_decision_url: input.owner_decision_url,
      owner_decision_body_sha256: input.owner_decision_body_sha256,
      exact_implementation_main_sha: input.exact_implementation_main_sha,
      exact_implementation_main_tree: input.exact_implementation_main_tree,
    },
  }
}

function validateSeats(plan: V2NativeStageExecutionPlanV1, seats: V2NativeStageSeatBindingV1[]): void {
  const expected = plan.stage_member_rows.map(row => row.agent_id)
  const actual = seats.map(seat => seat.seatId).sort()
  if (!same(actual, expected) || new Set(actual).size !== actual.length) stop('STAGE_MEMBERSHIP_DRIFT', 'execution seats differ from stage membership')
  const commands = new Set(plan.binding.command_catalog.map(command => command.command_id))
  for (const seat of seats) {
    const row = plan.stage_member_rows.find(candidate => candidate.agent_id === seat.seatId)!
    if (!commands.has(seat.commandId)) stop('COMMAND_CATALOG_DRIFT', `seat ${seat.seatId} references an unbound command`)
    if (
      seat.runtimeInstanceId !== row.runtime_instance_id ||
      seat.runtimeCheckoutRoot !== row.checkout_root_realpath ||
      seat.runtimeCheckoutSha !== row.checkout_sha
    ) stop('RUNTIME_BINDING_DRIFT', `seat ${seat.seatId} runtime identity differs`)
  }
}

function validateDurableAuthorityReadback(
  plan: V2NativeStageExecutionPlanV1,
  current: V2NativeStagePreflightInputV1,
  now?: Date,
): void {
  const currentPlan = preflightV2NativeStage({ ...current, now })
  if (
    currentPlan.exact_binding_sha256 !== plan.exact_binding_sha256 ||
    !same(currentPlan.revalidation_input, plan.revalidation_input)
  ) {
    stop(
      'OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH',
      'durable binding or owner-decision readback differs from the frozen execution plan',
    )
  }
}

function validateOfflineReadback(plan: V2NativeStageExecutionPlanV1, readback: V2NativeStageOfflineReadbackV1): void {
  if (
    readback.exact_implementation_main_sha !== plan.binding.exact_implementation_main_sha ||
    readback.exact_implementation_main_tree !== plan.binding.exact_implementation_main_tree
  ) stop('BASE_OR_TREE_DRIFT', 'repository readback differs from exact implementation SHA/tree')
  if (!same(readback.stage_member_rows, plan.stage_member_rows)) {
    stop('RUNTIME_BINDING_DRIFT', 'checkout, runtime, function, engine, policy, build or config readback differs')
  }
  if (!same(readback.command_catalog, plan.binding.command_catalog)) {
    stop('COMMAND_CATALOG_DRIFT', 'command catalog readback differs')
  }
}

function validateDatabaseReadback(binding: V2NativeStageBindingV1, readback: V2NativeStageDatabaseReadbackV1, requireBaseline: boolean): void {
  if (readback.database_identity_sha256 !== binding.database.identity_sha256 || !same(readback.migration, binding.migration)) {
    stop('DATABASE_OR_MIGRATION_DRIFT', 'database identity or migration readback differs')
  }
  if (requireBaseline && !same(readback.baselines, binding.pre_run_baselines)) {
    stop('DATABASE_OR_MIGRATION_DRIFT', 'pre-run baselines differ')
  }
  if (!requireBaseline) {
    const delta = baselineDelta(binding.pre_run_baselines, readback.baselines)
    if (
      delta.V1_message_queue_row_count !== 0 ||
      delta.V1_agent_messages_row_count !== 0 ||
      delta.V1_outbound_queue_row_count !== 0
    ) {
      stop('V1_TRAVERSAL_DETECTED', 'current V1 row counts differ from the frozen pre-run baseline')
    }
    if (
      delta.provider_attempt_count !== 0 ||
      delta.provider_effect_count !== 0 ||
      delta.external_send_attempt_count !== 0
    ) {
      stop('PROVIDER_OR_EXTERNAL_EFFECT_DETECTED', 'current provider or external counters differ from the frozen pre-run baseline')
    }
  }
}

interface V2NativeStageProvenanceEventV1 {
  seq: number | string
  event_id: string
  event_type: string
  occurred_at: string | Date
  seat_id: string | null
  seat_instance_id: string | null
  conversation_id: string | null
  causation_id: string | null
  correlation_id: string | null
  turn_id: string | null
  reply_id: string | null
  claim_epoch: number | string | null
  payload: Record<string, unknown>
}

async function readEventProvenance(db: DbAdapter, baselineSeq: number): Promise<V2NativeStageProvenanceEventV1[]> {
  const rows = await db.query<Omit<V2NativeStageProvenanceEventV1, 'payload'> & { payload: unknown }>(
    `SELECT seq, event_id, event_type, occurred_at, seat_id, seat_instance_id,
            conversation_id, causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
       FROM event_log
      WHERE seq > $1
      ORDER BY seq`,
    [baselineSeq],
  )
  return rows.map(row => ({ ...row, payload: parseEventPayload<Record<string, unknown>>(row.payload) }))
}

async function readQueueMutationProvenance(db: DbAdapter, baselineSeq: number): Promise<V2NativeStageProvenanceEventV1[]> {
  const rows = await db.query<Omit<V2NativeStageProvenanceEventV1, 'payload'> & { payload: unknown }>(
    `SELECT seq, event_id, event_type, occurred_at, seat_id, seat_instance_id,
            conversation_id, causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
       FROM event_log
      WHERE seq > $1
        AND (event_type = 'message.received' OR event_type LIKE 'turn.%' OR event_type = 'reply.enqueued')
      ORDER BY seq`,
    [baselineSeq],
  )
  return rows.map(row => ({ ...row, payload: parseEventPayload<Record<string, unknown>>(row.payload) }))
}

async function readOwnerMutationProvenance(db: DbAdapter, baselineSeq: number): Promise<V2NativeStageProvenanceEventV1[]> {
  const rows = await db.query<Omit<V2NativeStageProvenanceEventV1, 'payload'> & { payload: unknown }>(
    `SELECT seq, event_id, event_type, occurred_at, seat_id, seat_instance_id,
            conversation_id, causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
       FROM event_log
      WHERE seq > $1 AND seat_id IS NOT NULL
      ORDER BY seq`,
    [baselineSeq],
  )
  return rows.map(row => ({ ...row, payload: parseEventPayload<Record<string, unknown>>(row.payload) }))
}

function isExactStageEvent(row: V2NativeStageProvenanceEventV1, plan: V2NativeStageExecutionPlanV1): boolean {
  return row.payload.run_id === plan.binding.run_id && (
    row.payload.stage_id === plan.binding.stage_id ||
    row.payload.schema_version === 'aun-v2-native-route-plan/v1' &&
      row.payload.scope_sha256 === v2NativeMeshScopeSha256(plan.scope)
  )
}

async function stageEvents(db: DbAdapter, plan: V2NativeStageExecutionPlanV1) {
  return (await readEventProvenance(db, plan.binding.pre_run_baselines.event_log_max_seq))
    .filter(row => isExactStageEvent(row, plan))
}

function payloadEdge(payload: Record<string, unknown>): string {
  return `${String(payload.source_agent_id)}->${String(payload.recipient_agent_id)}`
}

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size
}

const QUEUE_OWNER_EVENT_TYPES = new Set([
  'turn.claimed', 'turn.presented', 'turn.completed', 'turn.attempt_failed',
  'turn.retry_scheduled', 'turn.blocked', 'turn.dead_lettered', 'reply.enqueued',
])

function stageTurnOwners(
  rows: V2NativeStageProvenanceEventV1[],
): Map<string, { owner: string; received: V2NativeStageProvenanceEventV1 }> {
  const owners = new Map<string, { owner: string; received: V2NativeStageProvenanceEventV1 }>()
  for (const row of rows) {
    if (row.event_type !== 'message.received' || row.turn_id === null || typeof row.payload.recipient_agent_id !== 'string') continue
    owners.set(row.turn_id, { owner: row.payload.recipient_agent_id, received: row })
  }
  return owners
}

function correlatedReplyEdges(
  stageRows: V2NativeStageProvenanceEventV1[],
  provenanceRows: V2NativeStageProvenanceEventV1[],
): number {
  const byEventId = new Map(provenanceRows.map(row => [row.event_id, row]))
  const directByTurn = new Map(stageRows
    .filter(row => row.event_type === 'message.received' && row.payload.route_kind === 'direct' && row.turn_id !== null)
    .map(row => [row.turn_id!, row]))
  const edges = new Set<string>()
  for (const reply of stageRows.filter(row => row.event_type === 'message.received' && row.payload.route_kind === 'reply')) {
    const enqueued = reply.causation_id ? byEventId.get(reply.causation_id) : undefined
    const request = enqueued?.turn_id ? directByTurn.get(enqueued.turn_id) : undefined
    if (
      enqueued?.event_type !== 'reply.enqueued' || !request ||
      enqueued.seat_id !== request.payload.recipient_agent_id ||
      reply.seat_id !== reply.payload.recipient_agent_id ||
      reply.payload.source_agent_id !== request.payload.recipient_agent_id ||
      reply.payload.recipient_agent_id !== request.payload.source_agent_id ||
      reply.correlation_id !== request.correlation_id
    ) continue
    edges.add(payloadEdge(request.payload))
  }
  return edges.size
}

function wrongQueueMutationCount(
  stageRows: V2NativeStageProvenanceEventV1[],
  queueProvenanceRows: V2NativeStageProvenanceEventV1[],
): number {
  const turns = stageTurnOwners(stageRows)
  const wrong = new Set<string>()
  for (const row of stageRows) {
    if (row.event_type === 'message.received' && row.seat_id !== row.payload.recipient_agent_id) wrong.add(row.event_id)
  }
  for (const row of queueProvenanceRows) {
    if (row.turn_id === null || !QUEUE_OWNER_EVENT_TYPES.has(row.event_type)) continue
    const expected = turns.get(row.turn_id)?.owner
    if (expected && row.seat_id !== expected) wrong.add(row.event_id)
  }
  return wrong.size
}

function foreignOwnerMutationCount(
  stageRows: V2NativeStageProvenanceEventV1[],
  ownerProvenanceRows: V2NativeStageProvenanceEventV1[],
  plan: V2NativeStageExecutionPlanV1,
): number {
  const members = new Set(plan.binding.stage_members.agent_ids)
  const stageEventIds = new Set(stageRows.map(row => row.event_id))
  const turns = stageTurnOwners(stageRows)
  const foreign = new Set<string>()
  for (const row of ownerProvenanceRows) {
    const stageRelated = stageEventIds.has(row.event_id) || row.turn_id !== null && turns.has(row.turn_id)
    if (!stageRelated || row.seat_id === null || row.seat_id === 'v2-native-internal-handoff') continue
    if (!members.has(row.seat_id)) foreign.add(row.event_id)
  }
  return foreign.size
}

function completeStageProvenance(
  stageRows: V2NativeStageProvenanceEventV1[],
  provenanceRows: V2NativeStageProvenanceEventV1[],
): V2NativeStageProvenanceEventV1[] {
  const eventIds = new Set(stageRows.map(row => row.event_id))
  const turns = stageTurnOwners(stageRows)
  return provenanceRows.filter(row => eventIds.has(row.event_id) || row.turn_id !== null && turns.has(row.turn_id))
}

async function validateStageOwnedProjectionReadback(
  db: DbAdapter,
  plan: V2NativeStageExecutionPlanV1,
  current: V2NativeStageBaselinesV1,
  accepted: V2NativeStageBaselinesV1,
): Promise<void> {
  if (current.event_log_max_seq < accepted.event_log_max_seq) {
    stop('DATABASE_OR_MIGRATION_DRIFT', 'EventLog projection moved behind the last accepted revalidation snapshot')
  }
  const provenance = await readEventProvenance(db, plan.binding.pre_run_baselines.event_log_max_seq)
  const observedMaxSeq = provenance.reduce(
    (max, row) => Math.max(max, Number(row.seq)),
    plan.binding.pre_run_baselines.event_log_max_seq,
  )
  if (observedMaxSeq !== current.event_log_max_seq) {
    stop('WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION', 'EventLog projection readback is not backed by exact durable event provenance')
  }
  const exactStageRows = provenance.filter(row => isExactStageEvent(row, plan))
  const stageOwned = completeStageProvenance(exactStageRows, provenance)
  const stageOwnedEventIds = new Set(stageOwned.map(row => row.event_id))
  if (provenance.some(row => !stageOwnedEventIds.has(row.event_id))) {
    stop('WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION', 'foreign or unbound EventLog projection appeared during exact-stage execution')
  }
  if (
    wrongQueueMutationCount(exactStageRows, provenance) !== 0 ||
    foreignOwnerMutationCount(exactStageRows, provenance, plan) !== 0
  ) {
    stop('WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION', 'stage projection contains a wrong-queue or foreign-owner mutation')
  }
  const eventLogAdvanced = current.event_log_max_seq > accepted.event_log_max_seq
  if (
    !eventLogAdvanced &&
    (
      current.active_turn_count !== accepted.active_turn_count ||
      current.open_delivery_count !== accepted.open_delivery_count
    )
  ) {
    stop('WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION', 'mutable stage projection changed without a newly accepted exact-stage EventLog event')
  }
}

function eventIdentities(
  plan: V2NativeStageExecutionPlanV1,
  events: Awaited<ReturnType<typeof stageEvents>>,
): V2NativeStageEventIdentityV1[] {
  return events.map(row => ({
    run_id: plan.binding.run_id,
    stage_id: plan.binding.stage_id,
    turn_id: row.turn_id,
    message_id: typeof row.payload.message_id === 'string' ? row.payload.message_id : null,
    reply_id: row.reply_id,
    delivery_id: typeof row.payload.delivery_id === 'string' ? row.payload.delivery_id : null,
    claim_epoch: row.claim_epoch === null ? null : Number(row.claim_epoch),
    runtime_instance_id: row.seat_instance_id,
    event_id: row.event_id,
    seq: Number(row.seq),
    payload_sha256: sha256Utf8(canonicalJson(row.payload)),
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
  }))
}

async function measureMatrix(
  db: DbAdapter,
  plan: V2NativeStageExecutionPlanV1,
  after: V2NativeStageDatabaseReadbackV1,
): Promise<{ counts: V2NativeStageMatrixCountsV1; events: V2NativeStageEventIdentityV1[] }> {
  const rows = await stageEvents(db, plan)
  // These are deliberately separate immutable provenance reads. A zero for
  // wrong-target, wrong-queue, foreign-owner or correlation is never inferred
  // from another counter.
  const correlationProvenance = await readEventProvenance(db, plan.binding.pre_run_baselines.event_log_max_seq)
  const queueProvenance = await readQueueMutationProvenance(db, plan.binding.pre_run_baselines.event_log_max_seq)
  const ownerProvenance = await readOwnerMutationProvenance(db, plan.binding.pre_run_baselines.event_log_max_seq)
  const received = rows.filter(row => row.event_type === 'message.received')
  const direct = received.filter(row => row.payload.route_kind === 'direct').map(row => payloadEdge(row.payload))
  const fanout = received.filter(row => row.payload.route_kind === 'fanout_child').map(row => payloadEdge(row.payload))
  const replies = received.filter(row => row.payload.route_kind === 'reply').map(row => payloadEdge(row.payload))
  const fanoutParents = rows.filter(row => row.event_type === 'message.route_planned' && row.payload.route_kind === 'fanout')
  const members = new Set(plan.binding.stage_members.agent_ids)
  const unexpected = received.filter(row => {
    const source = String(row.payload.source_agent_id)
    const recipient = String(row.payload.recipient_agent_id)
    return !members.has(source) || !members.has(recipient) || source === recipient
  }).length
  const n = members.size
  const expectedEdges = n * (n - 1)
  const expectedTotal = expectedEdges * 3 + n
  const actualTotal = direct.length + fanout.length + replies.length + fanoutParents.length
  const deltas = baselineDelta(plan.binding.pre_run_baselines, after.baselines)
  const openTurns = await openTurnCount(db)
  const pending = (await pendingV2NativeInternalHandoffs(db, plan.scope, plan.fence)).length
  const wrongQueue = wrongQueueMutationCount(rows, queueProvenance)
  const foreignOwner = foreignOwnerMutationCount(rows, ownerProvenance, plan)
  return {
    counts: {
      member_count: n,
      directed_requests: direct.length,
      terminal_replies: replies.length,
      fanout_parents: fanoutParents.length,
      fanout_children: fanout.length,
      correlated_reply_edges: correlatedReplyEdges(rows, correlationProvenance),
      missing: Math.max(0, expectedTotal - actualTotal),
      duplicates: duplicateCount(direct) + duplicateCount(fanout) + duplicateCount(replies),
      unexpected_recipients: unexpected,
      wrong_queue_mutations: wrongQueue,
      foreign_owner_mutations: foreignOwner,
      open_turns_after_drain: openTurns,
      pending_internal_deliveries_after_drain: pending,
      V1_invocations: deltas.V1_message_queue_row_count + deltas.V1_agent_messages_row_count + deltas.V1_outbound_queue_row_count,
      provider_attempts: deltas.provider_attempt_count,
      provider_effects: deltas.provider_effect_count,
      external_send_attempts: deltas.external_send_attempt_count,
    },
    events: eventIdentities(plan, completeStageProvenance(rows, correlationProvenance)),
  }
}

async function currentViewHash(db: DbAdapter): Promise<string> {
  const value = JSON.parse(JSON.stringify({
    active_turns: await activeTurnProjection(db),
    delivery_truth: await deliveryTruthView(db),
  }))
  return sha256Utf8(canonicalJson(value))
}

async function replayViewHashes(db: DbAdapter): Promise<{ before: string; after: string; byte_equal: boolean }> {
  const before = await currentViewHash(db)
  const afterValue = JSON.parse(JSON.stringify({
    active_turns: await rebuildActiveTurnProjection(db),
    delivery_truth: await rebuildDeliveryTruthView(db),
  }))
  const after = sha256Utf8(canonicalJson(afterValue))
  return { before, after, byte_equal: before === after }
}

function assertMatrix(counts: V2NativeStageMatrixCountsV1): void {
  const n = counts.member_count
  const edges = n * (n - 1)
  if (counts.wrong_queue_mutations !== 0 || counts.foreign_owner_mutations !== 0) {
    stop('WRONG_QUEUE_OR_FOREIGN_OWNER_MUTATION', 'independent queue or owner provenance query detected a forbidden mutation')
  }
  if (
    counts.directed_requests !== edges || counts.terminal_replies !== edges ||
    counts.fanout_parents !== n || counts.fanout_children !== edges || counts.correlated_reply_edges !== edges ||
    counts.missing !== 0 || counts.duplicates !== 0 || counts.unexpected_recipients !== 0
  ) stop('MATRIX_COUNT_MISMATCH', 'direct/fanout/correlated matrix counts differ')
  if (counts.open_turns_after_drain !== 0 || counts.pending_internal_deliveries_after_drain !== 0) stop('RESIDUAL_OPEN_WORK', 'stage has residual open work')
  if (counts.V1_invocations !== 0) stop('V1_TRAVERSAL_DETECTED', 'V1 row count changed')
  if (counts.provider_attempts !== 0 || counts.provider_effects !== 0 || counts.external_send_attempts !== 0) {
    stop('PROVIDER_OR_EXTERNAL_EFFECT_DETECTED', 'provider or external counters changed')
  }
}

function emptyCounts(plan: V2NativeStageExecutionPlanV1): V2NativeStageMatrixCountsV1 {
  return {
    member_count: plan.binding.stage_members.cardinality,
    directed_requests: 0,
    terminal_replies: 0,
    fanout_parents: 0,
    fanout_children: 0,
    correlated_reply_edges: 0,
    missing: plan.binding.stage_members.cardinality * (plan.binding.stage_members.cardinality - 1) * 3 + plan.binding.stage_members.cardinality,
    duplicates: 0,
    unexpected_recipients: 0,
    wrong_queue_mutations: 0,
    foreign_owner_mutations: 0,
    open_turns_after_drain: 0,
    pending_internal_deliveries_after_drain: 0,
    V1_invocations: 0,
    provider_attempts: 0,
    provider_effects: 0,
    external_send_attempts: 0,
  }
}

function evidenceBase(
  plan: V2NativeStageExecutionPlanV1,
  counts: V2NativeStageMatrixCountsV1,
  events: V2NativeStageEventIdentityV1[],
  replay: { before: string; after: string; byte_equal: boolean },
  after: V2NativeStageBaselinesV1,
  crashReceipts: V2NativeStageCrashBoundaryReceiptV1[],
  executedCommandIds: readonly string[] = [],
): Omit<V2NativeStageEvidenceV1, 'terminal_result'> {
  const delta = baselineDelta(plan.binding.pre_run_baselines, after)
  return {
    schema_version: V2_NATIVE_STAGE_EVIDENCE_SCHEMA_VERSION,
    stage_binding_url: plan.revalidation_input.binding_url,
    stage_binding_sha256: plan.exact_binding_sha256,
    exact_implementation_main_sha: plan.binding.exact_implementation_main_sha,
    exact_implementation_main_tree: plan.binding.exact_implementation_main_tree,
    database_identity_sha256: plan.binding.database.identity_sha256,
    migration_version_and_receipt: {
      required: plan.binding.migration.required,
      version: plan.binding.migration.version,
      receipt_ref: plan.binding.migration.receipt_ref,
    },
    enabled_snapshot_url_sha256_cardinality: {
      artifact_url: plan.binding.frozen_enabled_snapshot.artifact_url,
      canonical_json_sha256: plan.binding.frozen_enabled_snapshot.canonical_json_sha256,
      cardinality: plan.binding.frozen_enabled_snapshot.cardinality,
    },
    stage_membership_sha256: plan.binding.stage_members.membership_sha256,
    supervisor_process_identities: plan.binding.supervisor_processes,
    command_receipts: plan.binding.command_catalog.map(command => ({
      command_id: command.command_id,
      executable_sha256: command.executable_sha256,
      status: executedCommandIds.includes(command.command_id)
        ? 'EXECUTED_BY_BOUND_SEAT' as const
        : 'BOUND_NOT_STARTED_BY_EXECUTOR' as const,
    })),
    direct_fanout_correlated_matrix_counts: counts,
    crash_boundary_receipts: crashReceipts,
    replay_before_after_sha256: replay,
    V1_provider_external_baseline_and_delta: { before: baselineForbidden(plan.binding.pre_run_baselines), delta },
    wrong_target_wrong_queue_foreign_owner_zero_mutation: {
      wrong_target: counts.unexpected_recipients,
      wrong_queue: counts.wrong_queue_mutations,
      foreign_owner: counts.foreign_owner_mutations,
    },
    open_turn_and_pending_delivery_residual_queries: {
      open_turns: counts.open_turns_after_drain,
      pending_internal_deliveries: counts.pending_internal_deliveries_after_drain,
    },
    checkout_and_runtime_drift_report: {
      drift_count: 0,
      checked_agent_ids: plan.binding.stage_members.agent_ids,
    },
    implementation_audit_ref: null,
    scenario_verification_ref: null,
    stage_result_url_and_body_sha256: { durable_url: null, body_sha256: null },
    event_identities: events,
  }
}

export function emitV2NativeStageRollbackRequest(options: {
  plan: V2NativeStageExecutionPlanV1
  error: unknown
  partialEvidence?: Omit<V2NativeStageEvidenceV1, 'terminal_result'>
}): V2NativeStageEvidenceV1 {
  const reason = stopReasonFor(options.error)
  const base = options.partialEvidence ?? evidenceBase(
    options.plan,
    emptyCounts(options.plan),
    [],
    { before: sha256Utf8(canonicalJson([])), after: sha256Utf8(canonicalJson([])), byte_equal: true },
    options.plan.binding.pre_run_baselines,
    [],
  )
  return decodeV2NativeStageEvidence({
    ...base,
    terminal_result: {
      kind: 'ROLLBACK_REQUEST',
      stop_reason: reason,
      auto_advance: false,
      error: options.error instanceof Error ? options.error.message : String(options.error),
    },
  }, options.plan)
}

export async function executeV2NativeStage(
  input: V2NativeStagePreflightInputV1,
  ports: V2NativeStageExecutionPortsV1,
): Promise<V2NativeStageExecutionResultV1> {
  const plan = preflightV2NativeStage(input)
  validateSeats(plan, ports.seats)
  if (typeof ports.readDurableAuthority !== 'function') {
    stop('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'durable authority readback port is required')
  }
  if (plan.binding.stage_id === 'S1_TWO_AGENT') {
    if (ports.enableCrashHooks) stop('CRASH_RECOVERY_AMBIGUOUS', 'S1 cannot enable crash hooks')
  } else if (!ports.enableCrashHooks || plan.authority.decision.crash_hooks !== 'planned_stage_bound' || !ports.runCrashScenario) {
    stop('CRASH_RECOVERY_AMBIGUOUS', 'S2/S3 execution requires an exact stage decision, explicit crash enablement and a bound hook')
  }
  validateDurableAuthorityReadback(plan, await ports.readDurableAuthority(plan), ports.now?.())
  validateOfflineReadback(plan, await ports.readOfflineState(plan))
  let db: DbAdapter | null = null
  let partialEvidence: Omit<V2NativeStageEvidenceV1, 'terminal_result'> | undefined
  try {
    db = await ports.openBoundDatabase(plan.binding)
    const initial = await ports.readDatabaseState(db, plan.binding)
    validateDatabaseReadback(plan.binding, initial, true)
    let acceptedProjection = clone(initial.baselines)
    const revalidate = async () => {
      validateDurableAuthorityReadback(plan, await ports.readDurableAuthority(plan), ports.now?.())
      validateOfflineReadback(plan, await ports.readOfflineState(plan))
      const current = await ports.readDatabaseState(db!, plan.binding)
      validateDatabaseReadback(plan.binding, current, false)
      await validateStageOwnedProjectionReadback(db!, plan, current.baselines, acceptedProjection)
      acceptedProjection = clone(current.baselines)
    }
    const route = ports.routeMessage ?? routeV2NativeMessage
    const tick = ports.runMeshTick ?? runV2NativeMeshTick
    const meshMutationFence = async (boundary: string) => {
      await revalidate()
      if (ports.onMeshMutationBoundary) {
        await ports.onMeshMutationBoundary(boundary)
        await revalidate()
      }
    }
    const ids = plan.binding.stage_members.agent_ids
    for (const source of ids) {
      const recipients = ids.filter(agentId => agentId !== source)
      for (const recipient of recipients) {
        await revalidate()
        await route(db, plan.scope, plan.fence, {
          route_id: `stage:${plan.binding.run_id}:direct:${source}:${recipient}`,
          route_kind: 'direct',
          source_agent_id: source,
          recipient_agent_ids: [recipient],
          content: `stage-direct-request:${plan.binding.run_id}:${source}:${recipient}`,
        }, { onCommitPoint: async point => { await revalidate(); await ports.onCommitPoint?.(point); await revalidate() } })
        await revalidate()
      }
      await route(db, plan.scope, plan.fence, {
        route_id: `stage:${plan.binding.run_id}:fanout:${source}`,
        route_kind: 'fanout',
        source_agent_id: source,
        recipient_agent_ids: recipients,
        content: `stage-fanout-observation:${plan.binding.run_id}:${source}`,
      }, { onCommitPoint: async point => { await revalidate(); await ports.onCommitPoint?.(point); await revalidate() } })
      await revalidate()
    }
    let drainTicks = 0
    const maxDrainTicks = ports.maxDrainTicks ?? 32
    while ((await openTurnCount(db)) > 0 || (await pendingV2NativeInternalHandoffs(db, plan.scope, plan.fence)).length > 0) {
      await revalidate()
      await tick(db, {
        scope: plan.scope,
        fence: plan.fence,
        seats: ports.seats,
        instanceId: `stage:${plan.binding.run_id}:tick:${drainTicks}`,
        maxTurnsPerSeat: 100,
        dbFactory: ports.dbFactory,
        mutationFence: meshMutationFence,
        supervision: {
          reconnectMaxAttempts: 1,
          reconnectBaseDelayMs: 1,
          reconnectMaxDelayMs: 1,
          unitTimeoutMs: 120_000,
        },
      })
      await revalidate()
      if (++drainTicks > maxDrainTicks) stop('RESIDUAL_OPEN_WORK', 'stage matrix did not drain before the bounded tick limit')
    }
    const crashReceipts = ports.enableCrashHooks
      ? validateCrashReceiptsForExecution(await ports.runCrashScenario!({ plan, db, mutationFence: revalidate }), plan)
      : []
    await revalidate()
    const after = await ports.readDatabaseState(db, plan.binding)
    validateDatabaseReadback(plan.binding, after, false)
    const measured = await measureMatrix(db, plan, after)
    await revalidate()
    const replay = await replayViewHashes(db)
    await revalidate()
    partialEvidence = evidenceBase(
      plan,
      measured.counts,
      measured.events,
      replay,
      after.baselines,
      crashReceipts,
      ports.seats.map(seat => seat.commandId),
    )
    assertMatrix(measured.counts)
    if (!replay.byte_equal) stop('REPLAY_BYTE_MISMATCH', 'derived views differ after canonical replay')
    const evidence: V2NativeStageEvidenceV1 = {
      ...partialEvidence,
      terminal_result: {
        kind: 'MEASURED_PENDING_INDEPENDENT_GATES',
        stop_reason: 'EVIDENCE_INCOMPLETE_OR_STALE',
        auto_advance: false,
      },
    }
    return { ok: true, result: 'MEASURED_PENDING_INDEPENDENT_GATES', plan, evidence: decodeV2NativeStageEvidence(evidence, plan) }
  } catch (error) {
    if (db && !partialEvidence) {
      try {
        const after = await ports.readDatabaseState(db, plan.binding)
        const measured = await measureMatrix(db, plan, after)
        const preservedViewHash = await currentViewHash(db)
        partialEvidence = evidenceBase(
          plan,
          measured.counts,
          measured.events,
          { before: preservedViewHash, after: preservedViewHash, byte_equal: false },
          after.baselines,
          [],
          ports.seats.map(seat => seat.commandId),
        )
      } catch {
        // The original typed failure remains authority; evidence collection
        // never performs cleanup, retry, replay, or a second mutation.
      }
    }
    const evidence = emitV2NativeStageRollbackRequest({ plan, error, partialEvidence })
    return { ok: false, result: 'ROLLBACK_REQUEST', plan, evidence }
  } finally {
    if (db) await (ports.closeDatabase ? ports.closeDatabase(db) : db.close())
  }
}
