import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  type FleetRuntimePreflightReceipt,
  type FleetRuntimeRequest,
} from '../../core/fleet-runtime-v1-adapter'
import {
  ConcreteFleetRuntimeV1LocalSystem,
  FileFleetRuntimeV1Persistence,
  FleetRuntimeLocalProviderError,
  buildFleetRuntimeV1DryRunReceipt,
  executeLocalFleetRuntimeV1,
  assertExactFleetRuntimePathSet,
  parseFleetRuntimeQueueStatus,
  validateFleetRuntimeCheckoutReadback,
  validateFleetRuntimeExternalMergeBinding,
  validateFleetRuntimeImmutableSemantics,
  validateFleetRuntimeLocalReceipt,
  type FleetRuntimeLocalOperationState,
  type FleetRuntimeLocalPhase,
  type FleetRuntimeLocalPhaseContext,
  type FleetRuntimeLocalPhaseResult,
  type FleetRuntimeLocalReconcileResult,
  type FleetRuntimeLocalSystem,
} from '../../core/fleet-runtime-v1-local-provider'

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

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalFleetRuntimeJson(value)).digest('hex')}`
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

function requestFor(operation: 'CANARY_COLD_START' | 'ROLLBACK' | 'RECOVERY' | 'REAPPLY' = 'CANARY_COLD_START'): FleetRuntimeRequest {
  const exactSubject = subject()
  const request: FleetRuntimeRequest = {
    schema_version: 'fleet-runtime-v1/request/v1',
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
    queue_precheck: {
      source_receipt_sha256: SHA_A,
      observed_at: '2026-08-15T08:23:59Z',
      entries: [{ repository: 'watchout/kodama', agent_id: 'kodama', pending_count: 0, active_count: 0 }],
    },
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

function semanticOwnerBody(request: FleetRuntimeRequest): string {
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
    schema_version: 'fleet-runtime-v1/preflight-receipt/v1',
    request_digest: request.request_digest,
    observed_at: request.queue_precheck.observed_at,
    owner_decision_readback: structuredClone(request.owner_decision),
    owner_decision_raw_body: OWNER_BODY,
    predecessor_receipt_readback: structuredClone(request.predecessor_receipt),
    predecessor_receipt_raw_body: PREDECESSOR_BODY,
    target_preimages: structuredClone(request.preimages),
    queue_precheck: structuredClone(request.queue_precheck),
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
      ? 'fleet-runtime-v1/rollback-receipt/v1'
      : request.operation === 'REAPPLY'
        ? 'fleet-runtime-v1/reapply-receipt/v1'
        : 'fleet-runtime-v1/effect-receipt/v1',
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
      queue_precheck: structuredClone(request.queue_precheck.entries[0]),
      root_goal_readback: structuredClone(preflight.root_goal_readbacks[0]),
    }],
    duplicate_effect_count: 0,
    unauthorized_effect_count: 0,
  }
  if (request.operation === 'ROLLBACK') {
    receipt.forward_effect_receipt_sha256 = request.predecessor_receipt.sha256
    receipt.target_repository = 'watchout/kodama'
    receipt.restored_preimage = structuredClone(request.preimages[0])
    receipt.fresh_runtime_instance_readback = true
    receipt.queue_counts_unchanged = true
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

class FixtureSystem implements FleetRuntimeLocalSystem {
  readonly calls = new Map<FleetRuntimeLocalPhase, number>()
  mergeAvailable = true
  interruptOnceAt: FleetRuntimeLocalPhase | null = null
  reconcileInterrupted = true
  inspectCount = 0

  async inspect(request: Readonly<FleetRuntimeRequest>): Promise<FleetRuntimePreflightReceipt> {
    this.inspectCount += 1
    return preflightFor(request as FleetRuntimeRequest)
  }

  async performPhase(
    _request: Readonly<FleetRuntimeRequest>,
    _preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    _context: Readonly<FleetRuntimeLocalPhaseContext>,
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
    return { evidence: { phase, exact: true }, protected_effect_count: protectedPhase ? 1 : 0 }
  }

  async reconcilePhase(
    _request: Readonly<FleetRuntimeRequest>,
    _preflight: Readonly<FleetRuntimePreflightReceipt>,
    phase: FleetRuntimeLocalPhase,
    _context: Readonly<FleetRuntimeLocalPhaseContext>,
  ): Promise<FleetRuntimeLocalReconcileResult> {
    if (phase === 'VERIFY_EXTERNAL_MERGE' && !this.mergeAvailable) {
      throw new FleetRuntimeLocalProviderError('WAITING_INDEPENDENT_MERGE', 'fixture merge pending')
    }
    return this.reconcileInterrupted
      ? { completed: true, evidence: { phase, reconciled: true }, protected_effect_count: ['PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'COLD_START_DISCORD_KODAMA'].includes(phase) ? 1 : 0 }
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
    expect(system.inspectCount).toBe(2)
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

  test('a missing external merge receipt stops after Draft PR and resumes only by readback', async () => {
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
    system.mergeAvailable = true
    const receipt = await executeLocalFleetRuntimeV1(protectedFixtureInput({ request, stateDirectory, executeProtectedEffects: true, system }))
    expect(receipt.operation).toBe('CANARY_COLD_START')
    expect(system.calls.get('CREATE_DRAFT_PR')).toBe(1)
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
    queue.queue_precheck.entries[0].pending_count = 1
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
  })

  test('queue parsing requires fresh explicit finite nonnegative integer counters', () => {
    const now = Date.parse('2026-08-15T08:24:00Z')
    const valid = {
      observed_at: '2026-08-15T08:23:59Z',
      agents: [{ agent_id: 'kodama', queue: { pending_count: 0, received_count: 0, in_progress_count: 0 } }],
    }
    expect(parseFleetRuntimeQueueStatus(valid, now).entries[0]).toMatchObject({ pending_count: 0, active_count: 0 })
    expect(parseFleetRuntimeQueueStatus({
      observed_at: valid.observed_at,
      agents: [{ agent_id: 'kodama', queue: { pending: 0, received: 0, in_progress: 0 } }],
    }, now).entries[0]).toMatchObject({ pending_count: 0, active_count: 0 })
    const malformed: unknown[] = [
      { ...valid, observed_at: undefined },
      { ...valid, observed_at: '2026-08-15T07:00:00Z' },
      { ...valid, observed_at: 'not-a-timestamp' },
      { ...valid, observed_at: '2026-08-15T08:25:00Z' },
    ]
    for (const key of ['pending_count', 'received_count', 'in_progress_count']) {
      for (const invalidValue of [undefined, -1, 0.5, '0', Number.NaN, Number.POSITIVE_INFINITY]) {
        const queue: Record<string, unknown> = { pending_count: 0, received_count: 0, in_progress_count: 0 }
        if (invalidValue === undefined) delete queue[key]
        else queue[key] = invalidValue
        malformed.push({ ...valid, agents: [{ agent_id: 'kodama', queue }] })
      }
    }
    for (const invalid of malformed) expect(() => parseFleetRuntimeQueueStatus(invalid, now)).toThrow('READBACK_INVALID')
  })

  test('immutable owner and predecessor bodies are semantically bound, not substring-admitted', () => {
    const request = requestFor()
    const owner = semanticOwnerBody(request)
    const predecessor = semanticPredecessorBody(request)
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner, predecessor)).not.toThrow()
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner.replace('target_count: 1', 'target_count: 2'), predecessor)).toThrow('READBACK_INVALID')
    expect(() => validateFleetRuntimeImmutableSemantics(request, owner, predecessor.replace('release_tag: v4.1.0', 'release_tag: v4.1.1'))).toThrow('READBACK_INVALID')
  })

  test('external merge requires the created PR URL and exact pushed head', () => {
    const request = requestFor()
    const receipt = {
      repository: 'watchout/kodama', base: 'main', operation: request.operation, request_digest: request.request_digest,
      pr_url: 'https://github.com/watchout/kodama/pull/123', merge_commit: 'c'.repeat(40), merge_tree: 'd'.repeat(40),
    }
    const pr = {
      url: receipt.pr_url, state: 'MERGED', mergedAt: '2026-08-15T09:00:00Z', mergeCommit: { oid: receipt.merge_commit },
      headRefOid: 'e'.repeat(40), baseRefName: 'main', isDraft: false,
    }
    const input = { request, receipt, pr, createdPrUrl: receipt.pr_url, pushedHead: pr.headRefOid, observedMergeTree: receipt.merge_tree }
    expect(() => validateFleetRuntimeExternalMergeBinding(input)).not.toThrow()
    expect(() => validateFleetRuntimeExternalMergeBinding({ ...input, createdPrUrl: 'https://github.com/watchout/kodama/pull/124' })).toThrow('READBACK_INVALID')
    expect(() => validateFleetRuntimeExternalMergeBinding({ ...input, pushedHead: 'f'.repeat(40) })).toThrow('READBACK_INVALID')
    for (const field of ['repository', 'base', 'operation', 'request_digest'] as const) {
      expect(() => validateFleetRuntimeExternalMergeBinding({
        ...input, receipt: { ...receipt, [field]: field === 'repository' ? 'watchout/misell' : 'substituted' },
      })).toThrow('READBACK_INVALID')
    }
    expect(() => validateFleetRuntimeExternalMergeBinding({ ...input, observedMergeTree: 'f'.repeat(40) })).toThrow('READBACK_INVALID')
  })

  test('local receipt validates its self-digest, subject, operation, target, predecessor, and runtime image', () => {
    const request = requestFor()
    const receipt = receiptFor(request, preflightFor(request)) as FleetRuntimeEffectReceipt & Record<string, unknown>
    receipt.subject_digest = digest(request.subject)
    receipt.target_repository = 'watchout/kodama'
    receipt.predecessor_receipt_sha256 = request.predecessor_receipt.sha256
    receipt.receipt_sha256 = computeFleetRuntimeReceiptDigest(receipt)
    const expected = {
      subjectDigest: digest(request.subject), operation: request.operation, target: 'watchout/kodama',
      predecessorSha256: request.predecessor_receipt.sha256,
    }
    expect(() => validateFleetRuntimeLocalReceipt(receipt, expected)).not.toThrow()
    const foreign = structuredClone(receipt)
    foreign.subject_digest = SHA_B
    foreign.receipt_sha256 = computeFleetRuntimeReceiptDigest(foreign as FleetRuntimeEffectReceipt)
    expect(() => validateFleetRuntimeLocalReceipt(foreign, expected)).toThrow('READBACK_INVALID')
    const brokenSelf = { ...receipt, receipt_sha256: SHA_B }
    expect(() => validateFleetRuntimeLocalReceipt(brokenSelf, expected)).toThrow('READBACK_INVALID')
    for (const mutate of [
      (value: Record<string, unknown>) => { value.operation = 'ROLLBACK' },
      (value: Record<string, unknown>) => { value.target_repository = 'watchout/misell' },
      (value: Record<string, unknown>) => { value.predecessor_receipt_sha256 = SHA_B },
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

  test('the concrete receipt builder emits the complete self-digested operation chain', async () => {
    const request = requestFor()
    const preflight = preflightFor(request)
    const timestamp = '2026-08-15T08:30:00Z'
    const phases: FleetRuntimeLocalOperationState['phases'] = {}
    for (const phase of [
      'PREPARE_CLEAN_CHECKOUT', 'STAGE_EXACT_PAYLOAD', 'VERIFY_EXACT_PAYLOAD', 'CREATE_LOCAL_COMMIT',
      'PUSH_NORMAL_BRANCH', 'CREATE_DRAFT_PR', 'VERIFY_EXTERNAL_MERGE', 'PREPARE_MERGED_CHECKOUT',
      'COLD_START_DISCORD_KODAMA', 'VERIFY_LIVE_IDENTITY',
    ] as FleetRuntimeLocalPhase[]) {
      phases[phase] = { status: 'completed', started_at: timestamp, completed_at: timestamp, evidence: {}, intent: {}, protected_effect_count: 0 }
    }
    phases.VERIFY_EXTERNAL_MERGE!.evidence = {
      pr_url: 'https://github.com/watchout/kodama/pull/123', merge_commit: 'c'.repeat(40), merge_tree: 'd'.repeat(40),
    }
    phases.VERIFY_LIVE_IDENTITY!.evidence = {
      runtime_instance_id: 'runtime-fresh', inventory: { agent_id: 'kodama' },
      remote_image: {
        head_commit: 'c'.repeat(40), tree: 'd'.repeat(40),
        runtime_surface_sha256: request.preimages[0].runtime_surface_sha256,
        distribution_surface_sha256: request.preimages[0].distribution_surface_sha256,
      },
    }
    const state: FleetRuntimeLocalOperationState = {
      schema_version: 'fleet-runtime-v1/local-operation-state/v1', request_id: request.request_id,
      request_digest: request.request_digest, idempotency_key: request.idempotency_key, operation: request.operation, phases,
    }
    const receipt = await new ConcreteFleetRuntimeV1LocalSystem().buildReceipt(request, preflight, state)
    expect(receipt.receipt_sha256).toBe(computeFleetRuntimeReceiptDigest(receipt))
    expect(receipt).toMatchObject({
      subject_digest: digest(request.subject), predecessor_receipt_sha256: request.predecessor_receipt.sha256,
      target_repository: 'watchout/kodama', merge_commit: 'c'.repeat(40), merge_tree: 'd'.repeat(40),
    })
  })

  test('payload path set blocks omissions, extras, reordering, and duplicates', () => {
    const paths = Array.from({ length: 24 }, (_, index) => `payload/${String(index).padStart(2, '0')}.txt`)
    expect(() => assertExactFleetRuntimePathSet(paths, [...paths], 'fixture')).not.toThrow()
    expect(() => assertExactFleetRuntimePathSet(paths, paths.slice(1), 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimePathSet(paths, [...paths, 'payload/extra.txt'], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimePathSet(paths, [paths[1], paths[0], ...paths.slice(2)], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
    expect(() => assertExactFleetRuntimePathSet(paths, [paths[0], paths[0], ...paths.slice(2)], 'fixture')).toThrow('PAYLOAD_VERIFICATION_FAILED')
  })

  test('remote suffix lookalikes and local paths containing github.com are rejected', () => {
    const exact = {
      checkout_path: '/safe/state/invocations/key/checkout', state_directory: '/safe/state', canonical_path: '/Users/yuji/Developer/kodama',
      remote: 'https://github.com/watchout/kodama.git', head: 'a'.repeat(40), tree: 'b'.repeat(40), status_porcelain: '',
    }
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, remote: 'https://evil.example/watchout/kodama.git' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, remote: '/tmp/github.com/watchout/kodama.git' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, remote: 'https://github.com.evil/watchout/kodama.git' })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, expected_head: 'c'.repeat(40) })).toThrow('UNSAFE_CHECKOUT')
    expect(() => validateFleetRuntimeCheckoutReadback({ ...exact, expected_tree: 'c'.repeat(40) })).toThrow('UNSAFE_CHECKOUT')
  })

  test.each(['PREPARE_MERGED_CHECKOUT', 'VERIFY_EXACT_PREIMAGE', 'COLD_START_DISCORD_KODAMA', 'VERIFY_LIVE_IDENTITY'] as const)(
    '%s crash readback rejects a clean but stale exact-repository checkout',
    phase => {
      const stale = {
        checkout_path: '/safe/state/invocations/key/checkout', state_directory: '/safe/state', canonical_path: '/Users/yuji/Developer/kodama',
        remote: 'https://github.com/watchout/kodama.git', head: 'a'.repeat(40), tree: 'b'.repeat(40), status_porcelain: '',
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
