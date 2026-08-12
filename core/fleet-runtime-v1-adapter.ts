import { createHash } from 'node:crypto'

export const FLEET_RUNTIME_V1_CONTRACT = {
  adapter_id: 'FLEET_RUNTIME_V1',
  contract_schema: 'shirube-v4.1/fleet-runtime-v1-contract/v1',
  contract_sha256: 'sha256:da9184b1bd0df20b27c1a7cf19ae906bdd72076bc08f489352d14d1c922dfdf2',
  contract_path: 'releases/shirube-v4.1/fleet-runtime-v1-contract.json',
  contract_repository: 'watchout/ai-dev-framework',
  contract_release_commit: '07640c9c173b36930434847e1cb6838d56b993c0',
  graph_digest: 'sha256:8301ac86c6e32f642222cb62f6ea91490fe409f3ca767cd79a452f49be22187a',
  graph_generation: 8,
  node_id: 'N35-P4-P7-OWNER-ENVELOPE',
  lease_epoch: 'V41-DG-G8-N01-20260807-001',
  release_repository: 'watchout/ai-dev-framework',
  release_tag: 'v4.1.0',
  release_commit: '07640c9c173b36930434847e1cb6838d56b993c0',
  release_tree: '10ffb6acb558d9eecaedab7ce3c97ea447a2b1e5',
  release_manifest_digest: 'sha256:b99dc954d2495c2fd081920a1db497da6b33de5499ce323c3b39a9c91ad8e402',
  target_set_digest: 'sha256:fd1bd9ba828b5afd4960d203267c9533d58cb441f2cf3420307700b8bbd52584',
  payload_digest: 'sha256:58eb8e4f49a8c2f42087ce17956bbef571d4650321e9c25e15726c0529c58973',
  precondition_build_decision_url: 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-5260238887',
  precondition_build_decision_sha256: 'sha256:6464a7c19b2fae09d95bb3f6ed9d07a030c38e1b42bc263745065b45c460c6c9',
} as const

export const FLEET_RUNTIME_V1_TARGETS = [
  'watchout/agent-comms-mcp',
  'watchout/agent-memory',
  'watchout/aun-platform',
  'watchout/kodama',
  'watchout/misell',
] as const

export type FleetRuntimeTarget = typeof FLEET_RUNTIME_V1_TARGETS[number]
export type FleetRuntimeStage =
  | 'N40-P4-CANARY-VERIFY'
  | 'N50-P5-PLACEMENT'
  | 'N60-P6-APPLICATION'
  | 'N70-P7-OPERATIONAL'
export type FleetRuntimeOperation =
  | 'CANARY_COLD_START'
  | 'ROLLBACK'
  | 'RECOVERY'
  | 'REAPPLY'
  | 'FIVE_TARGET_PLACEMENT'
  | 'FIVE_TARGET_COLD_START'
  | 'ONE_OPERATIONAL_ACCEPTANCE_RUN'

export interface FleetRuntimeSubject {
  graph_digest: string
  node_id: string
  graph_generation: number
  lease_epoch: string
  release_repository: string
  release_tag: string
  release_commit: string
  release_tree: string
  release_manifest_digest: string
  target_set_digest: string
  payload_digest: string
}

export interface FleetRuntimeStageAuthority {
  stage_id: FleetRuntimeStage
  actor_agent_id: string
  active_function: string
  allowed_operations: FleetRuntimeOperation[]
  target_repositories: FleetRuntimeTarget[]
}

export interface FleetRuntimeOwnerDecision {
  url: string
  actor: string
  created_at: string
  updated_at: string
  raw_api_body_sha256: string
  node_id: string
  result: 'PASS'
  stage_authority_matrix: FleetRuntimeStageAuthority[]
  canary_target: FleetRuntimeTarget | null
}

export interface FleetRuntimeExecutorIdentity {
  actor_agent_id: string
  active_function: string
}

export interface FleetRuntimePredecessorReceipt {
  kind: 'NODE_RESULT' | 'EFFECT_RECEIPT' | 'ROLLBACK_RECEIPT' | 'RECOVERY_RECEIPT'
  url: string
  sha256: string
  node_id: string
  operation: FleetRuntimeOperation | null
  result: 'PASS' | 'PARTIAL'
  subject_digest: string
}

export interface FleetRuntimeTargetScope {
  repositories: FleetRuntimeTarget[]
  canonical_digest: string
}

export interface FleetRuntimePreimage {
  repository: FleetRuntimeTarget
  head_commit: string
  tree: string
  runtime_surface_sha256: string
  distribution_surface_sha256: string
}

export interface FleetRuntimeQueueEntry {
  repository: FleetRuntimeTarget
  agent_id: string
  pending_count: number
  active_count: number
}

export interface FleetRuntimeQueuePrecheck {
  source_receipt_sha256: string
  observed_at: string
  entries: FleetRuntimeQueueEntry[]
}

export interface FleetRuntimeRequest {
  schema_version: 'fleet-runtime-v1/request/v1'
  request_id: string
  request_digest: string
  subject: FleetRuntimeSubject
  owner_decision: FleetRuntimeOwnerDecision
  executor_identity: FleetRuntimeExecutorIdentity
  stage_id: FleetRuntimeStage
  operation: FleetRuntimeOperation
  predecessor_receipt: FleetRuntimePredecessorReceipt
  idempotency_key: string
  target_scope: FleetRuntimeTargetScope
  payload_digest: string
  queue_precheck: FleetRuntimeQueuePrecheck
  preimages: FleetRuntimePreimage[]
}

export interface FleetRuntimeRootGoalReadback {
  repository: FleetRuntimeTarget
  store_path: string
  schema: string
  verdict: string
  store_code: string
  runtime_digest: string | null
  root: unknown | null
  write_count: number
  effect_delivery_performed: boolean
}

export interface FleetRuntimePreflightReceipt {
  schema_version: 'fleet-runtime-v1/preflight-receipt/v1'
  request_digest: string
  observed_at: string
  owner_decision_readback: FleetRuntimeOwnerDecision
  owner_decision_raw_body: string
  predecessor_receipt_readback: FleetRuntimePredecessorReceipt
  predecessor_receipt_raw_body: string
  target_preimages: FleetRuntimePreimage[]
  queue_precheck: FleetRuntimeQueuePrecheck
  root_goal_readbacks: FleetRuntimeRootGoalReadback[]
  filesystem_write_count: 0
  database_write_count: 0
  queue_write_count: 0
  protected_effect_count: 0
}

export interface FleetRuntimeImage {
  head_commit: string | null
  tree: string | null
  runtime_surface_sha256: string | null
  distribution_surface_sha256: string | null
  release: unknown | null
  config: unknown | null
  policy: unknown | null
  root: unknown | null
  goal: unknown | null
  runtime_digest: string | null
  runtime_instance_id: string | null
}

export interface FleetRuntimeTargetReceipt {
  repository: FleetRuntimeTarget
  preimage: FleetRuntimePreimage
  postimage: FleetRuntimeImage
  queue_precheck: FleetRuntimeQueueEntry | null
  root_goal_readback: FleetRuntimeRootGoalReadback
}

export interface FleetRuntimeEffectReceipt {
  schema_version:
    | 'fleet-runtime-v1/effect-receipt/v1'
    | 'fleet-runtime-v1/rollback-receipt/v1'
    | 'fleet-runtime-v1/reapply-receipt/v1'
  receipt_id: string
  receipt_sha256: string
  request_id: string
  request_digest: string
  idempotency_key: string
  stage_id: FleetRuntimeStage
  operation: FleetRuntimeOperation
  effect_id: string
  actor_agent_id: string
  active_function: string
  started_at: string
  completed_at: string
  result: 'PASS' | 'BLOCK' | 'PARTIAL'
  per_target: FleetRuntimeTargetReceipt[]
  duplicate_effect_count: number
  unauthorized_effect_count: number
  forward_effect_receipt_sha256?: string
  rollback_receipt_sha256?: string
  recovery_receipt_sha256?: string
  target_repository?: FleetRuntimeTarget
  restored_preimage?: FleetRuntimePreimage
  fresh_runtime_instance_readback?: boolean
  queue_counts_unchanged?: boolean
  payload_digest?: string
  postimage?: FleetRuntimeImage
}

export interface FleetRuntimeInvocationState {
  idempotency_key: string
  request_digest: string
  status: 'reserved' | 'completed'
  receipt: FleetRuntimeEffectReceipt | null
}

export interface FleetRuntimePersistencePort {
  load(idempotencyKey: string): Promise<FleetRuntimeInvocationState | null>
  reserve_once(state: FleetRuntimeInvocationState): Promise<{
    acquired: boolean
    state: FleetRuntimeInvocationState
  }>
  complete_once(state: FleetRuntimeInvocationState): Promise<FleetRuntimeInvocationState>
}

export interface FleetRuntimePreflightPort {
  inspect(request: Readonly<FleetRuntimeRequest>): Promise<FleetRuntimePreflightReceipt>
}

export interface FleetRuntimeEffectPort {
  /**
   * The concrete provider must durably bind one effect and receipt to the
   * idempotency key. Replays after concurrency or acknowledgement loss must
   * return the same receipt without repeating the protected effect.
   */
  perform_once(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
  ): Promise<FleetRuntimeEffectReceipt>
}

export interface FleetRuntimePorts {
  preflight: FleetRuntimePreflightPort
  persistence: FleetRuntimePersistencePort
  effect: FleetRuntimeEffectPort
}

export type FleetRuntimeV1ErrorCode =
  | 'INVALID_REQUEST'
  | 'SUBJECT_MISMATCH'
  | 'PRECONDITION_BUILD_NOT_OPERATIONAL_AUTHORITY'
  | 'OWNER_DECISION_INVALID'
  | 'STAGE_PREDECESSOR_MISMATCH'
  | 'EXECUTOR_AUTHORITY_MISMATCH'
  | 'TARGET_SCOPE_MISMATCH'
  | 'TARGET_RUNTIME_BINDING_MISSING'
  | 'PAYLOAD_MISMATCH'
  | 'QUEUE_PRECHECK_NOT_ZERO'
  | 'PREIMAGE_MISMATCH'
  | 'REQUEST_DIGEST_MISMATCH'
  | 'IDEMPOTENCY_KEY_MISMATCH'
  | 'PREFLIGHT_RECEIPT_MISMATCH'
  | 'PERSISTED_INVOCATION_MISMATCH'
  | 'EFFECT_RECEIPT_INVALID'

export class FleetRuntimeV1Error extends Error {
  constructor(readonly code: FleetRuntimeV1ErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'FleetRuntimeV1Error'
  }
}

const SHA256 = /^sha256:[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const OWNER_DECISION_URL = /^https:\/\/github\.com\/watchout\/ai-dev-framework\/issues\/576#issuecomment-[1-9][0-9]*$/
const GATE_FUNCTIONS = new Set(['scenario_verification_gate', 'evidence_audit_gate'])

const SUBJECT: FleetRuntimeSubject = {
  graph_digest: FLEET_RUNTIME_V1_CONTRACT.graph_digest,
  node_id: FLEET_RUNTIME_V1_CONTRACT.node_id,
  graph_generation: FLEET_RUNTIME_V1_CONTRACT.graph_generation,
  lease_epoch: FLEET_RUNTIME_V1_CONTRACT.lease_epoch,
  release_repository: FLEET_RUNTIME_V1_CONTRACT.release_repository,
  release_tag: FLEET_RUNTIME_V1_CONTRACT.release_tag,
  release_commit: FLEET_RUNTIME_V1_CONTRACT.release_commit,
  release_tree: FLEET_RUNTIME_V1_CONTRACT.release_tree,
  release_manifest_digest: FLEET_RUNTIME_V1_CONTRACT.release_manifest_digest,
  target_set_digest: FLEET_RUNTIME_V1_CONTRACT.target_set_digest,
  payload_digest: FLEET_RUNTIME_V1_CONTRACT.payload_digest,
}

const STAGES: Record<FleetRuntimeStage, {
  short: 'N40' | 'N50' | 'N60' | 'N70'
  predecessor: string
  operations: FleetRuntimeOperation[]
}> = {
  'N40-P4-CANARY-VERIFY': {
    short: 'N40',
    predecessor: 'N35-P4-P7-OWNER-ENVELOPE',
    operations: ['CANARY_COLD_START', 'ROLLBACK', 'RECOVERY', 'REAPPLY'],
  },
  'N50-P5-PLACEMENT': {
    short: 'N50',
    predecessor: 'N40-P4-CANARY-VERIFY',
    operations: ['FIVE_TARGET_PLACEMENT'],
  },
  'N60-P6-APPLICATION': {
    short: 'N60',
    predecessor: 'N50-P5-PLACEMENT',
    operations: ['FIVE_TARGET_COLD_START'],
  },
  'N70-P7-OPERATIONAL': {
    short: 'N70',
    predecessor: 'N60-P6-APPLICATION',
    operations: ['ONE_OPERATIONAL_ACCEPTANCE_RUN'],
  },
}

const TARGET_BINDINGS: Record<FleetRuntimeTarget, {
  classification: 'REGISTERED_RUNTIME' | 'PLACEMENT_ONLY_CURRENT_N35_PREPARATION'
  agent_id: string | null
  checkout_path: string
  frozen_preimage: Omit<FleetRuntimePreimage, 'repository'>
}> = {
  'watchout/agent-comms-mcp': {
    classification: 'REGISTERED_RUNTIME', agent_id: 'aun', checkout_path: '/Users/yuji/Developer/agent-comms-mcp',
    frozen_preimage: { head_commit: 'e1d2cf316b2a8bdf5e4d2e7d73b570d29e2968d0', tree: '667bc355b978a9924f09528e9d9ee600b061d38f', runtime_surface_sha256: 'sha256:371d9c5b08047a072e97a8feb83a6d9ae8f837062061f9b0050bba6724087235', distribution_surface_sha256: 'sha256:4d303ed6b479b7019b153bce76e35101a6f4df7b063333cdbae920282b71da97' },
  },
  'watchout/agent-memory': {
    classification: 'REGISTERED_RUNTIME', agent_id: 'kusabi', checkout_path: '/Users/yuji/Developer/agent-memory',
    frozen_preimage: { head_commit: 'a9ae4b29e2e5739a903926a27cb83a34593f0b44', tree: '44fd6ba56230380d7b07f4d36d3557457b7f3e48', runtime_surface_sha256: 'sha256:31e1b62379e999040784f544e2ac2d1ae1b3aff8177e76332de404e3f4249a56', distribution_surface_sha256: 'sha256:1c60eff2322f700dd195cfb57e3e6a4b56af365ae2023f6271f3b1f0e3e98bf0' },
  },
  'watchout/aun-platform': {
    classification: 'PLACEMENT_ONLY_CURRENT_N35_PREPARATION', agent_id: null, checkout_path: '/Users/yuji/Developer/aun-platform',
    frozen_preimage: { head_commit: 'ce1a9fcc32b191286585a5c3cb47f2edf7a23568', tree: '7a83ad8d947b48b7e89e69c4e9c13beca2b32433', runtime_surface_sha256: 'sha256:31e1b62379e999040784f544e2ac2d1ae1b3aff8177e76332de404e3f4249a56', distribution_surface_sha256: 'sha256:a2c465bfc007a4d27d1d9caecac2c3e84f4510fe4daf11718563e9045c58fd19' },
  },
  'watchout/kodama': {
    classification: 'REGISTERED_RUNTIME', agent_id: 'kodama', checkout_path: '/Users/yuji/Developer/kodama',
    frozen_preimage: { head_commit: '3c85d6f7a3c83e31c90fe4e3172c111c7541978f', tree: '47d992a5c709cf65ef15f4aab5e60887be1aa45a', runtime_surface_sha256: 'sha256:b90aa1438ef152b36bb988e946c3272e8099c18a4d59dba966c1b8a054ea2212', distribution_surface_sha256: 'sha256:b1233c486d5921bc928318c4497dba8093ba0a62db0ee4e3e9ab3432ba6302e5' },
  },
  'watchout/misell': {
    classification: 'REGISTERED_RUNTIME', agent_id: 'misell', checkout_path: '/Users/yuji/Developer/misell',
    frozen_preimage: { head_commit: '640dc4d475cb3670d85579845ecaafae198e895e', tree: '8661e8cf569f4bf27a0a736f3f5379d0cfa5df16', runtime_surface_sha256: 'sha256:31e1b62379e999040784f544e2ac2d1ae1b3aff8177e76332de404e3f4249a56', distribution_surface_sha256: 'sha256:d41879bf3a6ce1d1aab725bd5f939b4973c3d5e68b75edb39b514e74164c539a' },
  },
}

function fail(code: FleetRuntimeV1ErrorCode, message: string): never {
  throw new FleetRuntimeV1Error(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) return fail('INVALID_REQUEST', `${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    return fail('INVALID_REQUEST', `${label} fields do not match the contract`)
  }
}

function assertTrimmed(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return fail('INVALID_REQUEST', `${label} must be a trimmed nonempty string`)
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) return fail('INVALID_REQUEST', `${label} must be sha256:<lowercase-hex>`)
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    return fail('INVALID_REQUEST', `${label} must be an RFC3339 UTC timestamp`)
  }
}

export function canonicalFleetRuntimeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalFleetRuntimeJson).join(',')}]`
  if (!isRecord(value)) throw new Error('unsupported canonical JSON value')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalFleetRuntimeJson(value[key])}`).join(',')}}`
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalFleetRuntimeJson(value), 'utf8').digest('hex')}`
}

function digestRawBody(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalFleetRuntimeJson(left) === canonicalFleetRuntimeJson(right)
}

function requestDigestMaterial(request: FleetRuntimeRequest): unknown {
  const material = structuredClone(request) as Partial<FleetRuntimeRequest>
  delete material.request_digest
  delete material.idempotency_key
  return material
}

export function computeFleetRuntimeRequestDigest(request: FleetRuntimeRequest): string {
  return digestCanonical(requestDigestMaterial(request))
}

function preimageSetDigest(request: FleetRuntimeRequest): string {
  return digestCanonical(request.preimages)
}

export function computeFleetRuntimeIdempotencyKey(request: FleetRuntimeRequest): string {
  const stage = STAGES[request.stage_id]
  if (!stage) return fail('INVALID_REQUEST', 'stage_id is not in the frozen graph')
  const fields = [
    'FLEET_RUNTIME_V1_IDEMPOTENCY_V1',
    request.subject.graph_digest,
    request.subject.node_id,
    String(request.subject.graph_generation),
    request.subject.lease_epoch,
    request.subject.release_manifest_digest,
    request.subject.target_set_digest,
    request.subject.payload_digest,
    request.owner_decision.url,
    request.owner_decision.raw_api_body_sha256,
    request.stage_id,
    request.operation,
    request.predecessor_receipt.sha256,
    request.target_scope.canonical_digest,
    preimageSetDigest(request),
  ]
  const digest = createHash('sha256').update(fields.join('\0'), 'utf8').digest('hex')
  return `frv1:${stage.short}:${digest}`
}

export function frozenFleetRuntimePreimage(repository: FleetRuntimeTarget): FleetRuntimePreimage {
  return { repository, ...TARGET_BINDINGS[repository].frozen_preimage }
}

function assertSubject(subject: FleetRuntimeSubject): void {
  assertExactKeys(subject, Object.keys(SUBJECT), 'subject')
  if (!exact(subject, SUBJECT)) return fail('SUBJECT_MISMATCH', 'graph, release, target, or payload subject drifted')
}

function assertTargetArray(value: unknown, label: string): asserts value is FleetRuntimeTarget[] {
  if (!Array.isArray(value) || value.length === 0) return fail('TARGET_SCOPE_MISMATCH', `${label} must be nonempty`)
  if (new Set(value).size !== value.length) return fail('TARGET_SCOPE_MISMATCH', `${label} contains duplicates`)
  for (const target of value) {
    if (!FLEET_RUNTIME_V1_TARGETS.includes(target as FleetRuntimeTarget)) {
      return fail('TARGET_SCOPE_MISMATCH', `${label} contains a target outside the frozen five`)
    }
  }
}

function assertAuthorityMatrix(decision: FleetRuntimeOwnerDecision): void {
  if (!Array.isArray(decision.stage_authority_matrix) || decision.stage_authority_matrix.length !== 4) {
    return fail('OWNER_DECISION_INVALID', 'owner stage authority matrix must contain the exact four stages')
  }
  const ids = decision.stage_authority_matrix.map(entry => entry.stage_id)
  if (!exact(ids, Object.keys(STAGES))) return fail('OWNER_DECISION_INVALID', 'owner stage authority order or set differs from the frozen graph')
  for (const [index, entry] of decision.stage_authority_matrix.entries()) {
    assertExactKeys(entry, ['stage_id', 'actor_agent_id', 'active_function', 'allowed_operations', 'target_repositories'], `stage_authority_matrix[${index}]`)
    assertTrimmed(entry.actor_agent_id, `stage_authority_matrix[${index}].actor_agent_id`)
    assertTrimmed(entry.active_function, `stage_authority_matrix[${index}].active_function`)
    if (GATE_FUNCTIONS.has(entry.active_function)) return fail('EXECUTOR_AUTHORITY_MISMATCH', 'a verifier function cannot execute protected effects')
    if (!exact(entry.allowed_operations, STAGES[entry.stage_id].operations)) {
      return fail('OWNER_DECISION_INVALID', `${entry.stage_id} operation authority differs from the frozen contract`)
    }
    assertTargetArray(entry.target_repositories, `${entry.stage_id}.target_repositories`)
  }
  const n40 = decision.stage_authority_matrix[0]
  if (decision.canary_target === null || n40.target_repositories.length !== 1 || n40.target_repositories[0] !== decision.canary_target) {
    return fail('OWNER_DECISION_INVALID', 'N40 requires one explicit owner-selected canary target')
  }
  if (!exact(decision.stage_authority_matrix[1].target_repositories, FLEET_RUNTIME_V1_TARGETS)) {
    return fail('OWNER_DECISION_INVALID', 'N50 must bind the exact frozen five')
  }
  if (!exact(decision.stage_authority_matrix[2].target_repositories, FLEET_RUNTIME_V1_TARGETS)) {
    return fail('OWNER_DECISION_INVALID', 'N60 must bind the exact frozen five')
  }
}

function assertOwnerDecision(decision: FleetRuntimeOwnerDecision): void {
  assertExactKeys(decision, ['url', 'actor', 'created_at', 'updated_at', 'raw_api_body_sha256', 'node_id', 'result', 'stage_authority_matrix', 'canary_target'], 'owner_decision')
  if (decision.url === FLEET_RUNTIME_V1_CONTRACT.precondition_build_decision_url
    || decision.raw_api_body_sha256 === FLEET_RUNTIME_V1_CONTRACT.precondition_build_decision_sha256) {
    return fail('PRECONDITION_BUILD_NOT_OPERATIONAL_AUTHORITY', 'the precondition-build decision cannot authorize a runtime effect')
  }
  if (!OWNER_DECISION_URL.test(decision.url)) return fail('OWNER_DECISION_INVALID', 'owner decision must be an immutable Issue 576 comment')
  if (decision.actor !== 'watchout' || decision.node_id !== FLEET_RUNTIME_V1_CONTRACT.node_id || decision.result !== 'PASS') {
    return fail('OWNER_DECISION_INVALID', 'owner actor, N35 node, or PASS result is invalid')
  }
  assertTimestamp(decision.created_at, 'owner_decision.created_at')
  assertTimestamp(decision.updated_at, 'owner_decision.updated_at')
  if (decision.created_at !== decision.updated_at) return fail('OWNER_DECISION_INVALID', 'owner decision comment is mutable')
  assertSha256(decision.raw_api_body_sha256, 'owner_decision.raw_api_body_sha256')
  assertAuthorityMatrix(decision)
}

function assertStageAndPredecessor(request: FleetRuntimeRequest): void {
  const stage = STAGES[request.stage_id]
  if (!stage || !stage.operations.includes(request.operation)) return fail('STAGE_PREDECESSOR_MISMATCH', 'operation is not admitted by the stage')
  const receipt = request.predecessor_receipt
  assertExactKeys(receipt, ['kind', 'url', 'sha256', 'node_id', 'operation', 'result', 'subject_digest'], 'predecessor_receipt')
  assertTrimmed(receipt.url, 'predecessor_receipt.url')
  assertSha256(receipt.sha256, 'predecessor_receipt.sha256')
  assertSha256(receipt.subject_digest, 'predecessor_receipt.subject_digest')
  if (receipt.subject_digest !== digestCanonical(request.subject)) return fail('STAGE_PREDECESSOR_MISMATCH', 'predecessor receipt subject differs')

  if (request.stage_id !== 'N40-P4-CANARY-VERIFY' || request.operation === 'CANARY_COLD_START') {
    if (receipt.kind !== 'NODE_RESULT' || receipt.node_id !== stage.predecessor || receipt.operation !== null || receipt.result !== 'PASS') {
      return fail('STAGE_PREDECESSOR_MISMATCH', 'stage predecessor must be the exact prior node PASS receipt')
    }
    return
  }
  const expected = request.operation === 'ROLLBACK'
    ? { kind: 'EFFECT_RECEIPT', operation: 'CANARY_COLD_START', results: ['PASS', 'PARTIAL'] }
    : request.operation === 'RECOVERY'
      ? { kind: 'ROLLBACK_RECEIPT', operation: 'ROLLBACK', results: ['PASS'] }
      : { kind: 'RECOVERY_RECEIPT', operation: 'RECOVERY', results: ['PASS'] }
  if (receipt.node_id !== request.stage_id || receipt.kind !== expected.kind || receipt.operation !== expected.operation || !expected.results.includes(receipt.result)) {
    return fail('STAGE_PREDECESSOR_MISMATCH', `${request.operation} does not bind its exact operation predecessor`)
  }
}

function assertExecutorAuthority(request: FleetRuntimeRequest): void {
  assertExactKeys(request.executor_identity, ['actor_agent_id', 'active_function'], 'executor_identity')
  const authority = request.owner_decision.stage_authority_matrix.find(entry => entry.stage_id === request.stage_id)
  if (!authority
    || authority.actor_agent_id !== request.executor_identity.actor_agent_id
    || authority.active_function !== request.executor_identity.active_function
    || !authority.allowed_operations.includes(request.operation)) {
    return fail('EXECUTOR_AUTHORITY_MISMATCH', 'executor identity is outside the owner stage authority')
  }
  if (GATE_FUNCTIONS.has(request.executor_identity.active_function)) {
    return fail('EXECUTOR_AUTHORITY_MISMATCH', 'gate functions are read-only verifiers')
  }
}

function expectedTargetsFor(request: FleetRuntimeRequest): FleetRuntimeTarget[] {
  const authority = request.owner_decision.stage_authority_matrix.find(entry => entry.stage_id === request.stage_id)
  if (!authority) return fail('OWNER_DECISION_INVALID', 'stage authority is missing')
  return authority.target_repositories
}

function assertTargetScope(request: FleetRuntimeRequest): void {
  assertExactKeys(request.target_scope, ['repositories', 'canonical_digest'], 'target_scope')
  assertTargetArray(request.target_scope.repositories, 'target_scope.repositories')
  if (!exact(request.target_scope.repositories, expectedTargetsFor(request))) {
    return fail('TARGET_SCOPE_MISMATCH', 'request targets differ from owner stage authority')
  }
  if (request.target_scope.canonical_digest !== digestCanonical(request.target_scope.repositories)) {
    return fail('TARGET_SCOPE_MISMATCH', 'target scope digest mismatch')
  }
  if (request.stage_id === 'N60-P6-APPLICATION'
    && request.target_scope.repositories.some(target => TARGET_BINDINGS[target].classification !== 'REGISTERED_RUNTIME')) {
    return fail('TARGET_RUNTIME_BINDING_MISSING', 'N60 is blocked while aun-platform is placement-only')
  }
  if (request.stage_id === 'N40-P4-CANARY-VERIFY'
    && request.operation !== 'FIVE_TARGET_PLACEMENT'
    && request.target_scope.repositories.some(target => TARGET_BINDINGS[target].classification !== 'REGISTERED_RUNTIME')) {
    return fail('TARGET_RUNTIME_BINDING_MISSING', 'canary runtime operation requires a registered runtime binding')
  }
}

function assertPreimages(request: FleetRuntimeRequest): void {
  if (!Array.isArray(request.preimages) || request.preimages.length !== request.target_scope.repositories.length) {
    return fail('PREIMAGE_MISMATCH', 'one preimage is required for every target in order')
  }
  request.preimages.forEach((preimage, index) => {
    assertExactKeys(preimage, ['repository', 'head_commit', 'tree', 'runtime_surface_sha256', 'distribution_surface_sha256'], `preimages[${index}]`)
    if (preimage.repository !== request.target_scope.repositories[index]) return fail('PREIMAGE_MISMATCH', 'preimage target order differs')
    if (!COMMIT.test(preimage.head_commit) || !COMMIT.test(preimage.tree)) return fail('PREIMAGE_MISMATCH', 'preimage head or tree is invalid')
    assertSha256(preimage.runtime_surface_sha256, `preimages[${index}].runtime_surface_sha256`)
    assertSha256(preimage.distribution_surface_sha256, `preimages[${index}].distribution_surface_sha256`)
  })
  if (request.stage_id === 'N40-P4-CANARY-VERIFY' && request.operation === 'CANARY_COLD_START') {
    const expected = request.target_scope.repositories.map(frozenFleetRuntimePreimage)
    if (!exact(request.preimages, expected)) return fail('PREIMAGE_MISMATCH', 'initial canary must bind the frozen rollback preimage')
  }
}

function registeredTargets(targets: FleetRuntimeTarget[]): FleetRuntimeTarget[] {
  return targets.filter(target => TARGET_BINDINGS[target].classification === 'REGISTERED_RUNTIME')
}

function assertQueuePrecheck(precheck: FleetRuntimeQueuePrecheck, targets: FleetRuntimeTarget[]): void {
  assertExactKeys(precheck, ['source_receipt_sha256', 'observed_at', 'entries'], 'queue_precheck')
  assertSha256(precheck.source_receipt_sha256, 'queue_precheck.source_receipt_sha256')
  assertTimestamp(precheck.observed_at, 'queue_precheck.observed_at')
  const required = registeredTargets(targets)
  if (!Array.isArray(precheck.entries) || precheck.entries.length !== required.length) {
    return fail('QUEUE_PRECHECK_NOT_ZERO', 'queue precheck must cover every registered runtime in scope')
  }
  precheck.entries.forEach((entry, index) => {
    assertExactKeys(entry, ['repository', 'agent_id', 'pending_count', 'active_count'], `queue_precheck.entries[${index}]`)
    const repository = required[index]
    if (entry.repository !== repository || entry.agent_id !== TARGET_BINDINGS[repository].agent_id) {
      return fail('QUEUE_PRECHECK_NOT_ZERO', 'queue entry does not match the frozen runtime binding')
    }
    if (entry.pending_count !== 0 || entry.active_count !== 0) return fail('QUEUE_PRECHECK_NOT_ZERO', 'queue is not zero')
  })
}

export function prepareFleetRuntimeV1Request(request: FleetRuntimeRequest): FleetRuntimeRequest {
  assertExactKeys(request, ['schema_version', 'request_id', 'request_digest', 'subject', 'owner_decision', 'executor_identity', 'stage_id', 'operation', 'predecessor_receipt', 'idempotency_key', 'target_scope', 'payload_digest', 'queue_precheck', 'preimages'], 'request')
  if (request.schema_version !== 'fleet-runtime-v1/request/v1') return fail('INVALID_REQUEST', 'request schema mismatch')
  assertTrimmed(request.request_id, 'request_id')
  assertSha256(request.request_digest, 'request_digest')
  assertSubject(request.subject)
  assertOwnerDecision(request.owner_decision)
  assertStageAndPredecessor(request)
  assertExecutorAuthority(request)
  assertTargetScope(request)
  if (request.payload_digest !== FLEET_RUNTIME_V1_CONTRACT.payload_digest) return fail('PAYLOAD_MISMATCH', 'target payload digest mismatch')
  assertQueuePrecheck(request.queue_precheck, request.target_scope.repositories)
  assertPreimages(request)
  if (request.request_digest !== computeFleetRuntimeRequestDigest(request)) return fail('REQUEST_DIGEST_MISMATCH', 'request digest mismatch')
  if (request.idempotency_key !== computeFleetRuntimeIdempotencyKey(request)) return fail('IDEMPOTENCY_KEY_MISMATCH', 'idempotency key mismatch')
  return structuredClone(request)
}

function assertRootGoalReadbacks(readbacks: FleetRuntimeRootGoalReadback[], targets: FleetRuntimeTarget[]): void {
  if (!Array.isArray(readbacks) || readbacks.length !== targets.length) return fail('PREFLIGHT_RECEIPT_MISMATCH', 'root-goal readbacks must cover target scope')
  readbacks.forEach((readback, index) => {
    assertExactKeys(readback, ['repository', 'store_path', 'schema', 'verdict', 'store_code', 'runtime_digest', 'root', 'write_count', 'effect_delivery_performed'], `root_goal_readbacks[${index}]`)
    const target = targets[index]
    if (readback.repository !== target || readback.store_path !== `${TARGET_BINDINGS[target].checkout_path}/.framework/runtime/goal-convergence.json`) {
      return fail('PREFLIGHT_RECEIPT_MISMATCH', 'root-goal store path differs from the frozen target map')
    }
    if (readback.schema !== 'shirube-goal-runtime-command/v1' || readback.write_count !== 0 || readback.effect_delivery_performed !== false) {
      return fail('PREFLIGHT_RECEIPT_MISMATCH', 'root-goal readback is not the exact read-only receipt')
    }
    if (readback.runtime_digest !== null) assertSha256(readback.runtime_digest, `root_goal_readbacks[${index}].runtime_digest`)
  })
}

function assertPreflight(request: FleetRuntimeRequest, receipt: FleetRuntimePreflightReceipt): void {
  assertExactKeys(receipt, ['schema_version', 'request_digest', 'observed_at', 'owner_decision_readback', 'owner_decision_raw_body', 'predecessor_receipt_readback', 'predecessor_receipt_raw_body', 'target_preimages', 'queue_precheck', 'root_goal_readbacks', 'filesystem_write_count', 'database_write_count', 'queue_write_count', 'protected_effect_count'], 'preflight receipt')
  if (receipt.schema_version !== 'fleet-runtime-v1/preflight-receipt/v1' || receipt.request_digest !== request.request_digest) {
    return fail('PREFLIGHT_RECEIPT_MISMATCH', 'preflight receipt is not bound to the request')
  }
  assertTimestamp(receipt.observed_at, 'preflight.observed_at')
  if (!exact(receipt.owner_decision_readback, request.owner_decision)) return fail('PREFLIGHT_RECEIPT_MISMATCH', 'owner decision API readback differs')
  if (typeof receipt.owner_decision_raw_body !== 'string'
    || digestRawBody(receipt.owner_decision_raw_body) !== request.owner_decision.raw_api_body_sha256) {
    return fail('PREFLIGHT_RECEIPT_MISMATCH', 'owner decision raw body digest differs')
  }
  if (!exact(receipt.predecessor_receipt_readback, request.predecessor_receipt)) return fail('PREFLIGHT_RECEIPT_MISMATCH', 'predecessor receipt readback differs')
  if (typeof receipt.predecessor_receipt_raw_body !== 'string'
    || digestRawBody(receipt.predecessor_receipt_raw_body) !== request.predecessor_receipt.sha256) {
    return fail('PREFLIGHT_RECEIPT_MISMATCH', 'predecessor receipt raw body digest differs')
  }
  if (!exact(receipt.target_preimages, request.preimages)) return fail('PREFLIGHT_RECEIPT_MISMATCH', 'live preimages differ from the request')
  if (!exact(receipt.queue_precheck, request.queue_precheck)) return fail('PREFLIGHT_RECEIPT_MISMATCH', 'fresh queue readback differs from the request')
  assertQueuePrecheck(receipt.queue_precheck, request.target_scope.repositories)
  assertRootGoalReadbacks(receipt.root_goal_readbacks, request.target_scope.repositories)
  if (receipt.filesystem_write_count !== 0 || receipt.database_write_count !== 0 || receipt.queue_write_count !== 0 || receipt.protected_effect_count !== 0) {
    return fail('PREFLIGHT_RECEIPT_MISMATCH', 'preflight performed a mutation or protected effect')
  }
}

function receiptDigestMaterial(receipt: FleetRuntimeEffectReceipt): unknown {
  const material = structuredClone(receipt) as Partial<FleetRuntimeEffectReceipt>
  delete material.receipt_sha256
  return material
}

export function computeFleetRuntimeReceiptDigest(receipt: FleetRuntimeEffectReceipt): string {
  return digestCanonical(receiptDigestMaterial(receipt))
}

function expectedReceiptSchema(operation: FleetRuntimeOperation): FleetRuntimeEffectReceipt['schema_version'] {
  if (operation === 'ROLLBACK') return 'fleet-runtime-v1/rollback-receipt/v1'
  if (operation === 'REAPPLY') return 'fleet-runtime-v1/reapply-receipt/v1'
  return 'fleet-runtime-v1/effect-receipt/v1'
}

function assertReceiptImage(image: FleetRuntimeImage, label: string): void {
  assertExactKeys(image, ['head_commit', 'tree', 'runtime_surface_sha256', 'distribution_surface_sha256', 'release', 'config', 'policy', 'root', 'goal', 'runtime_digest', 'runtime_instance_id'], label)
  if (image.head_commit !== null && !COMMIT.test(image.head_commit)) return fail('EFFECT_RECEIPT_INVALID', `${label}.head_commit is invalid`)
  if (image.tree !== null && !COMMIT.test(image.tree)) return fail('EFFECT_RECEIPT_INVALID', `${label}.tree is invalid`)
  for (const field of ['runtime_surface_sha256', 'distribution_surface_sha256', 'runtime_digest'] as const) {
    if (image[field] !== null) assertSha256(image[field], `${label}.${field}`)
  }
}

function assertEffectReceipt(request: FleetRuntimeRequest, receipt: FleetRuntimeEffectReceipt): void {
  if (!isRecord(receipt)) return fail('EFFECT_RECEIPT_INVALID', 'effect receipt must be an object')
  if (receipt.schema_version !== expectedReceiptSchema(request.operation)) return fail('EFFECT_RECEIPT_INVALID', 'effect receipt schema does not match operation')
  assertTrimmed(receipt.receipt_id, 'receipt_id')
  assertSha256(receipt.receipt_sha256, 'receipt_sha256')
  if (receipt.receipt_sha256 !== computeFleetRuntimeReceiptDigest(receipt)) return fail('EFFECT_RECEIPT_INVALID', 'receipt self digest mismatch')
  if (receipt.request_id !== request.request_id || receipt.request_digest !== request.request_digest || receipt.idempotency_key !== request.idempotency_key) {
    return fail('EFFECT_RECEIPT_INVALID', 'receipt request or idempotency binding mismatch')
  }
  if (receipt.stage_id !== request.stage_id || receipt.operation !== request.operation) return fail('EFFECT_RECEIPT_INVALID', 'receipt stage or operation mismatch')
  if (receipt.actor_agent_id !== request.executor_identity.actor_agent_id || receipt.active_function !== request.executor_identity.active_function) {
    return fail('EFFECT_RECEIPT_INVALID', 'receipt actor identity mismatch')
  }
  assertTrimmed(receipt.effect_id, 'effect_id')
  assertTimestamp(receipt.started_at, 'receipt.started_at')
  assertTimestamp(receipt.completed_at, 'receipt.completed_at')
  if (Date.parse(receipt.completed_at) < Date.parse(receipt.started_at)) return fail('EFFECT_RECEIPT_INVALID', 'receipt timestamps are reversed')
  if (!['PASS', 'BLOCK', 'PARTIAL'].includes(receipt.result)) return fail('EFFECT_RECEIPT_INVALID', 'receipt result is invalid')
  if (!Number.isInteger(receipt.duplicate_effect_count) || !Number.isInteger(receipt.unauthorized_effect_count)
    || receipt.duplicate_effect_count < 0 || receipt.unauthorized_effect_count < 0) {
    return fail('EFFECT_RECEIPT_INVALID', 'receipt effect counters are invalid')
  }
  if (receipt.result === 'PASS' && (receipt.duplicate_effect_count !== 0 || receipt.unauthorized_effect_count !== 0)) {
    return fail('EFFECT_RECEIPT_INVALID', 'PASS receipt contains duplicate or unauthorized effects')
  }
  if (!Array.isArray(receipt.per_target) || receipt.per_target.length !== request.target_scope.repositories.length) {
    return fail('EFFECT_RECEIPT_INVALID', 'receipt target count differs')
  }
  receipt.per_target.forEach((entry, index) => {
    const target = request.target_scope.repositories[index]
    if (entry.repository !== target || !exact(entry.preimage, request.preimages[index])) return fail('EFFECT_RECEIPT_INVALID', 'receipt preimage binding differs')
    assertReceiptImage(entry.postimage, `per_target[${index}].postimage`)
    const expectedQueue = request.queue_precheck.entries.find(candidate => candidate.repository === target) ?? null
    if (!exact(entry.queue_precheck, expectedQueue)) return fail('EFFECT_RECEIPT_INVALID', 'receipt queue precheck differs')
    assertRootGoalReadbacks([entry.root_goal_readback], [target])
  })

  if (request.operation === 'ROLLBACK') {
    const target = request.target_scope.repositories[0]
    if (receipt.forward_effect_receipt_sha256 !== request.predecessor_receipt.sha256
      || receipt.target_repository !== target
      || !exact(receipt.restored_preimage, frozenFleetRuntimePreimage(target))
      || receipt.fresh_runtime_instance_readback !== true
      || receipt.queue_counts_unchanged !== true) {
      return fail('EFFECT_RECEIPT_INVALID', 'rollback receipt does not prove exact restoration')
    }
  }
  if (request.operation === 'REAPPLY') {
    assertSha256(receipt.rollback_receipt_sha256, 'rollback_receipt_sha256')
    if (receipt.recovery_receipt_sha256 !== request.predecessor_receipt.sha256
      || receipt.target_repository !== request.target_scope.repositories[0]
      || receipt.payload_digest !== request.payload_digest) {
      return fail('EFFECT_RECEIPT_INVALID', 'reapply receipt does not bind rollback, recovery, target, and payload')
    }
    if (!receipt.postimage) return fail('EFFECT_RECEIPT_INVALID', 'reapply postimage is missing')
    assertReceiptImage(receipt.postimage, 'reapply.postimage')
  }
}

function assertInvocationState(state: FleetRuntimeInvocationState, request: FleetRuntimeRequest): void {
  if (state.idempotency_key !== request.idempotency_key || state.request_digest !== request.request_digest) {
    return fail('PERSISTED_INVOCATION_MISMATCH', 'persisted invocation belongs to another request')
  }
  if (state.status === 'reserved' && state.receipt === null) return
  if (state.status !== 'completed' || state.receipt === null) return fail('PERSISTED_INVOCATION_MISMATCH', 'invocation state is neither reserved nor completed')
  assertEffectReceipt(request, state.receipt)
}

export async function executeFleetRuntimeV1(
  untrustedRequest: FleetRuntimeRequest,
  ports: FleetRuntimePorts,
): Promise<FleetRuntimeEffectReceipt> {
  const request = prepareFleetRuntimeV1Request(untrustedRequest)
  const preflight = await ports.preflight.inspect(request)
  assertPreflight(request, preflight)

  const existing = await ports.persistence.load(request.idempotency_key)
  if (existing) {
    assertInvocationState(existing, request)
    if (existing.status === 'completed') return structuredClone(existing.receipt!)
  }

  const reservation = await ports.persistence.reserve_once({
    idempotency_key: request.idempotency_key,
    request_digest: request.request_digest,
    status: 'reserved',
    receipt: null,
  })
  assertInvocationState(reservation.state, request)
  if (reservation.state.status === 'completed') return structuredClone(reservation.state.receipt!)

  const receipt = await ports.effect.perform_once(request, preflight)
  assertEffectReceipt(request, receipt)
  const completed = await ports.persistence.complete_once({
    idempotency_key: request.idempotency_key,
    request_digest: request.request_digest,
    status: 'completed',
    receipt: structuredClone(receipt),
  })
  assertInvocationState(completed, request)
  if (!exact(completed.receipt, receipt)) return fail('PERSISTED_INVOCATION_MISMATCH', 'completed receipt differs from the effect receipt')
  return structuredClone(completed.receipt!)
}
