import { realpathSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { canonicalJson, sha256Utf8 } from './transport-contract'
import {
  frozenEnabledSetSha256,
  runtimeSnapshotSha256,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
  type V2NativeMeshStageId,
} from './v2-native-ingress'

export const V2_NATIVE_STAGE_BINDING_SCHEMA_VERSION = 'aun-v2-native-stage-binding/v1' as const
export const V2_NATIVE_STAGE_OWNER_DECISION_SCHEMA_VERSION = 'shirube-v3/v2-native-stage-owner-decision/v1' as const

export type V2NativeActivationStageId = Exclude<V2NativeMeshStageId, 'S0_IMPLEMENTATION'>

export interface V2NativeStageDatabaseV1 {
  engine: 'PostgreSQL'
  server_version: string
  cluster_fingerprint_sha256: string
  database_name: string
  database_oid: number
  schema_name: string
  identity_sha256: string
}

export interface V2NativeStageMigrationV1 {
  required: boolean
  version: string | null
  up_blob_sha256: string | null
  down_blob_sha256: string | null
  applied_at: string | null
  decision_ref: string | null
  receipt_ref: string | null
}

export interface V2NativeStageEnabledRowV1 {
  agent_id: string
  enabled: true
  active_function: string
  runtime_instance_id: string
  workspace_realpath: string
  checkout_root_realpath: string
  checkout_sha: string
  checkout_tree: string
  engine: string
  status: string
  last_seen_at: string
  runtime_policy_sha256: string
  runtime_build_sha256: string
  config_sha256: string
}

export interface V2NativeStageEnabledSnapshotV1 {
  artifact_url: string
  canonical_json_sha256: string
  cardinality: number
  generated_at: string
  query_digest: string
  rows: V2NativeStageEnabledRowV1[]
}

export interface V2NativeStageMembersV1 {
  agent_ids: string[]
  cardinality: number
  membership_sha256: string
}

export interface V2NativeStageBaselinesV1 {
  event_log_max_seq: number
  active_turn_count: number
  open_delivery_count: number
  V1_message_queue_row_count: number
  V1_agent_messages_row_count: number
  V1_outbound_queue_row_count: number
  provider_attempt_count: number
  provider_effect_count: number
  external_send_attempt_count: number
}

export interface V2NativeStageSupervisorProcessV1 {
  unit_kind: 'seat' | 'outbox' | 'reconciler'
  agent_id_or_dispatcher_id: string
  runtime_instance_id: string
  pid: number
  process_start_time: string
  executable_realpath: string
  executable_sha256: string
  checkout_sha: string
  database_identity_sha256: string
}

export interface V2NativeStageCommandV1 {
  command_id: string
  exact_argv: string[]
  cwd_realpath: string
  allowed_env_keys: string[]
  env_value_hashes: Record<string, string>
  timeout_seconds: number
  executable_sha256: string
}

export interface V2NativeStageApprovalRefV1 {
  owner: string
  durable_url: string
  body_sha256: string
  exact_stage_id: V2NativeActivationStageId
  exact_binding_sha256: string
}

export interface V2NativeStageBindingV1 {
  schema_version: typeof V2_NATIVE_STAGE_BINDING_SCHEMA_VERSION
  run_id: string
  stage_id: V2NativeActivationStageId
  exact_implementation_main_sha: string
  exact_implementation_main_tree: string
  database: V2NativeStageDatabaseV1
  migration: V2NativeStageMigrationV1
  frozen_enabled_snapshot: V2NativeStageEnabledSnapshotV1
  stage_members: V2NativeStageMembersV1
  started_at: string
  deadline: string
  provider_dispatch: 'disabled'
  V1_mode: 'observe_only_no_traversal'
  pre_run_baselines: V2NativeStageBaselinesV1
  supervisor_processes: V2NativeStageSupervisorProcessV1[]
  command_catalog: V2NativeStageCommandV1[]
  approval_ref: V2NativeStageApprovalRefV1
  prior_gate_ref: 'K3_POST_MERGE_AND_INDEPENDENT_GATES' | 'S1_TERMINAL_PASS' | 'S2_TERMINAL_PASS'
}

export interface V2NativeStageOwnerDecisionV1 {
  schema_version: typeof V2_NATIVE_STAGE_OWNER_DECISION_SCHEMA_VERSION
  decision_id: string
  owner: string
  decision: 'APPROVE_STAGE_ACTIVATION'
  status: 'active'
  exact_stage_id: V2NativeActivationStageId
  exact_binding_sha256: string
  issued_at: string
  expires_at: string
  superseded_by: null
  crash_hooks: 'disabled' | 'planned_stage_bound'
}

export interface V2NativeVerifiedStageAuthorityV1 {
  decision: V2NativeStageOwnerDecisionV1
  owner_decision_url: string
  owner_decision_body_sha256: string
  exact_binding_sha256: string
}

export class V2NativeStageBindingError extends Error {
  constructor(
    readonly code:
      | 'STAGE_BINDING_MISSING_OR_INVALID'
      | 'OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH'
      | 'STAGE_MEMBERSHIP_DRIFT'
      | 'ENABLED_SNAPSHOT_DRIFT'
      | 'RUNTIME_BINDING_DRIFT'
      | 'DATABASE_OR_MIGRATION_DRIFT'
      | 'COMMAND_CATALOG_DRIFT'
      | 'DEADLINE_EXPIRED',
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

const BINDING_FIELDS = [
  'schema_version', 'run_id', 'stage_id', 'exact_implementation_main_sha',
  'exact_implementation_main_tree', 'database', 'migration', 'frozen_enabled_snapshot',
  'stage_members', 'started_at', 'deadline', 'provider_dispatch', 'V1_mode',
  'pre_run_baselines', 'supervisor_processes', 'command_catalog', 'approval_ref', 'prior_gate_ref',
] as const
const DATABASE_FIELDS = ['engine', 'server_version', 'cluster_fingerprint_sha256', 'database_name', 'database_oid', 'schema_name', 'identity_sha256'] as const
const MIGRATION_FIELDS = ['required', 'version', 'up_blob_sha256', 'down_blob_sha256', 'applied_at', 'decision_ref', 'receipt_ref'] as const
const SNAPSHOT_FIELDS = ['artifact_url', 'canonical_json_sha256', 'cardinality', 'generated_at', 'query_digest', 'rows'] as const
const ENABLED_ROW_FIELDS = [
  'agent_id', 'enabled', 'active_function', 'runtime_instance_id', 'workspace_realpath',
  'checkout_root_realpath', 'checkout_sha', 'checkout_tree', 'engine', 'status', 'last_seen_at',
  'runtime_policy_sha256', 'runtime_build_sha256', 'config_sha256',
] as const
const MEMBER_FIELDS = ['agent_ids', 'cardinality', 'membership_sha256'] as const
const BASELINE_FIELDS = [
  'event_log_max_seq', 'active_turn_count', 'open_delivery_count', 'V1_message_queue_row_count',
  'V1_agent_messages_row_count', 'V1_outbound_queue_row_count', 'provider_attempt_count',
  'provider_effect_count', 'external_send_attempt_count',
] as const
const SUPERVISOR_FIELDS = [
  'unit_kind', 'agent_id_or_dispatcher_id', 'runtime_instance_id', 'pid', 'process_start_time',
  'executable_realpath', 'executable_sha256', 'checkout_sha', 'database_identity_sha256',
] as const
const COMMAND_FIELDS = [
  'command_id', 'exact_argv', 'cwd_realpath', 'allowed_env_keys', 'env_value_hashes',
  'timeout_seconds', 'executable_sha256',
] as const
const APPROVAL_FIELDS = ['owner', 'durable_url', 'body_sha256', 'exact_stage_id', 'exact_binding_sha256'] as const
const DECISION_FIELDS = [
  'schema_version', 'decision_id', 'owner', 'decision', 'status', 'exact_stage_id',
  'exact_binding_sha256', 'issued_at', 'expires_at', 'superseded_by', 'crash_hooks',
] as const

function fail(code: V2NativeStageBindingError['code'], message: string): never {
  throw new V2NativeStageBindingError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactFields(value: unknown, fields: readonly string[], name: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail('STAGE_BINDING_MISSING_OR_INVALID', `${name} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    const missing = expected.filter(field => !actual.includes(field))
    const extra = actual.filter(field => !expected.includes(field))
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${name} fields differ missing=[${missing.join(',')}] extra=[${extra.join(',')}]`)
  }
}

function string(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be a non-empty trimmed string`)
  }
}

function nullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null) string(value, field)
}

function sha(value: unknown, field: string, length: 40 | 64 = 64): asserts value is string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be lowercase ${length}-hex`)
  }
}

function nullableSha(value: unknown, field: string): asserts value is string | null {
  if (value !== null) sha(value, field)
}

function integer(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be an integer >= ${minimum}`)
  }
}

function rfc3339Utc(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be RFC3339 UTC`)
  }
}

function uuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be a UUID`)
  }
}

function durableUrl(value: unknown, field: string): asserts value is string {
  string(value, field)
  let parsed: URL
  try { parsed = new URL(value) } catch { return fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be an absolute URL`) }
  if (parsed.protocol !== 'https:' || parsed.hash === '') fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be a durable https URL with a fragment`)
}

function realpath(value: unknown, field: string): asserts value is string {
  string(value, field)
  let resolved: string
  try {
    resolved = realpathSync.native(value)
  } catch {
    fail('RUNTIME_BINDING_DRIFT', `${field} must resolve to an existing realpath`)
  }
  if (!isAbsolute(value) || normalize(value) !== value || resolved !== value) {
    fail('RUNTIME_BINDING_DRIFT', `${field} must be an absolute normalized realpath without a symlink alias`)
  }
}

function orderedStrings(value: unknown, field: string, allowEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be a ${allowEmpty ? '' : 'non-empty '}array`)
  for (const [index, item] of value.entries()) string(item, `${field}[${index}]`)
  const sorted = [...value].sort()
  if (sorted.some((item, index) => item !== value[index]) || sorted.some((item, index) => index > 0 && item === sorted[index - 1])) {
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} must be ascending and unique`)
  }
}

function stage(value: unknown, field: string): asserts value is V2NativeActivationStageId {
  if (!['S1_TWO_AGENT', 'S2_SELECTED_ENABLED', 'S3_ALL_ENABLED'].includes(value as string)) {
    fail('STAGE_BINDING_MISSING_OR_INVALID', `${field} is not an activation stage`)
  }
}

function databaseIdentitySha256(database: V2NativeStageDatabaseV1): string {
  const { identity_sha256: _identity, ...identity } = database
  return sha256Utf8(canonicalJson(identity))
}

function enabledSnapshotSha256(snapshot: V2NativeStageEnabledSnapshotV1): string {
  return sha256Utf8(canonicalJson(snapshot.rows))
}

export function stageMembershipSha256(agentIds: readonly string[]): string {
  return sha256Utf8(canonicalJson(agentIds))
}

function decodeDatabase(value: unknown): V2NativeStageDatabaseV1 {
  exactFields(value, DATABASE_FIELDS, 'database')
  const database = value as unknown as V2NativeStageDatabaseV1
  if (database.engine !== 'PostgreSQL') fail('DATABASE_OR_MIGRATION_DRIFT', 'database.engine must be PostgreSQL')
  string(database.server_version, 'database.server_version')
  sha(database.cluster_fingerprint_sha256, 'database.cluster_fingerprint_sha256')
  string(database.database_name, 'database.database_name')
  integer(database.database_oid, 'database.database_oid', 1)
  string(database.schema_name, 'database.schema_name')
  sha(database.identity_sha256, 'database.identity_sha256')
  if (database.identity_sha256 !== databaseIdentitySha256(database)) fail('DATABASE_OR_MIGRATION_DRIFT', 'database identity digest differs')
  return database
}

function decodeMigration(value: unknown): V2NativeStageMigrationV1 {
  exactFields(value, MIGRATION_FIELDS, 'migration')
  const migration = value as unknown as V2NativeStageMigrationV1
  if (typeof migration.required !== 'boolean') fail('STAGE_BINDING_MISSING_OR_INVALID', 'migration.required must be boolean')
  nullableString(migration.version, 'migration.version')
  nullableSha(migration.up_blob_sha256, 'migration.up_blob_sha256')
  nullableSha(migration.down_blob_sha256, 'migration.down_blob_sha256')
  if (migration.applied_at !== null) rfc3339Utc(migration.applied_at, 'migration.applied_at')
  nullableString(migration.decision_ref, 'migration.decision_ref')
  nullableString(migration.receipt_ref, 'migration.receipt_ref')
  const values = [migration.version, migration.up_blob_sha256, migration.down_blob_sha256, migration.applied_at, migration.decision_ref, migration.receipt_ref]
  if (migration.required && values.some(item => item === null)) fail('DATABASE_OR_MIGRATION_DRIFT', 'required migration evidence is incomplete')
  if (!migration.required && values.some(item => item !== null)) fail('DATABASE_OR_MIGRATION_DRIFT', 'non-required migration evidence must be null')
  return migration
}

function decodeSnapshot(value: unknown): V2NativeStageEnabledSnapshotV1 {
  exactFields(value, SNAPSHOT_FIELDS, 'frozen_enabled_snapshot')
  const snapshot = value as unknown as V2NativeStageEnabledSnapshotV1
  durableUrl(snapshot.artifact_url, 'frozen_enabled_snapshot.artifact_url')
  sha(snapshot.canonical_json_sha256, 'frozen_enabled_snapshot.canonical_json_sha256')
  integer(snapshot.cardinality, 'frozen_enabled_snapshot.cardinality', 2)
  rfc3339Utc(snapshot.generated_at, 'frozen_enabled_snapshot.generated_at')
  sha(snapshot.query_digest, 'frozen_enabled_snapshot.query_digest')
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length !== snapshot.cardinality) fail('ENABLED_SNAPSHOT_DRIFT', 'snapshot rows do not match cardinality')
  let previousAgent = ''
  const uniqueRuntime = new Set<string>()
  const uniqueWorkspace = new Set<string>()
  const uniqueCheckout = new Set<string>()
  for (const [index, candidate] of snapshot.rows.entries()) {
    exactFields(candidate, ENABLED_ROW_FIELDS, `frozen_enabled_snapshot.rows[${index}]`)
    const row = candidate as unknown as V2NativeStageEnabledRowV1
    string(row.agent_id, `rows[${index}].agent_id`)
    if (row.agent_id <= previousAgent) fail('ENABLED_SNAPSHOT_DRIFT', 'snapshot rows must be ascending by unique agent_id')
    previousAgent = row.agent_id
    if (row.enabled !== true) fail('ENABLED_SNAPSHOT_DRIFT', `snapshot row ${row.agent_id} is not enabled`)
    for (const field of ['active_function', 'runtime_instance_id', 'engine', 'status'] as const) string(row[field], `rows[${index}].${field}`)
    realpath(row.workspace_realpath, `rows[${index}].workspace_realpath`)
    realpath(row.checkout_root_realpath, `rows[${index}].checkout_root_realpath`)
    sha(row.checkout_sha, `rows[${index}].checkout_sha`, 40)
    sha(row.checkout_tree, `rows[${index}].checkout_tree`, 40)
    rfc3339Utc(row.last_seen_at, `rows[${index}].last_seen_at`)
    for (const field of ['runtime_policy_sha256', 'runtime_build_sha256', 'config_sha256'] as const) sha(row[field], `rows[${index}].${field}`)
    if (uniqueRuntime.has(row.runtime_instance_id) || uniqueWorkspace.has(row.workspace_realpath) || uniqueCheckout.has(row.checkout_root_realpath)) {
      fail('ENABLED_SNAPSHOT_DRIFT', 'snapshot runtime, workspace and checkout identities must be unique')
    }
    uniqueRuntime.add(row.runtime_instance_id)
    uniqueWorkspace.add(row.workspace_realpath)
    uniqueCheckout.add(row.checkout_root_realpath)
  }
  if (snapshot.canonical_json_sha256 !== enabledSnapshotSha256(snapshot)) fail('ENABLED_SNAPSHOT_DRIFT', 'snapshot canonical_json_sha256 differs from rows')
  return snapshot
}

function decodeMembers(value: unknown, binding: Pick<V2NativeStageBindingV1, 'stage_id' | 'frozen_enabled_snapshot'>): V2NativeStageMembersV1 {
  exactFields(value, MEMBER_FIELDS, 'stage_members')
  const members = value as unknown as V2NativeStageMembersV1
  orderedStrings(members.agent_ids, 'stage_members.agent_ids')
  integer(members.cardinality, 'stage_members.cardinality', 2)
  if (members.cardinality !== members.agent_ids.length) fail('STAGE_MEMBERSHIP_DRIFT', 'stage member cardinality differs')
  sha(members.membership_sha256, 'stage_members.membership_sha256')
  if (members.membership_sha256 !== stageMembershipSha256(members.agent_ids)) fail('STAGE_MEMBERSHIP_DRIFT', 'stage membership digest differs')
  const enabledIds = binding.frozen_enabled_snapshot.rows.map(row => row.agent_id)
  if (members.agent_ids.some(agentId => !enabledIds.includes(agentId))) fail('STAGE_MEMBERSHIP_DRIFT', 'stage has a foreign or disabled member')
  if (binding.stage_id === 'S1_TWO_AGENT' && members.cardinality !== 2) fail('STAGE_MEMBERSHIP_DRIFT', 'S1 requires exactly two members')
  if (binding.stage_id === 'S2_SELECTED_ENABLED' && (members.cardinality <= 2 || members.cardinality > enabledIds.length)) fail('STAGE_MEMBERSHIP_DRIFT', 'S2 cardinality must satisfy 2 < N <= enabled cardinality')
  if (binding.stage_id === 'S3_ALL_ENABLED' && canonicalJson(members.agent_ids) !== canonicalJson(enabledIds)) fail('STAGE_MEMBERSHIP_DRIFT', 'S3 must include every enabled row exactly')
  return members
}

function decodeBaselines(value: unknown): V2NativeStageBaselinesV1 {
  exactFields(value, BASELINE_FIELDS, 'pre_run_baselines')
  const baselines = value as unknown as V2NativeStageBaselinesV1
  for (const field of BASELINE_FIELDS) integer(baselines[field], `pre_run_baselines.${field}`)
  return baselines
}

function decodeSupervisors(value: unknown, databaseIdentity: string): V2NativeStageSupervisorProcessV1[] {
  if (!Array.isArray(value) || value.length === 0) fail('RUNTIME_BINDING_DRIFT', 'supervisor_processes must be non-empty')
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    exactFields(candidate, SUPERVISOR_FIELDS, `supervisor_processes[${index}]`)
    const unit = candidate as unknown as V2NativeStageSupervisorProcessV1
    if (!['seat', 'outbox', 'reconciler'].includes(unit.unit_kind)) fail('RUNTIME_BINDING_DRIFT', `supervisor_processes[${index}].unit_kind differs`)
    string(unit.agent_id_or_dispatcher_id, `supervisor_processes[${index}].agent_id_or_dispatcher_id`)
    string(unit.runtime_instance_id, `supervisor_processes[${index}].runtime_instance_id`)
    integer(unit.pid, `supervisor_processes[${index}].pid`, 1)
    rfc3339Utc(unit.process_start_time, `supervisor_processes[${index}].process_start_time`)
    realpath(unit.executable_realpath, `supervisor_processes[${index}].executable_realpath`)
    sha(unit.executable_sha256, `supervisor_processes[${index}].executable_sha256`)
    sha(unit.checkout_sha, `supervisor_processes[${index}].checkout_sha`, 40)
    sha(unit.database_identity_sha256, `supervisor_processes[${index}].database_identity_sha256`)
    if (unit.database_identity_sha256 !== databaseIdentity) fail('DATABASE_OR_MIGRATION_DRIFT', 'supervisor database identity differs')
    const key = `${unit.unit_kind}:${unit.agent_id_or_dispatcher_id}`
    if (seen.has(key)) fail('RUNTIME_BINDING_DRIFT', `duplicate supervisor ${key}`)
    seen.add(key)
    return unit
  })
}

function decodeCommands(value: unknown): V2NativeStageCommandV1[] {
  if (!Array.isArray(value) || value.length === 0) fail('COMMAND_CATALOG_DRIFT', 'command_catalog must be non-empty')
  let previous = ''
  return value.map((candidate, index) => {
    exactFields(candidate, COMMAND_FIELDS, `command_catalog[${index}]`)
    const command = candidate as unknown as V2NativeStageCommandV1
    string(command.command_id, `command_catalog[${index}].command_id`)
    if (command.command_id <= previous) fail('COMMAND_CATALOG_DRIFT', 'command_catalog must be ascending by unique command_id')
    previous = command.command_id
    if (!Array.isArray(command.exact_argv) || command.exact_argv.length === 0) fail('COMMAND_CATALOG_DRIFT', `command ${command.command_id} exact_argv is empty`)
    command.exact_argv.forEach((arg, argIndex) => string(arg, `command_catalog[${index}].exact_argv[${argIndex}]`))
    if (!isAbsolute(command.exact_argv[0])) fail('COMMAND_CATALOG_DRIFT', `command ${command.command_id} executable must be an absolute path`)
    realpath(command.exact_argv[0], `command_catalog[${index}].exact_argv[0]`)
    realpath(command.cwd_realpath, `command_catalog[${index}].cwd_realpath`)
    orderedStrings(command.allowed_env_keys, `command_catalog[${index}].allowed_env_keys`, true)
    if (!isRecord(command.env_value_hashes)) fail('COMMAND_CATALOG_DRIFT', `command ${command.command_id} env_value_hashes must be an object`)
    const envKeys = Object.keys(command.env_value_hashes).sort()
    if (canonicalJson(envKeys) !== canonicalJson(command.allowed_env_keys)) fail('COMMAND_CATALOG_DRIFT', `command ${command.command_id} env keys and hashes differ`)
    for (const key of envKeys) sha(command.env_value_hashes[key], `command_catalog[${index}].env_value_hashes.${key}`)
    integer(command.timeout_seconds, `command_catalog[${index}].timeout_seconds`, 1)
    sha(command.executable_sha256, `command_catalog[${index}].executable_sha256`)
    return command
  })
}

function decodeApproval(value: unknown): V2NativeStageApprovalRefV1 {
  exactFields(value, APPROVAL_FIELDS, 'approval_ref')
  const approval = value as unknown as V2NativeStageApprovalRefV1
  string(approval.owner, 'approval_ref.owner')
  durableUrl(approval.durable_url, 'approval_ref.durable_url')
  sha(approval.body_sha256, 'approval_ref.body_sha256')
  stage(approval.exact_stage_id, 'approval_ref.exact_stage_id')
  sha(approval.exact_binding_sha256, 'approval_ref.exact_binding_sha256')
  return approval
}

export function decodeV2NativeStageBinding(value: unknown): V2NativeStageBindingV1 {
  exactFields(value, BINDING_FIELDS, 'V2NativeStageBindingV1')
  const binding = value as unknown as V2NativeStageBindingV1
  if (binding.schema_version !== V2_NATIVE_STAGE_BINDING_SCHEMA_VERSION) fail('STAGE_BINDING_MISSING_OR_INVALID', 'binding schema_version differs')
  uuid(binding.run_id, 'run_id')
  stage(binding.stage_id, 'stage_id')
  sha(binding.exact_implementation_main_sha, 'exact_implementation_main_sha', 40)
  sha(binding.exact_implementation_main_tree, 'exact_implementation_main_tree', 40)
  binding.database = decodeDatabase(binding.database)
  binding.migration = decodeMigration(binding.migration)
  binding.frozen_enabled_snapshot = decodeSnapshot(binding.frozen_enabled_snapshot)
  binding.stage_members = decodeMembers(binding.stage_members, binding)
  rfc3339Utc(binding.started_at, 'started_at')
  rfc3339Utc(binding.deadline, 'deadline')
  if (Date.parse(binding.started_at) >= Date.parse(binding.deadline)) fail('STAGE_BINDING_MISSING_OR_INVALID', 'stage deadline must follow started_at')
  if (binding.provider_dispatch !== 'disabled') fail('STAGE_BINDING_MISSING_OR_INVALID', 'provider_dispatch must be disabled')
  if (binding.V1_mode !== 'observe_only_no_traversal') fail('STAGE_BINDING_MISSING_OR_INVALID', 'V1_mode must be observe_only_no_traversal')
  binding.pre_run_baselines = decodeBaselines(binding.pre_run_baselines)
  binding.supervisor_processes = decodeSupervisors(binding.supervisor_processes, binding.database.identity_sha256)
  binding.command_catalog = decodeCommands(binding.command_catalog)
  binding.approval_ref = decodeApproval(binding.approval_ref)
  const expectedPrior = {
    S1_TWO_AGENT: 'K3_POST_MERGE_AND_INDEPENDENT_GATES',
    S2_SELECTED_ENABLED: 'S1_TERMINAL_PASS',
    S3_ALL_ENABLED: 'S2_TERMINAL_PASS',
  }[binding.stage_id]
  if (binding.prior_gate_ref !== expectedPrior) fail('STAGE_BINDING_MISSING_OR_INVALID', 'prior_gate_ref differs for stage')
  if (binding.approval_ref.exact_stage_id !== binding.stage_id) fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'approval_ref stage differs')
  const memberRows = binding.frozen_enabled_snapshot.rows.filter(row => binding.stage_members.agent_ids.includes(row.agent_id))
  for (const row of memberRows) {
    if (row.checkout_sha !== binding.exact_implementation_main_sha || row.checkout_tree !== binding.exact_implementation_main_tree) {
      fail('RUNTIME_BINDING_DRIFT', `stage member ${row.agent_id} checkout differs from exact implementation`)
    }
  }
  return binding
}

/**
 * The owner approval is an authority envelope added after the immutable stage
 * inputs are frozen.  Excluding that envelope avoids a self-referential digest
 * while keeping every execution-affecting field inside the RFC 8785 hash.
 */
export function canonicalV2NativeStageBindingSha256(value: unknown): string {
  const binding = decodeV2NativeStageBinding(value)
  const { approval_ref: _approval, ...immutableStageInputs } = binding
  return sha256Utf8(canonicalJson(immutableStageInputs))
}

function decodeOwnerDecisionBody(body: string): V2NativeStageOwnerDecisionV1 {
  let value: unknown
  try { value = JSON.parse(body) } catch { return fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'owner decision body is not JSON') }
  try { exactFields(value, DECISION_FIELDS, 'V2NativeStageOwnerDecisionV1') } catch (error) {
    if (error instanceof V2NativeStageBindingError) fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', error.message)
    throw error
  }
  const decision = value as unknown as V2NativeStageOwnerDecisionV1
  if (decision.schema_version !== V2_NATIVE_STAGE_OWNER_DECISION_SCHEMA_VERSION) fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'owner decision schema differs')
  uuid(decision.decision_id, 'decision_id')
  string(decision.owner, 'owner')
  if (decision.decision !== 'APPROVE_STAGE_ACTIVATION' || decision.status !== 'active' || decision.superseded_by !== null) {
    fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'decision is not an active unsuperseded activation approval')
  }
  stage(decision.exact_stage_id, 'exact_stage_id')
  sha(decision.exact_binding_sha256, 'exact_binding_sha256')
  rfc3339Utc(decision.issued_at, 'issued_at')
  rfc3339Utc(decision.expires_at, 'expires_at')
  if (!['disabled', 'planned_stage_bound'].includes(decision.crash_hooks)) fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'crash_hooks differs')
  if (decision.exact_stage_id === 'S1_TWO_AGENT' && decision.crash_hooks !== 'disabled') fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'S1 cannot authorize crash hooks')
  return decision
}

export function verifyV2NativeStageOwnerDecision(options: {
  binding: unknown
  exactBindingSha256: string
  ownerDecisionBody: string
  ownerDecisionUrl: string
  ownerDecisionBodySha256: string
  now?: Date
}): V2NativeVerifiedStageAuthorityV1 {
  const binding = decodeV2NativeStageBinding(options.binding)
  sha(options.exactBindingSha256, 'exactBindingSha256')
  sha(options.ownerDecisionBodySha256, 'ownerDecisionBodySha256')
  durableUrl(options.ownerDecisionUrl, 'ownerDecisionUrl')
  const actualBindingSha = canonicalV2NativeStageBindingSha256(binding)
  const actualBodySha = sha256Utf8(options.ownerDecisionBody)
  if (actualBindingSha !== options.exactBindingSha256 || binding.approval_ref.exact_binding_sha256 !== actualBindingSha) {
    fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'binding digest differs')
  }
  if (actualBodySha !== options.ownerDecisionBodySha256 || binding.approval_ref.body_sha256 !== actualBodySha) {
    fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'owner decision body digest differs')
  }
  if (binding.approval_ref.durable_url !== options.ownerDecisionUrl) fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'owner decision URL differs')
  const decision = decodeOwnerDecisionBody(options.ownerDecisionBody)
  if (
    decision.owner !== binding.approval_ref.owner ||
    decision.exact_stage_id !== binding.stage_id ||
    decision.exact_binding_sha256 !== actualBindingSha
  ) fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'owner decision authority does not bind this stage')
  const now = (options.now ?? new Date()).getTime()
  if (Date.parse(decision.issued_at) > now || Date.parse(decision.expires_at) <= now) {
    fail('OWNER_DECISION_MISSING_STALE_SUPERSEDED_OR_HASH_MISMATCH', 'owner decision is stale or not yet valid')
  }
  if (Date.parse(binding.started_at) > now || Date.parse(binding.deadline) <= now) fail('DEADLINE_EXPIRED', 'stage binding is stale or not yet active')
  return {
    decision,
    owner_decision_url: options.ownerDecisionUrl,
    owner_decision_body_sha256: actualBodySha,
    exact_binding_sha256: actualBindingSha,
  }
}

export function deriveV2NativeMeshScopeAndFence(bindingValue: unknown): {
  scope: V2NativeMeshScopeV1
  fence: V2NativeMeshExecutionFence
} {
  const binding = decodeV2NativeStageBinding(bindingValue)
  const members: V2NativeMeshFrozenAgentV1[] = binding.frozen_enabled_snapshot.rows
    .filter(row => binding.stage_members.agent_ids.includes(row.agent_id))
    .map(row => ({
      agent_id: row.agent_id,
      profile_revision: row.config_sha256,
      runtime_engine: row.engine,
      runtime_instance_id: row.runtime_instance_id,
      runtime_checkout_root: row.checkout_root_realpath,
      runtime_checkout_sha: row.checkout_sha,
    }))
  const scope: V2NativeMeshScopeV1 = {
    schema_version: 'aun-v2-native-mesh-scope/v1',
    run_id: binding.run_id,
    stage_id: binding.stage_id,
    repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: binding.exact_implementation_main_sha,
    database_identity: binding.database.identity_sha256,
    frozen_enabled_set: members,
    frozen_enabled_set_sha256: frozenEnabledSetSha256(members),
    runtime_snapshot_sha256: runtimeSnapshotSha256(members),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    deadline_ms: Date.parse(binding.deadline),
  }
  return {
    scope,
    fence: {
      stage_id: binding.stage_id,
      exact_implementation_head: binding.exact_implementation_main_sha,
      database_identity: binding.database.identity_sha256,
      runtime_snapshot_sha256: scope.runtime_snapshot_sha256,
    },
  }
}
