import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  FLEET_RUNTIME_V1_CONTRACT,
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
  type FleetRuntimePreflightReceipt,
  type FleetRuntimeRequest,
  type FleetRuntimeRootGoalReadback,
  type FleetRuntimeStage,
  type FleetRuntimeTarget,
} from '../../core/fleet-runtime-v1-adapter'

const SHA_A = `sha256:${'a'.repeat(64)}`
const OWNER_BODY = '{"decision":"N35 PASS","actor":"watchout","fixture":true}'
const PREDECESSOR_BODY = '{"result":"PASS","fixture":true}'
const EXECUTOR = { actor_agent_id: 'aun-runtime-executor', active_function: 'runtime_recovery_executor' }

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

function requestFor(
  stage: FleetRuntimeStage = 'N40-P4-CANARY-VERIFY',
  operation: FleetRuntimeOperation = 'CANARY_COLD_START',
  canary: FleetRuntimeTarget = 'watchout/kodama',
): FleetRuntimeRequest {
  const exactSubject = subject()
  const targets = targetsFor(stage, canary)
  const request: FleetRuntimeRequest = {
    schema_version: 'fleet-runtime-v1/request/v1',
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
    queue_precheck: {
      source_receipt_sha256: SHA_A,
      observed_at: '2026-08-12T01:00:01Z',
      entries: targets
        .filter(target => target !== 'watchout/aun-platform')
        .map(target => ({
          repository: target,
          agent_id: target === 'watchout/agent-comms-mcp'
            ? 'aun'
            : target === 'watchout/agent-memory'
              ? 'kusabi'
              : target === 'watchout/kodama'
                ? 'kodama'
                : 'misell',
          pending_count: 0,
          active_count: 0,
        })),
    },
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
    schema_version: 'fleet-runtime-v1/preflight-receipt/v1',
    request_digest: request.request_digest,
    observed_at: '2026-08-12T01:00:02Z',
    owner_decision_readback: structuredClone(request.owner_decision),
    owner_decision_raw_body: OWNER_BODY,
    predecessor_receipt_readback: structuredClone(request.predecessor_receipt),
    predecessor_receipt_raw_body: PREDECESSOR_BODY,
    target_preimages: structuredClone(request.preimages),
    queue_precheck: structuredClone(request.queue_precheck),
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
      ? 'fleet-runtime-v1/rollback-receipt/v1'
      : request.operation === 'REAPPLY'
        ? 'fleet-runtime-v1/reapply-receipt/v1'
        : 'fleet-runtime-v1/effect-receipt/v1',
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
      queue_precheck: request.queue_precheck.entries.find(entry => entry.repository === target) ?? null,
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

  test('executes one injected canary effect and suppresses an exact replay', async () => {
    const counters = emptyCounters()
    const ports = portsFor(counters)
    const request = requestFor()

    const first = await executeFleetRuntimeV1(request, ports)
    const second = await executeFleetRuntimeV1(request, ports)

    expect(second).toEqual(first)
    expect(first.result).toBe('PASS')
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
    expect(request.queue_precheck.entries).toHaveLength(4)
    expect(counters.effect_port_calls).toBe(1)
    expect(counters.protected_effects).toBe(0)
  })

  test('executes rollback only with its exact forward receipt and restoration fields', async () => {
    const counters = emptyCounters()
    const request = requestFor('N40-P4-CANARY-VERIFY', 'ROLLBACK')
    const receipt = await executeFleetRuntimeV1(request, portsFor(counters))

    expect(receipt.schema_version).toBe('fleet-runtime-v1/rollback-receipt/v1')
    expect(receipt.forward_effect_receipt_sha256).toBe(request.predecessor_receipt.sha256)
    expect(receipt.restored_preimage).toEqual(request.preimages[0])
    expect(receipt.queue_counts_unchanged).toBe(true)
    expect(counters.protected_effects).toBe(0)
  })

  test('executes reapply only with rollback and recovery receipt links', async () => {
    const counters = emptyCounters()
    const request = requestFor('N40-P4-CANARY-VERIFY', 'REAPPLY')
    const receipt = await executeFleetRuntimeV1(request, portsFor(counters))

    expect(receipt.schema_version).toBe('fleet-runtime-v1/reapply-receipt/v1')
    expect(receipt.rollback_receipt_sha256).toBe(SHA_A)
    expect(receipt.recovery_receipt_sha256).toBe(request.predecessor_receipt.sha256)
    expect(receipt.payload_digest).toBe(FLEET_RUNTIME_V1_CONTRACT.payload_digest)
    expect(counters.protected_effects).toBe(0)
  })

  test.each([
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
    ['nonzero queue', 'QUEUE_PRECHECK_NOT_ZERO', (request: FleetRuntimeRequest) => { request.queue_precheck.entries[0].pending_count = 1 }],
    ['canary preimage drift', 'PREIMAGE_MISMATCH', (request: FleetRuntimeRequest) => { request.preimages[0].tree = 'f'.repeat(40) }],
  ] as const)('rejects %s before every port with %s', async (_name, code, mutate) => {
    const counters = emptyCounters()
    const request = requestFor()
    mutate(request)
    resignRequest(request)

    await expectCode(() => executeFleetRuntimeV1(request, portsFor(counters)), code)
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
