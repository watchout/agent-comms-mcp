import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  FLEET_RUNTIME_V1_CONTRACT,
  FLEET_RUNTIME_V1_TARGETS,
  FleetRuntimeV1Error,
  canonicalFleetRuntimeJson,
  computeFleetRuntimeIdempotencyKey,
  computeFleetRuntimeReceiptDigest,
  computeFleetRuntimeRequestDigest,
  frozenFleetRuntimePreimage,
  type FleetRuntimeEffectReceipt,
  type FleetRuntimeInvocationState,
  type FleetRuntimeOperation,
  type FleetRuntimePreflightContext,
  type FleetRuntimePreflightReceipt,
  type FleetRuntimeRequest,
  type FleetRuntimeResumeAdmissionBindingReadback,
  type FleetRuntimeResumeAdmissionControlHandoffRef,
} from '../../core/fleet-runtime-v1-adapter'
import {
  ConcreteFleetRuntimeV1LocalSystem,
  FLEET_RUNTIME_V1_ADF_READBACK_RELEASE,
  FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT,
  FLEET_RUNTIME_V1_PAYLOAD_MANIFEST_FILES,
  FileFleetRuntimeV1Persistence,
  FleetRuntimeLocalProviderError,
  buildFleetRuntimeV1DryRunReceipt,
  bunFleetRuntimeArgvRunner,
  executeLocalFleetRuntimeV1,
  assertExactFleetRuntimeChangedPathSet,
  assertExactFleetRuntimePathSet,
  validateFleetRuntimePayloadBlobLayer,
  parseFleetRuntimeQueueStatus,
  parseFleetRuntimeRootGoalReadback,
  validateFleetRuntimeCheckoutReadback,
  validateFleetRuntimeExternalMergeBinding,
  validateFleetRuntimeGitPayloadLayer,
  validateFleetRuntimeImmutableSemantics,
  validateFleetRuntimeLocalOperationState,
  validateFleetRuntimeLocalReceipt,
  validateFleetRuntimePayloadDirectory,
  parseFleetRuntimeOperationPredecessorBinding,
  parseFleetRuntimeResumeAdmissionBinding,
  selectFleetRuntimePayloadFromRenderer,
  type FleetRuntimeLocalOperationState,
  type FleetRuntimeLocalPhase,
  type FleetRuntimeLocalPhaseContext,
  type FleetRuntimeLocalPhaseResult,
  type FleetRuntimeLocalReconcileResult,
  type FleetRuntimeLocalSystem,
  type FleetRuntimeArgvRunner,
  type FleetRuntimeAdfReleaseReadback,
} from '../../core/fleet-runtime-v1-local-provider'
import {
  canonicalFleetRuntimeObservationJson,
  digestFleetRuntimeObservationMaterial,
  fleetRuntimeProfileBindingMaterial,
  fleetRuntimeQueueObservationIdMaterial,
  type FleetRuntimeQueueObservationV2,
} from '../../core/fleet-runtime-v1-queue-observation'

const temporaryRoots: string[] = []
const SHA_A = `sha256:${'a'.repeat(64)}`
const SHA_B = `sha256:${'b'.repeat(64)}`
const OWNER_BODY = '{"actor":"watchout","fixture":"N35 PASS"}'
const PREDECESSOR_BODY = '{"fixture":"predecessor","result":"PASS"}'
const EXECUTOR = { actor_agent_id: 'aun-runtime-executor', active_function: 'runtime_recovery_executor' }

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporary(name: string): string {
  const path = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `${name}-`)))
  temporaryRoots.push(path)
  return path
}

function protectedFixtureInput<T extends { stateDirectory: string }>(input: T): T & { approvedStateRoot: string } {
  return { ...input, approvedStateRoot: input.stateDirectory }
}

function rawDigest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`
}

function refreshQueueObservationId(observation: FleetRuntimeQueueObservationV2): void {
  observation.queue.active_rows_sha256 = digestFleetRuntimeObservationMaterial(observation.queue.active_rows)
  const material = { ...observation.queue }
  delete (material as Partial<typeof material>).queue_observation_id
  observation.queue.queue_observation_id = digestFleetRuntimeObservationMaterial(
    fleetRuntimeQueueObservationIdMaterial(observation.source, material),
  )
}

function resumeAdmissionControlHandoffFixture(
  request: FleetRuntimeRequest,
  durableRemoteHead: string,
  observation: FleetRuntimeQueueObservationV2,
): {
    ref: FleetRuntimeResumeAdmissionControlHandoffRef
    readback: { body: string; user: { login: string }; created_at: string; updated_at: string }
  } {
  const id = 'CH-ARC-ADF576-N40-LIVE-EXECUTION-20260819-010'
  const scalar = (value: string) => JSON.stringify(value)
  const body = [
    `<!-- shirube-v3:control-handoff:${id} -->`,
    'schema_version: shirube-v3/control_handoff/v1',
    `handoff_id: ${id}`,
    'cell:',
    `  id: ${id}`,
    'repository:',
    '  name: watchout/kodama',
    `control_source: ${scalar('https://github.com/watchout/ai-dev-framework/issues/576')}`,
    'from:',
    '  actor_agent_id: arc',
    '  active_function: control_artifact_author',
    'to:',
    '  actor_agent_id: aun-runtime-executor',
    '  active_function: runtime_recovery_executor',
    `  physical_bootstrap: ${scalar('aun seat may bootstrap')}`,
    'subject_invocation:',
    `  request_id: ${request.request_id}`,
    `  request_digest: ${scalar(request.request_digest)}`,
    `  idempotency_key: ${scalar(request.idempotency_key)}`,
    `  remote_head: ${durableRemoteHead}`,
    `  operational_subject_digest: ${scalar(request.predecessor_receipt.subject_digest)}`,
    'resume_admission_binding:',
    `  note: ${scalar('admits the one exact fresh observation')}`,
    '  repository: watchout/kodama',
    `  stage_id: ${request.stage_id}`,
    `  operation: ${request.operation}`,
    `  durable_request_id: ${request.request_id}`,
    `  request_digest: ${scalar(request.request_digest)}`,
    `  idempotency_key: ${scalar(request.idempotency_key)}`,
    `  remote_head: ${durableRemoteHead}`,
    `  operational_subject_digest: ${scalar(request.predecessor_receipt.subject_digest)}`,
    `  sealed_queue_revision: ${scalar(request.queue_observation.queue.revision)}`,
    `  admitted_fresh_queue_revision: ${scalar(observation.queue.revision)}`,
    `  admitted_fresh_queue_observation_id: ${scalar(observation.queue.queue_observation_id)}`,
    `  admitted_registry_status_change: ${scalar('registry status drift acknowledged; queue counts remain the safety predicate')}`,
    `  drift_disposition: ${scalar('the exact observation id is admitted without durable state mutation')}`,
    '',
  ].join('\n')
  const ref = {
    url: 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-5342500000',
    raw_api_body_sha256: rawDigest(body),
  }
  return {
    ref,
    readback: {
      body,
      user: { login: 'watchout' },
      created_at: '2026-08-19T13:03:36Z',
      updated_at: '2026-08-19T13:03:36Z',
    },
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalFleetRuntimeJson(value)).digest('hex')}`
}

function officialBlockedRootGoalStatus(): Record<string, unknown> {
  return {
    schema: 'shirube-goal-runtime-command/v1',
    verdict: 'BLOCKED',
    command: 'status',
    store_path: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.store_path,
    store_code: 'STORE_NOT_CREATED',
    runner_code: null,
    disposition: null,
    persisted: false,
    write_count: 0,
    root: null,
    runtime_digest: null,
    checkpoint: null,
    proposed_effect: null,
    counters: { state_mutations: 0, effect_count: 0, dispatch_count: 0, model_calls: 0, polling_count: 0 },
    effect_delivery_performed: false,
  }
}

function officialPassRootGoalStatus(): Record<string, unknown> {
  return {
    schema: 'shirube-goal-runtime-command/v1',
    verdict: 'PASS',
    command: 'status',
    store_path: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.store_path,
    store_code: 'RESTORED',
    runner_code: null,
    disposition: null,
    persisted: false,
    write_count: 0,
    root: {
      root_goal_run_id: 'fixture-root-goal',
      status: 'ACTIVE',
      generation: 0,
      objective_digest: SHA_A,
      acceptance_digest: SHA_A,
      target_digest: SHA_B,
      state_digest: SHA_B,
    },
    runtime_digest: SHA_A,
    checkpoint: {
      accepted_event_count: 0,
      idempotency_key_count: 0,
      continuation_effect_id: null,
      wait_event_key: null,
      protected_pause_key: null,
      target_evidence_count: 0,
      delivery_ledger_digest: SHA_B,
      watchdog_stall_count: 0,
      watchdog_replan_count: 0,
    },
    proposed_effect: null,
    counters: { state_mutations: 0, effect_count: 0, dispatch_count: 0, model_calls: 0, polling_count: 0 },
    effect_delivery_performed: false,
  }
}

function subject(): FleetRuntimeRequest['subject'] {
  return {
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
}

function predecessor(operation: FleetRuntimeOperation, exactSubject: FleetRuntimeRequest['subject']): FleetRuntimeRequest['predecessor_receipt'] {
  const base = {
    url: 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-9999999998',
    sha256: rawDigest(PREDECESSOR_BODY),
    subject_digest: digest(exactSubject),
    node_id: 'N40-P4-CANARY-VERIFY',
  }
  if (operation === 'ROLLBACK') return { ...base, kind: 'EFFECT_RECEIPT', operation: 'CANARY_COLD_START', result: 'PASS' }
  if (operation === 'RECOVERY') return { ...base, kind: 'ROLLBACK_RECEIPT', operation: 'ROLLBACK', result: 'PASS' }
  if (operation === 'REAPPLY') return { ...base, kind: 'RECOVERY_RECEIPT', operation: 'RECOVERY', result: 'PASS' }
  return { ...base, kind: 'NODE_RESULT', node_id: FLEET_RUNTIME_V1_CONTRACT.node_id, operation: null, result: 'PASS' }
}

function queueObservation(observedAt = '2026-08-15T08:23:59.000Z'): FleetRuntimeQueueObservationV2 {
  const sourceBase = {
    dialect: 'postgres' as const, database_name: 'agent_comms', database_oid: '16384',
    database_user: 'yuji', system_identifier: '7612345678901234567',
  }
  const source = {
    ...sourceBase,
    profile_binding_digest: digestFleetRuntimeObservationMaterial(fleetRuntimeProfileBindingMaterial(sourceBase)),
    migration_epoch: '1',
  }
  const queueBase = {
    agent_id: 'kodama' as const, revision: '0', active_rows: [],
    active_rows_sha256: digestFleetRuntimeObservationMaterial([]),
    pending_count: 0, received_count: 0, in_progress_count: 0,
  }
  return {
    schema_version: 'fleet-runtime-v1/observation/v2', contract_revision: 2, observed_at: observedAt, source,
    queue: { ...queueBase, queue_observation_id: digestFleetRuntimeObservationMaterial(fleetRuntimeQueueObservationIdMaterial(source, queueBase)) },
    executor_profile: {
      agent_id: 'aun-runtime-executor', agent_type: 'system', runtime: 'local_process', status: 'offline',
      profile_enabled: true, profile_revision: 1, profile_source: 'agent.register',
    },
    kodama_registry: {
      agent_id: 'kodama', agent_type: 'dev', runtime: 'TUI', status: 'offline', profile_enabled: true,
      profile_revision: 1, home_directory: '/Users/yuji/Developer/kodama',
    },
    runtime_inventory: { latest_instance: null },
  }
}

function requestFor(operation: 'CANARY_COLD_START' | 'ROLLBACK' | 'RECOVERY' | 'REAPPLY' = 'CANARY_COLD_START'): FleetRuntimeRequest {
  const exactSubject = subject()
  const request: FleetRuntimeRequest = {
    schema_version: 'fleet-runtime-v1/request/v2',
    request_id: `FRV1-N40-${operation}-FIXTURE`,
    request_digest: SHA_A,
    subject: exactSubject,
    owner_decision: {
      url: 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-9999999999',
      actor: 'watchout',
      created_at: '2026-08-15T08:04:04Z',
      updated_at: '2026-08-15T08:04:04Z',
      raw_api_body_sha256: rawDigest(OWNER_BODY),
      node_id: FLEET_RUNTIME_V1_CONTRACT.node_id,
      result: 'PASS',
      stage_authority_matrix: [
        { stage_id: 'N40-P4-CANARY-VERIFY', ...EXECUTOR, allowed_operations: ['CANARY_COLD_START', 'ROLLBACK', 'RECOVERY', 'REAPPLY'], target_repositories: ['watchout/kodama'] },
        { stage_id: 'N50-P5-PLACEMENT', ...EXECUTOR, allowed_operations: ['FIVE_TARGET_PLACEMENT'], target_repositories: [...FLEET_RUNTIME_V1_TARGETS] },
        { stage_id: 'N60-P6-APPLICATION', ...EXECUTOR, allowed_operations: ['FIVE_TARGET_COLD_START'], target_repositories: [...FLEET_RUNTIME_V1_TARGETS] },
        { stage_id: 'N70-P7-OPERATIONAL', ...EXECUTOR, allowed_operations: ['ONE_OPERATIONAL_ACCEPTANCE_RUN'], target_repositories: ['watchout/kodama'] },
      ],
      canary_target: 'watchout/kodama',
    },
    executor_identity: { ...EXECUTOR },
    stage_id: 'N40-P4-CANARY-VERIFY',
    operation,
    predecessor_receipt: predecessor(operation, exactSubject),
    idempotency_key: `frv1:N40:${'0'.repeat(64)}`,
    target_scope: { repositories: ['watchout/kodama'], canonical_digest: digest(['watchout/kodama']) },
    payload_digest: FLEET_RUNTIME_V1_CONTRACT.payload_digest,
    queue_observation: queueObservation(),
    preimages: [frozenFleetRuntimePreimage('watchout/kodama')],
  }
  request.request_digest = computeFleetRuntimeRequestDigest(request)
  request.idempotency_key = computeFleetRuntimeIdempotencyKey(request)
  return request
}

function resign(request: FleetRuntimeRequest): FleetRuntimeRequest {
  request.request_digest = computeFleetRuntimeRequestDigest(request)
  request.idempotency_key = computeFleetRuntimeIdempotencyKey(request)
  return request
}

function operationPredecessorBinding(
  request: FleetRuntimeRequest,
  overrides: Partial<Record<string, string>> = {},
): string[] {
  const effect = request.operation !== 'CANARY_COLD_START'
  const reapply = request.operation === 'REAPPLY'
  const values: Record<string, string> = {
    operation: request.operation,
    predecessor_url: request.predecessor_receipt.url,
    predecessor_raw_body_sha256: request.predecessor_receipt.sha256,
    predecessor_self_sha256: effect ? SHA_B : 'null',
    prior_request_id: effect ? 'FRV1-N40-PRIOR-FIXTURE' : 'null',
    prior_request_digest: effect ? SHA_B : 'null',
    prior_idempotency_key: effect ? `frv1:N40:${'b'.repeat(64)}` : 'null',
    prior_operation: request.predecessor_receipt.operation ?? 'null',
    prior_result: request.predecessor_receipt.result,
    subject_digest: request.predecessor_receipt.subject_digest,
    companion_url: reapply ? 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-9999999997' : 'null',
    companion_raw_body_sha256: reapply ? SHA_A : 'null',
    companion_self_sha256: reapply ? SHA_B : 'null',
    companion_request_id: reapply ? 'FRV1-N40-ROLLBACK-FIXTURE' : 'null',
    companion_request_digest: reapply ? SHA_A : 'null',
    companion_idempotency_key: reapply ? `frv1:N40:${'c'.repeat(64)}` : 'null',
    companion_operation: reapply ? 'ROLLBACK' : 'null',
    companion_result: reapply ? 'PASS' : 'null',
    ...overrides,
  }
  return [
    'operation_predecessor_binding:',
    ...[
      'operation', 'predecessor_url', 'predecessor_raw_body_sha256', 'predecessor_self_sha256',
      'prior_request_id', 'prior_request_digest', 'prior_idempotency_key', 'prior_operation', 'prior_result', 'subject_digest',
      'companion_url', 'companion_raw_body_sha256', 'companion_self_sha256', 'companion_request_id',
      'companion_request_digest', 'companion_idempotency_key', 'companion_operation', 'companion_result',
    ].map(key => `  ${key}: ${values[key]}`),
  ]
}

function semanticOwnerBody(
  request: FleetRuntimeRequest,
  bindingOverrides: Partial<Record<string, string>> = {},
): string {
  const matrix = request.owner_decision.stage_authority_matrix.map(entry => [
    `  - stage_id: ${entry.stage_id}`,
    `    actor_agent_id: ${entry.actor_agent_id}`,
    `    active_function: ${entry.active_function}`,
    `    allowed_operations: [${entry.allowed_operations.join(', ')}]`,
    `    target_repositories: [${entry.target_repositories.join(', ')}]`,
  ].join('\n')).join('\n')
  return [
    'schema_version: shirube-v3/owner_decision/v1',
    'decision: GO',
    'result: PASS',
    'actor_identity: watchout',
    'subject:',
    `  graph_digest: ${request.subject.graph_digest}`,
    `  graph_generation: ${request.subject.graph_generation}`,
    `  node_id: ${request.owner_decision.node_id}`,
    `  lease_epoch: ${request.subject.lease_epoch}`,
    '  release:',
    `    repository: ${request.subject.release_repository}`,
    `    tag: ${request.subject.release_tag}`,
    `    commit: ${request.subject.release_commit}`,
    `    tree: ${request.subject.release_tree}`,
    `    manifest_self_digest: ${request.subject.release_manifest_digest}`,
    '  target_set:',
    '    ordered:',
    ...FLEET_RUNTIME_V1_TARGETS.map(target => `      - ${target}`),
    `    canonical_digest: ${request.subject.target_set_digest}`,
    `    payload_digest: ${request.subject.payload_digest}`,
    'canary_selection:',
    '  target: watchout/kodama',
    '  explicit_owner_selection: true',
    '  target_count: 1',
    'rollback_preimage:',
    '  target_repository: watchout/kodama',
    '  repository_preimage:',
    `    required_base_branch: ${request.preimages[0].required_base_branch}`,
    `    head_commit: ${request.preimages[0].head_commit}`,
    `    tree: ${request.preimages[0].tree}`,
    `    runtime_surface_sha256: ${request.preimages[0].runtime_surface_sha256}`,
    `    distribution_surface_sha256: ${request.preimages[0].distribution_surface_sha256}`,
    ...operationPredecessorBinding(request, bindingOverrides),
    'stage_authority_matrix:',
    matrix,
  ].join('\n')
}

function semanticPredecessorBody(request: FleetRuntimeRequest): string {
  return [
    'schema_version: shirube-v3/node-result/v1',
    `node_id: ${request.predecessor_receipt.node_id}`,
    'result: PASS',
    'verdict: PASS_EXACT_SUBJECT',
    'exact_subject:',
    `  graph_digest: ${request.subject.graph_digest.replace(/^sha256:/, '')}`,
    `  release_tag: ${request.subject.release_tag}`,
    `  release_commit: ${request.subject.release_commit}`,
    `  release_tree: ${request.subject.release_tree}`,
    `  release_manifest_digest: ${request.subject.release_manifest_digest.replace(/^sha256:/, '')}`,
    `  target_set_digest: ${request.subject.target_set_digest.replace(/^sha256:/, '')}`,
    `  payload_digest: ${request.subject.payload_digest.replace(/^sha256:/, '')}`,
  ].join('\n')
}

function preflightFor(request: FleetRuntimeRequest): FleetRuntimePreflightReceipt {
  return {
    schema_version: 'fleet-runtime-v1/preflight-receipt/v3',
    request_digest: request.request_digest,
    observed_at: request.queue_observation.observed_at,
    owner_decision_readback: structuredClone(request.owner_decision),
    owner_decision_raw_body: OWNER_BODY,
    predecessor_receipt_readback: structuredClone(request.predecessor_receipt),
    predecessor_receipt_raw_body: PREDECESSOR_BODY,
    target_preimages: structuredClone(request.preimages),
    queue_observation: structuredClone(request.queue_observation),
    resume_admission_binding: null,
    root_goal_readbacks: [{
      repository: 'watchout/kodama',
      store_path: '/Users/yuji/Developer/kodama/.framework/runtime/goal-convergence.json',
      schema: 'shirube-goal-runtime-command/v1',
      verdict: 'PASS',
      store_code: 'FOUND',
      runtime_digest: SHA_A,
      root: { root_goal_id: 'fixture' },
      write_count: 0,
      effect_delivery_performed: false,
    }],
    filesystem_write_count: 0,
    database_write_count: 0,
    queue_write_count: 0,
    protected_effect_count: 0,
  }
}

function image(request: FleetRuntimeRequest, instance = `runtime-${request.operation}`) {
  const preimage = request.preimages[0]
  return {
    head_commit: preimage.head_commit,
    tree: preimage.tree,
    runtime_surface_sha256: preimage.runtime_surface_sha256,
    distribution_surface_sha256: preimage.distribution_surface_sha256,
    release: { commit: request.subject.release_commit, tree: request.subject.release_tree },
    config: { exact: true },
    policy: { exact: true },
    root: { root_goal_id: 'fixture' },
    goal: { state: 'READY' },
    runtime_digest: SHA_A,
    runtime_instance_id: instance,
  }
}

function receiptFor(request: FleetRuntimeRequest, preflight: FleetRuntimePreflightReceipt): FleetRuntimeEffectReceipt {
  const receipt: FleetRuntimeEffectReceipt = {
    schema_version: request.operation === 'ROLLBACK'
      ? 'fleet-runtime-v1/rollback-receipt/v2'
      : request.operation === 'REAPPLY'
        ? 'fleet-runtime-v1/reapply-receipt/v2'
        : 'fleet-runtime-v1/effect-receipt/v2',
    receipt_id: `fixture-${request.request_id}`,
    receipt_sha256: SHA_A,
    request_id: request.request_id,
    request_digest: request.request_digest,
    idempotency_key: request.idempotency_key,
    stage_id: request.stage_id,
    operation: request.operation,
    effect_id: `effect-${request.operation}`,
    actor_agent_id: request.executor_identity.actor_agent_id,
    active_function: request.executor_identity.active_function,
    started_at: '2026-08-15T08:30:00Z',
    completed_at: '2026-08-15T08:30:01Z',
    result: 'PASS',
    per_target: [{
      repository: 'watchout/kodama',
      preimage: structuredClone(request.preimages[0]),
      postimage: image(request),
      queue_observation: structuredClone(request.queue_observation),
      root_goal_readback: structuredClone(preflight.root_goal_readbacks[0]),
    }],
    duplicate_effect_count: 0,
    unauthorized_effect_count: 0,
  }
  const bound = receipt as FleetRuntimeEffectReceipt & Record<string, unknown>
  bound.subject_digest = digest(request.subject)
  bound.target_repository = 'watchout/kodama'
  bound.predecessor_receipt_sha256 = request.predecessor_receipt.sha256
  bound.predecessor_receipt_raw_body_sha256 = request.predecessor_receipt.sha256
  bound.predecessor_receipt_self_sha256 = request.operation === 'CANARY_COLD_START' ? null : SHA_B
  if (request.operation === 'CANARY_COLD_START') {
    bound.merge_commit = 'c'.repeat(40)
    bound.merge_tree = 'd'.repeat(40)
    bound.pr_url = 'https://github.com/watchout/kodama/pull/123'
  }
  if (request.operation === 'ROLLBACK') {
    bound.merge_commit = 'c'.repeat(40)
    bound.merge_tree = request.preimages[0].tree
    bound.pr_url = 'https://github.com/watchout/kodama/pull/124'
    receipt.forward_effect_receipt_sha256 = request.predecessor_receipt.sha256
    receipt.target_repository = 'watchout/kodama'
    receipt.restored_preimage = structuredClone(request.preimages[0])
    receipt.fresh_runtime_instance_readback = true
    receipt.queue_counts_unchanged = true
  }
  if (request.operation === 'RECOVERY') {
    bound.rollback_receipt_sha256 = SHA_B
  }
  if (request.operation === 'REAPPLY') {
    receipt.rollback_receipt_sha256 = SHA_B
    receipt.recovery_receipt_sha256 = request.predecessor_receipt.sha256
    receipt.target_repository = 'watchout/kodama'
    receipt.payload_digest = request.payload_digest
    receipt.postimage = image(request)
  }
  receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt)
  return receipt
}

const FIXTURE_PAYLOAD_PATHS = FLEET_RUNTIME_V1_PAYLOAD_MANIFEST_FILES.map(file => file.path)
const FIXTURE_RAW_PATHS = [...FIXTURE_PAYLOAD_PATHS, ...Array.from({ length: 10 }, (_, index) => `control/extra-${index}.txt`)].sort()
const SYNTHETIC_PAYLOAD_PATHS = Array.from({ length: 24 }, (_, index) => `payload/${String(index).padStart(2, '0')}.txt`)
const SYNTHETIC_RAW_PATHS = [...SYNTHETIC_PAYLOAD_PATHS, ...Array.from({ length: 10 }, (_, index) => `control/extra-${index}.txt`)].sort()
const MEASURED_CHANGED_PATHS = [
  '.github/workflows/shirube-rapid-lite-gates-report.yml',
  '.shirube/runtime/rapid-lite/check-control-state-completeness.mjs',
  '.shirube/runtime/rapid-lite/manifest.json',
  '.shirube/runtime/rapid-lite/run-rapid-lite-report.mjs',
]

function measuredGitDeltaFixture(name: string, stage = true) {
  const stateDirectory = temporary(name)
  const invocationDirectory = join(stateDirectory, 'invocations', 'copied-reserved-journal')
  const checkout = join(invocationDirectory, 'checkout')
  mkdirSync(checkout, { recursive: true })
  runTempGit(['git', 'init', '--quiet'], checkout)
  runTempGit(['git', 'config', 'user.name', 'Fleet Runtime Fixture'], checkout)
  runTempGit(['git', 'config', 'user.email', 'fleet-runtime@example.invalid'], checkout)
  const baseline = new Map<string, string>()
  for (const [index, path] of FIXTURE_PAYLOAD_PATHS.entries()) {
    const content = `preimage-payload-${String(index).padStart(2, '0')}\n`
    baseline.set(path, content)
    const target = join(checkout, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  runTempGit(['git', 'add', '--', ...FIXTURE_PAYLOAD_PATHS], checkout)
  runTempGit(['git', 'commit', '--quiet', '-m', 'frozen preimage'], checkout)
  const preimageHead = runTempGit(['git', 'rev-parse', 'HEAD'], checkout)
  runTempGit(['git', 'checkout', '--quiet', '--detach', preimageHead], checkout)
  const manifest = FIXTURE_PAYLOAD_PATHS.map((path, index) => {
    const content = MEASURED_CHANGED_PATHS.includes(path)
      ? `rendered-payload-${String(index).padStart(2, '0')}\n`
      : baseline.get(path)!
    writeFileSync(join(checkout, path), content)
    return { path, bytes: Buffer.byteLength(content), sha256: rawDigest(content) }
  })
  if (stage) runTempGit(['git', 'add', '--', ...FIXTURE_PAYLOAD_PATHS], checkout)
  return { stateDirectory, invocationDirectory, checkout, manifest, preimageHead }
}

function fixtureBlobMap(): Record<string, { bytes: number; sha256: string }> {
  return Object.fromEntries(FLEET_RUNTIME_V1_PAYLOAD_MANIFEST_FILES.map(file => [file.path, { bytes: file.bytes, sha256: file.sha256 }]))
}

function concreteRendererManifest() {
  return {
    files: SYNTHETIC_PAYLOAD_PATHS.map((path, index) => {
      const content = `selected-payload-${String(index).padStart(2, '0')}\n`
      return { path, bytes: Buffer.byteLength(content), sha256: rawDigest(content) }
    }),
  }
}

function writeConcreteRendererOutput(rawOutputPath: string) {
  mkdirSync(rawOutputPath, { recursive: true })
  const manifest = concreteRendererManifest()
  for (const [index, file] of manifest.files.entries()) {
    const outputPath = join(rawOutputPath, file.path)
    mkdirSync(join(outputPath, '..'), { recursive: true })
    writeFileSync(outputPath, `selected-payload-${String(index).padStart(2, '0')}\n`)
  }
  const extras = Array.from({ length: 10 }, (_, index) => {
    const path = `control/extra-${index}.txt`
    const content = `renderer-extra-${index}\n`
    const outputPath = join(rawOutputPath, path)
    mkdirSync(join(outputPath, '..'), { recursive: true })
    writeFileSync(outputPath, content)
    return { path, bytes: Buffer.byteLength(content), sha256: rawDigest(content) }
  })
  const generatedFiles = [...manifest.files, ...extras]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => ({
      path: file.path,
      output_path: join(rawOutputPath, file.path),
      bytes: file.bytes,
      sha256: file.sha256.replace(/^sha256:/, ''),
    }))
  const rendererReport = {
    schema: 'shirube-adoption-pack-render/v1',
    verdict: 'PASS',
    profile: 'hotel-lite',
    mode: 'render',
    target_repo: 'watchout/kodama',
    product: 'Kodama',
    source_control: 'watchout/ai-dev-framework#576',
    framework_ref: `watchout/ai-dev-framework@${FLEET_RUNTIME_V1_CONTRACT.release_commit}`,
    output_root: rawOutputPath,
    generated_files: generatedFiles,
    target_change_policy: {
      allowed_paths: ['.shirube/**', 'docs/shirube/**', '.github/workflows/shirube-rapid-lite-gates-report.yml'],
      forbidden_paths: [
        'scripts/shirube/**', 'src/**', 'app/**', 'api/**', 'lib/**', 'db/**', 'migrations/**',
        'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.env*', 'deploy/**', 'deployment/**',
        '.github/branch-protection/**', '.github/rulesets/**',
      ],
      workflow_caller_generated: true,
      workflow_caller_path: '.github/workflows/shirube-rapid-lite-gates-report.yml',
      application_runtime_changes_allowed: false,
      shirube_control_runtime_bundle_generated: true,
      package_changes_allowed: false,
      branch_protection_changes_allowed: false,
      required_check_activation_allowed: false,
      external_repo_mutation_allowed: false,
    },
    required_next_actions: [
      'Open a target-repo adoption PR containing only the generated overlay files.',
      'Owner must fill exact-head decision evidence before merge if any gate would block.',
      'The generated fail-closed workflow and immutable local runtime bundle must be updated together from an audited Shirube release; required-check activation remains separately authorized.',
      'Do not mix runtime, API, DB, package, deploy, branch protection, ruleset, or required-check changes into the adoption PR.',
    ],
  }
  return { manifest, rendererReport }
}

function concreteRendererFixture(name: string) {
  const stateDirectory = temporary(name)
  const rawOutputPath = join(stateDirectory, 'renderer-raw-output')
  const selectedPayloadPath = join(stateDirectory, 'selected-payload')
  const { manifest, rendererReport } = writeConcreteRendererOutput(rawOutputPath)
  return { stateDirectory, rawOutputPath, selectedPayloadPath, manifest, rendererReport }
}

function runTempGit(argv: string[], cwd: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, `${argv.join(' ')}: ${result.stderr.toString()}`).toBe(0)
  return result.stdout.toString().trim()
}

function fixtureCheckout(intent: Record<string, unknown>): Record<string, unknown> {
  return {
    checkout_path: intent.checkout_path ?? '/fixture/state/invocations/key/checkout',
    remote: 'https://github.com/watchout/kodama.git',
    head: intent.expected_head,
    tree: intent.expected_tree,
    clean: true,
    detached: true,
  }
}

function fixtureRendererSourceCheckout(context: Readonly<FleetRuntimeLocalPhaseContext>): Record<string, unknown> {
  return {
    checkout_path: join(context.invocation_directory, 'adf-payload-amendment'),
    remote: 'https://github.com/watchout/ai-dev-framework.git',
    head: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref,
    tree: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree,
    renderer_blob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_blob,
    workflow_template_blob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_blob,
    clean: true,
    detached: true,
  }
}

function fixtureIntent(
  request: FleetRuntimeRequest,
  phase: FleetRuntimeLocalPhase,
  context: Readonly<FleetRuntimeLocalPhaseContext>,
): Record<string, unknown> {
  const prepared = context.prior_evidence.PREPARE_CLEAN_CHECKOUT
  const staged = context.prior_evidence.STAGE_EXACT_PAYLOAD
  const local = context.prior_evidence.CREATE_LOCAL_COMMIT ?? context.prior_evidence.CREATE_LOCAL_REVERT
  const pushed = context.prior_evidence.PUSH_NORMAL_BRANCH
  const created = context.prior_evidence.CREATE_DRAFT_PR
  const merged = context.prior_evidence.VERIFY_EXTERNAL_MERGE
  const checkoutPath = join(context.invocation_directory, 'checkout')
  if (phase === 'PREPARE_CLEAN_CHECKOUT') {
    return {
      expected_head: request.operation === 'ROLLBACK' || request.operation === 'RECOVERY' ? 'c'.repeat(40) : request.preimages[0].head_commit,
      expected_tree: request.operation === 'ROLLBACK' || request.operation === 'RECOVERY' ? 'd'.repeat(40) : request.preimages[0].tree,
    }
  }
  if (phase === 'STAGE_EXACT_PAYLOAD') return {
    payload_digest: request.payload_digest, path_count: 24,
    raw_output_path: join(context.invocation_directory, 'renderer-raw-output'),
    release_commit: request.subject.release_commit, release_tree: request.subject.release_tree,
    renderer_source_ref: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref,
    renderer_source_tree: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree,
    selected_payload_path: join(context.invocation_directory, 'selected-payload'),
  }
  if (phase === 'VERIFY_EXACT_PAYLOAD') return {
    payload_digest: request.payload_digest, path_count: 24, selected_payload_path: staged?.selected_payload_path,
  }
  if (phase === 'CREATE_LOCAL_COMMIT') return { payload_digest: request.payload_digest, path_count: 24 }
  if (phase === 'CREATE_LOCAL_REVERT') return { merge_commit: 'c'.repeat(40), expected_tree: request.preimages[0].tree }
  if (phase === 'PUSH_NORMAL_BRANCH') return { branch: local?.branch, head: local?.head, force: false }
  if (phase === 'CREATE_DRAFT_PR') return {
    repository: 'watchout/kodama', base: 'main', branch: pushed?.branch, head: pushed?.head, draft: true,
  }
  if (phase === 'VERIFY_EXTERNAL_MERGE') return {
    repository: 'watchout/kodama', base: 'main', pr_url: created?.pr_url, pushed_head: pushed?.head,
  }
  if (phase === 'PREPARE_MERGED_CHECKOUT') return { expected_head: merged?.merge_commit, expected_tree: merged?.merge_tree }
  if (phase === 'VERIFY_EXACT_PREIMAGE') return request.operation === 'ROLLBACK'
    ? { expected_head: merged?.merge_commit, expected_tree: request.preimages[0].tree }
    : { expected_head: prepared?.head, expected_tree: request.preimages[0].tree }
  if (phase === 'COLD_START_DISCORD_KODAMA' || phase === 'VERIFY_LIVE_IDENTITY') return {
    checkout_path: checkoutPath, session: 'discord-kodama', port: 8803,
    expected_head: merged?.merge_commit ?? prepared?.head,
    expected_tree: merged?.merge_tree ?? (request.operation === 'RECOVERY' ? request.preimages[0].tree : prepared?.tree),
  }
  throw new Error(`unsupported fixture intent ${phase}`)
}

function fixtureExternalMergeReceipt(request: FleetRuntimeRequest, intent: Record<string, unknown>): Record<string, unknown> {
  const receipt: Record<string, unknown> = {
    schema_version: 'fleet-runtime-v1/external-merge-receipt/v1', receipt_sha256: SHA_A,
    subject_digest: digest(request.subject), request_id: request.request_id, request_digest: request.request_digest,
    idempotency_key: request.idempotency_key, operation: request.operation, target_repository: 'watchout/kodama',
    base: 'main', pr_url: intent.pr_url, pushed_head: intent.pushed_head,
    merge_commit: 'c'.repeat(40), merge_tree: request.operation === 'ROLLBACK' ? request.preimages[0].tree : 'd'.repeat(40),
    result: 'PASS', predecessor_receipt_sha256: request.predecessor_receipt.sha256,
  }
  receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt as unknown as FleetRuntimeEffectReceipt)
  return receipt
}

function fixtureEvidence(
  request: FleetRuntimeRequest,
  phase: FleetRuntimeLocalPhase,
  context: Readonly<FleetRuntimeLocalPhaseContext>,
): Record<string, unknown> {
  const intent = context.current_intent
  if (phase === 'PREPARE_CLEAN_CHECKOUT') return {
    ...fixtureCheckout({ ...intent, checkout_path: join(context.invocation_directory, 'checkout') }),
    baseline_runtime_instance_id: null,
    ...(request.operation === 'REAPPLY' ? {
      rollback_receipt_url: 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-9999999997',
      rollback_receipt_raw_body_sha256: SHA_A,
      rollback_receipt_self_sha256: SHA_B,
    } : {}),
  }
  if (phase === 'STAGE_EXACT_PAYLOAD') return {
    path_count: 24, payload_digest: request.payload_digest, payload_paths: FIXTURE_PAYLOAD_PATHS,
    raw_output_path: intent.raw_output_path, raw_path_count: 34, raw_paths: FIXTURE_RAW_PATHS,
    renderer_source_checkout_after: fixtureRendererSourceCheckout(context),
    renderer_source_checkout_before: fixtureRendererSourceCheckout(context), renderer_report_sha256: SHA_A,
    selected_blobs: fixtureBlobMap(), selected_payload_path: intent.selected_payload_path,
  }
  if (phase === 'VERIFY_EXACT_PAYLOAD') return {
    checkout_blobs: fixtureBlobMap(), path_count: 24, payload_digest: request.payload_digest,
    payload_paths: FIXTURE_PAYLOAD_PATHS, selected_payload_path: intent.selected_payload_path,
  }
  if (phase === 'CREATE_LOCAL_COMMIT') return {
    branch: 'fixture-branch', head: 'e'.repeat(40), payload_paths: FIXTURE_PAYLOAD_PATHS,
    index_blobs: fixtureBlobMap(), commit_blobs: fixtureBlobMap(),
  }
  if (phase === 'CREATE_LOCAL_REVERT') return { branch: 'fixture-rollback', head: 'e'.repeat(40), reverted_merge: intent.merge_commit }
  if (phase === 'PUSH_NORMAL_BRANCH') return { branch: intent.branch, head: intent.head, force: false }
  if (phase === 'CREATE_DRAFT_PR') return {
    pr_url: 'https://github.com/watchout/kodama/pull/123', branch: intent.branch, head: intent.head, draft: true,
  }
  if (phase === 'VERIFY_EXTERNAL_MERGE') return fixtureExternalMergeReceipt(request, intent)
  if (phase === 'PREPARE_MERGED_CHECKOUT' || phase === 'VERIFY_EXACT_PREIMAGE') return {
    ...fixtureCheckout({ ...intent, checkout_path: join(context.invocation_directory, 'checkout') }),
  }
  if (phase === 'COLD_START_DISCORD_KODAMA') return { ...fixtureCheckout(intent), session: intent.session, port: intent.port }
  if (phase === 'VERIFY_LIVE_IDENTITY') return {
    duplicate_effect_count: 0, inventory: { agent_id: 'kodama' }, local_checkout: fixtureCheckout(intent),
    queue_unchanged: true,
    remote_image: {
      distribution_surface_entry_count: 1, distribution_surface_sha256: request.preimages[0].distribution_surface_sha256,
      head_commit: intent.expected_head, runtime_surface_entry_count: 1,
      runtime_surface_sha256: request.preimages[0].runtime_surface_sha256, tree: intent.expected_tree,
    },
    runtime_instance_id: `runtime-${request.operation}`, unauthorized_effect_count: 0,
  }
  throw new Error(`unsupported fixture evidence ${phase}`)
}

class FixtureSystem implements FleetRuntimeLocalSystem {
  readonly calls = new Map<FleetRuntimeLocalPhase, number>()
  mergeAvailable = true
  interruptOnceAt: FleetRuntimeLocalPhase | null = null
  reconcileInterrupted = true
  inspectCount = 0
  readonly inspectModes: FleetRuntimePreflightContext['mode'][] = []
  resumeObservedAt: string | null = null
  resumeObservation: FleetRuntimeQueueObservationV2 | null = null
  resumeAdmissionBinding: FleetRuntimeResumeAdmissionBindingReadback | null = null
  lastResumeControlHandoff: FleetRuntimeResumeAdmissionControlHandoffRef | null = null
  lastDurableRemoteHead: string | null = null

  async inspect(request: Readonly<FleetRuntimeRequest>): Promise<FleetRuntimePreflightReceipt> {
    return this.inspectFor(request, 'SEALED_START')
  }

  async inspectResume(
    request: Readonly<FleetRuntimeRequest>,
    controlHandoff: Readonly<FleetRuntimeResumeAdmissionControlHandoffRef> | null,
    durableRemoteHead: string | null,
  ): Promise<FleetRuntimePreflightReceipt> {
    this.lastResumeControlHandoff = controlHandoff ? structuredClone(controlHandoff) : null
    this.lastDurableRemoteHead = durableRemoteHead
    return this.inspectFor(request, 'DURABLE_RESUME')
  }

  private async inspectFor(
    request: Readonly<FleetRuntimeRequest>,
    mode: FleetRuntimePreflightContext['mode'],
  ): Promise<FleetRuntimePreflightReceipt> {
    this.inspectCount += 1
    this.inspectModes.push(mode)
    const receipt = preflightFor(request as FleetRuntimeRequest)
    if (mode === 'DURABLE_RESUME' && this.resumeObservedAt) {
      receipt.observed_at = this.resumeObservedAt
      receipt.queue_observation.observed_at = this.resumeObservedAt
    }
    if (mode === 'DURABLE_RESUME' && this.resumeObservation) {
      receipt.observed_at = this.resumeObservation.observed_at
      receipt.queue_observation = structuredClone(this.resumeObservation)
    }
    if (mode === 'DURABLE_RESUME') {
      receipt.resume_admission_binding = this.resumeAdmissionBinding
        ? structuredClone(this.resumeAdmissionBinding)
        : null
    }
    return receipt
  }

  phaseIntent(
    request: Readonly<FleetRuntimeRequest>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Record<string, unknown> {
    return fixtureIntent(request as FleetRuntimeRequest, phase, context)
  }

  async performPhase(
    request: Readonly<FleetRuntimeRequest>,
    _preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalPhaseResult> {
    this.calls.set(phase, (this.calls.get(phase) ?? 0) + 1)
    if (phase === 'VERIFY_EXTERNAL_MERGE' && !this.mergeAvailable) {
      throw new FleetRuntimeLocalProviderError('WAITING_INDEPENDENT_MERGE', 'fixture merge pending')
    }
    if (this.interruptOnceAt === phase) {
      this.interruptOnceAt = null
      throw new Error(`fixture interruption at ${phase}`)
    }
    const protectedPhase = ['PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'COLD_START_DISCORD_KODAMA'].includes(phase)
    return { evidence: fixtureEvidence(request as FleetRuntimeRequest, phase, context), protected_effect_count: protectedPhase ? 1 : 0 }
  }

  async reconcilePhase(
    request: Readonly<FleetRuntimeRequest>,
    _preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalReconcileResult> {
    if (phase === 'VERIFY_EXTERNAL_MERGE' && !this.mergeAvailable) {
      throw new FleetRuntimeLocalProviderError('WAITING_INDEPENDENT_MERGE', 'fixture merge pending')
    }
    return this.reconcileInterrupted
      ? { completed: true, evidence: fixtureEvidence(request as FleetRuntimeRequest, phase, context), protected_effect_count: ['PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'COLD_START_DISCORD_KODAMA'].includes(phase) ? 1 : 0 }
      : { completed: false, evidence: null, protected_effect_count: 0 }
  }

  async buildReceipt(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    _state: Readonly<FleetRuntimeLocalOperationState>,
  ): Promise<FleetRuntimeEffectReceipt> {
    return receiptFor(request as FleetRuntimeRequest, preflight as FleetRuntimePreflightReceipt)
  }
}

class BlockingProtectedFixtureSystem extends FixtureSystem {
  protectedActive = 0
  maxProtectedActive = 0
  private release: () => void = () => {}
  readonly entered: Promise<void>
  private signalEntered: () => void = () => {}
  private readonly released: Promise<void>

  constructor() {
    super()
    this.entered = new Promise<void>(resolve => { this.signalEntered = resolve })
    this.released = new Promise<void>(resolve => { this.release = resolve })
  }

  unblock(): void { this.release() }

  override async performPhase(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalPhaseResult> {
    if (phase === 'PUSH_NORMAL_BRANCH') {
      this.protectedActive += 1
      this.maxProtectedActive = Math.max(this.maxProtectedActive, this.protectedActive)
      this.signalEntered()
      await this.released
      this.protectedActive -= 1
    }
    return super.performPhase(request, preflight, phase, context)
  }
}

class PersistedConcreteReconcileFixtureSystem extends FixtureSystem {
  private readonly concrete: ConcreteFleetRuntimeV1LocalSystem

  constructor(readonly targetPhase: FleetRuntimeLocalPhase, runner: FleetRuntimeArgvRunner) {
    super()
    this.interruptOnceAt = targetPhase
    this.concrete = new ConcreteFleetRuntimeV1LocalSystem(runner)
  }

  override async reconcilePhase(
    request: Readonly<FleetRuntimeRequest>,
    preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalReconcileResult> {
    if (phase === this.targetPhase) return this.concrete.reconcilePhase(request, preflight, phase, context)
    return super.reconcilePhase(request, preflight, phase, context)
  }
}

async function expectProviderCode(action: () => Promise<unknown> | unknown, code: FleetRuntimeLocalProviderError['code']): Promise<void> {
  try {
    await action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(FleetRuntimeLocalProviderError)
    expect((error as FleetRuntimeLocalProviderError).code).toBe(code)
  }
}

describe('FLEET_RUNTIME_V1 concrete local provider', () => {
  test('binds the regenerated payload fixture and preserves the three immutable release artifacts', () => {
    const fixture = JSON.parse(readFileSync(join(
      resolveRepo(),
      'tests/contract/fixtures/fleet-runtime-v1/payload-pin-bump-20260819.json',
    ), 'utf8'))

    expect(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref).toBe(fixture.source.amendment_merge_commit)
    expect(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree).toBe(fixture.source.amendment_merge_tree)
    expect({
      path: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_path,
      content_sha256: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_content_sha256,
      git_blob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_blob,
    }).toEqual(fixture.source.renderer)
    expect({
      path: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_path,
      content_sha256: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_sha256,
      git_blob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_blob,
    }).toEqual(fixture.source.workflow_template)
    expect(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.previous_payload_digest).toBe(fixture.previous_tuple.payload_records_sha256)
    expect(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.effective_payload_digest).toBe(fixture.effective_tuple.payload_records_sha256)
    expect(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.effective_path_manifest_sha256).toBe(fixture.effective_tuple.path_manifest_sha256)
    expect(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.amendment_sha256).toBe(fixture.effective_tuple.amendment_sha256)
    expect(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.amendment_byte_sha256).toBe(fixture.effective_tuple.amendment_byte_sha256)
    expect(FLEET_RUNTIME_V1_PAYLOAD_MANIFEST_FILES[0]).toEqual(fixture.modified_file)
    expect(digest(FLEET_RUNTIME_V1_PAYLOAD_MANIFEST_FILES)).toBe(fixture.effective_tuple.payload_records_sha256)
    expect(rawDigest(`${FIXTURE_PAYLOAD_PATHS.join('\n')}\n`)).toBe(fixture.effective_tuple.path_manifest_sha256)
    expect(Object.fromEntries(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.original_immutable_artifacts.map(artifact => [artifact.path, artifact.byte_sha256])))
      .toEqual(fixture.original_immutable_artifact_byte_sha256)
  })

  test('default deny is deterministic and does not create state', async () => {
    const root = temporary('frv1-default-deny')
    const state = join(root, 'state-not-created')
    const request = requestFor()
    const system = new FixtureSystem()
    const first = await executeLocalFleetRuntimeV1({ request, stateDirectory: state, executeProtectedEffects: false, system })
    const second = buildFleetRuntimeV1DryRunReceipt(request)

    expect(first).toEqual(second)
    expect(first).toMatchObject({ effect_started: false, protected_effect_count: 0, filesystem_write_count: 0 })
    expect(system.inspectCount).toBe(0)
    expect(existsSync(state)).toBe(false)
  })

  test('CLI help names the exact command and protected flag', () => {
    const result = Bun.spawnSync([process.execPath, 'scripts/fleet-runtime-v1-execute.ts', '--help'], { cwd: resolveRepo() })
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain('--request <ABSOLUTE_REQUEST_JSON> --state-dir <ABSOLUTE_STATE_DIR> --format json')
    expect(output).toContain('--execute-protected-effects')
  })

  test('CLI dry-run emits a typed block and leaves the supplied state path absent', () => {
    const root = temporary('frv1-cli-dry')
    const requestPath = join(root, 'request.json')
    const statePath = join(root, 'state')
    writeFileSync(requestPath, `${JSON.stringify(requestFor())}\n`)
    const result = Bun.spawnSync([
      process.execPath, 'scripts/fleet-runtime-v1-execute.ts', '--request', requestPath,
      '--state-dir', statePath, '--format', 'json',
    ], { cwd: resolveRepo() })
    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ code: 'PROTECTED_EFFECTS_DISABLED', protected_effect_count: 0 })
    expect(existsSync(statePath)).toBe(false)
  })

  test('frozen Kodama tree derives the exact runtime and distribution surfaces including tree entries', async () => {
    const fixturePath = join(
      resolveRepo(),
      'tests/fixtures/fleet-runtime-v1/kodama-tree-47d992a5c709cf65ef15f4aab5e60887be1aa45a.json',
    )
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      truncated: boolean
      tree: Array<{ path: string; mode: string; type: string; size: number | null; sha: string }>
    }
    expect(fixture.tree).toHaveLength(63)
    expect(fixture.tree.filter(entry => entry.type === 'tree')).toHaveLength(8)

    const request = requestFor()
    const calls: string[] = []
    const runner: FleetRuntimeArgvRunner = {
      async run(argv) {
        const path = argv[2]
        calls.push(path)
        if (path === 'repos/watchout/kodama/git/ref/heads/main') {
          return { exitCode: 0, stdout: JSON.stringify({ object: { sha: request.preimages[0].head_commit } }), stderr: '' }
        }
        if (path === `repos/watchout/kodama/git/commits/${request.preimages[0].head_commit}`) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ sha: request.preimages[0].head_commit, tree: { sha: request.preimages[0].tree } }),
            stderr: '',
          }
        }
        if (path === `repos/watchout/kodama/git/trees/${request.preimages[0].tree}?recursive=1`) {
          return { exitCode: 0, stdout: JSON.stringify(fixture), stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected gh path ${path}` }
      },
    }
    const system = new ConcreteFleetRuntimeV1LocalSystem(runner)
    expect(await (system as any).remotePreimage(request)).toEqual(request.preimages[0])
    expect(calls).toEqual([
      'repos/watchout/kodama/git/ref/heads/main',
      `repos/watchout/kodama/git/commits/${request.preimages[0].head_commit}`,
      `repos/watchout/kodama/git/trees/${request.preimages[0].tree}?recursive=1`,
    ])
  })

  test('root-goal preflight verifies only the exact released ADF image before the immutable goal argv', async () => {
    const canonicalDirtyRoot = '/Users/yuji/Developer/ai-dev-framework'
    const calls: Array<{ argv: string[]; cwd?: string }> = []
    const blocked = `${JSON.stringify(officialBlockedRootGoalStatus(), null, 2)}\n`
    const exact: FleetRuntimeAdfReleaseReadback = {
      root: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root,
      root_realpath: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root,
      root_is_directory: true,
      root_is_symlink: false,
      remote: 'https://github.com/watchout/ai-dev-framework.git',
      head: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.head,
      tree: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.tree,
      status_porcelain: '',
      branch: '',
      source_sha256: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.source_sha256,
      dist_sha256: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.dist_sha256,
    }
    let releaseReadbackCount = 0
    const runner: FleetRuntimeArgvRunner = {
      async run(argv, options) {
        calls.push({ argv: [...argv], cwd: options?.cwd })
        const command = argv.join(' ')
        if (canonicalFleetRuntimeJson(argv) === canonicalFleetRuntimeJson([
          'node', 'dist/cli/index.js', 'goal-runtime', 'status', '--store',
          '/Users/yuji/Developer/kodama/.framework/runtime/goal-convergence.json', '--format', 'json',
        ])) return { exitCode: 1, stdout: blocked, stderr: '' }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` }
      },
    }
    const system = new ConcreteFleetRuntimeV1LocalSystem(
      runner,
      resolveRepo(),
      Date.now,
      async (_runner, root) => {
        releaseReadbackCount += 1
        expect(root).toBe(FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root)
        return exact
      },
    )
    expect(await system.readAdfRootGoalStatus()).toBe(blocked)
    expect(releaseReadbackCount).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls.every(call => call.cwd === FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root)).toBe(true)
    expect(calls.some(call => call.cwd === canonicalDirtyRoot)).toBe(false)
    expect(calls.at(-1)!.argv).toEqual([
      'node', 'dist/cli/index.js', 'goal-runtime', 'status', '--store',
      '/Users/yuji/Developer/kodama/.framework/runtime/goal-convergence.json', '--format', 'json',
    ])

    const mutations: Array<[string, (value: FleetRuntimeAdfReleaseReadback) => void]> = [
      ['wrong path', value => {
        value.root = canonicalDirtyRoot
        value.root_realpath = canonicalDirtyRoot
      }],
      ['symlink root', value => { value.root_is_symlink = true }],
      ['wrong origin', value => { value.remote = 'https://github.com/watchout/not-ai-dev-framework.git' }],
      ['attached branch', value => { value.branch = 'main' }],
      ['wrong head', value => { value.head = 'c'.repeat(40) }],
      ['wrong tree', value => { value.tree = 'd'.repeat(40) }],
      ['dirty checkout', value => { value.status_porcelain = ' M src/cli/commands/goal-runtime.ts' }],
      ['wrong source digest', value => { value.source_sha256 = '0'.repeat(64) }],
      ['wrong dist digest', value => { value.dist_sha256 = '0'.repeat(64) }],
    ]
    for (const [label, mutate] of mutations) {
      const observed = structuredClone(exact)
      mutate(observed)
      const rejectedCalls: Array<{ argv: string[]; cwd?: string }> = []
      const rejectedRunner: FleetRuntimeArgvRunner = {
        async run(argv, options) {
          rejectedCalls.push({ argv: [...argv], cwd: options?.cwd })
          return { exitCode: 0, stdout: blocked, stderr: '' }
        },
      }
      const rejected = new ConcreteFleetRuntimeV1LocalSystem(
        rejectedRunner,
        resolveRepo(),
        Date.now,
        async (_runner, root) => {
          expect(root, label).toBe(FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root)
          return observed
        },
      )
      await expectProviderCode(() => rejected.readAdfRootGoalStatus(), 'READBACK_INVALID')
      expect(rejectedCalls, `${label} reached the goal command`).toHaveLength(0)
      expect(rejectedCalls.some(call => call.cwd === canonicalDirtyRoot)).toBe(false)
    }

    let changedReadbackCount = 0
    const changedCalls: string[][] = []
    const changedBetweenReads = new ConcreteFleetRuntimeV1LocalSystem(
      { async run(argv) {
        changedCalls.push([...argv])
        return { exitCode: 1, stdout: blocked, stderr: '' }
      } },
      resolveRepo(),
      Date.now,
      async () => {
        changedReadbackCount += 1
        return changedReadbackCount === 1
          ? structuredClone(exact)
          : { ...structuredClone(exact), remote: 'git@github.com:watchout/ai-dev-framework.git' }
      },
    )
    await expectProviderCode(() => changedBetweenReads.readAdfRootGoalStatus(), 'READBACK_INVALID')
    expect(changedReadbackCount).toBe(2)
    expect(changedCalls).toHaveLength(0)
  })

  test('root-goal command admits only exit-coupled complete official read-only reports', async () => {
    const exactRelease: FleetRuntimeAdfReleaseReadback = {
      root: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root,
      root_realpath: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.root,
      root_is_directory: true,
      root_is_symlink: false,
      remote: 'https://github.com/watchout/ai-dev-framework.git',
      head: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.head,
      tree: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.tree,
      status_porcelain: '',
      branch: '',
      source_sha256: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.source_sha256,
      dist_sha256: FLEET_RUNTIME_V1_ADF_READBACK_RELEASE.dist_sha256,
    }
    const invoke = async (result: { exitCode: number; stdout: string; stderr: string }) => {
      let goalInvocationCount = 0
      let identityReadbackCount = 0
      const system = new ConcreteFleetRuntimeV1LocalSystem(
        { async run() {
          goalInvocationCount += 1
          return result
        } },
        resolveRepo(),
        Date.now,
        async () => {
          identityReadbackCount += 1
          return structuredClone(exactRelease)
        },
      )
      return { system, counts: () => ({ goalInvocationCount, identityReadbackCount }) }
    }
    const blocked = `${JSON.stringify(officialBlockedRootGoalStatus(), null, 2)}\n`
    const pass = `${JSON.stringify(officialPassRootGoalStatus(), null, 2)}\n`
    const admittedBlocked = await invoke({ exitCode: 1, stdout: blocked, stderr: '' })
    expect(await admittedBlocked.system.readAdfRootGoalStatus()).toBe(blocked)
    expect(admittedBlocked.counts()).toEqual({ goalInvocationCount: 1, identityReadbackCount: 2 })
    const admittedPass = await invoke({ exitCode: 0, stdout: pass, stderr: '' })
    expect(await admittedPass.system.readAdfRootGoalStatus()).toBe(pass)
    expect(admittedPass.counts()).toEqual({ goalInvocationCount: 1, identityReadbackCount: 2 })

    const withExtra = officialBlockedRootGoalStatus()
    withExtra.extra = true
    const missing = officialBlockedRootGoalStatus()
    delete missing.checkpoint
    const nonzeroCounter = officialBlockedRootGoalStatus()
    ;(nonzeroCounter.counters as Record<string, unknown>).state_mutations = 1
    const wrongPath = { ...officialBlockedRootGoalStatus(), store_path: '/tmp/foreign.json' }
    const wrongSchema = { ...officialBlockedRootGoalStatus(), schema: 'aun.goal-runtime.v1' }
    const crossField = { ...officialBlockedRootGoalStatus(), store_code: 'FOUND' }
    const legacyPassCode = { ...officialPassRootGoalStatus(), store_code: 'FOUND' }
    const cases: Array<[string, { exitCode: number; stdout: string; stderr: string }]> = [
      ['arbitrary nonzero exit', { exitCode: 2, stdout: blocked, stderr: '' }],
      ['malformed stdout', { exitCode: 1, stdout: '{', stderr: '' }],
      ['unexpected stderr', { exitCode: 1, stdout: blocked, stderr: 'unexpected warning' }],
      ['blocked report with zero exit', { exitCode: 0, stdout: blocked, stderr: '' }],
      ['pass report with exit one', { exitCode: 1, stdout: pass, stderr: '' }],
      ['extra field', { exitCode: 1, stdout: JSON.stringify(withExtra), stderr: '' }],
      ['missing field', { exitCode: 1, stdout: JSON.stringify(missing), stderr: '' }],
      ['nonzero counter', { exitCode: 1, stdout: JSON.stringify(nonzeroCounter), stderr: '' }],
      ['wrong store path', { exitCode: 1, stdout: JSON.stringify(wrongPath), stderr: '' }],
      ['forbidden schema alias', { exitCode: 1, stdout: JSON.stringify(wrongSchema), stderr: '' }],
      ['inconsistent report fields', { exitCode: 1, stdout: JSON.stringify(crossField), stderr: '' }],
      ['legacy pass store code', { exitCode: 0, stdout: JSON.stringify(legacyPassCode), stderr: '' }],
    ]
    for (const [label, result] of cases) {
      const rejected = await invoke(result)
      await expectProviderCode(() => rejected.system.readAdfRootGoalStatus(), 'READBACK_INVALID')
      expect(rejected.counts(), label).toEqual({ goalInvocationCount: 1, identityReadbackCount: 2 })
    }
  })

  test('one official observation command receives the locator only through child environment', async () => {
    const secretSentinel = ['N40', 'LOCATOR', 'SECRET', 'SENTINEL'].join('_')
    const locator = ['postgresql:', '/', '/', 'fixture.invalid', '/', 'agent_comms', '?sentinel=', secretSentinel].join('')
    const observed = queueObservation('2026-08-15T08:23:59.000Z')
    const calls: Array<{ argv: readonly string[]; options?: { cwd?: string; env?: Record<string, string> } }> = []
    const runner: FleetRuntimeArgvRunner = {
      async run(argv, options) {
        calls.push({ argv, options })
        return { exitCode: 0, stdout: `${canonicalFleetRuntimeObservationJson(observed)}\n`, stderr: '' }
      },
    }
    const system = new ConcreteFleetRuntimeV1LocalSystem(
      runner,
      resolveRepo(),
      () => Date.parse('2026-08-15T08:24:00.000Z'),
      async () => { throw new Error('unused') },
      locator,
    )
    const readback = await (system as any).queueObservation()
    expect(readback.queue.queue_observation_id).toBe(observed.queue.queue_observation_id)
    expect(calls).toHaveLength(1)
    expect(calls[0].argv).toEqual([
      process.execPath, 'cli/index.ts', 'fleet-runtime', 'queue-observation', '--format', 'json',
    ])
    expect(calls[0].argv.join(' ')).not.toContain(locator)
    expect(calls[0].options?.env?.DATABASE_URL).toBe(locator)
    expect(calls[0].options?.env?.AGENT_COM_DB).toBe('postgres')
    expect(canonicalFleetRuntimeObservationJson(readback)).not.toContain(secretSentinel)
  })

  test.each(['CANARY_COLD_START', 'ROLLBACK', 'RECOVERY', 'REAPPLY'] as const)(
    '%s completes its exact journal and produces an adapter-valid receipt',
    async operation => {
      const system = new FixtureSystem()
      const stateDirectory = join(temporary(`frv1-${operation}`), 'state')
      const receipt = await executeLocalFleetRuntimeV1(protectedFixtureInput({
        request: requestFor(operation),
        stateDirectory,
        executeProtectedEffects: true,
        system,
        now: () => '2026-08-15T08:30:00Z',
      }))
      expect(receipt.schema_version).not.toBe('fleet-runtime-v1/typed-block-receipt/v1')
      expect(receipt.operation).toBe(operation)
      expect(receipt.duplicate_effect_count).toBe(0)
      expect(receipt.unauthorized_effect_count).toBe(0)
    },
  )

  test('same request replays the durable receipt without repeating a subeffect', async () => {
    const stateDirectory = join(temporary('frv1-replay'), 'state')
    const request = requestFor()
    const system = new FixtureSystem()
    const first = await executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))
    const calls = [...system.calls.entries()]
    const second = await executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))
    expect(second).toEqual(first)
    expect([...system.calls.entries()]).toEqual(calls)
    expect(system.inspectCount).toBe(1)
    expect(system.inspectModes).toEqual(['SEALED_START'])
  })

  test('same key with another request digest is an atomic collision', async () => {
    const stateDirectory = join(temporary('frv1-collision'), 'state')
    const store = new FileFleetRuntimeV1Persistence(stateDirectory, { approvedRoot: stateDirectory })
    const key = `frv1:N40:${'1'.repeat(64)}`
    const first: FleetRuntimeInvocationState = { idempotency_key: key, request_digest: SHA_A, status: 'reserved', receipt: null }
    const second: FleetRuntimeInvocationState = { ...first, request_digest: SHA_B }
    expect((await store.reserve_once(first)).acquired).toBe(true)
    await expectProviderCode(() => store.reserve_once(second), 'STATE_COLLISION')
  })

  test('a missing external merge receipt resumes with a fresh observation after the sealed observation expires', async () => {
    const stateDirectory = join(temporary('frv1-merge-wait'), 'state')
    const request = requestFor()
    const system = new FixtureSystem()
    system.mergeAvailable = false
    await expectProviderCode(
      () => executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system })),
      'WAITING_INDEPENDENT_MERGE',
    )
    expect(system.calls.get('CREATE_DRAFT_PR')).toBe(1)
    expect(system.calls.has('COLD_START_DISCORD_KODAMA')).toBe(false)
    system.resumeObservedAt = '2026-08-15T08:40:00.000Z'
    system.mergeAvailable = true
    const receipt = await executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))
    expect(receipt.operation).toBe('CANARY_COLD_START')
    expect(system.calls.get('CREATE_DRAFT_PR')).toBe(1)
    expect(system.inspectModes).toEqual(['SEALED_START', 'DURABLE_RESUME'])
  })

  test('durable resume consumes a canonical handoff binding against the read-only pushed journal head', async () => {
    const stateDirectory = join(temporary('frv1-resume-admission-binding'), 'state')
    const request = requestFor()
    const system = new FixtureSystem()
    system.mergeAvailable = false
    await expectProviderCode(
      () => executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system })),
      'WAITING_INDEPENDENT_MERGE',
    )
    const persistence = new FileFleetRuntimeV1Persistence(stateDirectory, { approvedRoot: stateDirectory })
    const durableRemoteHead = persistence.readDurableResumeRemoteHead(request)
    const admitted = structuredClone(request.queue_observation)
    admitted.observed_at = '2026-08-19T13:04:00.000Z'
    admitted.queue.revision = '357'
    admitted.kodama_registry.status = 'busy'
    refreshQueueObservationId(admitted)
    const handoff = resumeAdmissionControlHandoffFixture(request, durableRemoteHead, admitted)
    const binding = parseFleetRuntimeResumeAdmissionBinding(
      request,
      durableRemoteHead,
      handoff.ref,
      handoff.readback,
    )
    system.resumeObservation = admitted
    system.resumeAdmissionBinding = binding
    system.mergeAvailable = true

    const receipt = await executeLocalFleetRuntimeV1(protectedFixtureInput({
      request,
      stateDirectory,
      executeProtectedEffects: true,
      system,
      resumeAdmissionControlHandoff: handoff.ref,
    }))

    expect(receipt.operation).toBe('CANARY_COLD_START')
    expect(system.lastResumeControlHandoff).toEqual(handoff.ref)
    expect(system.lastDurableRemoteHead).toBe(durableRemoteHead)
    expect(system.calls.get('PUSH_NORMAL_BRANCH')).toBe(1)
    expect(system.calls.get('CREATE_DRAFT_PR')).toBe(1)

    await expectProviderCode(
      () => Promise.resolve(parseFleetRuntimeResumeAdmissionBinding(
        request,
        '8'.repeat(40),
        handoff.ref,
        handoff.readback,
      )),
      'READBACK_INVALID',
    )
    await expectProviderCode(
      () => Promise.resolve(parseFleetRuntimeResumeAdmissionBinding(
        request,
        durableRemoteHead,
        handoff.ref,
        { ...handoff.readback, updated_at: '2026-08-19T13:03:37Z' },
      )),
      'READBACK_INVALID',
    )
  })

  test.each(['PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'COLD_START_DISCORD_KODAMA'] as const)(
    'interruption at protected %s reconciles without repeating the subeffect',
    async phase => {
      const request = requestFor()
      const stateDirectory = join(temporary(`frv1-interrupt-${phase}`), 'state')
      const system = new FixtureSystem()
      system.interruptOnceAt = phase
      await expect(executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))).rejects.toThrow('fixture interruption')
      const receipt = await executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))
      expect(receipt.operation).toBe('CANARY_COLD_START')
      expect(system.calls.get(phase)).toBe(1)
    },
  )

  test('unresolved interrupted subeffect fails closed and is not repeated', async () => {
    const request = requestFor()
    const stateDirectory = join(temporary('frv1-unresolved'), 'state')
    const system = new FixtureSystem()
    system.interruptOnceAt = 'CREATE_LOCAL_COMMIT'
    await expect(executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))).rejects.toThrow()
    system.reconcileInterrupted = false
    await expectProviderCode(
      () => executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system })),
      'INTERRUPTED_SUBEFFECT_UNRESOLVED',
    )
    expect(system.calls.get('CREATE_LOCAL_COMMIT')).toBe(1)
  })

  test('journal rejects malformed phase sets, intent/evidence digests, and protected counts', async () => {
    const mutations: Array<(state: FleetRuntimeLocalOperationState) => void> = [
      state => { state.phases.PREPARE_CLEAN_CHECKOUT!.intent_sha256 = SHA_B },
      state => { state.phases.PREPARE_CLEAN_CHECKOUT!.evidence_sha256 = SHA_B },
      state => { state.phases.PUSH_NORMAL_BRANCH!.protected_effect_count = 0 },
      state => { delete state.phases.PREPARE_CLEAN_CHECKOUT },
      state => {
        state.phases.VERIFY_EXACT_PREIMAGE = {
          status: 'started', started_at: '2026-08-15T08:30:00Z', completed_at: null, evidence: null,
          intent: {}, protected_effect_count: 0, intent_sha256: digest({}), evidence_sha256: null,
        }
      },
    ]
    for (const [index, mutate] of mutations.entries()) {
      const request = requestFor()
      const stateDirectory = join(temporary(`frv1-journal-tamper-${index}`), 'state')
      const system = new FixtureSystem()
      system.interruptOnceAt = 'CREATE_DRAFT_PR'
      await expect(executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))).rejects.toThrow('fixture interruption')
      const path = join(stateDirectory, 'invocations', request.idempotency_key, 'operation-state.json')
      const state = JSON.parse(readFileSync(path, 'utf8')) as FleetRuntimeLocalOperationState
      mutate(state)
      writeFileSync(path, `${canonicalFleetRuntimeJson(state)}\n`)
      await expectProviderCode(
        () => executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system })),
        'STATE_RECORD_INVALID',
      )
    }
  })

  test('wrong executor, preimage drift, and nonzero queue fail before state or effect', async () => {
    const cases: FleetRuntimeRequest[] = []
    const wrongActor = requestFor()
    wrongActor.executor_identity.actor_agent_id = 'not-the-executor'
    cases.push(wrongActor)
    const preimage = requestFor()
    preimage.preimages[0].tree = 'f'.repeat(40)
    resign(preimage)
    cases.push(preimage)
    const queue = requestFor()
    queue.queue_observation.queue.pending_count = 1
    resign(queue)
    cases.push(queue)

    for (const [index, request] of cases.entries()) {
      const state = join(temporary(`frv1-reject-${index}`), 'state')
      const system = new FixtureSystem()
      await expect(executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory: state, executeProtectedEffects: true, system }))).rejects.toThrow()
      expect(existsSync(state)).toBe(false)
      expect(system.calls.size).toBe(0)
    }
  })

  test('canonical, dirty, wrong-repository, and outside-state checkouts are rejected', () => {
    const exact = {
      checkout_path: '/safe/state/invocations/key/checkout',
      state_directory: '/safe/state',
      canonical_path: '/Users/yuji/Developer/kodama',
      remote: 'https://github.com/watchout/kodama.git',
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      status_porcelain: '',
      branch: '',
    }
    expect(() => validateFleetRuntimeCheckoutReadback(exact)).not.toThrow()
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, checkout_path: exact.canonical_path })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, status_porcelain: ' M AGENTS.md' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, remote: 'https://github.com/watchout/other.git' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, checkout_path: '/outside/checkout' })).toThrow('STATE_DIRECTORY_INVALID')
  })

  test('symlink state directory is rejected before reservation', () => {
    const root = temporary('frv1-symlink')
    const target = join(root, 'real')
    const link = join(root, 'link')
    Bun.spawnSync(['mkdir', '-p', target])
    symlinkSync(target, link)
    expect(() => new FileFleetRuntimeV1Persistence(link, { approvedRoot: link })).toThrow('STATE_DIRECTORY_INVALID')
  })

  test('two concrete persistence instances admit exactly one live execution owner', async () => {
    const stateDirectory = join(temporary('frv1-concurrent-owner'), 'state')
    const first = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'owner-a', ownerAlive: () => true,
    })
    const second = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'owner-b', ownerAlive: () => true,
    })
    const state: FleetRuntimeInvocationState = {
      idempotency_key: `frv1:N40:${'2'.repeat(64)}`, request_digest: SHA_A, status: 'reserved', receipt: null,
    }
    const results = await Promise.allSettled([first.reserve_once(state), second.reserve_once(state)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const blocked = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(blocked.reason).toMatchObject({ code: 'IN_FLIGHT' })
  })

  test('two independent child processes admit one reservation and one simulated protected marker', async () => {
    const stateDirectory = join(temporary('frv1-child-owner'), 'state')
    const marker = join(temporary('frv1-child-marker'), 'marker')
    const modulePath = join(resolveRepo(), 'core/fleet-runtime-v1-local-provider.ts')
    const key = `frv1:N40:${'8'.repeat(64)}`
    const program = `
      import { writeFileSync } from 'node:fs';
      import { FileFleetRuntimeV1Persistence } from ${JSON.stringify(modulePath)};
      const [stateDirectory, key, marker] = process.argv.slice(1);
      const store = new FileFleetRuntimeV1Persistence(stateDirectory, { approvedRoot: stateDirectory });
      try {
        const result = await store.reserve_once({ idempotency_key: key, request_digest: ${JSON.stringify(SHA_A)}, status: 'reserved', receipt: null });
        if (result.acquired) { writeFileSync(marker, String(process.pid), { flag: 'wx' }); await Bun.sleep(250); console.log('ACQUIRED'); }
      } catch (error) { console.log(error.code ?? 'ERROR'); }
    `
    const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', program, '--', stateDirectory, key, marker], { stdout: 'pipe', stderr: 'pipe' }))
    const outputs = await Promise.all(children.map(async child => ({
      stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), exit: await child.exited,
    })))
    expect(outputs.every(output => output.exit === 0), JSON.stringify(outputs)).toBe(true)
    expect(outputs.filter(output => output.stdout.includes('ACQUIRED'))).toHaveLength(1)
    expect(outputs.filter(output => output.stdout.includes('IN_FLIGHT'))).toHaveLength(1)
    expect(readFileSync(marker, 'utf8')).toMatch(/^[1-9][0-9]*$/)
  })

  test.each(['heartbeat', 'journal', 'completion'] as const)(
    'a real displaced child process cannot perform fenced %s mutation after stale takeover',
    async mode => {
      const root = temporary(`frv1-displaced-${mode}`)
      const stateDirectory = join(root, 'state')
      const ready = join(root, 'ready')
      const proceed = join(root, 'proceed')
      const modulePath = join(resolveRepo(), 'core/fleet-runtime-v1-local-provider.ts')
      const key = `frv1:N40:${createHash('sha256').update(mode).digest('hex')}`
      const program = `
        import { existsSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { FileFleetRuntimeV1Persistence } from ${JSON.stringify(modulePath)};
        const [stateDirectory, key, ready, proceed, mode] = process.argv.slice(1);
        const store = new FileFleetRuntimeV1Persistence(stateDirectory, {
          approvedRoot: stateDirectory, ownerId: 'displaced-child', staleAfterMs: 1,
        });
        await store.reserve_once({ idempotency_key: key, request_digest: ${JSON.stringify(SHA_A)}, status: 'reserved', receipt: null });
        writeFileSync(ready, 'ready', { flag: 'wx' });
        while (!existsSync(proceed)) await Bun.sleep(5);
        try {
          if (mode === 'heartbeat') await store.heartbeatOwner(key);
          if (mode === 'journal') store.commitOwnedRecord(key, join(stateDirectory, 'invocations', key, 'operation-state.json'), 'operation state', null, { owner: 'displaced-child' });
          if (mode === 'completion') await store.complete_once({ idempotency_key: key, request_digest: ${JSON.stringify(SHA_A)}, status: 'completed', receipt: { result: 'PASS' } });
          console.log('UNEXPECTED_SUCCESS');
        } catch (error) { console.log(error.code ?? 'ERROR'); }
      `
      const child = Bun.spawn([process.execPath, '-e', program, '--', stateDirectory, key, ready, proceed, mode], {
        stdout: 'pipe', stderr: 'pipe',
      })
      for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) await Bun.sleep(5)
      expect(existsSync(ready)).toBe(true)
      const takeover = new FileFleetRuntimeV1Persistence(stateDirectory, {
        approvedRoot: stateDirectory,
        ownerId: 'takeover-parent',
        nowMs: () => Date.now() + 120_000,
        staleAfterMs: 1,
        ownerAlive: () => false,
      })
      expect((await takeover.reserve_once({
        idempotency_key: key, request_digest: SHA_A, status: 'reserved', receipt: null,
      })).acquired).toBe(true)
      writeFileSync(proceed, 'go', { flag: 'wx' })
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited, stderr).toBe(0)
      expect(stdout.trim()).toBe('IN_FLIGHT')
      const durable = await takeover.load(key) as FleetRuntimeInvocationState & { execution_owner: { owner_id: string } }
      expect(durable.execution_owner.owner_id).toBe('takeover-parent')
      expect(existsSync(join(stateDirectory, 'invocations', key, 'operation-state.json'))).toBe(false)
      expect(existsSync(join(stateDirectory, 'invocations', key, 'completed.json'))).toBe(false)
    },
  )

  test('two real provider calls never overlap a protected phase for the same invocation', async () => {
    const stateDirectory = join(temporary('frv1-concurrent-provider'), 'state')
    const request = requestFor()
    const system = new BlockingProtectedFixtureSystem()
    const first = executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))
    await system.entered
    await expectProviderCode(
      () => executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system })),
      'IN_FLIGHT',
    )
    system.unblock()
    await first
    expect(system.maxProtectedActive).toBe(1)
    expect(system.calls.get('PUSH_NORMAL_BRANCH')).toBe(1)
  })

  test('a live owner is never stolen and a stale dead owner is atomically replaced', async () => {
    const stateDirectory = join(temporary('frv1-takeover'), 'state')
    let now = Date.parse('2026-08-15T08:00:00Z')
    const state: FleetRuntimeInvocationState = {
      idempotency_key: `frv1:N40:${'3'.repeat(64)}`, request_digest: SHA_A, status: 'reserved', receipt: null,
    }
    const first = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'owner-live', nowMs: () => now, ownerAlive: () => true, staleAfterMs: 1_000,
    })
    await first.reserve_once(state)
    now += 5_000
    const liveContender = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'owner-blocked', nowMs: () => now, ownerAlive: () => true, staleAfterMs: 1_000,
    })
    await expectProviderCode(() => liveContender.reserve_once(state), 'IN_FLIGHT')
    const takeover = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'owner-takeover', nowMs: () => now, ownerAlive: () => false, staleAfterMs: 1_000,
    })
    expect((await takeover.reserve_once(state)).acquired).toBe(true)
    expect(((await takeover.load(state.idempotency_key)) as FleetRuntimeInvocationState & { execution_owner: { owner_id: string } }).execution_owner.owner_id).toBe('owner-takeover')
    await expectProviderCode(() => first.complete_once({ ...state, status: 'completed', receipt: receiptFor(requestFor(), preflightFor(requestFor())) }), 'IN_FLIGHT')
  })

  test('a stale dead takeover lock is reclaimed without stealing a live lock', async () => {
    const stateDirectory = join(temporary('frv1-stale-takeover-lock'), 'state')
    let now = Date.parse('2026-08-15T08:00:00Z')
    const state: FleetRuntimeInvocationState = {
      idempotency_key: `frv1:N40:${'7'.repeat(64)}`, request_digest: SHA_A, status: 'reserved', receipt: null,
    }
    const original = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'dead-original', nowMs: () => now, ownerAlive: () => false, staleAfterMs: 1_000,
    })
    await original.reserve_once(state)
    const lock = join(stateDirectory, 'invocations', state.idempotency_key, 'owner-write.lock')
    mkdirSync(lock, { mode: 0o700 })
    writeFileSync(join(lock, 'owner.json'), `${canonicalFleetRuntimeJson({
      lock_token: '00000000-0000-4000-8000-000000000007',
      execution_owner: { ...original.owner, owner_id: 'dead-lock-owner' },
    })}\n`)
    now += 5_000
    const contender = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'new-owner', nowMs: () => now, ownerAlive: () => false, staleAfterMs: 1_000,
    })
    expect((await contender.reserve_once(state)).acquired).toBe(true)
  })

  test('barrier-controlled real processes atomically retire one stale lock generation without deleting its successor', async () => {
    const root = temporary('frv1-dual-stale-reclaimer')
    const stateDirectory = join(root, 'state')
    const key = `frv1:N40:${'6'.repeat(64)}`
    const state: FleetRuntimeInvocationState = {
      idempotency_key: key, request_digest: SHA_A, status: 'reserved', receipt: null,
    }
    const staleNow = Date.parse('2026-08-15T08:00:00Z')
    const displaced = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'displaced-original', nowMs: () => staleNow,
    })
    await displaced.reserve_once(state)
    const invocation = join(stateDirectory, 'invocations', key)
    const lock = join(invocation, 'owner-write.lock')
    const staleToken = '00000000-0000-4000-8000-000000000006'
    mkdirSync(lock, { mode: 0o700 })
    writeFileSync(join(lock, 'owner.json'), `${canonicalFleetRuntimeJson({
      lock_token: staleToken,
      execution_owner: { ...displaced.owner, owner_id: 'dead-lock-owner' },
    })}\n`)

    const barrier = join(root, 'release-reclaimers')
    const releaseCritical = join(root, 'release-critical')
    const criticalReady = join(root, 'critical-ready')
    const active = join(root, 'critical-active')
    const entrants = join(root, 'critical-entrants')
    const overlap = join(root, 'critical-overlap')
    const effect = join(root, 'simulated-effect')
    const duplicate = join(root, 'duplicate-effect')
    const modulePath = join(resolveRepo(), 'core/fleet-runtime-v1-local-provider.ts')
    const program = `
      import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
      import { FileFleetRuntimeV1Persistence } from ${JSON.stringify(modulePath)};
      const [stateDirectory, key, id, ready, barrier, releaseCritical, criticalReady, active, entrants, overlap, effect, duplicate, result] = process.argv.slice(1);
      const pause = path => { while (!existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); };
      let reservationChecks = 0;
      const store = new FileFleetRuntimeV1Persistence(stateDirectory, {
        approvedRoot: stateDirectory,
        ownerId: 'reclaimer-' + id,
        staleAfterMs: 1,
        ownerAlive: owner => {
          if (owner.owner_id === 'dead-lock-owner') {
            writeFileSync(ready, 'ready', { flag: 'wx' });
            pause(barrier);
            return false;
          }
          if (owner.owner_id === 'displaced-original') {
            reservationChecks += 1;
            if (reservationChecks > 1) {
              let ownsActive = false;
              try { writeFileSync(active, id, { flag: 'wx' }); ownsActive = true; }
              catch { appendFileSync(overlap, id + '\\n'); }
              appendFileSync(entrants, id + '\\n');
              try { writeFileSync(effect, id, { flag: 'wx' }); }
              catch { appendFileSync(duplicate, id + '\\n'); }
              writeFileSync(criticalReady, id, { flag: 'a' });
              pause(releaseCritical);
              if (ownsActive && existsSync(active)) unlinkSync(active);
            }
            return false;
          }
          return false;
        },
      });
      try {
        const acquired = await store.reserve_once({ idempotency_key: key, request_digest: ${JSON.stringify(SHA_A)}, status: 'reserved', receipt: null });
        writeFileSync(result, acquired.acquired ? 'ACQUIRED' : 'NOT_ACQUIRED', { flag: 'wx' });
        console.log(acquired.acquired ? 'ACQUIRED_' + id : 'NOT_ACQUIRED_' + id);
      } catch (error) {
        const code = error.code ?? 'ERROR';
        writeFileSync(result, code, { flag: 'wx' });
        console.log(code + '_' + id);
      }
    `
    const ids = ['a', 'b']
    const ready = ids.map(id => join(root, `ready-${id}`))
    const results = ids.map(id => join(root, `result-${id}`))
    const children = ids.map((id, index) => Bun.spawn([
      process.execPath, '-e', program, '--', stateDirectory, key, id, ready[index], barrier, releaseCritical,
      criticalReady, active, entrants, overlap, effect, duplicate, results[index],
    ], { stdout: 'pipe', stderr: 'pipe' }))
    for (let attempt = 0; attempt < 400 && ready.some(path => !existsSync(path)); attempt += 1) await Bun.sleep(5)
    expect(ready.every(existsSync)).toBe(true)
    writeFileSync(barrier, 'go', { flag: 'wx' })
    for (let attempt = 0; attempt < 400
      && (!existsSync(criticalReady) || !results.some(existsSync))
      && !existsSync(overlap); attempt += 1) await Bun.sleep(5)
    expect(existsSync(criticalReady)).toBe(true)
    expect(results.filter(existsSync)).toHaveLength(1)
    expect(readFileSync(results.find(existsSync)!, 'utf8')).toBe('IN_FLIGHT')
    expect(existsSync(overlap)).toBe(false)
    expect(existsSync(duplicate)).toBe(false)
    const successor = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as {
      lock_token: string
      execution_owner: { owner_id: string }
    }
    expect(successor.execution_owner.owner_id).toMatch(/^reclaimer-[ab]$/)
    expect(existsSync(join(invocation, `owner-write.lock.retired.${staleToken}`))).toBe(true)
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).lock_token).toBe(successor.lock_token)
    writeFileSync(releaseCritical, 'go', { flag: 'wx' })
    const outputs = await Promise.all(children.map(async child => ({
      stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), exit: await child.exited,
    })))
    expect(outputs.every(output => output.exit === 0), JSON.stringify(outputs)).toBe(true)
    expect(outputs.filter(output => output.stdout.includes('ACQUIRED_'))).toHaveLength(1)
    expect(outputs.filter(output => output.stdout.includes('IN_FLIGHT_'))).toHaveLength(1)
    const entrantRows = readFileSync(entrants, 'utf8').trim().split('\n')
    const maxCriticalConcurrency = existsSync(overlap) ? 2 : entrantRows.length
    expect(maxCriticalConcurrency).toBe(1)
    expect(readFileSync(effect, 'utf8')).toMatch(/^[ab]$/)
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(join(invocation, `owner-write.lock.retired.${successor.lock_token}`))).toBe(true)

    await expectProviderCode(() => displaced.heartbeatOwner(key), 'IN_FLIGHT')
    await expectProviderCode(
      () => displaced.commitOwnedRecord(key, join(invocation, 'operation-state.json'), 'operation state', null, { owner: 'displaced' }),
      'IN_FLIGHT',
    )
    await expectProviderCode(
      () => displaced.complete_once({ ...state, status: 'completed', receipt: { result: 'PASS' } }),
      'IN_FLIGHT',
    )
    expect(existsSync(join(invocation, 'operation-state.json'))).toBe(false)
    expect(existsSync(join(invocation, 'completed.json'))).toBe(false)
  })

  test('an abandoned unpublished candidate and already-retired stale generation do not wedge takeover recovery', async () => {
    const stateDirectory = join(temporary('frv1-abandoned-lock-generation'), 'state')
    const key = `frv1:N40:${'5'.repeat(64)}`
    const state: FleetRuntimeInvocationState = {
      idempotency_key: key, request_digest: SHA_A, status: 'reserved', receipt: null,
    }
    const staleNow = Date.parse('2026-08-15T08:00:00Z')
    const original = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'abandoned-owner', nowMs: () => staleNow,
    })
    await original.reserve_once(state)
    const invocation = join(stateDirectory, 'invocations', key)
    const abandonedToken = '00000000-0000-4000-8000-000000000005'
    const retired = join(invocation, `owner-write.lock.retired.${abandonedToken}`)
    const candidate = join(invocation, '.owner-write.lock.abandoned.candidate')
    for (const directory of [retired, candidate]) {
      mkdirSync(directory, { mode: 0o700 })
      writeFileSync(join(directory, 'owner.json'), `${canonicalFleetRuntimeJson({
        lock_token: abandonedToken,
        execution_owner: { ...original.owner, owner_id: 'abandoned-reclaimer' },
      })}\n`)
    }
    const contender = new FileFleetRuntimeV1Persistence(stateDirectory, {
      approvedRoot: stateDirectory, ownerId: 'recovered-owner', nowMs: () => staleNow + 120_000,
      staleAfterMs: 1, ownerAlive: () => false,
    })
    expect((await contender.reserve_once(state)).acquired).toBe(true)
    const durable = await contender.load(key) as FleetRuntimeInvocationState & { execution_owner: { owner_id: string } }
    expect(durable.execution_owner.owner_id).toBe('recovered-owner')
    expect(existsSync(join(invocation, 'owner-write.lock'))).toBe(false)
    expect(existsSync(retired)).toBe(true)
    expect(existsSync(candidate)).toBe(true)
  })

  test('queue parsing requires an exact fresh v2 observation envelope', () => {
    const now = Date.parse('2026-08-15T08:24:00Z')
    const valid = queueObservation()
    expect(parseFleetRuntimeQueueStatus(valid, now).queue).toMatchObject({ pending_count: 0, received_count: 0, in_progress_count: 0 })
    const malformed: unknown[] = [
      { ...valid, observed_at: undefined },
      { ...valid, observed_at: '2026-08-15T07:00:00.000Z' },
      { ...valid, observed_at: 'not-a-timestamp' },
      { ...valid, observed_at: '2026-08-15T08:25:00.000Z' },
      { ...valid, schema_version: 'fleet-runtime-v1/observation/v1' },
      { ...valid, contract_revision: 1 },
      { ...valid, unknown: true },
      { ...valid, source: { ...valid.source, profile_binding_digest: SHA_A } },
      { ...valid, queue: { ...valid.queue, pending_count: '0' } },
      { ...valid, executor_profile: { ...valid.executor_profile, profile_enabled: false } },
    ]
    for (const invalid of malformed) expect(() => parseFleetRuntimeQueueStatus(invalid, now)).toThrow('READBACK_INVALID')
  })

  test('immutable owner and predecessor bodies are semantically bound, not substring-admitted', () => {
    const request = requestFor()
    const owner = semanticOwnerBody(request)
    const predecessor = semanticPredecessorBody(request)
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner, predecessor)).not.toThrow()
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner.replace('target_count: 1', 'target_count: 2'), predecessor)).toThrow('READBACK_INVALID')
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner, predecessor.replace('release_tag: v4.1.0', 'release_tag: v4.1.1'))).toThrow('READBACK_INVALID')
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner.replace('    actor_agent_id:', '    actor_agent_id: duplicate\n    actor_agent_id:'), predecessor)).toThrow('READBACK_INVALID')
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner.replace('    active_function:', '    unknown_key: denied\n    active_function:'), predecessor)).toThrow('READBACK_INVALID')
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner.replace('result: PASS', 'result: PASS\nresult: PASS'), predecessor)).toThrow('READBACK_INVALID')
  })

  test('owner-bound exact prior request tuple rejects the audit same-subject foreign predecessor probe', () => {
    const priorRequest = requestFor('CANARY_COLD_START')
    const priorReceipt = receiptFor(priorRequest, preflightFor(priorRequest)) as FleetRuntimeEffectReceipt & Record<string, unknown>
    const priorRaw = canonicalFleetRuntimeJson(priorReceipt)
    const request = requestFor('ROLLBACK')
    request.predecessor_receipt.sha256 = rawDigest(priorRaw)
    resign(request)
    const binding = {
      predecessor_raw_body_sha256: request.predecessor_receipt.sha256,
      predecessor_self_sha256: String(priorReceipt.receipt_sha256),
      prior_request_id: priorRequest.request_id,
      prior_request_digest: priorRequest.request_digest,
      prior_idempotency_key: priorRequest.idempotency_key,
    }
    const owner = semanticOwnerBody(request, binding)
    expect(parseFleetRuntimeOperationPredecessorBinding(request, owner)).toMatchObject(binding)
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner, priorRaw)).not.toThrow()

    const foreign = structuredClone(priorReceipt)
    foreign.request_id = 'FRV1-N40-FOREIGN'
    foreign.request_digest = SHA_B
    foreign.idempotency_key = `frv1:N40:${'9'.repeat(64)}`
    foreign.receipt_sha256 = computeFleetRuntimeReceiptDigest(foreign as FleetRuntimeEffectReceipt)
    const foreignRaw = canonicalFleetRuntimeJson(foreign)
    const rebound = structuredClone(request)
    rebound.predecessor_receipt.sha256 = rawDigest(foreignRaw)
    resign(rebound)
    expect(() => validateFleetRuntimeImmutableSemantics(rebound, owner, foreignRaw)).toThrow('READBACK_INVALID')

    for (const override of [
      { prior_request_id: 'FRV1-N40-FOREIGN' },
      { prior_request_digest: SHA_A },
      { prior_idempotency_key: `frv1:N40:${'8'.repeat(64)}` },
      { predecessor_self_sha256: SHA_A },
    ]) {
      expect(() => validateFleetRuntimeImmutableSemantics(request, semanticOwnerBody(request, { ...binding, ...override }), priorRaw)).toThrow('READBACK_INVALID')
    }
  })

  test('REAPPLY binds the exact RECOVERY predecessor and exact ROLLBACK raw/self/request companion chain', () => {
    const rollbackRequest = requestFor('ROLLBACK')
    const rollbackReceipt = receiptFor(rollbackRequest, preflightFor(rollbackRequest)) as FleetRuntimeEffectReceipt & Record<string, unknown>
    rollbackReceipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(rollbackReceipt as FleetRuntimeEffectReceipt)
    const rollbackRaw = canonicalFleetRuntimeJson(rollbackReceipt)

    const recoveryRequest = requestFor('RECOVERY')
    const recoveryReceipt = receiptFor(recoveryRequest, preflightFor(recoveryRequest)) as FleetRuntimeEffectReceipt & Record<string, unknown>
    recoveryReceipt.rollback_receipt_sha256 = rollbackReceipt.receipt_sha256
    recoveryReceipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(recoveryReceipt as FleetRuntimeEffectReceipt)
    const recoveryRaw = canonicalFleetRuntimeJson(recoveryReceipt)

    const request = requestFor('REAPPLY')
    request.predecessor_receipt.sha256 = rawDigest(recoveryRaw)
    resign(request)
    const binding = {
      predecessor_raw_body_sha256: request.predecessor_receipt.sha256,
      predecessor_self_sha256: String(recoveryReceipt.receipt_sha256),
      prior_request_id: recoveryRequest.request_id,
      prior_request_digest: recoveryRequest.request_digest,
      prior_idempotency_key: recoveryRequest.idempotency_key,
      companion_raw_body_sha256: rawDigest(rollbackRaw),
      companion_self_sha256: String(rollbackReceipt.receipt_sha256),
      companion_request_id: rollbackRequest.request_id,
      companion_request_digest: rollbackRequest.request_digest,
      companion_idempotency_key: rollbackRequest.idempotency_key,
    }
    const owner = semanticOwnerBody(request, binding)
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner, recoveryRaw, rollbackRaw)).not.toThrow()

    const brokenRecovery = structuredClone(recoveryReceipt)
    brokenRecovery.rollback_receipt_sha256 = SHA_A
    brokenRecovery.receipt_sha256 = computeFleetRuntimeReceiptDigest(brokenRecovery as FleetRuntimeEffectReceipt)
    const brokenRecoveryRaw = canonicalFleetRuntimeJson(brokenRecovery)
    const brokenRequest = structuredClone(request)
    brokenRequest.predecessor_receipt.sha256 = rawDigest(brokenRecoveryRaw)
    resign(brokenRequest)
    const brokenOwner = semanticOwnerBody(brokenRequest, {
      ...binding,
      predecessor_raw_body_sha256: brokenRequest.predecessor_receipt.sha256,
      predecessor_self_sha256: String(brokenRecovery.receipt_sha256),
    })
    expect(() => validateFleetRuntimeImmutableSemantics(brokenRequest, brokenOwner, brokenRecoveryRaw, rollbackRaw)).toThrow('READBACK_INVALID')

    const foreignRollback = structuredClone(rollbackReceipt)
    foreignRollback.request_id = 'FRV1-N40-ROLLBACK-FOREIGN'
    foreignRollback.receipt_sha256 = computeFleetRuntimeReceiptDigest(foreignRollback as FleetRuntimeEffectReceipt)
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner, recoveryRaw, canonicalFleetRuntimeJson(foreignRollback))).toThrow('READBACK_INVALID')
  })

  test('external merge requires the created PR URL and exact pushed head', () => {
    const request = requestFor()
    const receipt: Record<string, unknown> = {
      schema_version: 'fleet-runtime-v1/external-merge-receipt/v1', receipt_sha256: SHA_A,
      subject_digest: digest(request.subject), request_id: request.request_id, request_digest: request.request_digest,
      idempotency_key: request.idempotency_key, operation: request.operation, target_repository: 'watchout/kodama',
      base: 'main', pr_url: 'https://github.com/watchout/kodama/pull/123', pushed_head: 'e'.repeat(40),
      merge_commit: 'c'.repeat(40), merge_tree: 'd'.repeat(40), result: 'PASS',
      predecessor_receipt_sha256: request.predecessor_receipt.sha256,
    }
    receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt as unknown as FleetRuntimeEffectReceipt)
    const pr = {
      url: receipt.pr_url, state: 'MERGED', mergedAt: '2026-08-15T09:00:00Z', mergeCommit: { oid: receipt.merge_commit },
      headRefOid: 'e'.repeat(40), baseRefName: 'main', isDraft: false,
    }
    const input = { request, receipt, pr, createdPrUrl: receipt.pr_url, pushedHead: pr.headRefOid, observedMergeTree: receipt.merge_tree }
    expect(() => validateFleetRuntimeExternalMergeBinding(input)).not.toThrow()
    expect(() => validateFleetRuntimeExternalMergeBinding({ ...input, createdPrUrl: 'https://github.com/watchout/kodama/pull/124' })).toThrow('READBACK_INVALID')
    expect(() => validateFleetRuntimeExternalMergeBinding({ ...input, pushedHead: 'f'.repeat(40) })).toThrow('READBACK_INVALID')
    const missingHead = structuredClone(receipt)
    delete missingHead.pushed_head
    expect(() => validateFleetRuntimeExternalMergeBinding({ ...input, receipt: missingHead })).toThrow('READBACK_INVALID')
    for (const field of ['target_repository', 'base', 'operation', 'request_digest'] as const) {
      expect(() => validateFleetRuntimeExternalMergeBinding({
        ...input, receipt: { ...receipt, [field]: field === 'target_repository' ? 'watchout/misell' : 'substituted' },
      })).toThrow('READBACK_INVALID')
    }
    expect(() => validateFleetRuntimeExternalMergeBinding({ ...input, observedMergeTree: 'f'.repeat(40) })).toThrow('READBACK_INVALID')
  })

  test('schema-correct external merge receipt succeeds through the concrete file and injected GitHub readback path', async () => {
    const request = requestFor()
    const stateDirectory = temporary('frv1-concrete-external-merge')
    const invocationDirectory = join(stateDirectory, 'invocations', request.idempotency_key)
    mkdirSync(invocationDirectory, { recursive: true })
    const currentIntent = {
      pr_url: 'https://github.com/watchout/kodama/pull/123',
      pushed_head: 'e'.repeat(40),
    }
    const receipt = fixtureExternalMergeReceipt(request, currentIntent)
    writeFileSync(join(invocationDirectory, 'external-merge-receipt.json'), `${canonicalFleetRuntimeJson(receipt)}\n`)
    const calls: string[][] = []
    const runner: FleetRuntimeArgvRunner = {
      async run(argv) {
        calls.push([...argv])
        if (argv[0] === 'gh' && argv[1] === 'pr') return {
          exitCode: 0, stderr: '', stdout: JSON.stringify({
            url: receipt.pr_url, state: 'MERGED', mergedAt: '2026-08-15T09:00:00Z',
            mergeCommit: { oid: receipt.merge_commit }, headRefOid: receipt.pushed_head,
            baseRefName: 'main', isDraft: false,
          }),
        }
        if (argv[0] === 'gh' && argv[1] === 'api') return {
          exitCode: 0, stderr: '', stdout: JSON.stringify({ tree: { sha: receipt.merge_tree } }),
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected argv ${argv.join(' ')}` }
      },
    }
    const system = new ConcreteFleetRuntimeV1LocalSystem(runner)
    const context: FleetRuntimeLocalPhaseContext = {
      state_directory: stateDirectory,
      invocation_directory: invocationDirectory,
      prior_evidence: {},
      current_intent: currentIntent,
      execution_owner_id: 'fixture-owner',
      owner_decision_raw_body: semanticOwnerBody(request),
      predecessor_receipt_raw_body: semanticPredecessorBody(request),
    }
    const result = await system.performPhase(request, preflightFor(request), 'VERIFY_EXTERNAL_MERGE', context)
    expect(result).toEqual({ evidence: receipt, protected_effect_count: 0 })
    expect(calls).toHaveLength(2)

    const legacy = structuredClone(receipt)
    delete legacy.target_repository
    legacy.repository = 'watchout/kodama'
    legacy.receipt_sha256 = computeFleetRuntimeReceiptDigest(legacy as unknown as FleetRuntimeEffectReceipt)
    writeFileSync(join(invocationDirectory, 'external-merge-receipt.json'), `${canonicalFleetRuntimeJson(legacy)}\n`)
    await expectProviderCode(
      () => system.performPhase(request, preflightFor(request), 'VERIFY_EXTERNAL_MERGE', context),
      'READBACK_INVALID',
    )
    expect(calls).toHaveLength(2)
  })

  test('local receipt validates its self-digest, subject, operation, target, predecessor, and runtime image', () => {
    const request = requestFor()
    const receipt = receiptFor(request, preflightFor(request)) as FleetRuntimeEffectReceipt & Record<string, unknown>
    receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt)
    const expected = {
      request, operation: request.operation, target: 'watchout/kodama',
      predecessorRawBodySha256: request.predecessor_receipt.sha256, predecessorSelfSha256: null,
    }
    expect(() => validateFleetRuntimeLocalReceipt(receipt, expected)).not.toThrow()
    const foreign = structuredClone(receipt)
    foreign.subject_digest = SHA_B
    foreign.receipt_sha256 = computeFleetRuntimeReceiptDigest(foreign as FleetRuntimeEffectReceipt)
    expect(() => validateFleetRuntimeLocalReceipt(foreign, expected)).toThrow('READBACK_INVALID')
    const brokenSelf = { ...receipt, receipt_sha256: SHA_B }
    expect(() => validateFleetRuntimeLocalReceipt(brokenSelf, expected)).toThrow('READBACK_INVALID')
    const duplicateJson = canonicalFleetRuntimeJson(receipt).replace('{', '{"request_id":"FRV1-N40-FOREIGN",')
    expect(() => validateFleetRuntimeLocalReceipt(duplicateJson, expected)).toThrow('READBACK_INVALID')
    for (const field of ['request_id', 'request_digest', 'idempotency_key'] as const) {
      const foreign = structuredClone(receipt)
      foreign[field] = field === 'request_id' ? 'FRV1-N40-FOREIGN' : field === 'idempotency_key' ? `frv1:N40:${'9'.repeat(64)}` : SHA_B
      foreign.receipt_sha256 = computeFleetRuntimeReceiptDigest(foreign as FleetRuntimeEffectReceipt)
      expect(() => validateFleetRuntimeLocalReceipt(foreign, expected)).toThrow('READBACK_INVALID')
    }
    for (const mutate of [
      (value: Record<string, unknown>) => { value.operation = 'ROLLBACK' },
      (value: Record<string, unknown>) => { value.target_repository = 'watchout/misell' },
      (value: Record<string, unknown>) => { value.predecessor_receipt_sha256 = SHA_B },
      (value: Record<string, unknown>) => { value.predecessor_receipt_raw_body_sha256 = SHA_B },
      (value: Record<string, unknown>) => { value.predecessor_receipt_self_sha256 = SHA_B },
      (value: Record<string, unknown>) => {
        ((value.per_target as Array<Record<string, unknown>>)[0].postimage as Record<string, unknown>).runtime_instance_id = ''
      },
    ]) {
      const invalid = structuredClone(receipt) as Record<string, unknown>
      mutate(invalid)
      invalid.receipt_sha256 = computeFleetRuntimeReceiptDigest(invalid as unknown as FleetRuntimeEffectReceipt)
      expect(() => validateFleetRuntimeLocalReceipt(invalid, expected)).toThrow('READBACK_INVALID')
    }
  })

  test('rollback exact-preimage intent uses the rollback merge head, not the prepared canary head', () => {
    const request = requestFor('ROLLBACK')
    const context: FleetRuntimeLocalPhaseContext = {
      state_directory: '/safe/state', invocation_directory: '/safe/state/invocations/key', current_intent: {},
      predecessor_receipt_raw_body: '',
      prior_evidence: {
        PREPARE_CLEAN_CHECKOUT: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
        VERIFY_EXTERNAL_MERGE: { merge_commit: 'c'.repeat(40), merge_tree: 'd'.repeat(40) },
      },
    }
    expect(new ConcreteFleetRuntimeV1LocalSystem().phaseIntent(request, 'VERIFY_EXACT_PREIMAGE', context)).toEqual({
      expected_head: 'c'.repeat(40), expected_tree: request.preimages[0].tree,
    })
    expect(new ConcreteFleetRuntimeV1LocalSystem().phaseIntent(request, 'CREATE_DRAFT_PR', {
      ...context,
      prior_evidence: { PUSH_NORMAL_BRANCH: { branch: 'fixture-branch', head: 'e'.repeat(40) } },
    })).toEqual({
      repository: 'watchout/kodama', base: request.preimages[0].required_base_branch,
      branch: 'fixture-branch', head: 'e'.repeat(40), draft: true,
    })
  })

  test('root-goal parsing has no defaults and admits only exact zero-effect states', () => {
    const valid = officialPassRootGoalStatus()
    expect(parseFleetRuntimeRootGoalReadback(valid)).toMatchObject({ repository: 'watchout/kodama', verdict: 'PASS', write_count: 0 })
    expect(parseFleetRuntimeRootGoalReadback(officialBlockedRootGoalStatus())).toMatchObject({
      repository: 'watchout/kodama', verdict: 'BLOCKED', store_code: 'STORE_NOT_CREATED', runtime_digest: null,
    })
    for (const field of Object.keys(valid)) {
      const missing = structuredClone(valid) as Record<string, unknown>
      delete missing[field]
      expect(() => parseFleetRuntimeRootGoalReadback(missing), field).toThrow('READBACK_INVALID')
    }
    expect(() => parseFleetRuntimeRootGoalReadback({ ...valid, write_count: '0' })).toThrow('READBACK_INVALID')
    expect(() => parseFleetRuntimeRootGoalReadback({ ...valid, effect_delivery_performed: true })).toThrow('READBACK_INVALID')
    expect(() => parseFleetRuntimeRootGoalReadback({ ...valid, extra: true })).toThrow('READBACK_INVALID')
  })

  test('the concrete receipt builder emits the complete self-digested operation chain', async () => {
    const request = requestFor()
    const preflight = preflightFor(request)
    preflight.owner_decision_raw_body = semanticOwnerBody(request)
    preflight.predecessor_receipt_raw_body = semanticPredecessorBody(request)
    const stateDirectory = join(temporary('frv1-concrete-receipt'), 'state')
    await executeLocalFleetRuntimeV1(protectedFixtureInput({
      request, stateDirectory, executeProtectedEffects: true, system: new FixtureSystem(), now: () => '2026-08-15T08:30:00Z',
    }))
    const state = JSON.parse(readFileSync(join(
      stateDirectory, 'invocations', request.idempotency_key, 'operation-state.json',
    ), 'utf8')) as FleetRuntimeLocalOperationState
    const receipt = await new ConcreteFleetRuntimeV1LocalSystem().buildReceipt(request, preflight, state)
    expect(receipt.receipt_sha256).toBe(computeFleetRuntimeReceiptDigest(receipt))
    expect(receipt).toMatchObject({
      subject_digest: digest(request.subject), predecessor_receipt_sha256: request.predecessor_receipt.sha256,
      target_repository: 'watchout/kodama', merge_commit: 'c'.repeat(40), merge_tree: 'd'.repeat(40),
    })
    const emptyEvidence = structuredClone(state)
    emptyEvidence.phases.PREPARE_CLEAN_CHECKOUT!.evidence = {}
    emptyEvidence.phases.PREPARE_CLEAN_CHECKOUT!.evidence_sha256 = digest({})
    await expectProviderCode(
      () => new ConcreteFleetRuntimeV1LocalSystem().buildReceipt(request, preflight, emptyEvidence),
      'READBACK_INVALID',
    )
  })

  test('full journal validation and receipt building reject recomputed cross-phase head, branch, and PR substitutions', async () => {
    for (const operation of ['CANARY_COLD_START', 'ROLLBACK'] as const) {
      const request = requestFor(operation)
      const preflight = preflightFor(request)
      const stateDirectory = join(temporary(`frv1-cross-phase-chain-${operation}`), 'state')
      await executeLocalFleetRuntimeV1(protectedFixtureInput({
        request, stateDirectory, executeProtectedEffects: true, system: new FixtureSystem(), now: () => '2026-08-15T08:30:00Z',
      }))
      const original = JSON.parse(readFileSync(join(
        stateDirectory, 'invocations', request.idempotency_key, 'operation-state.json',
      ), 'utf8')) as FleetRuntimeLocalOperationState
      const refreshPhase = (state: FleetRuntimeLocalOperationState, phaseName: FleetRuntimeLocalPhase): void => {
        const phase = state.phases[phaseName]!
        phase.intent_sha256 = digest(phase.intent)
        phase.evidence!.intent_sha256 = phase.intent_sha256
        if (phaseName === 'VERIFY_EXTERNAL_MERGE') {
          const receipt = structuredClone(phase.evidence!)
          delete receipt.execution_owner_id
          delete receipt.phase
          delete receipt.intent_sha256
          receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt as unknown as FleetRuntimeEffectReceipt)
          phase.evidence!.receipt_sha256 = receipt.receipt_sha256
        }
        phase.evidence_sha256 = digest(phase.evidence)
      }
      const probes: Array<{ name: string; mutate: (state: FleetRuntimeLocalOperationState) => void }> = [
        {
          name: 'local e head versus downstream f head',
          mutate: state => {
            state.phases.PUSH_NORMAL_BRANCH!.intent.head = 'f'.repeat(40)
            state.phases.PUSH_NORMAL_BRANCH!.evidence!.head = 'f'.repeat(40)
            state.phases.CREATE_DRAFT_PR!.intent.head = 'f'.repeat(40)
            state.phases.CREATE_DRAFT_PR!.evidence!.head = 'f'.repeat(40)
            state.phases.VERIFY_EXTERNAL_MERGE!.intent.pushed_head = 'f'.repeat(40)
            state.phases.VERIFY_EXTERNAL_MERGE!.evidence!.pushed_head = 'f'.repeat(40)
            for (const phase of ['PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'VERIFY_EXTERNAL_MERGE'] as const) refreshPhase(state, phase)
          },
        },
        {
          name: 'downstream branch substitution',
          mutate: state => {
            state.phases.PUSH_NORMAL_BRANCH!.intent.branch = 'foreign-branch'
            state.phases.PUSH_NORMAL_BRANCH!.evidence!.branch = 'foreign-branch'
            state.phases.CREATE_DRAFT_PR!.intent.branch = 'foreign-branch'
            state.phases.CREATE_DRAFT_PR!.evidence!.branch = 'foreign-branch'
            for (const phase of ['PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR'] as const) refreshPhase(state, phase)
          },
        },
        {
          name: 'external merge PR URL substitution',
          mutate: state => {
            const substituted = 'https://github.com/watchout/kodama/pull/456'
            state.phases.VERIFY_EXTERNAL_MERGE!.intent.pr_url = substituted
            state.phases.VERIFY_EXTERNAL_MERGE!.evidence!.pr_url = substituted
            refreshPhase(state, 'VERIFY_EXTERNAL_MERGE')
          },
        },
      ]
      for (const probe of probes) {
        const state = structuredClone(original)
        probe.mutate(state)
        expect(
          () => validateFleetRuntimeLocalOperationState(state, request, state.execution_owner_id),
          `${operation}: validator accepted ${probe.name}`,
        ).toThrow('STATE_RECORD_INVALID')
        await expectProviderCode(
          () => new ConcreteFleetRuntimeV1LocalSystem().buildReceipt(request, preflight, state),
          'STATE_RECORD_INVALID',
        )
      }
    }
  })

  test('every completed phase rejects empty, missing, extra, foreign, digest-only, count, order, and semantic tamper', async () => {
    const journals: Array<{ request: FleetRuntimeRequest; state: FleetRuntimeLocalOperationState }> = []
    for (const operation of ['CANARY_COLD_START', 'ROLLBACK', 'RECOVERY', 'REAPPLY'] as const) {
      const request = requestFor(operation)
      const stateDirectory = join(temporary(`frv1-full-journal-matrix-${operation}`), 'state')
      await executeLocalFleetRuntimeV1(protectedFixtureInput({
        request, stateDirectory, executeProtectedEffects: true, system: new FixtureSystem(), now: () => '2026-08-15T08:30:00Z',
      }))
      journals.push({
        request,
        state: JSON.parse(readFileSync(join(
          stateDirectory, 'invocations', request.idempotency_key, 'operation-state.json',
        ), 'utf8')) as FleetRuntimeLocalOperationState,
      })
    }
    const common = new Set(['execution_owner_id', 'operation', 'phase', 'request_digest', 'request_id', 'intent_sha256'])
    const covered = new Set<FleetRuntimeLocalPhase>()
    for (const { request, state } of journals) {
      validateFleetRuntimeLocalOperationState(state, request, state.execution_owner_id)
      const expectInvalid = (mutate: (copy: FleetRuntimeLocalOperationState, phase: FleetRuntimeLocalPhase) => void, phase: FleetRuntimeLocalPhase) => {
        const copy = structuredClone(state)
        mutate(copy, phase)
        expect(() => validateFleetRuntimeLocalOperationState(copy, request, state.execution_owner_id), `${request.operation}:${phase}`).toThrow()
      }
      for (const phase of state.phase_sequence) {
        covered.add(phase)
        expectInvalid((copy, selected) => {
          copy.phases[selected]!.evidence = {}
          copy.phases[selected]!.evidence_sha256 = digest({})
        }, phase)
        expectInvalid((copy, selected) => {
          const evidence = copy.phases[selected]!.evidence!
          const key = Object.keys(evidence).find(candidate => !common.has(candidate))!
          delete evidence[key]
          copy.phases[selected]!.evidence_sha256 = digest(evidence)
        }, phase)
        expectInvalid((copy, selected) => {
          copy.phases[selected]!.evidence!.unexpected = true
          copy.phases[selected]!.evidence_sha256 = digest(copy.phases[selected]!.evidence)
        }, phase)
        expectInvalid((copy, selected) => {
          copy.phases[selected]!.evidence!.execution_owner_id = 'foreign-owner'
          copy.phases[selected]!.evidence_sha256 = digest(copy.phases[selected]!.evidence)
        }, phase)
        expectInvalid((copy, selected) => {
          const entry = copy.phases[selected]!
          entry.intent.request_id = 'FRV1-N40-FOREIGN'
          entry.intent_sha256 = digest(entry.intent)
          entry.evidence!.intent_sha256 = entry.intent_sha256
          entry.evidence_sha256 = digest(entry.evidence)
        }, phase)
        expectInvalid((copy, selected) => { copy.phases[selected]!.evidence_sha256 = SHA_B }, phase)
        expectInvalid((copy, selected) => {
          copy.phases[selected]!.protected_effect_count = copy.phases[selected]!.protected_effect_count === 0 ? 1 : 0
        }, phase)
        expectInvalid((copy, selected) => {
          const evidence = copy.phases[selected]!.evidence!
          if (selected === 'PREPARE_CLEAN_CHECKOUT' || selected === 'PREPARE_MERGED_CHECKOUT' || selected === 'VERIFY_EXACT_PREIMAGE') evidence.head = 'f'.repeat(40)
          else if (selected === 'STAGE_EXACT_PAYLOAD') (evidence.renderer_source_checkout_after as Record<string, unknown>).remote = 'https://github.com/watchout/foreign.git'
          else if (selected === 'VERIFY_EXACT_PAYLOAD') (evidence.checkout_blobs as Record<string, unknown>)[FIXTURE_PAYLOAD_PATHS[0]] = { bytes: 99, sha256: SHA_A }
          else if (selected === 'CREATE_LOCAL_COMMIT') {
            ;(evidence.index_blobs as Record<string, unknown>)[FIXTURE_PAYLOAD_PATHS[0]] = { bytes: 99, sha256: SHA_A }
            ;(evidence.commit_blobs as Record<string, unknown>)[FIXTURE_PAYLOAD_PATHS[0]] = { bytes: 99, sha256: SHA_A }
          }
          else if (selected === 'CREATE_LOCAL_REVERT') evidence.reverted_merge = 'f'.repeat(40)
          else if (selected === 'PUSH_NORMAL_BRANCH') evidence.force = true
          else if (selected === 'CREATE_DRAFT_PR') evidence.draft = false
          else if (selected === 'VERIFY_EXTERNAL_MERGE') evidence.target_repository = 'watchout/misell'
          else if (selected === 'COLD_START_DISCORD_KODAMA') evidence.port = 1
          else if (selected === 'VERIFY_LIVE_IDENTITY') evidence.queue_unchanged = false
          copy.phases[selected]!.evidence_sha256 = digest(evidence)
        }, phase)
      }
      const reordered = structuredClone(state)
      ;[reordered.phase_sequence[0], reordered.phase_sequence[1]] = [reordered.phase_sequence[1], reordered.phase_sequence[0]]
      expect(() => validateFleetRuntimeLocalOperationState(reordered, request, state.execution_owner_id)).toThrow('STATE_RECORD_INVALID')
    }
    expect([...covered].sort()).toEqual([
      'COLD_START_DISCORD_KODAMA', 'CREATE_DRAFT_PR', 'CREATE_LOCAL_COMMIT', 'CREATE_LOCAL_REVERT',
      'PREPARE_CLEAN_CHECKOUT', 'PREPARE_MERGED_CHECKOUT', 'PUSH_NORMAL_BRANCH', 'STAGE_EXACT_PAYLOAD',
      'VERIFY_EXACT_PAYLOAD', 'VERIFY_EXACT_PREIMAGE', 'VERIFY_EXTERNAL_MERGE', 'VERIFY_LIVE_IDENTITY',
    ])
  })

  test('payload path set blocks omissions, extras, reordering, and duplicates', () => {
    const paths = Array.from({ length: 24 }, (_, index) => `payload/${String(index).padStart(2, '0')}.txt`)
    expect(() => assertExactFleetRuntimePathSet(paths, [...paths], 'fixture')).not.toThrow()
    expect(() => assertExactFleetRuntimePathSet(paths, paths.slice(1), 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimePathSet(paths, [...paths, 'payload/extra.txt'], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimePathSet(paths, [paths[1], paths[0], ...paths.slice(2)], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimePathSet(paths, [paths[0], paths[0], ...paths.slice(2)], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
  })

  test('changed path set blocks omissions, extras, reordering, and duplicates without requiring 24 paths', () => {
    expect(() => assertExactFleetRuntimeChangedPathSet(MEASURED_CHANGED_PATHS, [...MEASURED_CHANGED_PATHS], 'fixture')).not.toThrow()
    expect(() => assertExactFleetRuntimeChangedPathSet(MEASURED_CHANGED_PATHS, MEASURED_CHANGED_PATHS.slice(1), 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimeChangedPathSet(MEASURED_CHANGED_PATHS, [...MEASURED_CHANGED_PATHS, '.shirube/extra'], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimeChangedPathSet(MEASURED_CHANGED_PATHS, [MEASURED_CHANGED_PATHS[1], MEASURED_CHANGED_PATHS[0], ...MEASURED_CHANGED_PATHS.slice(2)], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimeChangedPathSet(MEASURED_CHANGED_PATHS, [MEASURED_CHANGED_PATHS[0], MEASURED_CHANGED_PATHS[0], ...MEASURED_CHANGED_PATHS.slice(2)], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
  })

  test.each(['renderer', 'index', 'commit'])('%s payload layer binds all 24 paths and byte digests', layer => {
    const rows = Array.from({ length: 24 }, (_, index) => ({
      path: `payload/${String(index).padStart(2, '0')}.txt`, bytes: index + 1, sha256: `sha256:${index.toString(16).padStart(64, '0')}`,
    }))
    expect(() => validateFleetRuntimePayloadBlobLayer(rows, structuredClone(rows), layer)).not.toThrow()
    const wrongBlob = structuredClone(rows)
    wrongBlob[12].sha256 = SHA_A
    expect(() => validateFleetRuntimePayloadBlobLayer(rows, wrongBlob, layer)).toThrow('PAYLOAD_VERIFICATION_FAILED')
    const wrongBytes = structuredClone(rows)
    wrongBytes[12].bytes += 1
    expect(() => validateFleetRuntimePayloadBlobLayer(rows, wrongBytes, layer)).toThrow('PAYLOAD_VERIFICATION_FAILED')
  })

  test('the concrete renderer raw 34 are verified before a separate exact selected 24 directory is admitted', () => {
    const fixture = concreteRendererFixture('frv1-renderer-selection')
    const result = selectFleetRuntimePayloadFromRenderer({
      state_directory: fixture.stateDirectory,
      raw_output_path: fixture.rawOutputPath,
      selected_payload_path: fixture.selectedPayloadPath,
      renderer_report_raw: JSON.stringify(fixture.rendererReport),
      manifest: fixture.manifest,
    })
    expect(result.raw_paths).toEqual(SYNTHETIC_RAW_PATHS)
    expect(Object.keys(result.selected_blobs)).toEqual(SYNTHETIC_PAYLOAD_PATHS)
    expect(validateFleetRuntimePayloadDirectory({
      state_directory: fixture.stateDirectory,
      directory: fixture.selectedPayloadPath,
      manifest: fixture.manifest.files,
      label: 'selected fixture',
      exact_path_set: true,
    })).toEqual(result.selected_blobs)
    for (const extra of SYNTHETIC_RAW_PATHS.filter(path => !SYNTHETIC_PAYLOAD_PATHS.includes(path))) {
      expect(existsSync(join(fixture.selectedPayloadPath, extra))).toBe(false)
    }

    const first = fixture.manifest.files[0]
    const selectedFirst = join(fixture.selectedPayloadPath, first.path)
    const exactBytes = readFileSync(join(fixture.rawOutputPath, first.path))
    rmSync(selectedFirst)
    expect(() => validateFleetRuntimePayloadDirectory({
      state_directory: fixture.stateDirectory, directory: fixture.selectedPayloadPath,
      manifest: fixture.manifest.files, label: 'selected omission', exact_path_set: true,
    })).toThrow('PAYLOAD_VERIFICATION_FAILED')
    writeFileSync(selectedFirst, exactBytes)
    writeFileSync(join(fixture.selectedPayloadPath, 'payload/extra.txt'), 'extra\n')
    expect(() => validateFleetRuntimePayloadDirectory({
      state_directory: fixture.stateDirectory, directory: fixture.selectedPayloadPath,
      manifest: fixture.manifest.files, label: 'selected extra', exact_path_set: true,
    })).toThrow('PAYLOAD_VERIFICATION_FAILED')
    rmSync(join(fixture.selectedPayloadPath, 'payload/extra.txt'))
    writeFileSync(selectedFirst, 'changed\n')
    expect(() => validateFleetRuntimePayloadDirectory({
      state_directory: fixture.stateDirectory, directory: fixture.selectedPayloadPath,
      manifest: fixture.manifest.files, label: 'selected changed bytes', exact_path_set: true,
    })).toThrow('PAYLOAD_VERIFICATION_FAILED')
    rmSync(selectedFirst)
    symlinkSync(join(fixture.rawOutputPath, fixture.manifest.files[1].path), selectedFirst)
    expect(() => validateFleetRuntimePayloadDirectory({
      state_directory: fixture.stateDirectory, directory: fixture.selectedPayloadPath,
      manifest: fixture.manifest.files, label: 'selected symlink', exact_path_set: true,
    })).toThrow('PAYLOAD_VERIFICATION_FAILED')
  })

  test('renderer report and source negatives reject omission, extra, duplicate, reorder, changed bytes, and symlinks', () => {
    const reportMutations: Array<(fixture: ReturnType<typeof concreteRendererFixture>) => void> = [
      fixture => { fixture.rendererReport.generated_files.pop() },
      fixture => { fixture.rendererReport.generated_files.push(structuredClone(fixture.rendererReport.generated_files[0])) },
      fixture => { fixture.rendererReport.generated_files[33] = structuredClone(fixture.rendererReport.generated_files[0]) },
      fixture => {
        ;[fixture.manifest.files[0], fixture.manifest.files[1]] = [fixture.manifest.files[1], fixture.manifest.files[0]]
      },
      fixture => { fixture.rendererReport.target_change_policy.external_repo_mutation_allowed = true },
      fixture => { fixture.rendererReport.required_next_actions.pop() },
      fixture => { writeFileSync(join(fixture.rawOutputPath, fixture.manifest.files[0].path), 'changed-renderer-bytes\n') },
      fixture => {
        const first = join(fixture.rawOutputPath, fixture.manifest.files[0].path)
        rmSync(first)
        symlinkSync(join(fixture.rawOutputPath, fixture.manifest.files[1].path), first)
      },
    ]
    for (const [index, mutate] of reportMutations.entries()) {
      const fixture = concreteRendererFixture(`frv1-renderer-negative-${index}`)
      mutate(fixture)
      expect(() => selectFleetRuntimePayloadFromRenderer({
        state_directory: fixture.stateDirectory,
        raw_output_path: fixture.rawOutputPath,
        selected_payload_path: fixture.selectedPayloadPath,
        renderer_report_raw: JSON.stringify(fixture.rendererReport),
        manifest: fixture.manifest,
      }), `renderer mutation ${index}`).toThrow(index === reportMutations.length - 1 ? 'STATE_DIRECTORY_INVALID' : 'PAYLOAD_VERIFICATION_FAILED')
      expect(existsSync(fixture.selectedPayloadPath)).toBe(false)
    }
  })

  test('concrete STAGE_EXACT_PAYLOAD renders only from the amendment image and rejects the predecessor image before renderer spawn', async () => {
    const runStage = async (observedHead: string) => {
      const request = requestFor()
      const stateDirectory = temporary(`frv1-stage-amendment-${observedHead.slice(0, 7)}`)
      const invocationDirectory = join(stateDirectory, 'invocations', 'stage-amendment')
      const checkout = join(invocationDirectory, 'checkout')
      mkdirSync(checkout, { recursive: true })
      const manifest = concreteRendererManifest()
      const checkoutRefs: string[] = []
      let rendererCalls = 0
      const runner: FleetRuntimeArgvRunner = {
        async run(argv, options) {
          const command = argv.join(' ')
          if (argv[0] === 'git' && argv[1] === 'clone') {
            mkdirSync(String(argv.at(-1)), { recursive: true })
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          if (argv[0] === 'git' && argv[1] === 'checkout' && argv[2] === '--detach') {
            checkoutRefs.push(String(argv[3]))
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          if (command === 'git remote get-url origin') {
            return { exitCode: 0, stdout: 'https://github.com/watchout/ai-dev-framework.git', stderr: '' }
          }
          if (command === 'git rev-parse HEAD') return { exitCode: 0, stdout: observedHead, stderr: '' }
          if (command === 'git rev-parse HEAD^{tree}') {
            return { exitCode: 0, stdout: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree, stderr: '' }
          }
          if (command === `git rev-parse HEAD:${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_path}`) {
            return { exitCode: 0, stdout: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_blob, stderr: '' }
          }
          if (command === `git rev-parse HEAD:${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_path}`) {
            return { exitCode: 0, stdout: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_blob, stderr: '' }
          }
          if (command === 'git status --porcelain=v1' || command === 'git branch --show-current') {
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          if (argv[0] === 'node' && argv[1] === FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_path) {
            rendererCalls += 1
            expect(options?.cwd).toBe(join(invocationDirectory, 'adf-payload-amendment'))
            const outputIndex = argv.indexOf('--out')
            const { rendererReport } = writeConcreteRendererOutput(String(argv[outputIndex + 1]))
            return { exitCode: 0, stdout: JSON.stringify(rendererReport), stderr: '' }
          }
          return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` }
        },
      }
      const system = new ConcreteFleetRuntimeV1LocalSystem(runner)
      ;(system as any).payloadManifest = async () => ({ path_count: 24, files: manifest.files })
      const context: FleetRuntimeLocalPhaseContext = {
        state_directory: stateDirectory,
        invocation_directory: invocationDirectory,
        prior_evidence: {},
        current_intent: {},
        execution_owner_id: 'fixture-owner',
        owner_decision_raw_body: OWNER_BODY,
        predecessor_receipt_raw_body: PREDECESSOR_BODY,
      }
      context.current_intent = system.phaseIntent(request, 'STAGE_EXACT_PAYLOAD', context)
      const perform = () => system.performPhase(request, preflightFor(request), 'STAGE_EXACT_PAYLOAD', context)
      return { checkout, checkoutRefs, manifest, perform, rendererCalls: () => rendererCalls }
    }

    const accepted = await runStage(FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref)
    const result = await accepted.perform()
    expect(result).toMatchObject({
      protected_effect_count: 0,
      evidence: {
        path_count: 24,
        raw_path_count: 34,
        renderer_source_checkout_before: {
          head: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref,
          tree: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree,
          renderer_blob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_blob,
          workflow_template_blob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_blob,
        },
      },
    })
    expect(accepted.checkoutRefs).toEqual([FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref])
    expect(accepted.rendererCalls()).toBe(1)
    expect(readFileSync(join(accepted.checkout, accepted.manifest.files[0].path), 'utf8')).toBe('selected-payload-00\n')

    const rejected = await runStage(FLEET_RUNTIME_V1_CONTRACT.release_commit)
    await expectProviderCode(rejected.perform, 'PAYLOAD_VERIFICATION_FAILED')
    expect(rejected.checkoutRefs).toEqual([FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref])
    expect(rejected.rendererCalls()).toBe(0)
  })

  test('measured 24-path payload admits exactly the 4 paths changed against the frozen preimage', async () => {
    const fixture = measuredGitDeltaFixture('frv1-measured-24-20-4')
    const index = await validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: fixture.checkout, manifest: fixture.manifest, layer: 'index',
    })
    expect(index.changed_paths).toEqual(MEASURED_CHANGED_PATHS)

    runTempGit(['git', 'reset', '--quiet', '--', MEASURED_CHANGED_PATHS[0]], fixture.checkout)
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: fixture.checkout, manifest: fixture.manifest, layer: 'index',
    }), 'PAYLOAD_VERIFICATION_FAILED')
    runTempGit(['git', 'add', '--', MEASURED_CHANGED_PATHS[0]], fixture.checkout)

    writeFileSync(join(fixture.checkout, '.shirube/extra-delta.txt'), 'extra\n')
    runTempGit(['git', 'add', '--', '.shirube/extra-delta.txt'], fixture.checkout)
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: fixture.checkout, manifest: fixture.manifest, layer: 'index',
    }), 'PAYLOAD_VERIFICATION_FAILED')
    runTempGit(['git', 'reset', '--quiet', '--', '.shirube/extra-delta.txt'], fixture.checkout)
    rmSync(join(fixture.checkout, '.shirube/extra-delta.txt'))

    runTempGit(['git', 'commit', '--quiet', '-m', 'measured four-path payload'], fixture.checkout)
    const head = runTempGit(['git', 'rev-parse', 'HEAD'], fixture.checkout)
    const committed = await validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner,
      checkout: fixture.checkout,
      manifest: fixture.manifest,
      layer: 'commit',
      commit: head,
      expected_object_ids: index.object_ids,
    })
    expect(committed.changed_paths).toEqual(MEASURED_CHANGED_PATHS)
  })

  test('started local-commit reconciliation resumes the measured staged copy once and then reads it back', async () => {
    const fixture = measuredGitDeltaFixture('frv1-reserved-journal-resume')
    const request = requestFor()
    const branch = `shirube-v41-canary-cold-start-${request.request_digest.slice(-12)}`
    runTempGit(['git', 'switch', '-c', branch], fixture.checkout)
    const system = new ConcreteFleetRuntimeV1LocalSystem(bunFleetRuntimeArgvRunner)
    ;(system as any).payloadManifest = async () => ({ path_count: 24, files: fixture.manifest })
    const context: FleetRuntimeLocalPhaseContext = {
      state_directory: fixture.stateDirectory,
      invocation_directory: fixture.invocationDirectory,
      prior_evidence: {
        PREPARE_CLEAN_CHECKOUT: { head: fixture.preimageHead },
        VERIFY_EXACT_PAYLOAD: { payload_paths: FIXTURE_PAYLOAD_PATHS },
      },
      current_intent: { payload_digest: request.payload_digest, path_count: 24 },
      execution_owner_id: 'fixture-owner',
      owner_decision_raw_body: OWNER_BODY,
      predecessor_receipt_raw_body: PREDECESSOR_BODY,
    }
    const first = await system.reconcilePhase(request, preflightFor(request), 'CREATE_LOCAL_COMMIT', context)
    expect(first).toMatchObject({ completed: true, protected_effect_count: 0 })
    const head = String(first.evidence?.head)
    expect(runTempGit(['git', 'diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', head], fixture.checkout).split('\n')).toEqual(MEASURED_CHANGED_PATHS)
    const second = await system.reconcilePhase(request, preflightFor(request), 'CREATE_LOCAL_COMMIT', context)
    expect(second).toEqual(first)
    expect(runTempGit(['git', 'rev-list', '--count', `${fixture.preimageHead}..${head}`], fixture.checkout)).toBe('1')
  })

  test('real temp-git index and commit objects reject exact-path and byte tampering', async () => {
    const createRepository = (name: string, mutateBeforeAdd?: (repo: string, manifest: Array<{ path: string; bytes: number; sha256: string }>) => void) => {
      const repo = join(temporary(name), 'repo')
      mkdirSync(repo)
      runTempGit(['git', 'init', '--quiet'], repo)
      runTempGit(['git', 'config', 'user.name', 'Fleet Runtime Fixture'], repo)
      runTempGit(['git', 'config', 'user.email', 'fleet-runtime@example.invalid'], repo)
      writeFileSync(join(repo, 'README.md'), 'base\n')
      runTempGit(['git', 'add', 'README.md'], repo)
      runTempGit(['git', 'commit', '--quiet', '-m', 'base'], repo)
      const manifest = SYNTHETIC_PAYLOAD_PATHS.map((path, index) => {
        const content = `git-payload-${String(index).padStart(2, '0')}\n`
        const fullPath = join(repo, path)
        mkdirSync(join(fullPath, '..'), { recursive: true })
        writeFileSync(fullPath, content)
        return { path, bytes: Buffer.byteLength(content), sha256: rawDigest(content) }
      })
      mutateBeforeAdd?.(repo, manifest)
      runTempGit(['git', 'add', '--', ...manifest.map(file => file.path)], repo)
      return { repo, manifest }
    }

    const valid = createRepository('frv1-temp-git-valid')
    const index = await validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: valid.manifest, layer: 'index',
    })
    const reordered = structuredClone(valid.manifest)
    ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: reordered, layer: 'index',
    }), 'PAYLOAD_VERIFICATION_FAILED')
    const duplicate = structuredClone(valid.manifest)
    duplicate[1] = structuredClone(duplicate[0])
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: duplicate, layer: 'index',
    }), 'PAYLOAD_VERIFICATION_FAILED')
    runTempGit(['git', 'reset', '--quiet', '--', valid.manifest[0].path], valid.repo)
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: valid.manifest, layer: 'index',
    }), 'PAYLOAD_VERIFICATION_FAILED')
    runTempGit(['git', 'add', '--', valid.manifest[0].path], valid.repo)
    writeFileSync(join(valid.repo, 'payload/extra.txt'), 'extra\n')
    runTempGit(['git', 'add', 'payload/extra.txt'], valid.repo)
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: valid.manifest, layer: 'index',
    }), 'PAYLOAD_VERIFICATION_FAILED')
    runTempGit(['git', 'reset', '--quiet', '--', 'payload/extra.txt'], valid.repo)
    rmSync(join(valid.repo, 'payload/extra.txt'))
    writeFileSync(join(valid.repo, valid.manifest[0].path), 'changed-index-bytes\n')
    runTempGit(['git', 'add', '--', valid.manifest[0].path], valid.repo)
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: valid.manifest, layer: 'index',
    }), 'PAYLOAD_VERIFICATION_FAILED')
    writeFileSync(join(valid.repo, valid.manifest[0].path), readFileSync(join(valid.repo, valid.manifest[1].path), 'utf8').replace('01', '00'))
    runTempGit(['git', 'add', '--', valid.manifest[0].path], valid.repo)
    await validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: valid.manifest, layer: 'index',
    })
    runTempGit(['git', 'commit', '--quiet', '-m', 'valid payload'], valid.repo)
    const validCommit = runTempGit(['git', 'rev-parse', 'HEAD'], valid.repo)
    await validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: valid.manifest, layer: 'commit',
      commit: validCommit, expected_object_ids: index.object_ids,
    })
    for (const manifestMutation of [reordered, duplicate]) {
      await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
        runner: bunFleetRuntimeArgvRunner, checkout: valid.repo, manifest: manifestMutation,
        layer: 'commit', commit: validCommit,
      }), 'PAYLOAD_VERIFICATION_FAILED')
    }

    const changed = createRepository('frv1-temp-git-changed', (repo, manifest) => {
      writeFileSync(join(repo, manifest[0].path), 'changed-commit-bytes\n')
    })
    runTempGit(['git', 'commit', '--quiet', '-m', 'changed payload'], changed.repo)
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: changed.repo, manifest: changed.manifest,
      layer: 'commit', commit: runTempGit(['git', 'rev-parse', 'HEAD'], changed.repo),
    }), 'PAYLOAD_VERIFICATION_FAILED')

    const extra = createRepository('frv1-temp-git-extra')
    writeFileSync(join(extra.repo, 'payload/extra.txt'), 'extra\n')
    runTempGit(['git', 'add', 'payload/extra.txt'], extra.repo)
    runTempGit(['git', 'commit', '--quiet', '-m', 'extra payload'], extra.repo)
    await expectProviderCode(() => validateFleetRuntimeGitPayloadLayer({
      runner: bunFleetRuntimeArgvRunner, checkout: extra.repo, manifest: extra.manifest,
      layer: 'commit', commit: runTempGit(['git', 'rev-parse', 'HEAD'], extra.repo),
    }), 'PAYLOAD_VERIFICATION_FAILED')
  })

  test('remote suffix lookalikes and local paths containing github.com are rejected', () => {
    const exact = {
      checkout_path: '/safe/state/invocations/key/checkout', state_directory: '/safe/state', canonical_path: '/Users/yuji/Developer/kodama',
      remote: 'https://github.com/watchout/kodama.git', head: 'a'.repeat(40), tree: 'b'.repeat(40), status_porcelain: '',
      branch: '',
    }
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, remote: 'https://evil.example/watchout/kodama.git' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, remote: '/tmp/github.com/watchout/kodama.git' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, remote: 'https://github.com.evil/watchout/kodama.git' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, expected_head: 'c'.repeat(40) })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, expected_tree: 'c'.repeat(40) })).toThrow('UNSAFE_CHECKOUT')
  })

  test('concrete Kodama checkout readback enforces exact origin/head/tree/clean/detached/realpath matrix', async () => {
    const stateDirectory = temporary('frv1-kodama-checkout-matrix')
    const checkout = join(stateDirectory, 'invocations/key/checkout')
    mkdirSync(checkout, { recursive: true })
    const exact = {
      remote: 'https://github.com/watchout/kodama.git',
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      status: '',
      branch: '',
    }
    const observed = { ...exact }
    const runner: FleetRuntimeArgvRunner = {
      async run(argv) {
        const command = argv.join(' ')
        if (command === 'git remote get-url origin') return { exitCode: 0, stdout: observed.remote, stderr: '' }
        if (command === 'git rev-parse HEAD') return { exitCode: 0, stdout: observed.head, stderr: '' }
        if (command === 'git rev-parse HEAD^{tree}') return { exitCode: 0, stdout: observed.tree, stderr: '' }
        if (command === 'git status --porcelain=v1') return { exitCode: 0, stdout: observed.status, stderr: '' }
        if (command === 'git branch --show-current') return { exitCode: 0, stdout: observed.branch, stderr: '' }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` }
      },
    }
    const system = new ConcreteFleetRuntimeV1LocalSystem(runner)
    await expect(system.verifyCheckout(checkout, stateDirectory, exact.head, exact.tree)).resolves.toMatchObject({
      remote: exact.remote, head: exact.head, tree: exact.tree, clean: true, detached: true,
    })
    const mutations: Array<[keyof typeof observed, string]> = [
      ['remote', 'https://github.com/watchout/kodama-lookalike.git'],
      ['head', 'c'.repeat(40)],
      ['tree', 'd'.repeat(40)],
      ['status', ' M payload/file.txt'],
      ['branch', 'main'],
    ]
    for (const [key, value] of mutations) {
      Object.assign(observed, exact, { [key]: value })
      await expectProviderCode(() => system.verifyCheckout(checkout, stateDirectory, exact.head, exact.tree), 'UNSAFE_CHECKOUT')
    }
    Object.assign(observed, exact)
    const realCheckout = join(stateDirectory, 'real-checkout')
    const linkedCheckout = join(stateDirectory, 'linked-checkout')
    mkdirSync(realCheckout)
    symlinkSync(realCheckout, linkedCheckout)
    await expectProviderCode(() => system.verifyCheckout(linkedCheckout, stateDirectory, exact.head, exact.tree), 'UNSAFE_CHECKOUT')
  })

  test('concrete amendment-bound renderer source enforces exact origin/head/tree/blobs/clean/detached/realpath matrix', async () => {
    const stateDirectory = temporary('frv1-adf-payload-source-matrix')
    const checkout = join(stateDirectory, 'adf-payload-amendment')
    mkdirSync(checkout)
    const exact = {
      remote: 'https://github.com/watchout/ai-dev-framework.git',
      head: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.ref,
      tree: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.tree,
      rendererBlob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_blob,
      workflowTemplateBlob: FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_blob,
      status: '',
      branch: '',
    }
    const observed = { ...exact }
    const runner: FleetRuntimeArgvRunner = {
      async run(argv) {
        const command = argv.join(' ')
        if (command === 'git remote get-url origin') return { exitCode: 0, stdout: observed.remote, stderr: '' }
        if (command === 'git rev-parse HEAD') return { exitCode: 0, stdout: observed.head, stderr: '' }
        if (command === 'git rev-parse HEAD^{tree}') return { exitCode: 0, stdout: observed.tree, stderr: '' }
        if (command === `git rev-parse HEAD:${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.renderer_path}`) {
          return { exitCode: 0, stdout: observed.rendererBlob, stderr: '' }
        }
        if (command === `git rev-parse HEAD:${FLEET_RUNTIME_V1_PAYLOAD_AMENDMENT.workflow_template_path}`) {
          return { exitCode: 0, stdout: observed.workflowTemplateBlob, stderr: '' }
        }
        if (command === 'git status --porcelain=v1') return { exitCode: 0, stdout: observed.status, stderr: '' }
        if (command === 'git branch --show-current') return { exitCode: 0, stdout: observed.branch, stderr: '' }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` }
      },
    }
    const system = new ConcreteFleetRuntimeV1LocalSystem(runner)
    await expect(system.verifyRendererSourceCheckout(checkout, stateDirectory)).resolves.toMatchObject({
      remote: exact.remote, head: exact.head, tree: exact.tree,
      renderer_blob: exact.rendererBlob, workflow_template_blob: exact.workflowTemplateBlob,
      clean: true, detached: true,
    })
    const mutations: Array<[keyof typeof observed, string]> = [
      ['remote', 'https://github.com/watchout/not-ai-dev-framework.git'],
      ['head', 'c'.repeat(40)],
      ['tree', 'd'.repeat(40)],
      ['rendererBlob', 'e'.repeat(40)],
      ['workflowTemplateBlob', 'f'.repeat(40)],
      ['status', ' M scripts/shirube/render-adoption-pack.mjs'],
      ['branch', 'main'],
    ]
    for (const [key, value] of mutations) {
      Object.assign(observed, exact, { [key]: value })
      await expectProviderCode(() => system.verifyRendererSourceCheckout(checkout, stateDirectory), 'PAYLOAD_VERIFICATION_FAILED')
    }
    Object.assign(observed, exact)
    const realCheckout = join(stateDirectory, 'real-adf-payload-amendment')
    const linkedCheckout = join(stateDirectory, 'linked-adf-payload-amendment')
    mkdirSync(realCheckout)
    symlinkSync(realCheckout, linkedCheckout)
    await expectProviderCode(() => system.verifyRendererSourceCheckout(linkedCheckout, stateDirectory), 'STATE_DIRECTORY_INVALID')
  })

  test('a concrete Kodama checkout payload-file symlink is rejected by the full no-symlink readback', () => {
    const stateDirectory = temporary('frv1-kodama-file-symlink')
    const checkout = join(stateDirectory, 'invocations/key/checkout')
    mkdirSync(join(checkout, 'payload'), { recursive: true })
    const outside = join(stateDirectory, 'outside.txt')
    writeFileSync(outside, 'exact\n')
    symlinkSync(outside, join(checkout, 'payload/00.txt'))
    expect(() => validateFleetRuntimePayloadDirectory({
      state_directory: stateDirectory,
      directory: checkout,
      manifest: [{ path: 'payload/00.txt', bytes: 6, sha256: rawDigest('exact\n') }],
      label: 'Kodama checkout payload',
      exact_path_set: true,
    })).toThrow('PAYLOAD_VERIFICATION_FAILED')
  })

  test.each([
    ['COLD_START_DISCORD_KODAMA', 'stale'],
    ['COLD_START_DISCORD_KODAMA', 'attached'],
    ['VERIFY_LIVE_IDENTITY', 'stale'],
    ['VERIFY_LIVE_IDENTITY', 'attached'],
  ] as const)('persisted concrete %s reconciliation rejects a %s checkout without repeating the interrupted phase', async (phase, mutation) => {
    const request = requestFor()
    const stateDirectory = join(temporary(`frv1-persisted-${phase}-${mutation}`), 'state')
    const exactHead = 'c'.repeat(40)
    const exactTree = 'd'.repeat(40)
    const runner: FleetRuntimeArgvRunner = {
      async run(argv) {
        const command = argv.join(' ')
        if (command === 'git remote get-url origin') return { exitCode: 0, stdout: 'https://github.com/watchout/kodama.git', stderr: '' }
        if (command === 'git rev-parse HEAD') return { exitCode: 0, stdout: mutation === 'stale' ? 'f'.repeat(40) : exactHead, stderr: '' }
        if (command === 'git rev-parse HEAD^{tree}') return { exitCode: 0, stdout: exactTree, stderr: '' }
        if (command === 'git status --porcelain=v1') return { exitCode: 0, stdout: '', stderr: '' }
        if (command === 'git branch --show-current') return { exitCode: 0, stdout: mutation === 'attached' ? 'main' : '', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command}` }
      },
    }
    const system = new PersistedConcreteReconcileFixtureSystem(phase, runner)
    await expect(executeLocalFleetRuntimeV1(protectedFixtureInput({
      request, stateDirectory, executeProtectedEffects: true, system,
    }))).rejects.toThrow(`fixture interruption at ${phase}`)
    const journalPath = join(stateDirectory, 'invocations', request.idempotency_key, 'operation-state.json')
    const interrupted = JSON.parse(readFileSync(journalPath, 'utf8')) as FleetRuntimeLocalOperationState
    expect(interrupted.phases[phase]?.status).toBe('started')
    const checkout = join(stateDirectory, 'invocations', request.idempotency_key, 'checkout')
    mkdirSync(checkout, { recursive: true })
    await expectProviderCode(() => executeLocalFleetRuntimeV1(protectedFixtureInput({
      request, stateDirectory, executeProtectedEffects: true, system,
    })), 'UNSAFE_CHECKOUT')
    const after = JSON.parse(readFileSync(journalPath, 'utf8')) as FleetRuntimeLocalOperationState
    expect(after.phases[phase]?.status).toBe('started')
    expect(system.calls.get(phase)).toBe(1)
  })

  test.each(['PREPARE_MERGED_CHECKOUT', 'VERIFY_EXACT_PREIMAGE', 'COLD_START_DISCORD_KODAMA', 'VERIFY_LIVE_IDENTITY'] as const)(
    '%s crash readback rejects a clean but stale exact-repository checkout',
    phase => {
      const stale = {
        checkout_path: '/safe/state/invocations/key/checkout', state_directory: '/safe/state', canonical_path: '/Users/yuji/Developer/kodama',
        remote: 'https://github.com/watchout/kodama.git', head: 'a'.repeat(40), tree: 'b'.repeat(40), status_porcelain: '',
        branch: '',
        expected_head: 'c'.repeat(40), expected_tree: 'd'.repeat(40),
      }
      expect(() => validateFleetRuntimeCheckoutReadback(stale), phase).toThrow('UNSAFE_CHECKOUT')
    },
  )

  test('a symlink below an approved state root is rejected before reservation writes', async () => {
    const root = temporary('frv1-descendant-symlink')
    const stateDirectory = join(root, 'state')
    const outside = join(root, 'outside')
    Bun.spawnSync(['mkdir', '-p', stateDirectory, outside])
    symlinkSync(outside, join(stateDirectory, 'invocations'))
    const store = new FileFleetRuntimeV1Persistence(stateDirectory, { approvedRoot: stateDirectory })
    await expectProviderCode(() => store.reserve_once({
      idempotency_key: `frv1:N40:${'4'.repeat(64)}`, request_digest: SHA_A, status: 'reserved', receipt: null,
    }), 'STATE_DIRECTORY_INVALID')
    expect(existsSync(join(outside, `frv1:N40:${'4'.repeat(64)}`))).toBe(false)
  })

  test('CLI protected mode rejects every non-production state root before constructing the system', () => {
    const root = temporary('frv1-cli-root-deny')
    const requestPath = join(root, 'request.json')
    const statePath = join(root, 'state')
    writeFileSync(requestPath, `${JSON.stringify(requestFor())}\n`)
    const result = Bun.spawnSync([
      process.execPath, 'scripts/fleet-runtime-v1-execute.ts', '--request', requestPath,
      '--state-dir', statePath, '--format', 'json', '--execute-protected-effects',
    ], { cwd: resolveRepo() })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ code: 'STATE_DIRECTORY_INVALID', protected_effect_count: 0 })
    expect(existsSync(statePath)).toBe(false)
  })

  test('adapter failures remain typed and cannot be converted into provider success', async () => {
    const request = requestFor()
    request.preimages[0].tree = 'f'.repeat(40)
    resign(request)
    const system = new FixtureSystem()
    try {
      const stateDirectory = join(temporary('frv1-adapter-block'), 'state')
      await executeLocalFleetRuntimeV1(protectedFixtureInput({
        request,
        stateDirectory,
        executeProtectedEffects: true,
        system,
      }))
      throw new Error('expected adapter failure')
    } catch (error) {
      expect(error).toBeInstanceOf(FleetRuntimeV1Error)
      expect((error as FleetRuntimeV1Error).code).toBe('PREIMAGE_MISMATCH')
    }
  })
})

function resolveRepo(): string {
  return join(import.meta.dir, '..', '..')
}
