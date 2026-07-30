import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  admitAunReceipt,
  canonicalJson,
  classifyDelivery,
  commitControllerTransition,
  deriveIdempotencyKey,
  deriveRuntimeStateDigest,
  digestObject,
  sha256Hex,
  validateReceiptWire,
  type AunAdmissionRequest,
  type AunAdmissionStore,
  type AuthoritativeReceiptEnvelope,
  type ControllerStore,
  type ControllerTransitionRequest,
  type LocalConsumptionRecord,
  type RuntimePlanState,
  type TransitionBinding,
  type TransitionReceiptWire,
} from '../core/shirube-v41-transition-controller'

const d = (value: string) => digestObject({ value })
const now = '2026-07-30T01:00:00Z'
const later = '2026-07-30T02:00:00Z'

function state(
  actor = 'adf-lead',
  activeFunction = 'implementation_executor',
  next: Record<string, any> = {},
): RuntimePlanState {
  const subject = {
    repository: 'watchout/agent-comms-mcp',
    commit_sha: '8'.repeat(40),
    tree_sha: '9'.repeat(40),
    release_id: 'N6-test',
    process_identity: 'test-process',
    config_digest: d('config'),
    policy_digest: d('policy'),
    environment: 'test',
  }
  const result: RuntimePlanState = {
    root_goal_run_id: 'GOAL-RUN-V41-001',
    plan_id: 'PLAN-V41-001',
    plan_digest: d('plan'),
    generation: 2,
    graph_id: 'GRAPH-1',
    node_id: 'N8',
    parent_graph_id: null,
    parent_node_id: null,
    state_digest: '',
    subject_tuple: subject,
    actor_agent_id: actor,
    active_function: activeFunction,
    dispatch_state: 'LOCAL_READY',
    graph_state: {
      wip_limit: 1,
      terminal_predicates: [{ predicate_id: 'ROOT-DONE', status: 'OPEN', generation: 2, subject_tuple_digest: digestObject(subject), evidence_ref: null, evidence_digest: null }],
      nodes: [
        {
          node_id: 'N8', plan_order: 8, depends_on: [], lifecycle_state: 'IN_PROGRESS',
          actor_agent_id: actor, active_function: activeFunction, maker_agent_id: null,
          work_class: 'IMPLEMENTATION', typed_wait_key: null, protected_decision_key: null,
          owner_transport_available: false, destination_registered: true,
          destination_owner_principal_id: null, destination_owner_authority_key: null,
          subject_tuple: structuredClone(subject), allowed_paths: ['core/example.ts'], required_checks: ['bun test'],
        },
        {
          node_id: 'N9', plan_order: 9, depends_on: ['N8'], lifecycle_state: 'PLANNED',
          actor_agent_id: 'codex-audit', active_function: 'evidence_audit_gate', maker_agent_id: 'adf-lead',
          work_class: 'INDEPENDENT_EVIDENCE_AUDIT', typed_wait_key: null, protected_decision_key: null,
          owner_transport_available: false, destination_registered: true,
          destination_owner_principal_id: null, destination_owner_authority_key: null,
          subject_tuple: structuredClone(subject), allowed_paths: ['core/example.ts'], required_checks: ['bun test'],
          ...next,
        },
      ],
    },
    controller_adapter_id: 'controller-adapter-1',
    controller_instance_id: 'controller-instance-1',
    controller_version: 'shirube-v4.1-controller/1',
  }
  result.state_digest = deriveRuntimeStateDigest(result)
  return result
}

function request(target = state()): ControllerTransitionRequest {
  const nextNode = target.graph_state.nodes[1]
  return {
    expected_state: structuredClone(target),
    result: {
      root_goal_run_id: target.root_goal_run_id,
      plan_id: target.plan_id,
      plan_digest: target.plan_digest,
      generation: target.generation,
      graph_id: target.graph_id,
      node_id: target.node_id,
      parent_graph_id: target.parent_graph_id,
      parent_node_id: target.parent_node_id,
      result_digest: d('result'),
      actor_agent_id: target.actor_agent_id,
      active_function: target.active_function,
      subject_tuple: structuredClone(target.subject_tuple),
      evidence_refs: [{ ref: 'https://evidence.invalid/exact', digest: d('evidence') }],
      terminal_predicate_verified: true,
    },
    proposal: nextNode ? {
      node_id: nextNode.node_id,
      destination_actor_agent_id: nextNode.actor_agent_id,
      destination_active_function: nextNode.active_function,
    } : {},
    controller_issuer_agent_id: 'adf-lead',
    receipt_id: 'TR-TEST-001',
    issued_at: now,
    expires_at: later,
    telemetry: {
      attempt_started_at: now,
      decision_completed_at: '2026-07-30T01:00:01Z',
      model: 'gpt-5',
      input_tokens: 120,
      output_tokens: 40,
      cached_tokens: 20,
    },
  }
}

class MemoryController implements ControllerStore {
  plan: RuntimePlanState
  results = new Map<string, any>()
  receipts = new Map<string, TransitionReceiptWire>()
  outbox = new Map<string, TransitionReceiptWire>()
  revision = 0
  failAt: 'receipt' | 'cas' | 'outbox' | null = null

  constructor(initial = state()) { this.plan = structuredClone(initial) }

  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({ plan: this.plan, results: [...this.results], receipts: [...this.receipts], outbox: [...this.outbox], revision: this.revision })
    try {
      return await fn({
        lockPlanState: async () => structuredClone(this.plan),
        loadResultConsumption: async (key: string) => structuredClone(this.results.get(key) ?? null),
        reserveReceiptRevision: async () => ++this.revision,
        persistReceipt: async (wire: TransitionReceiptWire) => {
          if (this.failAt === 'receipt') throw new Error('injected precommit crash')
          if (this.receipts.has(wire.receipt_payload.receipt_identity.receipt_id)) throw new Error('duplicate receipt')
          this.receipts.set(wire.receipt_payload.receipt_identity.receipt_id, structuredClone(wire))
        },
        compareAndSwapState: async (from: string, nextState: RuntimePlanState) => {
          if (this.failAt === 'cas') throw new Error('injected precommit crash')
          if (this.plan.state_digest !== from) return false
          this.plan = structuredClone(nextState)
          return true
        },
        persistResultConsumption: async (record: any) => { this.results.set(record.result_digest, structuredClone(record)) },
        insertControllerOutbox: async (wire: TransitionReceiptWire) => {
          if (this.failAt === 'outbox') throw new Error('injected precommit crash')
          this.outbox.set(wire.receipt_payload.delivery_binding.idempotency_key, structuredClone(wire))
        },
      })
    } catch (error) {
      this.plan = snapshot.plan
      this.results = new Map(snapshot.results)
      this.receipts = new Map(snapshot.receipts)
      this.outbox = new Map(snapshot.outbox)
      this.revision = snapshot.revision
      throw error
    }
  }
}

function envelope(wire: TransitionReceiptWire): AuthoritativeReceiptEnvelope {
  const transition = wire.receipt_payload.transition_binding
  return {
    wire: structuredClone(wire),
    wire_bytes: canonicalJson(wire),
    lookup_observed_store_revision: wire.receipt_payload.receipt_identity.authoritative_store_revision,
    lifecycle_state: 'ISSUED',
    dispatch_state: 'DISPATCH_PENDING',
    current_state_digest: transition.to_state_digest,
    committed_transition_record: {
      plan_digest: wire.receipt_payload.plan_binding.plan_digest,
      generation: wire.receipt_payload.plan_binding.generation,
      graph_id: wire.receipt_payload.plan_binding.graph_id,
      node_id: wire.receipt_payload.plan_binding.node_id,
      result_digest: transition.result_digest,
      from_state_digest: transition.from_state_digest,
      to_state_digest: transition.to_state_digest,
    },
  }
}

function destination(transition: TransitionBinding) {
  return {
    destination_kind: transition.destination_kind,
    destination_actor_agent_id: transition.destination_actor_agent_id,
    destination_active_function: transition.destination_active_function,
    destination_owner_principal_id: transition.destination_owner_principal_id,
    destination_owner_authority_key: transition.destination_owner_authority_key,
    owner_decision_schema: transition.owner_decision_schema,
    protected_decision_key: transition.protected_decision_key,
  }
}

function admissionRequest(wire: TransitionReceiptWire): AunAdmissionRequest {
  const payload = wire.receipt_payload
  return {
    authenticated_caller: 'controller-service',
    controller_adapter_id: payload.receipt_identity.controller_adapter_id,
    receipt_id: payload.receipt_identity.receipt_id,
    payload_sha256: wire.payload_sha256,
    now: '2026-07-30T01:30:00Z',
    expected_binding: {
      ...payload.plan_binding,
      subject_tuple_digest: payload.subject_binding.subject_tuple_digest,
      result_digest: payload.transition_binding.result_digest,
      handoff_digest: payload.transition_binding.handoff_digest,
    },
    destination: destination(payload.transition_binding),
    telemetry: {
      attempt_started_at: now,
      decision_completed_at: '2026-07-30T01:30:01Z',
      model: 'NOT_AVAILABLE',
      input_tokens: 'NOT_AVAILABLE',
      output_tokens: 'NOT_AVAILABLE',
      cached_tokens: 'NOT_AVAILABLE',
    },
  }
}

class MemoryAun implements AunAdmissionStore {
  envelope: AuthoritativeReceiptEnvelope | null
  consumptions = new Map<string, LocalConsumptionRecord>()
  idempotencies = new Map<string, LocalConsumptionRecord>()
  queues: Array<{ queue_id: string; message_id: string }> = []
  projections: Array<{ queue_id: string; message_id: string }> = []
  authenticated = true
  destinationRegistered = true
  failBeforeCommit = false

  constructor(value: AuthoritativeReceiptEnvelope | null) { this.envelope = value }

  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({ consumptions: [...this.consumptions], idempotencies: [...this.idempotencies], queues: this.queues, projections: this.projections })
    try {
      return await fn({
        authenticateControllerAdapter: async () => this.authenticated,
        loadLocalConsumption: async (adapter: string, receipt: string) => structuredClone(this.consumptions.get(`${adapter}:${receipt}`) ?? null),
        loadIdempotencyConsumption: async (adapter: string, key: string) => structuredClone(this.idempotencies.get(`${adapter}:${key}`) ?? null),
        loadAuthoritativeReceipt: async () => structuredClone(this.envelope),
        registeredDestination: async (transition: TransitionBinding) => this.destinationRegistered ? destination(transition) : null,
        insertQueueAndProjection: async (wire: TransitionReceiptWire) => {
          const queue = { queue_id: String(this.queues.length + 101), message_id: `message-${this.queues.length + 1}` }
          this.queues.push(queue)
          this.projections.push(queue)
          return queue
        },
        persistLocalConsumption: async (record: LocalConsumptionRecord) => {
          if (this.failBeforeCommit) throw new Error('injected precommit crash')
          this.consumptions.set(`${record.controller_adapter_id}:${record.receipt_id}`, structuredClone(record))
          this.idempotencies.set(`${record.controller_adapter_id}:${record.idempotency_key}`, structuredClone(record))
        },
      })
    } catch (error) {
      this.consumptions = new Map(snapshot.consumptions)
      this.idempotencies = new Map(snapshot.idempotencies)
      this.queues = snapshot.queues
      this.projections = snapshot.projections
      throw error
    }
  }
}

async function issued(): Promise<{ wire: TransitionReceiptWire; controller: MemoryController }> {
  const controller = new MemoryController()
  const result = await commitControllerTransition(controller, request())
  expect(result.verdict).toBe('PASS')
  return { wire: result.receipt_wire!, controller }
}

function rehash(value: AuthoritativeReceiptEnvelope): void {
  value.wire.payload_sha256 = sha256Hex(canonicalJson(value.wire.receipt_payload))
  value.wire_bytes = canonicalJson(value.wire)
}

describe('Shirube V4.1 transition controller', () => {
  test('same actor continuation advances state without a queue or receipt', async () => {
    const localState = state('adf-lead', 'implementation_executor', {
      actor_agent_id: 'adf-lead', active_function: 'implementation_executor', maker_agent_id: null, work_class: 'IMPLEMENTATION',
    })
    const store = new MemoryController(localState)
    const report = await commitControllerTransition(store, request(localState))
    expect(report).toMatchObject({ verdict: 'PASS', reason_code: 'LOCAL_CONTINUE', queue_rows: 0, state_transitions: 1 })
    expect(store.receipts.size).toBe(0)
    expect(store.outbox.size).toBe(0)
  })

  test('controller commit binds actor, telemetry, one receipt, and one outbox row', async () => {
    const { wire, controller } = await issued()
    expect(validateReceiptWire(wire)).toBeNull()
    expect(controller.receipts.size).toBe(1)
    expect(controller.outbox.size).toBe(1)
    expect(wire.receipt_payload.transition_binding.destination_active_function).toBe('evidence_audit_gate')
    const bad = request()
    bad.result.actor_agent_id = 'codex-audit'
    const blocked = await commitControllerTransition(new MemoryController(), bad)
    expect(blocked.reason_code).toBe('RESULT_NODE_BINDING_MISMATCH')
  })

  test('precommit failure rolls everything back and retry commits once', async () => {
    const controller = new MemoryController()
    controller.failAt = 'outbox'
    const first = await commitControllerTransition(controller, request())
    expect(first).toMatchObject({ verdict: 'BLOCK', reason_code: 'TRANSACTION_ABORTED' })
    expect([controller.receipts.size, controller.outbox.size, controller.results.size]).toEqual([0, 0, 0])
    controller.failAt = null
    const retry = await commitControllerTransition(controller, request())
    expect(retry.verdict).toBe('PASS')
    expect([controller.receipts.size, controller.outbox.size, controller.results.size]).toEqual([1, 1, 1])
  })

  test('controller recomputes dependency closure, frontmost node, WIP, and registry reachability', async () => {
    const missingDependency = state()
    missingDependency.graph_state.nodes[1].depends_on = ['OMITTED-NODE']
    missingDependency.state_digest = deriveRuntimeStateDigest(missingDependency)
    expect((await commitControllerTransition(new MemoryController(missingDependency), request(missingDependency))).reason_code).toBe('DEPENDENCY_OPEN')

    const omittedCriticalNode = state()
    omittedCriticalNode.graph_state.nodes.splice(1, 1)
    omittedCriticalNode.state_digest = deriveRuntimeStateDigest(omittedCriticalNode)
    const omittedRequest = request(omittedCriticalNode)
    omittedRequest.proposal = {}
    expect((await commitControllerTransition(new MemoryController(omittedCriticalNode), omittedRequest)).reason_code).toBe('DEPENDENCY_OPEN')

    const wrongFrontmost = state()
    wrongFrontmost.graph_state.nodes.push({
      ...structuredClone(wrongFrontmost.graph_state.nodes[1]), node_id: 'N10', plan_order: 10,
    })
    wrongFrontmost.state_digest = deriveRuntimeStateDigest(wrongFrontmost)
    const wrongFrontmostRequest = request(wrongFrontmost)
    wrongFrontmostRequest.proposal = { node_id: 'N10' }
    expect((await commitControllerTransition(new MemoryController(wrongFrontmost), wrongFrontmostRequest)).reason_code).toBe('FRONTMOST_MISMATCH')

    const overWip = state()
    overWip.graph_state.nodes.push({
      ...structuredClone(overWip.graph_state.nodes[0]), node_id: 'N7', plan_order: 7,
    })
    overWip.state_digest = deriveRuntimeStateDigest(overWip)
    expect((await commitControllerTransition(new MemoryController(overWip), request(overWip))).reason_code).toBe('WIP_LIMIT_EXCEEDED')

    const unregistered = state('adf-lead', 'implementation_executor', { destination_registered: false })
    const unregisteredStore = new MemoryController(unregistered)
    expect(await commitControllerTransition(unregisteredStore, request(unregistered))).toMatchObject({ verdict: 'BLOCK', reason_code: 'TYPED_WAIT', queue_rows: 0 })
    expect([unregisteredStore.receipts.size, unregisteredStore.outbox.size]).toEqual([0, 0])
  })

  test('non-NFC input fails before transactional receipt revision reservation', async () => {
    const target = state()
    target.graph_state.nodes[1].allowed_paths = ['cafe\u0301.ts']
    target.state_digest = deriveRuntimeStateDigest(target)
    const store = new MemoryController(target)
    const report = await commitControllerTransition(store, request(target))
    expect(report.reason_code).toBe('RECEIPT_CANONICALIZATION_FAILED')
    expect(store.revision).toBe(0)
  })

  test('AUN admission is local-first and crash-safe exactly once', async () => {
    const { wire } = await issued()
    const store = new MemoryAun(envelope(wire))
    store.failBeforeCommit = true
    expect(await admitAunReceipt(store, admissionRequest(wire))).toMatchObject({ verdict: 'BLOCK', reason_code: 'TRANSACTION_ABORTED' })
    expect([store.queues.length, store.projections.length]).toEqual([0, 0])
    store.failBeforeCommit = false
    const admitted = await admitAunReceipt(store, admissionRequest(wire))
    expect(admitted).toMatchObject({ verdict: 'PASS', reason_code: 'RECEIPT_ADMITTED', queue_rows: 1, projections: 1, effects: 0, authoritative_lookup_performed: true })
    store.envelope!.lifecycle_state = 'CONSUMED'
    store.envelope!.dispatch_state = 'ADVANCED'
    const replay = await admitAunReceipt(store, admissionRequest(wire))
    expect(replay).toMatchObject({ verdict: 'PASS', reason_code: 'OUTBOX_DUPLICATE_SUPPRESSED', queue_rows: 0, authoritative_lookup_performed: false })
    expect([store.queues.length, store.projections.length]).toEqual([1, 1])
  })

  test('wire rejects non-NFC and lone-surrogate payloads before admission', async () => {
    const { wire } = await issued()
    const nonNfc = structuredClone(wire)
    nonNfc.receipt_payload.transition_binding.delivery_subtype = 'e\u0301'
    nonNfc.payload_sha256 = sha256Hex(canonicalJson(nonNfc.receipt_payload))
    expect(validateReceiptWire(nonNfc)).toBe('RECEIPT_CANONICALIZATION_FAILED')
    const surrogate = structuredClone(wire)
    surrogate.receipt_payload.transition_binding.reason_code = '\ud800'
    surrogate.payload_sha256 = sha256Hex(canonicalJson(surrogate.receipt_payload))
    expect(validateReceiptWire(surrogate)).toBe('RECEIPT_CANONICALIZATION_FAILED')
  })

  test('frozen 33-case predecessor+successor suite stays behaviorally bound', async () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, 'fixtures/shirube-v41-transition-admission/cases.json'), 'utf8'))
    expect(fixture).toMatchObject({ predecessor_count: 17, successor_002_count: 16, composed_total: 33 })
    expect(fixture.cases).toHaveLength(33)
    expect(new Set(fixture.cases.map((entry: any) => entry.id)).size).toBe(33)
    for (const entry of fixture.cases) {
      const actual = await runFrozenOperation(entry.operation)
      expect(actual.reason, entry.id).toBe(entry.expected_reason)
      expect(actual.queueRows, entry.id).toBe(entry.expected_queue_rows)
    }
  })
})

async function runFrozenOperation(operation: string): Promise<{ reason: string; queueRows: number }> {
  const classifier = (overrides: Record<string, any>) => {
    const report = classifyDelivery({
      dependencies_complete: true, frontmost_selected: true, wip_within_limit: true,
      work_class: 'IMPLEMENTATION', actor_agent_id: 'adf-lead', active_function: 'implementation_executor',
      current_actor_agent_id: 'adf-lead', current_active_function: 'implementation_executor',
      ...overrides,
    } as any)
    return { reason: report.reason_code, queueRows: report.queue_permission === 'ALLOW_EXACTLY_ONE' ? 1 : 0 }
  }
  if (operation === 'same_actor') return classifier({})
  if (operation === 'scenario_before_dependency') return classifier({ dependencies_complete: false, work_class: 'INDEPENDENT_SCENARIO_VERIFICATION' })
  if (operation === 'protected_as_delegate') return classifier({ work_class: 'PROTECTED_SURFACE_GATE', active_function: 'protected_surface_gate', protected_decision_key: 'merge:1', proposed_delivery_class: 'AUN_DELEGATE' })
  if (operation === 'graph_assigned_actor') return classifier({ actor_agent_id: 'agent-two', current_actor_agent_id: 'adf-lead' })
  if (operation === 'graph_amendment') return classifier({ work_class: 'GRAPH_AMENDMENT', actor_agent_id: 'arc', active_function: 'control_artifact_author', current_actor_agent_id: 'adf-lead', maker_agent_id: 'adf-lead' })
  if (operation === 'unmatched_recipient') return classifier({ proposed_actor_agent_id: 'random-agent' })
  if (operation === 'protected_gate') return classifier({ work_class: 'PROTECTED_SURFACE_GATE', active_function: 'protected_surface_gate', protected_decision_key: 'merge:1' })
  if (operation === 'gate_cannot_satisfy_owner' || operation === 'gate_owner_order') return classifier({ dependencies_complete: false, work_class: 'HUMAN_OWNER_DECISION' })
  if (operation === 'human_owner') return classifier({ work_class: 'HUMAN_OWNER_DECISION', destination_owner_principal_id: 'owner-1', destination_owner_authority_key: 'owner-key', protected_decision_key: 'release:1', owner_transport_available: true })
  if (operation === 'protected_impersonation') return classifier({ work_class: 'PROTECTED_SURFACE_GATE', active_function: 'implementation_executor', protected_decision_key: 'merge:1' })
  if (operation === 'human_owner_function') {
    const { wire } = await issued()
    wire.receipt_payload.transition_binding.delivery_class = 'PROTECTED_DECISION'
    wire.receipt_payload.transition_binding.delivery_subtype = 'HUMAN_OWNER_DECISION'
    wire.receipt_payload.transition_binding.destination_kind = 'HUMAN_OWNER'
    wire.receipt_payload.transition_binding.destination_owner_principal_id = 'owner-1'
    wire.receipt_payload.transition_binding.destination_owner_authority_key = 'owner-key'
    wire.receipt_payload.transition_binding.owner_decision_schema = 'shirube-v3/owner_decision/v1'
    wire.receipt_payload.transition_binding.destination_active_function = 'implementation_executor'
    wire.payload_sha256 = sha256Hex(canonicalJson(wire.receipt_payload))
    return { reason: validateReceiptWire(wire)!, queueRows: 0 }
  }
  if (operation === 'controller_precommit_crash') {
    const store = new MemoryController(); store.failAt = 'receipt'
    const blocked = await commitControllerTransition(store, request())
    return { reason: blocked.verdict === 'BLOCK' && store.receipts.size === 0 ? 'CRASH_RECOVERY_DETERMINISTIC' : blocked.reason_code, queueRows: 0 }
  }
  if (operation === 'controller_postcommit_crash') {
    const store = new MemoryController()
    await commitControllerTransition(store, request())
    const replay = await commitControllerTransition(store, request())
    return { reason: replay.reason_code === 'OUTBOX_DUPLICATE_SUPPRESSED' && store.outbox.size === 1 ? 'CRASH_RECOVERY_DETERMINISTIC' : replay.reason_code, queueRows: 0 }
  }

  const { wire } = await issued()
  const env = envelope(wire)
  const store = new MemoryAun(env)
  const req = admissionRequest(wire)
  if (operation === 'receipt_not_found') store.envelope = null
  else if (operation === 'receipt_digest_tamper' || operation === 'hash_domain_field_tamper') {
    env.wire.receipt_payload.transition_binding.reason_code = 'TAMPERED'
    env.wire_bytes = canonicalJson(env.wire)
  } else if (operation === 'receipt_expired') req.now = later
  else if (operation === 'receipt_stale_state') env.current_state_digest = d('other-state')
  else if (operation === 'receipt_wrong_destination') req.destination.destination_actor_agent_id = 'wrong-agent'
  else if (operation === 'store_revision_mismatch') env.lookup_observed_store_revision += 1
  else if (operation === 'non_nfc') {
    env.wire.receipt_payload.transition_binding.delivery_subtype = 'e\u0301'
    rehash(env); req.payload_sha256 = env.wire.payload_sha256
  } else if (operation === 'consumed_local_missing') env.lifecycle_state = 'CONSUMED'
  else if (operation === 'aun_precommit_crash') store.failBeforeCommit = true

  if (operation === 'local_replay' || operation === 'replay_after_ack' || operation === 'replay_after_state_advance' || operation === 'replay_after_expiry' || operation === 'aun_postcommit_crash') {
    await admitAunReceipt(store, req)
    if (operation === 'replay_after_ack') env.dispatch_state = 'ACKNOWLEDGED'
    if (operation === 'replay_after_state_advance') env.dispatch_state = 'ADVANCED'
    if (operation === 'replay_after_expiry') req.now = later
    const replay = await admitAunReceipt(store, req)
    if (operation === 'aun_postcommit_crash') return { reason: store.queues.length === 1 ? 'CRASH_RECOVERY_DETERMINISTIC' : replay.reason_code, queueRows: store.queues.length }
    return { reason: replay.reason_code, queueRows: replay.queue_rows }
  }
  if (operation === 'idempotency_persisted') {
    return { reason: deriveIdempotencyKey(wire.receipt_payload) === wire.receipt_payload.delivery_binding.idempotency_key ? 'IDEMPOTENCY_PERSISTED' : 'FAILED', queueRows: 0 }
  }
  if (operation === 'idempotency_collision' || operation === 'idempotency_collision_v2') {
    const bad = fakeConsumption(wire)
    bad.receipt_id = 'TR-OTHER'
    store.idempotencies.set(`${req.controller_adapter_id}:${wire.receipt_payload.delivery_binding.idempotency_key}`, bad)
  }
  if (operation === 'local_digest_mismatch') {
    const bad = fakeConsumption(wire)
    store.consumptions.set(`${req.controller_adapter_id}:${req.receipt_id}`, bad)
    req.payload_sha256 = '0'.repeat(64)
  }
  const report = await admitAunReceipt(store, req)
  if (operation === 'aun_precommit_crash') {
    return {
      reason: report.verdict === 'BLOCK' && store.queues.length === 0 && store.projections.length === 0
        ? 'CRASH_RECOVERY_DETERMINISTIC'
        : report.reason_code,
      queueRows: 0,
    }
  }
  return { reason: report.reason_code, queueRows: report.queue_rows }
}

function fakeConsumption(wire: TransitionReceiptWire): LocalConsumptionRecord {
  const transition = wire.receipt_payload.transition_binding
  const provenance = {
    controller_adapter_id: wire.receipt_payload.receipt_identity.controller_adapter_id,
    receipt_id: wire.receipt_payload.receipt_identity.receipt_id,
    payload_sha256: wire.payload_sha256,
    idempotency_key: wire.receipt_payload.delivery_binding.idempotency_key,
    handoff_digest: transition.handoff_digest,
    ...destination(transition),
    queue_id: '777',
    message_id: 'message-777',
  }
  return { ...provenance, provenance, provenance_digest: digestObject(provenance) } as LocalConsumptionRecord
}
