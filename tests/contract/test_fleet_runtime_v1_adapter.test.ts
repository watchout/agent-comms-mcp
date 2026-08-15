import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  FLEET_RUNTIME_V1_CONTRACT,
  FLEET_RUNTIME_V1_PREIMAGE_AMENDMENT,
  FLEET_RUNTIME_V1_TARGETS,
  FleetRuntimeV1Error,
  canonicalFleetRuntimeJson,
  computeFleetRuntimeIdempotencyKey,
  computeFleetRuntimeReceiptDigest,
  computeFleetRuntimeRequestDigest,
  executeFleetRuntimeV1,
  frozenFleetRuntimePreimage,
  prepareFleetRuntimeV1Request,
  type FleetRuntimeEffectReceipt,
  type FleetRuntimeOperation,
  type FleetRuntimePorts,
  type FleetRuntimePreimage,
  type FleetRuntimePreflightReceipt,
  type FleetRuntimeRequest,
  type FleetRuntimeRootGoalReadback,
  type FleetRuntimeStage,
  type FleetRuntimeTarget,
} from '../../core/fleet-runtime-v1-adapter'
import {
  digestFleetRuntimeObservationMaterial,
  fleetRuntimeProfileBindingMaterial,
  fleetRuntimeQueueObservationIdMaterial,
  type FleetRuntimeQueueObservationV2,
} from '../../core/fleet-runtime-v1-queue-observation'

const SHA_A = `sha256:${'a'.repeat(64)}`
const OWNER_BODY = '{"decision":"N35 PASS","actor":"watchout","fixture":true}'
const PREDECESSOR_BODY = '{"result":"PASS","fixture":true}'
const EXECUTOR = { actor_agent_id: 'aun-runtime-executor', active_function: 'runtime_recovery_executor' }

const AMENDED_FROM_PREIMAGES = {
  'watchout/agent-comms-mcp': {
    repository: 'watchout/agent-comms-mcp',
    required_base_branch: 'main',
    head_commit: 'e1d2cf316b2a8bdf5e4d2e7d73b570d29e2968d0',
    tree: '667bc355b978a9924f09528e9d9ee600b061d38f',
    runtime_surface_entry_count: 26,
    runtime_surface_sha256: 'sha256:371d9c5b08047a072e97a8feb83a6d9ae8f837062061f9b0050bba6724087235',
    distribution_surface_entry_count: 136,
    distribution_surface_sha256: 'sha256:4d303ed6b479b7019b153bce76e35101a6f4df7b063333cdbae920282b71da97',
  },
  'watchout/agent-memory': {
    repository: 'watchout/agent-memory',
    required_base_branch: 'main',
    head_commit: 'a9ae4b29e2e5739a903926a27cb83a34593f0b44',
    tree: '44fd6ba56230380d7b07f4d36d3557457b7f3e48',
    runtime_surface_entry_count: 24,
    runtime_surface_sha256: 'sha256:31e1b62379e999040784f544e2ac2d1ae1b3aff8177e76332de404e3f4249a56',
    distribution_surface_entry_count: 190,
    distribution_surface_sha256: 'sha256:1c60eff2322f700dd195cfb57e3e6a4b56af365ae2023f6271f3b1f0e3e98bf0',
  },
} as const satisfies Partial<Record<FleetRuntimeTarget, FleetRuntimePreimage>>

const EFFECTIVE_PREIMAGES: FleetRuntimePreimage[] = [
  {
    repository: 'watchout/agent-comms-mcp',
    required_base_branch: 'main',
    head_commit: '933a14ac92605aa10698136b54276cad689aab91',
    tree: '9086c5d2967064839d538e9b53922f2bb600e329',
    runtime_surface_entry_count: 26,
    runtime_surface_sha256: 'sha256:371d9c5b08047a072e97a8feb83a6d9ae8f837062061f9b0050bba6724087235',
    distribution_surface_entry_count: 136,
    distribution_surface_sha256: 'sha256:4d303ed6b479b7019b153bce76e35101a6f4df7b063333cdbae920282b71da97',
  },
  {
    repository: 'watchout/agent-memory',
    required_base_branch: 'main',
    head_commit: 'fdda199c7d686b0a8b9b90a7621ee6fdaab35621',
    tree: '25f450565cd9cd981adf1c33e38ee21d82f6402d',
    runtime_surface_entry_count: 0,
    runtime_surface_sha256: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    distribution_surface_entry_count: 0,
    distribution_surface_sha256: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  },
  {
    repository: 'watchout/aun-platform',
    required_base_branch: 'feat/channel-ux-v2-2-sidebar-thread',
    head_commit: 'ce1a9fcc32b191286585a5c3cb47f2edf7a23568',
    tree: '7a83ad8d947b48b7e89e69c4e9c13beca2b32433',
    runtime_surface_entry_count: 24,
    runtime_surface_sha256: 'sha256:31e1b62379e999040784f544e2ac2d1ae1b3aff8177e76332de404e3f4249a56',
    distribution_surface_entry_count: 54,
    distribution_surface_sha256: 'sha256:a2c465bfc007a4d27d1d9caecac2c3e84f4510fe4daf11718563e9045c58fd19',
  },
  {
    repository: 'watchout/kodama',
    required_base_branch: 'main',
    head_commit: '3c85d6f7a3c83e31c90fe4e3172c111c7541978f',
    tree: '47d992a5c709cf65ef15f4aab5e60887be1aa45a',
    runtime_surface_entry_count: 24,
    runtime_surface_sha256: 'sha256:b90aa1438ef152b36bb988e946c3272e8099c18a4d59dba966c1b8a054ea2212',
    distribution_surface_entry_count: 63,
    distribution_surface_sha256: 'sha256:b1233c486d5921bc928318c4497dba8093ba0a62db0ee4e3e9ab3432ba6302e5',
  },
  {
    repository: 'watchout/misell',
    required_base_branch: 'main',
    head_commit: '640dc4d475cb3670d85579845ecaafae198e895e',
    tree: '8661e8cf569f4bf27a0a736f3f5379d0cfa5df16',
    runtime_surface_entry_count: 24,
    runtime_surface_sha256: 'sha256:31e1b62379e999040784f544e2ac2d1ae1b3aff8177e76332de404e3f4249a56',
    distribution_surface_entry_count: 251,
    distribution_surface_sha256: 'sha256:d41879bf3a6ce1d1aab725bd5f939b4973c3d5e68b75edb39b514e74164c539a',
  },
]

interface Counters {
  preflight_reads: number
  invocation_reservations: number
  invocation_completions: number
  effect_port_calls: number
  protected_effects: number
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalFleetRuntimeJson(value), 'utf8').digest('hex')}`
}

function rawDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
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

function targetsFor(stage: FleetRuntimeStage, canary: FleetRuntimeTarget): FleetRuntimeTarget[] {
  if (stage === 'N40-P4-CANARY-VERIFY' || stage === 'N70-P7-OPERATIONAL') return [canary]
  return [...FLEET_RUNTIME_V1_TARGETS]
}

function authorityMatrix(canary: FleetRuntimeTarget): FleetRuntimeRequest['owner_decision']['stage_authority_matrix'] {
  return [
    { stage_id: 'N40-P4-CANARY-VERIFY', ...EXECUTOR, allowed_operations: ['CANARY_COLD_START', 'ROLLBACK', 'RECOVERY', 'REAPPLY'], target_repositories: [canary] },
    { stage_id: 'N50-P5-PLACEMENT', ...EXECUTOR, allowed_operations: ['FIVE_TARGET_PLACEMENT'], target_repositories: [...FLEET_RUNTIME_V1_TARGETS] },
    { stage_id: 'N60-P6-APPLICATION', ...EXECUTOR, allowed_operations: ['FIVE_TARGET_COLD_START'], target_repositories: [...FLEET_RUNTIME_V1_TARGETS] },
    { stage_id: 'N70-P7-OPERATIONAL', ...EXECUTOR, allowed_operations: ['ONE_OPERATIONAL_ACCEPTANCE_RUN'], target_repositories: [canary] },
  ]
}

function predecessor(stage: FleetRuntimeStage, operation: FleetRuntimeOperation, exactSubject: FleetRuntimeRequest['subject']): FleetRuntimeRequest['predecessor_receipt'] {
  const base = {
    url: 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-9999999998',
    sha256: rawDigest(PREDECESSOR_BODY),
    subject_digest: digest(exactSubject),
  }
  if (stage === 'N40-P4-CANARY-VERIFY' && operation === 'ROLLBACK') {
    return { ...base, kind: 'EFFECT_RECEIPT', node_id: stage, operation: 'CANARY_COLD_START', result: 'PASS' }
  }
  if (stage === 'N40-P4-CANARY-VERIFY' && operation === 'RECOVERY') {
    return { ...base, kind: 'ROLLBACK_RECEIPT', node_id: stage, operation: 'ROLLBACK', result: 'PASS' }
  }
  if (stage === 'N40-P4-CANARY-VERIFY' && operation === 'REAPPLY') {
    return { ...base, kind: 'RECOVERY_RECEIPT', node_id: stage, operation: 'RECOVERY', result: 'PASS' }
  }
  const prior = stage === 'N40-P4-CANARY-VERIFY'
    ? FLEET_RUNTIME_V1_CONTRACT.node_id
    : stage === 'N50-P5-PLACEMENT'
      ? 'N40-P4-CANARY-VERIFY'
      : stage === 'N60-P6-APPLICATION'
        ? 'N50-P5-PLACEMENT'
        : 'N60-P6-APPLICATION'
  return { ...base, kind: 'NODE_RESULT', node_id: prior, operation: null, result: 'PASS' }
}

function resignRequest(request: FleetRuntimeRequest): FleetRuntimeRequest {
  request.request_digest = computeFleetRuntimeRequestDigest(request)
  request.idempotency_key = computeFleetRuntimeIdempotencyKey(request)
  return request
}

function queueObservation(): FleetRuntimeQueueObservationV2 {
  const sourceBase = {
    dialect: 'postgres' as const,
    database_name: 'agent_comms',
    database_oid: '16384',
    database_user: 'yuji',
    system_identifier: '7612345678901234567',
  }
  const source = {
    ...sourceBase,
    profile_binding_digest: digestFleetRuntimeObservationMaterial(fleetRuntimeProfileBindingMaterial(sourceBase)),
    migration_epoch: '1',
  }
  const queueBase = {
    agent_id: 'kodama' as const,
    revision: '0',
    active_rows: [],
    active_rows_sha256: digestFleetRuntimeObservationMaterial([]),
    pending_count: 0,
    received_count: 0,
    in_progress_count: 0,
  }
  return {
    schema_version: 'fleet-runtime-v1/observation/v2',
    contract_revision: 2,
    observed_at: '2026-08-12T01:00:01.000Z',
    source,
    queue: {
      ...queueBase,
      queue_observation_id: digestFleetRuntimeObservationMaterial(fleetRuntimeQueueObservationIdMaterial(source, queueBase)),
    },
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

function requestFor(
  stage: FleetRuntimeStage = 'N40-P4-CANARY-VERIFY',
  operation: FleetRuntimeOperation = 'CANARY_COLD_START',
  canary: FleetRuntimeTarget = 'watchout/kodama',
): FleetRuntimeRequest {
  const exactSubject = subject()
  const targets = targetsFor(stage, canary)
  const request: FleetRuntimeRequest = {
    schema_version: 'fleet-runtime-v1/request/v2',
    request_id: `FRV1-${stage}-${operation}-001`,
    request_digest: SHA_A,
    subject: exactSubject,
    owner_decision: {
      url: 'https://github.com/watchout/ai-dev-framework/issues/576#issuecomment-9999999999',
      actor: 'watchout',
      created_at: '2026-08-12T01:00:00Z',
      updated_at: '2026-08-12T01:00:00Z',
      raw_api_body_sha256: rawDigest(OWNER_BODY),
      node_id: FLEET_RUNTIME_V1_CONTRACT.node_id,
      result: 'PASS',
      stage_authority_matrix: authorityMatrix(canary),
      canary_target: canary,
    },
    executor_identity: { ...EXECUTOR },
    stage_id: stage,
    operation,
    predecessor_receipt: predecessor(stage, operation, exactSubject),
    idempotency_key: `frv1:N40:${'0'.repeat(64)}`,
    target_scope: {
      repositories: targets,
      canonical_digest: digest(targets),
    },
    payload_digest: FLEET_RUNTIME_V1_CONTRACT.payload_digest,
    queue_observation: queueObservation(),
    preimages: targets.map(frozenFleetRuntimePreimage),
  }
  return resignRequest(request)
}

function rootGoalReadback(target: FleetRuntimeTarget): FleetRuntimeRootGoalReadback {
  const checkout = target === 'watchout/agent-comms-mcp'
    ? '/Users/yuji/Developer/agent-comms-mcp'
    : target === 'watchout/agent-memory'
      ? '/Users/yuji/Developer/agent-memory'
      : target === 'watchout/aun-platform'
        ? '/Users/yuji/Developer/aun-platform'
        : target === 'watchout/kodama'
          ? '/Users/yuji/Developer/kodama'
          : '/Users/yuji/Developer/misell'
  return {
    repository: target,
    store_path: `${checkout}/.framework/runtime/goal-convergence.json`,
    schema: 'shirube-goal-runtime-command/v1',
    verdict: 'PASS',
    store_code: 'FOUND',
    runtime_digest: SHA_A,
    root: { root_goal_id: 'ROOT-N35-FIXTURE' },
    write_count: 0,
    effect_delivery_performed: false,
  }
}

function preflightFor(request: FleetRuntimeRequest): FleetRuntimePreflightReceipt {
  return {
    schema_version: 'fleet-runtime-v1/preflight-receipt/v2',
    request_digest: request.request_digest,
    observed_at: '2026-08-12T01:00:02Z',
    owner_decision_readback: structuredClone(request.owner_decision),
    owner_decision_raw_body: OWNER_BODY,
    predecessor_receipt_readback: structuredClone(request.predecessor_receipt),
    predecessor_receipt_raw_body: PREDECESSOR_BODY,
    target_preimages: structuredClone(request.preimages),
    queue_observation: structuredClone(request.queue_observation),
    root_goal_readbacks: request.target_scope.repositories.map(rootGoalReadback),
    filesystem_write_count: 0,
    database_write_count: 0,
    queue_write_count: 0,
    protected_effect_count: 0,
  }
}

function postimage(request: FleetRuntimeRequest, index: number) {
  const preimage = request.preimages[index]
  return {
    head_commit: preimage.head_commit,
    tree: preimage.tree,
    runtime_surface_sha256: preimage.runtime_surface_sha256,
    distribution_surface_sha256: preimage.distribution_surface_sha256,
    release: { commit: request.subject.release_commit, tree: request.subject.release_tree },
    config: { exact: true },
    policy: { exact: true },
    root: { root_goal_id: 'ROOT-N35-FIXTURE' },
    goal: { state: 'READY' },
    runtime_digest: SHA_A,
    runtime_instance_id: `fixture-runtime-${index}`,
  }
}

function receiptFor(request: FleetRuntimeRequest): FleetRuntimeEffectReceipt {
  const receipt: FleetRuntimeEffectReceipt = {
    schema_version: request.operation === 'ROLLBACK'
      ? 'fleet-runtime-v1/rollback-receipt/v2'
      : request.operation === 'REAPPLY'
        ? 'fleet-runtime-v1/reapply-receipt/v2'
        : 'fleet-runtime-v1/effect-receipt/v2',
    receipt_id: `RCP-${request.request_id}`,
    receipt_sha256: SHA_A,
    request_id: request.request_id,
    request_digest: request.request_digest,
    idempotency_key: request.idempotency_key,
    stage_id: request.stage_id,
    operation: request.operation,
    effect_id: `EFFECT-${request.request_id}`,
    actor_agent_id: request.executor_identity.actor_agent_id,
    active_function: request.executor_identity.active_function,
    started_at: '2026-08-12T01:00:03Z',
    completed_at: '2026-08-12T01:00:04Z',
    result: 'PASS',
    per_target: request.target_scope.repositories.map((target, index) => ({
      repository: target,
      preimage: structuredClone(request.preimages[index]),
      postimage: postimage(request, index),
      queue_observation: target === 'watchout/kodama' ? structuredClone(request.queue_observation) : null,
      root_goal_readback: rootGoalReadback(target),
    })),
    duplicate_effect_count: 0,
    unauthorized_effect_count: 0,
  }
  if (request.operation === 'ROLLBACK') {
    receipt.forward_effect_receipt_sha256 = request.predecessor_receipt.sha256
    receipt.target_repository = request.target_scope.repositories[0]
    receipt.restored_preimage = structuredClone(request.preimages[0])
    receipt.fresh_runtime_instance_readback = true
    receipt.queue_counts_unchanged = true
  }
  if (request.operation === 'REAPPLY') {
    receipt.rollback_receipt_sha256 = SHA_A
    receipt.recovery_receipt_sha256 = request.predecessor_receipt.sha256
    receipt.target_repository = request.target_scope.repositories[0]
    receipt.payload_digest = request.payload_digest
    receipt.postimage = postimage(request, 0)
  }
  receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt)
  return receipt
}

function emptyCounters(): Counters {
  return {
    preflight_reads: 0,
    invocation_reservations: 0,
    invocation_completions: 0,
    effect_port_calls: 0,
    protected_effects: 0,
  }
}

function portsFor(
  counters: Counters,
  options: {
    mutatePreflight?: (receipt: FleetRuntimePreflightReceipt) => void
    mutateReceipt?: (receipt: FleetRuntimeEffectReceipt) => void
  } = {},
): FleetRuntimePorts {
  const states = new Map<string, Awaited<ReturnType<FleetRuntimePorts['persistence']['load']>>>()
  const effectReceipts = new Map<string, FleetRuntimeEffectReceipt>()
  return {
    preflight: {
      async inspect(request) {
        counters.preflight_reads += 1
        const receipt = preflightFor(request as FleetRuntimeRequest)
        options.mutatePreflight?.(receipt)
        return receipt
      },
    },
    persistence: {
      async load(key) {
        const state = states.get(key)
        return state ? structuredClone(state) : null
      },
      async reserve_once(state) {
        const existing = states.get(state.idempotency_key)
        if (existing) return { acquired: false, state: structuredClone(existing) }
        counters.invocation_reservations += 1
        states.set(state.idempotency_key, structuredClone(state))
        return { acquired: true, state: structuredClone(state) }
      },
      async complete_once(state) {
        const existing = states.get(state.idempotency_key)
        if (!existing) throw new Error('TEST_COMPLETION_WITHOUT_RESERVATION')
        if (existing.status === 'completed') return structuredClone(existing)
        counters.invocation_completions += 1
        states.set(state.idempotency_key, structuredClone(state))
        return structuredClone(state)
      },
    },
    effect: {
      async perform_once(request) {
        const existing = effectReceipts.get(request.idempotency_key)
        if (existing) return structuredClone(existing)
        counters.effect_port_calls += 1
        const receipt = receiptFor(request as FleetRuntimeRequest)
        options.mutateReceipt?.(receipt)
        if (options.mutateReceipt) receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt)
        effectReceipts.set(request.idempotency_key, structuredClone(receipt))
        return receipt
      },
    },
  }
}

async function expectCode(operation: () => Promise<unknown> | unknown, code: FleetRuntimeV1Error['code']): Promise<void> {
  try {
    await operation()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(FleetRuntimeV1Error)
    expect((error as FleetRuntimeV1Error).code).toBe(code)
  }
}

function expectNoPortCalls(counters: Counters): void {
  expect(counters).toEqual(emptyCounters())
}

describe('FLEET_RUNTIME_V1 no-live-effect executable adapter', () => {
  test('binds the exact ADF release, graph, payload, and precondition contract', () => {
    expect(FLEET_RUNTIME_V1_CONTRACT.contract_sha256).toBe('sha256:da9184b1bd0df20b27c1a7cf19ae906bdd72076bc08f489352d14d1c922dfdf2')
    expect(FLEET_RUNTIME_V1_CONTRACT.graph_digest).toBe('sha256:8301ac86c6e32f642222cb62f6ea91490fe409f3ca767cd79a452f49be22187a')
    expect(FLEET_RUNTIME_V1_CONTRACT.payload_digest).toBe('sha256:58eb8e4f49a8c2f42087ce17956bbef571d4650321e9c25e15726c0529c58973')
    expect(FLEET_RUNTIME_V1_TARGETS).toHaveLength(5)
  })

  test('binds the merged amendment identity and exact ordered five-target effective view', () => {
    expect(FLEET_RUNTIME_V1_PREIMAGE_AMENDMENT).toEqual({
      amendment_id: 'FLEET-RUNTIME-V1-PREIMAGE-AMENDMENT-20260815-001',
      artifact_state: 'FINAL_IMMUTABLE',
      schema_version: 'shirube-v4.1/fleet-runtime-v1-preimage-amendment/v1',
      repository: 'watchout/ai-dev-framework',
      merge_commit: '810981f049311cb2fede4f72fff651b1d4e8e04e',
      merge_tree: 'ea48787485b5f4bca35d9788f46ede2424b09eb0',
      path: 'releases/shirube-v4.1/fleet-runtime-v1-preimage-amendment-20260815-001.json',
      amendment_sha256: 'sha256:92b4ce3630c2f58476240c84b5b794adc5263e23e07064aabd4ee12f54213567',
      amendment_byte_sha256: 'sha256:00b323018d0219bcd2869d3700e54be06a25d62f921f2755d13e2454cd6ea285',
      original_contract_sha256: FLEET_RUNTIME_V1_CONTRACT.contract_sha256,
      original_contract_byte_sha256: 'sha256:7936bd8d92c73f54f71c67c744a4e8fb5339f69c7070f709449fba178dd73ebd',
      original_payload_byte_sha256: 'sha256:6a7bce4ab348d3cd4ccc290aed06fe41dff7db4b7c690cd0b031b7ddc30b63a9',
      effective_view_mode: 'EXACT_ORDERED_COMPLETE_PREIMAGE_RECORD_SUBSTITUTION_ONLY',
      required_record_fields_in_order: [
        'repository',
        'required_base_branch',
        'head_commit',
        'tree',
        'runtime_surface_entry_count',
        'runtime_surface_sha256',
        'distribution_surface_entry_count',
        'distribution_surface_sha256',
      ],
    })
    expect(FLEET_RUNTIME_V1_TARGETS.map(frozenFleetRuntimePreimage)).toEqual(EFFECTIVE_PREIMAGES)
    for (const preimage of EFFECTIVE_PREIMAGES) {
      expect(Object.keys(preimage)).toEqual(FLEET_RUNTIME_V1_PREIMAGE_AMENDMENT.required_record_fields_in_order)
    }
  })

  test('request digest and frozen idempotency tuple bind all eight effective-preimage fields', () => {
    const baseline = requestFor('N50-P5-PLACEMENT', 'FIVE_TARGET_PLACEMENT')
    const mutations: Array<(preimage: FleetRuntimePreimage) => void> = [
      preimage => { preimage.repository = 'watchout/agent-memory' },
      preimage => { preimage.required_base_branch = 'develop' },
      preimage => { preimage.head_commit = 'f'.repeat(40) },
      preimage => { preimage.tree = 'f'.repeat(40) },
      preimage => { preimage.runtime_surface_entry_count += 1 },
      preimage => { preimage.runtime_surface_sha256 = SHA_A },
      preimage => { preimage.distribution_surface_entry_count += 1 },
      preimage => { preimage.distribution_surface_sha256 = SHA_A },
    ]

    for (const mutate of mutations) {
      const drifted = structuredClone(baseline)
      mutate(drifted.preimages[0])
      expect(computeFleetRuntimeRequestDigest(drifted)).not.toBe(baseline.request_digest)
      expect(computeFleetRuntimeIdempotencyKey(drifted)).not.toBe(baseline.idempotency_key)
    }
  })

  test('executes one injected canary effect and suppresses an exact replay', async () => {
    const counters = emptyCounters()
    const ports = portsFor(counters)
    const request = requestFor('N40-P4-CANARY-VERIFY', 'CANARY_COLD_START', 'watchout/agent-comms-mcp')

    const first = await executeFleetRuntimeV1(request, ports)
    const second = await executeFleetRuntimeV1(request, ports)

    expect(second).toEqual(first)
    expect(first.result).toBe('PASS')
    expect(first.per_target[0].preimage).toEqual(EFFECTIVE_PREIMAGES[0])
    expect(counters).toEqual({
      preflight_reads: 2,
      invocation_reservations: 1,
      invocation_completions: 1,
      effect_port_calls: 1,
      protected_effects: 0,
    })
  })

  test('permits five-target placement while preserving aun-platform as placement-only', async () => {
    const counters = emptyCounters()
    const request = requestFor('N50-P5-PLACEMENT', 'FIVE_TARGET_PLACEMENT')
    const receipt = await executeFleetRuntimeV1(request, portsFor(counters))

    expect(receipt.per_target).toHaveLength(5)
    expect(request.queue_observation.schema_version).toBe('fleet-runtime-v1/observation/v2')
    expect(counters.effect_port_calls).toBe(1)
    expect(counters.protected_effects).toBe(0)
  })

  test('executes rollback only with its exact forward receipt and restoration fields', async () => {
    const counters = emptyCounters()
    const request = requestFor('N40-P4-CANARY-VERIFY', 'ROLLBACK', 'watchout/agent-memory')
    const receipt = await executeFleetRuntimeV1(request, portsFor(counters))

    expect(receipt.schema_version).toBe('fleet-runtime-v1/rollback-receipt/v2')
    expect(receipt.forward_effect_receipt_sha256).toBe(request.predecessor_receipt.sha256)
    expect(receipt.restored_preimage).toEqual(EFFECTIVE_PREIMAGES[1])
    expect(receipt.restored_preimage).toEqual(request.preimages[0])
    expect(receipt.queue_counts_unchanged).toBe(true)
    expect(counters.protected_effects).toBe(0)
  })

  test('executes reapply only with rollback and recovery receipt links', async () => {
    const counters = emptyCounters()
    const request = requestFor('N40-P4-CANARY-VERIFY', 'REAPPLY')
    const receipt = await executeFleetRuntimeV1(request, portsFor(counters))

    expect(receipt.schema_version).toBe('fleet-runtime-v1/reapply-receipt/v2')
    expect(receipt.rollback_receipt_sha256).toBe(SHA_A)
    expect(receipt.recovery_receipt_sha256).toBe(request.predecessor_receipt.sha256)
    expect(receipt.payload_digest).toBe(FLEET_RUNTIME_V1_CONTRACT.payload_digest)
    expect(counters.protected_effects).toBe(0)
  })

  test.each([
    ['v1 request revision', 'INVALID_REQUEST', (request: FleetRuntimeRequest) => { (request as any).schema_version = 'fleet-runtime-v1/request/v1' }],
    ['subject drift', 'SUBJECT_MISMATCH', (request: FleetRuntimeRequest) => { request.subject.graph_digest = SHA_A }],
    ['precondition decision replay', 'PRECONDITION_BUILD_NOT_OPERATIONAL_AUTHORITY', (request: FleetRuntimeRequest) => {
      request.owner_decision.url = FLEET_RUNTIME_V1_CONTRACT.precondition_build_decision_url
      request.owner_decision.raw_api_body_sha256 = FLEET_RUNTIME_V1_CONTRACT.precondition_build_decision_sha256
    }],
    ['owner actor mismatch', 'OWNER_DECISION_INVALID', (request: FleetRuntimeRequest) => { request.owner_decision.actor = 'not-watchout' }],
    ['mutable owner comment', 'OWNER_DECISION_INVALID', (request: FleetRuntimeRequest) => { request.owner_decision.updated_at = '2026-08-12T01:00:01Z' }],
    ['recommendation without selection', 'OWNER_DECISION_INVALID', (request: FleetRuntimeRequest) => { request.owner_decision.canary_target = null }],
    ['stage skip', 'STAGE_PREDECESSOR_MISMATCH', (request: FleetRuntimeRequest) => { request.predecessor_receipt.node_id = 'N20-WORKFLOW-CANDIDATE' }],
    ['executor mismatch', 'EXECUTOR_AUTHORITY_MISMATCH', (request: FleetRuntimeRequest) => { request.executor_identity.actor_agent_id = 'other-executor' }],
    ['gate function as executor', 'EXECUTOR_AUTHORITY_MISMATCH', (request: FleetRuntimeRequest) => {
      request.owner_decision.stage_authority_matrix[0].active_function = 'scenario_verification_gate'
      request.executor_identity.active_function = 'scenario_verification_gate'
    }],
    ['target expansion', 'TARGET_SCOPE_MISMATCH', (request: FleetRuntimeRequest) => { (request.target_scope.repositories as string[]).push('watchout/not-frozen') }],
    ['payload mismatch', 'PAYLOAD_MISMATCH', (request: FleetRuntimeRequest) => { request.payload_digest = SHA_A }],
    ['nonzero queue', 'QUEUE_PRECHECK_NOT_ZERO', (request: FleetRuntimeRequest) => { request.queue_observation.queue.pending_count = 1 }],
    ['preimage branch drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].required_base_branch = 'develop' }],
    ['preimage runtime count drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].runtime_surface_entry_count += 1 }],
    ['preimage distribution count drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].distribution_surface_entry_count += 1 }],
    ['preimage head drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].head_commit = 'f'.repeat(40) }],
    ['preimage tree drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].tree = 'f'.repeat(40) }],
    ['preimage runtime digest drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].runtime_surface_sha256 = SHA_A }],
    ['preimage distribution digest drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].distribution_surface_sha256 = SHA_A }],
  ] as const)('rejects %s before every port with %s', async (_name, code, mutate) => {
    const counters = emptyCounters()
    const request = requestFor()
    mutate(request)
    resignRequest(request)

    await expectCode(() => executeFleetRuntimeV1(request, portsFor(counters)), code)
    expectNoPortCalls(counters)
  })

  test.each([
    ['order drift', (request: FleetRuntimeRequest) => { [request.preimages[0], request.preimages[1]] = [request.preimages[1], request.preimages[0]] }],
    ['missing row', (request: FleetRuntimeRequest) => { request.preimages.pop() }],
    ['extra row', (request: FleetRuntimeRequest) => { request.preimages.push(structuredClone(request.preimages[0])) }],
    ['field inversion', (request: FleetRuntimeRequest) => {
      const preimage = request.preimages[0]
      ;[preimage.runtime_surface_entry_count, preimage.distribution_surface_entry_count] = [preimage.distribution_surface_entry_count, preimage.runtime_surface_entry_count]
    }],
  ] as const)('rejects preimage %s before every port', async (_name, mutate) => {
    const counters = emptyCounters()
    const request = requestFor('N50-P5-PLACEMENT', 'FIVE_TARGET_PLACEMENT')
    mutate(request)
    resignRequest(request)

    await expectCode(() => executeFleetRuntimeV1(request, portsFor(counters)), 'PREIMAGE_MISMATCH')
    expectNoPortCalls(counters)
  })

  test.each([
    ['initial canary', 'CANARY_COLD_START', 'watchout/agent-comms-mcp'],
    ['rollback restoration', 'ROLLBACK', 'watchout/agent-memory'],
  ] as const)('rejects amended FROM preimage during %s before every port', async (_name, operation, target) => {
    const counters = emptyCounters()
    const request = requestFor('N40-P4-CANARY-VERIFY', operation, target)
    request.preimages[0] = structuredClone(AMENDED_FROM_PREIMAGES[target])
    resignRequest(request)

    await expectCode(() => executeFleetRuntimeV1(request, portsFor(counters)), 'PREIMAGE_MISMATCH')
    expectNoPortCalls(counters)
  })

  test('rejects request digest tamper before every port', async () => {
    const counters = emptyCounters()
    const request = requestFor()
    request.request_digest = `sha256:${'b'.repeat(64)}`

    await expectCode(() => executeFleetRuntimeV1(request, portsFor(counters)), 'REQUEST_DIGEST_MISMATCH')
    expectNoPortCalls(counters)
  })

  test('rejects idempotency key tamper before every port', async () => {
    const counters = emptyCounters()
    const request = requestFor()
    request.idempotency_key = `frv1:N40:${'f'.repeat(64)}`

    await expectCode(() => executeFleetRuntimeV1(request, portsFor(counters)), 'IDEMPOTENCY_KEY_MISMATCH')
    expectNoPortCalls(counters)
  })

  test('blocks N60 while aun-platform has no live runtime binding', async () => {
    const counters = emptyCounters()
    const request = requestFor('N60-P6-APPLICATION', 'FIVE_TARGET_COLD_START')

    await expectCode(() => executeFleetRuntimeV1(request, portsFor(counters)), 'TARGET_RUNTIME_BINDING_MISSING')
    expectNoPortCalls(counters)
  })

  test('rejects a preflight owner-decision readback mismatch before persistence and effect', async () => {
    const counters = emptyCounters()
    const request = requestFor()
    const ports = portsFor(counters, {
      mutatePreflight(receipt) {
        receipt.owner_decision_readback.raw_api_body_sha256 = SHA_A
      },
    })

    await expectCode(() => executeFleetRuntimeV1(request, ports), 'PREFLIGHT_RECEIPT_MISMATCH')
    expect(counters).toEqual({ ...emptyCounters(), preflight_reads: 1 })
  })

  test('rejects a live preimage drift before persistence and effect', async () => {
    const counters = emptyCounters()
    const request = requestFor()
    const ports = portsFor(counters, {
      mutatePreflight(receipt) {
        receipt.target_preimages[0].tree = 'e'.repeat(40)
      },
    })

    await expectCode(() => executeFleetRuntimeV1(request, ports), 'PREFLIGHT_RECEIPT_MISMATCH')
    expect(counters).toEqual({ ...emptyCounters(), preflight_reads: 1 })
  })

  test('rejects raw owner-decision body drift before persistence and effect', async () => {
    const counters = emptyCounters()
    const request = requestFor()
    const ports = portsFor(counters, {
      mutatePreflight(receipt) {
        receipt.owner_decision_raw_body += '\n'
      },
    })

    await expectCode(() => executeFleetRuntimeV1(request, ports), 'PREFLIGHT_RECEIPT_MISMATCH')
    expect(counters).toEqual({ ...emptyCounters(), preflight_reads: 1 })
  })

  test('rejects a malformed effect receipt without completing or activating a successor', async () => {
    const counters = emptyCounters()
    const request = requestFor()
    const ports = portsFor(counters, {
      mutateReceipt(receipt) {
        receipt.unauthorized_effect_count = 1
      },
    })

    await expectCode(() => executeFleetRuntimeV1(request, ports), 'EFFECT_RECEIPT_INVALID')
    expect(counters).toEqual({
      preflight_reads: 1,
      invocation_reservations: 1,
      invocation_completions: 0,
      effect_port_calls: 1,
      protected_effects: 0,
    })
  })

  test('prepare is deterministic and performs no I/O or effect', () => {
    const request = requestFor()
    const first = prepareFleetRuntimeV1Request(request)
    const second = prepareFleetRuntimeV1Request(request)

    expect(first).toEqual(second)
    expect(first.request_digest).toBe(computeFleetRuntimeRequestDigest(first))
    expect(first.idempotency_key).toBe(computeFleetRuntimeIdempotencyKey(first))
  })
})
