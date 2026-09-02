import { createHash } from 'node:crypto'

export const SHIRUBE_V41_TRANSITION_RUNTIME_VERSION = 'shirube-v4.1/transition-runtime/v1' as const
export const SHIRUBE_V41_RECEIPT_SCHEMA_VERSION = 'shirube-transition-admission-receipt/v2' as const
export const SHIRUBE_V41_C4_HEAD = 'de0cdf18907dfce5b01bdc76b68dad03a5865888' as const
export const SHIRUBE_V41_C4_TREE = 'ec79706df937026fe83a9de033ee51476ee0fee9' as const
export const SHIRUBE_V41_C4_SCHEMA_SHA256 = '0f167547e1b5851478f774e962dd4bed812888710d64a1f33801c127aee0e446' as const
export const SHIRUBE_V41_C4_CHECKER_SHA256 = '1decd8f8687160f3f03677def5bacf44fa2620aaa14d6f9bb9f3020c2cb1762a' as const
export const SHIRUBE_V41_C4_CASES_SHA256 = '70d28a8aa7c2faee51917f0f7c7f798c9a590c0f593ac9df16964c5a55158441' as const

const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/
const GIT_SHA = /^[a-f0-9]{40}$/
const RECEIPT_ID = /^TR-[A-Z0-9._:-]+$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/
const QUEUE_CLASSES = new Set(['AUN_DELEGATE', 'PROTECTED_DECISION'])
const LOCAL_PROVENANCE_FIELDS = [
  'controller_adapter_id',
  'receipt_id',
  'payload_sha256',
  'idempotency_key',
  'handoff_digest',
  'destination_kind',
  'destination_actor_agent_id',
  'destination_active_function',
  'destination_owner_principal_id',
  'destination_owner_authority_key',
  'owner_decision_schema',
  'protected_decision_key',
  'queue_id',
  'message_id',
] as const

const RECEIPT_KEYS = {
  wire: ['receipt_payload', 'payload_sha256'],
  payload: ['receipt_identity', 'plan_binding', 'subject_binding', 'transition_binding', 'delivery_binding', 'integrity'],
  identity: ['receipt_id', 'controller_adapter_id', 'controller_issuer_agent_id', 'controller_instance_id', 'controller_version', 'authoritative_store_revision'],
  plan: ['root_goal_run_id', 'plan_id', 'plan_digest', 'generation', 'graph_id', 'node_id', 'parent_graph_id', 'parent_node_id'],
  subject: ['subject_tuple', 'subject_tuple_digest'],
  subjectTuple: ['repository', 'commit_sha', 'tree_sha', 'release_id', 'process_identity', 'config_digest', 'policy_digest', 'environment'],
  transition: ['result_digest', 'from_state_digest', 'to_state_digest', 'ready_set', 'ready_set_digest', 'selected_node_digest', 'delivery_class', 'delivery_subtype', 'destination_kind', 'destination_actor_agent_id', 'destination_active_function', 'destination_owner_principal_id', 'destination_owner_authority_key', 'owner_decision_schema', 'protected_decision_key', 'reason_code', 'handoff_digest'],
  delivery: ['idempotency_key', 'queue_permission', 'maximum_hop_count', 'issued_at', 'expires_at'],
  integrity: ['canonicalization', 'hash_algorithm'],
} as const

export type JsonRecord = Record<string, any>
export type DeliveryClass = 'REJECT' | 'TERMINAL' | 'TYPED_WAIT' | 'LOCAL_CONTINUE' | 'AUN_DELEGATE' | 'PROTECTED_DECISION'
export type DestinationKind = 'NONE' | 'AGENT_FUNCTION' | 'HUMAN_OWNER'

export interface SubjectTuple {
  repository: string
  commit_sha: string
  tree_sha: string
  release_id: string
  process_identity: string
  config_digest: string
  policy_digest: string
  environment: string
}

export interface PlanBinding {
  root_goal_run_id: string
  plan_id: string
  plan_digest: string
  generation: number
  graph_id: string
  node_id: string
  parent_graph_id: string | null
  parent_node_id: string | null
}

export interface TransitionBinding {
  result_digest: string
  from_state_digest: string
  to_state_digest: string
  ready_set: string[]
  ready_set_digest: string
  selected_node_digest: string
  delivery_class: 'AUN_DELEGATE' | 'PROTECTED_DECISION'
  delivery_subtype: string
  destination_kind: DestinationKind
  destination_actor_agent_id: string | null
  destination_active_function: string | null
  destination_owner_principal_id: string | null
  destination_owner_authority_key: string | null
  owner_decision_schema: string | null
  protected_decision_key: string | null
  reason_code: string
  handoff_digest: string
}

export interface ReceiptPayload {
  receipt_identity: {
    receipt_id: string
    controller_adapter_id: string
    controller_issuer_agent_id: string
    controller_instance_id: string
    controller_version: string
    authoritative_store_revision: number
  }
  plan_binding: PlanBinding
  subject_binding: { subject_tuple: SubjectTuple; subject_tuple_digest: string }
  transition_binding: TransitionBinding
  delivery_binding: {
    idempotency_key: string
    queue_permission: 'ALLOW_EXACTLY_ONE'
    maximum_hop_count: 1
    issued_at: string
    expires_at: string
  }
  integrity: { canonicalization: 'RFC8785'; hash_algorithm: 'SHA-256' }
}

export interface TransitionReceiptWire {
  receipt_payload: ReceiptPayload
  payload_sha256: string
}

export interface TransitionTelemetry {
  attempt_started_at: string | 'NOT_AVAILABLE'
  decision_completed_at: string | 'NOT_AVAILABLE'
  model: string | 'NOT_AVAILABLE'
  input_tokens: number | 'NOT_AVAILABLE'
  output_tokens: number | 'NOT_AVAILABLE'
  cached_tokens: number | 'NOT_AVAILABLE'
}

export interface RuntimeGraphNode {
  node_id: string
  plan_order: number
  depends_on: string[]
  lifecycle_state: 'PLANNED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETE'
  actor_agent_id: string
  active_function: string
  maker_agent_id: string | null
  work_class: DeliveryClassificationInput['work_class']
  typed_wait_key: string | null
  protected_decision_key: string | null
  owner_transport_available: boolean
  destination_registered: boolean
  destination_owner_principal_id: string | null
  destination_owner_authority_key: string | null
  subject_tuple: SubjectTuple
  allowed_paths: string[]
  required_checks: string[]
}

export interface RuntimeGraphState {
  wip_limit: number
  nodes: RuntimeGraphNode[]
  terminal_predicates: Array<{
    predicate_id: string
    status: 'OPEN' | 'VERIFIED'
    generation: number
    subject_tuple_digest: string
    evidence_ref: string | null
    evidence_digest: string | null
  }>
}

export interface RuntimePlanState extends PlanBinding {
  state_digest: string
  subject_tuple: SubjectTuple
  actor_agent_id: string
  active_function: string
  dispatch_state: 'LOCAL_READY' | 'DISPATCH_PENDING' | 'ACKNOWLEDGED' | 'ADVANCED'
  graph_state: RuntimeGraphState
  controller_adapter_id: string
  controller_instance_id: string
  controller_version: string
}

export interface WorkResultBinding extends PlanBinding {
  result_digest: string
  actor_agent_id: string
  active_function: string
  subject_tuple: SubjectTuple
  evidence_refs: Array<{ ref: string; digest: string }>
  terminal_predicate_verified: boolean
}

export interface DeliveryClassificationInput {
  dependencies_complete: boolean
  frontmost_selected: boolean
  wip_within_limit: boolean
  work_class: 'IMPLEMENTATION' | 'INDEPENDENT_EVIDENCE_AUDIT' | 'INDEPENDENT_SCENARIO_VERIFICATION' | 'GRAPH_AMENDMENT' | 'PROTECTED_SURFACE_GATE' | 'HUMAN_OWNER_DECISION'
  actor_agent_id: string
  active_function: string
  maker_agent_id?: string | null
  protected_decision_key?: string | null
  destination_owner_principal_id?: string | null
  destination_owner_authority_key?: string | null
  owner_transport_available?: boolean
  current_actor_agent_id: string
  current_active_function: string
  proposed_actor_agent_id?: string | null
  proposed_active_function?: string | null
  proposed_delivery_class?: string | null
}

export interface DeliveryClassification {
  delivery_class: DeliveryClass
  delivery_subtype: string | null
  reason_code: string
  queue_permission: 'ALLOW_EXACTLY_ONE' | 'DENY'
  maximum_hop_count: 0 | 1
  destination_kind: DestinationKind
  destination_actor_agent_id: string | null
  destination_active_function: string | null
  destination_owner_principal_id: string | null
  destination_owner_authority_key: string | null
  owner_decision_schema: string | null
  protected_decision_key: string | null
}

export interface ControllerTransitionRequest {
  expected_state: RuntimePlanState
  result: WorkResultBinding
  proposal?: {
    node_id?: string
    destination_actor_agent_id?: string
    destination_active_function?: string
    delivery_class?: string
  }
  controller_issuer_agent_id: string
  receipt_id: string
  issued_at: string
  expires_at: string
  telemetry: TransitionTelemetry
}

export interface ResultConsumptionRecord {
  result_digest: string
  state_digest: string
  receipt_wire: TransitionReceiptWire | null
  delivery_class: DeliveryClass
}

export interface ControllerTransactionPort {
  lockPlanState(binding: PlanBinding): Promise<RuntimePlanState | null>
  loadResultConsumption(resultDigest: string): Promise<ResultConsumptionRecord | null>
  reserveReceiptRevision(): Promise<number>
  persistReceipt(wire: TransitionReceiptWire, telemetry: TransitionTelemetry): Promise<void>
  compareAndSwapState(fromDigest: string, nextState: RuntimePlanState): Promise<boolean>
  persistResultConsumption(record: ResultConsumptionRecord): Promise<void>
  insertControllerOutbox(wire: TransitionReceiptWire): Promise<void>
}

export interface ControllerStore {
  transaction<T>(fn: (tx: ControllerTransactionPort) => Promise<T>): Promise<T>
}

export interface LocalConsumptionRecord extends JsonRecord {
  controller_adapter_id: string
  receipt_id: string
  payload_sha256: string
  idempotency_key: string
  handoff_digest: string
  destination_kind: DestinationKind
  destination_actor_agent_id: string | null
  destination_active_function: string | null
  destination_owner_principal_id: string | null
  destination_owner_authority_key: string | null
  owner_decision_schema: string | null
  protected_decision_key: string | null
  queue_id: string
  message_id: string
  provenance: JsonRecord
  provenance_digest: string
}

export interface AuthoritativeReceiptEnvelope {
  wire: TransitionReceiptWire
  wire_bytes: string
  lookup_observed_store_revision: number
  lifecycle_state: 'ISSUED' | 'CONSUMED' | 'REVOKED'
  dispatch_state: 'DISPATCH_PENDING' | 'ACKNOWLEDGED' | 'ADVANCED'
  current_state_digest: string
  committed_transition_record: JsonRecord
}

export interface AunAdmissionTransactionPort {
  authenticateControllerAdapter(adapterId: string, authenticatedCaller: string): Promise<boolean>
  loadLocalConsumption(adapterId: string, receiptId: string): Promise<LocalConsumptionRecord | null>
  loadIdempotencyConsumption(adapterId: string, idempotencyKey: string): Promise<LocalConsumptionRecord | null>
  loadAuthoritativeReceipt(receiptId: string, payloadSha256: string): Promise<AuthoritativeReceiptEnvelope | null>
  registeredDestination(transition: TransitionBinding): Promise<JsonRecord | null>
  insertQueueAndProjection(wire: TransitionReceiptWire): Promise<{ queue_id: string; message_id: string }>
  persistLocalConsumption(record: LocalConsumptionRecord): Promise<void>
}

export interface AunAdmissionStore {
  transaction<T>(fn: (tx: AunAdmissionTransactionPort) => Promise<T>): Promise<T>
}

export interface AunAdmissionRequest {
  authenticated_caller: string
  controller_adapter_id: string
  receipt_id: string
  payload_sha256: string
  now: string
  expected_binding: JsonRecord
  destination: JsonRecord
  telemetry: TransitionTelemetry
}

export interface RuntimeReport {
  schema: typeof SHIRUBE_V41_TRANSITION_RUNTIME_VERSION
  verdict: 'PASS' | 'BLOCK'
  decision: string
  reason_code: string
  queue_id: string | null
  message_id: string | null
  queue_rows: number
  projections: number
  effects: number
  state_transitions: number
  telemetry: TransitionTelemetry
  receipt_wire?: TransitionReceiptWire | null
  authoritative_lookup_performed?: boolean
}

export class ShirubeV41TransitionError extends Error {
  constructor(public readonly reasonCode: string, message = reasonCode) {
    super(message)
    this.name = 'ShirubeV41TransitionError'
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!isObject(value)) throw new Error('unsupported canonical JSON value')
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function digestObject(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

export function deriveRuntimeStateDigest(state: Omit<RuntimePlanState, 'state_digest'> | RuntimePlanState): string {
  return digestObject({
    root_goal_run_id: state.root_goal_run_id,
    plan_id: state.plan_id,
    plan_digest: state.plan_digest,
    generation: state.generation,
    graph_id: state.graph_id,
    parent_graph_id: state.parent_graph_id,
    parent_node_id: state.parent_node_id,
    node_id: state.node_id,
    subject_tuple: state.subject_tuple,
    actor_agent_id: state.actor_agent_id,
    active_function: state.active_function,
    dispatch_state: state.dispatch_state,
    graph_state: state.graph_state,
    controller_adapter_id: state.controller_adapter_id,
    controller_instance_id: state.controller_instance_id,
    controller_version: state.controller_version,
  })
}

export function deriveIdempotencyKey(payload: ReceiptPayload): string {
  const identity = payload.receipt_identity
  const plan = payload.plan_binding
  const subject = payload.subject_binding
  const transition = payload.transition_binding
  const components = [
    identity.controller_adapter_id,
    plan.root_goal_run_id,
    plan.plan_digest,
    String(plan.generation),
    plan.graph_id,
    plan.node_id,
    plan.parent_graph_id ?? 'ROOT',
    plan.parent_node_id ?? 'ROOT',
    subject.subject_tuple_digest,
    transition.result_digest,
    transition.from_state_digest,
    transition.to_state_digest,
    transition.selected_node_digest,
    transition.delivery_class,
    transition.delivery_subtype ?? '',
    transition.destination_kind,
    transition.destination_actor_agent_id ?? '',
    transition.destination_active_function ?? '',
    transition.destination_owner_principal_id ?? '',
    transition.destination_owner_authority_key ?? '',
    transition.protected_decision_key ?? '',
    transition.handoff_digest,
  ]
  return `owd:v2:${sha256Hex(['OWD_TRANSITION_ADMISSION_IDEMPOTENCY_V2', ...components].join('\0'))}`
}

export function buildReceiptWire(payloadInput: ReceiptPayload): TransitionReceiptWire {
  const payload = structuredClone(payloadInput)
  payload.delivery_binding.idempotency_key = deriveIdempotencyKey(payload)
  assertNfc(payload)
  return { receipt_payload: payload, payload_sha256: sha256Hex(canonicalJson(payload)) }
}

export function classifyDelivery(input: DeliveryClassificationInput): DeliveryClassification {
  const reject = (reason: string): DeliveryClassification => ({
    delivery_class: 'REJECT', delivery_subtype: null, reason_code: reason,
    queue_permission: 'DENY', maximum_hop_count: 0, destination_kind: 'NONE',
    destination_actor_agent_id: null, destination_active_function: null,
    destination_owner_principal_id: null, destination_owner_authority_key: null,
    owner_decision_schema: null, protected_decision_key: null,
  })
  if (!input.dependencies_complete) return reject('DEPENDENCY_OPEN')
  if (!input.frontmost_selected) return reject('FRONTMOST_MISMATCH')
  if (!input.wip_within_limit) return reject('WIP_LIMIT_EXCEEDED')
  if (input.proposed_actor_agent_id && input.proposed_actor_agent_id !== input.actor_agent_id) return reject('UNNECESSARY_DELEGATION')
  if (input.proposed_active_function && input.proposed_active_function !== input.active_function) return reject('UNNECESSARY_DELEGATION')

  const agentDestination = {
    destination_kind: 'AGENT_FUNCTION' as const,
    destination_actor_agent_id: input.actor_agent_id,
    destination_active_function: input.active_function,
    destination_owner_principal_id: null,
    destination_owner_authority_key: null,
    owner_decision_schema: null,
    protected_decision_key: input.protected_decision_key ?? null,
  }
  let admitted: DeliveryClassification
  if (input.work_class === 'PROTECTED_SURFACE_GATE') {
    if (input.active_function !== 'protected_surface_gate' || !nonEmptyString(input.protected_decision_key)) return reject('RECEIPT_DESTINATION_MISMATCH')
    admitted = { delivery_class: 'PROTECTED_DECISION', delivery_subtype: 'PROTECTED_SURFACE_GATE', reason_code: 'PROTECTED_SURFACE_GATE_REQUIRED', queue_permission: 'ALLOW_EXACTLY_ONE', maximum_hop_count: 1, ...agentDestination }
  } else if (input.work_class === 'HUMAN_OWNER_DECISION') {
    if (!nonEmptyString(input.destination_owner_principal_id) || !nonEmptyString(input.destination_owner_authority_key) || !nonEmptyString(input.protected_decision_key)) return reject('RECEIPT_DESTINATION_MISMATCH')
    admitted = {
      delivery_class: input.owner_transport_available ? 'PROTECTED_DECISION' : 'TYPED_WAIT',
      delivery_subtype: input.owner_transport_available ? 'HUMAN_OWNER_DECISION' : 'OWNER_TRANSPORT_WAIT',
      reason_code: input.owner_transport_available ? 'HUMAN_OWNER_DECISION_REQUIRED' : 'TYPED_WAIT',
      queue_permission: input.owner_transport_available ? 'ALLOW_EXACTLY_ONE' : 'DENY',
      maximum_hop_count: input.owner_transport_available ? 1 : 0,
      destination_kind: 'HUMAN_OWNER',
      destination_actor_agent_id: null,
      destination_active_function: null,
      destination_owner_principal_id: input.destination_owner_principal_id ?? null,
      destination_owner_authority_key: input.destination_owner_authority_key ?? null,
      owner_decision_schema: 'shirube-v3/owner_decision/v1',
      protected_decision_key: input.protected_decision_key ?? null,
    }
  } else if (input.work_class === 'INDEPENDENT_EVIDENCE_AUDIT' || input.work_class === 'INDEPENDENT_SCENARIO_VERIFICATION' || input.work_class === 'GRAPH_AMENDMENT') {
    const requirements = {
      INDEPENDENT_EVIDENCE_AUDIT: ['evidence_audit_gate', 'INDEPENDENT_EVIDENCE_AUDIT', 'INDEPENDENT_CHECK_REQUIRED'],
      INDEPENDENT_SCENARIO_VERIFICATION: ['scenario_verification_gate', 'INDEPENDENT_SCENARIO_VERIFICATION', 'INDEPENDENT_SCENARIO_CHECK_REQUIRED'],
      GRAPH_AMENDMENT: ['control_artifact_author', 'GRAPH_AMENDMENT', 'GRAPH_AMENDMENT_REQUIRED'],
    } as const
    const [requiredFunction, subtype, reason] = requirements[input.work_class]
    if (input.active_function !== requiredFunction) return reject('RECEIPT_DESTINATION_MISMATCH')
    if (input.maker_agent_id && input.maker_agent_id === input.actor_agent_id) return reject('MAKER_CHECKER_VIOLATION')
    admitted = { delivery_class: 'AUN_DELEGATE', delivery_subtype: subtype, reason_code: reason, queue_permission: 'ALLOW_EXACTLY_ONE', maximum_hop_count: 1, ...agentDestination }
  } else if (input.actor_agent_id === input.current_actor_agent_id && input.active_function === input.current_active_function) {
    admitted = { delivery_class: 'LOCAL_CONTINUE', delivery_subtype: 'SAME_ACTOR', reason_code: 'LOCAL_CONTINUE', queue_permission: 'DENY', maximum_hop_count: 0, ...agentDestination }
  } else {
    admitted = { delivery_class: 'AUN_DELEGATE', delivery_subtype: 'GRAPH_ASSIGNED_HANDOFF', reason_code: 'GRAPH_ASSIGNED_ACTOR_TRANSFER', queue_permission: 'ALLOW_EXACTLY_ONE', maximum_hop_count: 1, ...agentDestination }
  }
  if (input.proposed_delivery_class && input.proposed_delivery_class !== admitted.delivery_class) {
    return reject(admitted.delivery_class === 'PROTECTED_DECISION' ? 'RECEIPT_BINDING_MISMATCH' : 'UNNECESSARY_DELEGATION')
  }
  return admitted
}

interface ComputedTransition {
  classification: DeliveryClassification
  ready_set: string[]
  selected_node: RuntimeGraphNode | null
  selected_node_digest: string | null
  handoff: JsonRecord | null
  handoff_digest: string | null
  next_state: RuntimePlanState | null
}

export function computeControllerTransition(state: RuntimePlanState, result: WorkResultBinding, proposal: ControllerTransitionRequest['proposal'] = {}): ComputedTransition {
  validateGraphState(state)
  validateResultAgainstState(result, state)
  const graph = structuredClone(state.graph_state)
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]))
  const resultNode = byId.get(result.node_id)
  if (!resultNode || resultNode.lifecycle_state !== 'IN_PROGRESS') throw new ShirubeV41TransitionError('RESULT_NODE_BINDING_MISMATCH')
  const completedBefore = new Set(graph.nodes.filter((node) => node.lifecycle_state === 'COMPLETE').map((node) => node.node_id))
  if (resultNode.depends_on.some((dependency) => !completedBefore.has(dependency))) throw new ShirubeV41TransitionError('DEPENDENCY_OPEN')
  if (graph.nodes.filter((node) => node.lifecycle_state === 'IN_PROGRESS').length > graph.wip_limit) throw new ShirubeV41TransitionError('WIP_LIMIT_EXCEEDED')
  resultNode.lifecycle_state = 'COMPLETE'
  const completed = new Set(graph.nodes.filter((node) => node.lifecycle_state === 'COMPLETE').map((node) => node.node_id))

  if (graph.terminal_predicates.length > 0 && graph.terminal_predicates.every((predicate) => predicate.status === 'VERIFIED')) {
    const stale = graph.terminal_predicates.some((predicate) => predicate.generation !== state.generation
      || !DIGEST.test(predicate.subject_tuple_digest)
      || !nonEmptyString(predicate.evidence_ref)
      || !DIGEST.test(predicate.evidence_digest ?? ''))
    if (stale) throw new ShirubeV41TransitionError('TERMINAL_EVIDENCE_BINDING_MISMATCH')
    const classification = noQueueClassification('TERMINAL', 'TERMINAL')
    return computedState(state, graph, resultNode, classification, [], null, null)
  }

  const candidates = graph.nodes
    .filter((node) => node.lifecycle_state === 'PLANNED' && node.depends_on.every((dependency) => completed.has(dependency)) && node.typed_wait_key === null)
    .sort(compareGraphNodes)
  const readySet = candidates.map((node) => node.node_id)
  const selected = candidates[0] ?? null
  if (!selected) {
    const remaining = graph.nodes.filter((node) => node.lifecycle_state !== 'COMPLETE')
    const waited = remaining.filter((node) => node.typed_wait_key !== null)
    if (remaining.length > 0 && waited.length > 0 && remaining.every((node) => node.typed_wait_key !== null || node.depends_on.some((dependency) => descendantOfTypedWait(dependency, byId)))) {
      return { classification: noQueueClassification('TYPED_WAIT', 'TYPED_WAIT'), ready_set: [], selected_node: null, selected_node_digest: null, handoff: null, handoff_digest: null, next_state: null }
    }
    throw new ShirubeV41TransitionError('DEPENDENCY_OPEN')
  }
  if (proposal.node_id && proposal.node_id !== selected.node_id) {
    const proposed = byId.get(proposal.node_id)
    throw new ShirubeV41TransitionError(proposed?.depends_on.some((dependency) => !completed.has(dependency)) ? 'DEPENDENCY_OPEN' : 'FRONTMOST_MISMATCH')
  }
  const activeWip = graph.nodes.filter((node) => node.lifecycle_state === 'IN_PROGRESS')
  if (activeWip.length >= graph.wip_limit) throw new ShirubeV41TransitionError('WIP_LIMIT_EXCEEDED')
  let computed = classifyDelivery({
    dependencies_complete: true,
    frontmost_selected: true,
    wip_within_limit: true,
    work_class: selected.work_class,
    actor_agent_id: selected.actor_agent_id,
    active_function: selected.active_function,
    maker_agent_id: selected.maker_agent_id,
    protected_decision_key: selected.protected_decision_key,
    destination_owner_principal_id: selected.destination_owner_principal_id,
    destination_owner_authority_key: selected.destination_owner_authority_key,
    owner_transport_available: selected.owner_transport_available,
    current_actor_agent_id: result.actor_agent_id,
    current_active_function: result.active_function,
    proposed_actor_agent_id: proposal.destination_actor_agent_id,
    proposed_active_function: proposal.destination_active_function,
    proposed_delivery_class: proposal.delivery_class,
  })
  if (computed.delivery_class === 'REJECT') throw new ShirubeV41TransitionError(computed.reason_code)
  if ((computed.delivery_class === 'AUN_DELEGATE' || computed.delivery_class === 'PROTECTED_DECISION') && !selected.destination_registered) {
    computed = noQueueClassification('TYPED_WAIT', 'TYPED_WAIT')
    return { classification: computed, ready_set: readySet, selected_node: selected, selected_node_digest: digestObject(selected), handoff: null, handoff_digest: null, next_state: null }
  }
  const handoff = renderHandoff(state, selected)
  return computedState(state, graph, selected, computed, readySet, digestObject(handoff), handoff)
}

function computedState(
  state: RuntimePlanState,
  graph: RuntimeGraphState,
  selected: RuntimeGraphNode,
  classification: DeliveryClassification,
  readySet: string[],
  handoffDigest: string | null,
  handoff: JsonRecord | null,
): ComputedTransition {
  const dispatchState = classification.delivery_class === 'AUN_DELEGATE' || classification.delivery_class === 'PROTECTED_DECISION'
    ? 'DISPATCH_PENDING'
    : 'LOCAL_READY'
  if (classification.delivery_class === 'LOCAL_CONTINUE') selected.lifecycle_state = 'IN_PROGRESS'
  const nextState: RuntimePlanState = {
    ...state,
    node_id: selected.node_id,
    subject_tuple: structuredClone(selected.subject_tuple),
    actor_agent_id: selected.actor_agent_id,
    active_function: selected.active_function,
    dispatch_state: dispatchState,
    graph_state: graph,
    state_digest: '',
  }
  nextState.state_digest = deriveRuntimeStateDigest(nextState)
  return {
    classification,
    ready_set: readySet,
    selected_node: structuredClone(selected),
    selected_node_digest: digestObject(selected),
    handoff,
    handoff_digest: handoffDigest,
    next_state: nextState,
  }
}

function noQueueClassification(deliveryClass: 'TERMINAL' | 'TYPED_WAIT', reason: string): DeliveryClassification {
  return {
    delivery_class: deliveryClass, delivery_subtype: null, reason_code: reason,
    queue_permission: 'DENY', maximum_hop_count: 0, destination_kind: 'NONE',
    destination_actor_agent_id: null, destination_active_function: null,
    destination_owner_principal_id: null, destination_owner_authority_key: null,
    owner_decision_schema: null, protected_decision_key: null,
  }
}

function renderHandoff(state: RuntimePlanState, node: RuntimeGraphNode): JsonRecord {
  return {
    schema_version: 'shirube-v3/control_handoff/v1',
    root_goal_run_id: state.root_goal_run_id,
    plan_id: state.plan_id,
    plan_digest: state.plan_digest,
    generation: state.generation,
    graph_id: state.graph_id,
    node_id: node.node_id,
    parent_graph_id: state.parent_graph_id,
    parent_node_id: state.parent_node_id,
    execution_context: { actor_agent_id: node.actor_agent_id, active_function: node.active_function },
    subject_tuple: structuredClone(node.subject_tuple),
    allowed_paths: [...node.allowed_paths],
    required_checks: [...node.required_checks],
    protected_effects_authorized: false,
  }
}

export async function commitControllerTransition(store: ControllerStore, request: ControllerTransitionRequest): Promise<RuntimeReport> {
  try {
    validateControllerRequest(request)
    return await store.transaction(async (tx) => {
      const locked = await tx.lockPlanState(request.expected_state)
      if (!locked) throw new ShirubeV41TransitionError('STALE_GENERATION')
      const prior = await tx.loadResultConsumption(request.result.result_digest)
      if (prior) {
        if (locked.state_digest !== prior.state_digest) throw new ShirubeV41TransitionError('TRANSITION_ALREADY_CONSUMED')
        return passReport('CONTROLLER_REPLAY', 'OUTBOX_DUPLICATE_SUPPRESSED', 0, 0, 0, 0, prior.receipt_wire, null, null, undefined, request.telemetry)
      }
      if (!samePlanState(locked, request.expected_state)) throw new ShirubeV41TransitionError('STALE_GENERATION')
      validateResultAgainstState(request.result, locked)
      const computed = computeControllerTransition(locked, request.result, request.proposal)
      if (!computed.next_state || computed.classification.delivery_class === 'TYPED_WAIT') throw new ShirubeV41TransitionError(computed.classification.reason_code)

      if (computed.classification.delivery_class === 'LOCAL_CONTINUE' || computed.classification.delivery_class === 'TERMINAL') {
        const swapped = await tx.compareAndSwapState(locked.state_digest, computed.next_state)
        if (!swapped) throw new ShirubeV41TransitionError('CONTROLLER_STATE_CAS_FAILED')
        await tx.persistResultConsumption({ result_digest: request.result.result_digest, state_digest: computed.next_state.state_digest, receipt_wire: null, delivery_class: computed.classification.delivery_class })
        return passReport(computed.classification.delivery_class, computed.classification.reason_code, 0, 0, 0, 1, null, null, null, undefined, request.telemetry)
      }

      if (!QUEUE_CLASSES.has(computed.classification.delivery_class) || computed.classification.queue_permission !== 'ALLOW_EXACTLY_ONE' || computed.classification.maximum_hop_count !== 1) {
        throw new ShirubeV41TransitionError('RECEIPT_QUEUE_NOT_PERMITTED')
      }
      const revision = await tx.reserveReceiptRevision()
      const wire = buildReceiptWire(buildReceiptPayload(request, locked, computed, revision))
      const wireFailure = validateReceiptWire(wire)
      if (wireFailure) throw new ShirubeV41TransitionError(wireFailure)
      await tx.persistReceipt(wire, request.telemetry)
      const swapped = await tx.compareAndSwapState(locked.state_digest, computed.next_state)
      if (!swapped) throw new ShirubeV41TransitionError('CONTROLLER_STATE_CAS_FAILED')
      await tx.persistResultConsumption({ result_digest: request.result.result_digest, state_digest: computed.next_state.state_digest, receipt_wire: wire, delivery_class: computed.classification.delivery_class })
      await tx.insertControllerOutbox(wire)
      return passReport('CONTROLLER_COMMIT', 'TRANSITION_COMMITTED', 0, 0, 0, 1, wire, null, null, undefined, request.telemetry)
    })
  } catch (error) {
    return blockReport(reasonFromError(error), request.telemetry)
  }
}

export async function admitAunReceipt(store: AunAdmissionStore, request: AunAdmissionRequest): Promise<RuntimeReport> {
  let authoritativeLookupPerformed = false
  try {
    if (!validTelemetry(request.telemetry)) throw new ShirubeV41TransitionError('PLAN_BINDING_MISMATCH')
    return await store.transaction(async (tx) => {
      if (!await tx.authenticateControllerAdapter(request.controller_adapter_id, request.authenticated_caller)) {
        throw new ShirubeV41TransitionError('RECEIPT_ADAPTER_UNTRUSTED')
      }
      const local = await tx.loadLocalConsumption(request.controller_adapter_id, request.receipt_id)
      if (local) {
        if (!validLocalConsumption(local, request)) throw new ShirubeV41TransitionError('RECEIPT_BINDING_MISMATCH')
        return passReport('REPLAY', 'OUTBOX_DUPLICATE_SUPPRESSED', 0, 0, 0, 0, undefined, local.queue_id, local.message_id, false, request.telemetry)
      }

      authoritativeLookupPerformed = true
      const envelope = await tx.loadAuthoritativeReceipt(request.receipt_id, request.payload_sha256)
      if (!envelope) throw new ShirubeV41TransitionError('RECEIPT_NOT_FOUND')
      if (envelope.wire_bytes !== canonicalJson(envelope.wire)) throw new ShirubeV41TransitionError('RECEIPT_CANONICALIZATION_FAILED')
      const wireFailure = validateReceiptWire(envelope.wire)
      if (wireFailure) throw new ShirubeV41TransitionError(wireFailure)
      const payload = envelope.wire.receipt_payload
      const transition = payload.transition_binding
      if (request.receipt_id !== payload.receipt_identity.receipt_id || request.payload_sha256 !== envelope.wire.payload_sha256) throw new ShirubeV41TransitionError('RECEIPT_BINDING_MISMATCH')
      if (request.controller_adapter_id !== payload.receipt_identity.controller_adapter_id) throw new ShirubeV41TransitionError('RECEIPT_ADAPTER_UNTRUSTED')
      if (envelope.lookup_observed_store_revision !== payload.receipt_identity.authoritative_store_revision) throw new ShirubeV41TransitionError('RECEIPT_STORE_REVISION_MISMATCH')
      if (!bindingMatches(payload, request.expected_binding)) throw new ShirubeV41TransitionError('RECEIPT_BINDING_MISMATCH')
      if (!committedTransitionMatches(payload, envelope.committed_transition_record)) throw new ShirubeV41TransitionError('RECEIPT_STALE_STATE')
      if (envelope.lifecycle_state === 'CONSUMED') throw new ShirubeV41TransitionError('RECEIPT_RECONCILIATION_REQUIRED')
      if (envelope.lifecycle_state === 'REVOKED') throw new ShirubeV41TransitionError('RECEIPT_REVOKED')
      if (envelope.lifecycle_state !== 'ISSUED') throw new ShirubeV41TransitionError('RECEIPT_BINDING_MISMATCH')
      if (!isValidRfc3339(request.now)) throw new ShirubeV41TransitionError('RECEIPT_CLOCK_INVALID')
      if (Date.parse(request.now) >= Date.parse(payload.delivery_binding.expires_at)) throw new ShirubeV41TransitionError('RECEIPT_EXPIRED')
      if (envelope.dispatch_state !== 'DISPATCH_PENDING' || envelope.current_state_digest !== transition.to_state_digest) throw new ShirubeV41TransitionError('RECEIPT_STALE_STATE')
      if (!destinationMatches(transition, request.destination)) throw new ShirubeV41TransitionError('RECEIPT_DESTINATION_MISMATCH')
      const registered = await tx.registeredDestination(transition)
      if (!registered || !destinationMatches(transition, registered)) throw new ShirubeV41TransitionError('RECEIPT_DESTINATION_MISMATCH')
      const idempotency = await tx.loadIdempotencyConsumption(request.controller_adapter_id, payload.delivery_binding.idempotency_key)
      if (idempotency) {
        if (!validLocalConsumption(idempotency, request)) throw new ShirubeV41TransitionError('RECEIPT_IDEMPOTENCY_CONFLICT')
        return passReport('REPLAY', 'OUTBOX_DUPLICATE_SUPPRESSED', 0, 0, 0, 0, undefined, idempotency.queue_id, idempotency.message_id, true, request.telemetry)
      }
      const queue = await tx.insertQueueAndProjection(envelope.wire)
      const provenance = localProvenance(envelope.wire, queue)
      const consumption: LocalConsumptionRecord = {
        ...provenance,
        provenance,
        provenance_digest: digestObject(provenance),
      } as LocalConsumptionRecord
      await tx.persistLocalConsumption(consumption)
      return passReport('ADMIT_EXACTLY_ONE', 'RECEIPT_ADMITTED', 1, 1, 0, 0, undefined, queue.queue_id, queue.message_id, true, request.telemetry)
    })
  } catch (error) {
    return blockReport(reasonFromError(error), request.telemetry, authoritativeLookupPerformed)
  }
}

export function validateReceiptWire(wire: unknown): string | null {
  try {
    exactKeys(wire, RECEIPT_KEYS.wire)
    const receiptWire = wire as TransitionReceiptWire
    const payload = receiptWire.receipt_payload
    exactKeys(payload, RECEIPT_KEYS.payload)
    exactKeys(payload.receipt_identity, RECEIPT_KEYS.identity)
    exactKeys(payload.plan_binding, RECEIPT_KEYS.plan)
    exactKeys(payload.subject_binding, RECEIPT_KEYS.subject)
    exactKeys(payload.subject_binding.subject_tuple, RECEIPT_KEYS.subjectTuple)
    exactKeys(payload.transition_binding, RECEIPT_KEYS.transition)
    exactKeys(payload.delivery_binding, RECEIPT_KEYS.delivery)
    exactKeys(payload.integrity, RECEIPT_KEYS.integrity)
    assertNfc(payload)
    if (!/^[a-f0-9]{64}$/.test(receiptWire.payload_sha256) || sha256Hex(canonicalJson(payload)) !== receiptWire.payload_sha256) return 'RECEIPT_DIGEST_MISMATCH'
    const identity = payload.receipt_identity
    if (!RECEIPT_ID.test(identity.receipt_id) || ![identity.controller_adapter_id, identity.controller_issuer_agent_id, identity.controller_instance_id, identity.controller_version].every(nonEmptyString)) return 'RECEIPT_BINDING_MISMATCH'
    if (!Number.isInteger(identity.authoritative_store_revision) || identity.authoritative_store_revision < 1) return 'RECEIPT_BINDING_MISMATCH'
    const plan = payload.plan_binding
    if (![plan.root_goal_run_id, plan.plan_id, plan.graph_id, plan.node_id].every(nonEmptyString) || !DIGEST.test(plan.plan_digest)) return 'PLAN_BINDING_MISMATCH'
    if (!Number.isInteger(plan.generation) || plan.generation < 1) return 'STALE_GENERATION'
    if ((plan.parent_graph_id === null) !== (plan.parent_node_id === null)) return 'PLAN_BINDING_MISMATCH'
    if (plan.parent_graph_id !== null && (!nonEmptyString(plan.parent_graph_id) || !nonEmptyString(plan.parent_node_id))) return 'PLAN_BINDING_MISMATCH'
    if (!validSubjectTuple(payload.subject_binding.subject_tuple) || payload.subject_binding.subject_tuple_digest !== digestObject(payload.subject_binding.subject_tuple)) return 'SUBJECT_TUPLE_MISMATCH'
    const transition = payload.transition_binding
    if (![plan.plan_digest, transition.result_digest, transition.from_state_digest, transition.to_state_digest, transition.ready_set_digest, transition.selected_node_digest, transition.handoff_digest].every((value) => DIGEST.test(value))) return 'RECEIPT_BINDING_MISMATCH'
    if (!QUEUE_CLASSES.has(transition.delivery_class)) return 'RECEIPT_QUEUE_NOT_PERMITTED'
    if (!nonEmptyString(transition.delivery_subtype) || !nonEmptyString(transition.reason_code) || !Array.isArray(transition.ready_set) || transition.ready_set.some((id) => !nonEmptyString(id)) || new Set(transition.ready_set).size !== transition.ready_set.length || transition.ready_set_digest !== digestObject(transition.ready_set)) return 'RECEIPT_BINDING_MISMATCH'
    const destinationFailure = validateDestination(transition, payload.delivery_binding)
    if (destinationFailure) return destinationFailure
    const delivery = payload.delivery_binding
    if (delivery.idempotency_key !== deriveIdempotencyKey(payload)) return 'RECEIPT_IDEMPOTENCY_CONFLICT'
    if (delivery.queue_permission !== 'ALLOW_EXACTLY_ONE' || delivery.maximum_hop_count !== 1) return 'RECEIPT_QUEUE_NOT_PERMITTED'
    if (!isValidRfc3339(delivery.issued_at) || !isValidRfc3339(delivery.expires_at) || Date.parse(delivery.issued_at) >= Date.parse(delivery.expires_at)) return 'RECEIPT_BINDING_MISMATCH'
    if (payload.integrity.canonicalization !== 'RFC8785' || payload.integrity.hash_algorithm !== 'SHA-256') return 'RECEIPT_CANONICALIZATION_FAILED'
    return null
  } catch (error) {
    if (/NFC|Unicode/.test(String((error as Error)?.message))) return 'RECEIPT_CANONICALIZATION_FAILED'
    return 'RECEIPT_BINDING_MISMATCH'
  }
}

function buildReceiptPayload(request: ControllerTransitionRequest, state: RuntimePlanState, computed: ComputedTransition, revision: number): ReceiptPayload {
  const classification = computed.classification
  const nextState = computed.next_state!
  return {
    receipt_identity: {
      receipt_id: request.receipt_id,
      controller_adapter_id: state.controller_adapter_id,
      controller_issuer_agent_id: request.controller_issuer_agent_id,
      controller_instance_id: state.controller_instance_id,
      controller_version: state.controller_version,
      authoritative_store_revision: revision,
    },
    plan_binding: planBindingOf(nextState),
    subject_binding: { subject_tuple: structuredClone(nextState.subject_tuple), subject_tuple_digest: digestObject(nextState.subject_tuple) },
    transition_binding: {
      result_digest: request.result.result_digest,
      from_state_digest: state.state_digest,
      to_state_digest: nextState.state_digest,
      ready_set: [...computed.ready_set],
      ready_set_digest: digestObject(computed.ready_set),
      selected_node_digest: computed.selected_node_digest!,
      delivery_class: classification.delivery_class as 'AUN_DELEGATE' | 'PROTECTED_DECISION',
      delivery_subtype: classification.delivery_subtype!,
      destination_kind: classification.destination_kind,
      destination_actor_agent_id: classification.destination_actor_agent_id,
      destination_active_function: classification.destination_active_function,
      destination_owner_principal_id: classification.destination_owner_principal_id,
      destination_owner_authority_key: classification.destination_owner_authority_key,
      owner_decision_schema: classification.owner_decision_schema,
      protected_decision_key: classification.protected_decision_key,
      reason_code: classification.reason_code,
      handoff_digest: computed.handoff_digest!,
    },
    delivery_binding: {
      idempotency_key: `owd:v2:${'0'.repeat(64)}`,
      queue_permission: 'ALLOW_EXACTLY_ONE',
      maximum_hop_count: 1,
      issued_at: request.issued_at,
      expires_at: request.expires_at,
    },
    integrity: { canonicalization: 'RFC8785', hash_algorithm: 'SHA-256' },
  }
}

function validateControllerRequest(request: ControllerTransitionRequest): void {
  try { assertNfc(request) } catch { throw new ShirubeV41TransitionError('RECEIPT_CANONICALIZATION_FAILED') }
  if (!validSubjectTuple(request.expected_state.subject_tuple) || !validTelemetry(request.telemetry)) throw new ShirubeV41TransitionError('PLAN_BINDING_MISMATCH')
  if (!DIGEST.test(request.expected_state.state_digest) || !DIGEST.test(request.result.result_digest)) throw new ShirubeV41TransitionError('RECEIPT_BINDING_MISMATCH')
  if (!RECEIPT_ID.test(request.receipt_id)) throw new ShirubeV41TransitionError('RECEIPT_BINDING_MISMATCH')
  if (!isValidRfc3339(request.issued_at) || !isValidRfc3339(request.expires_at) || Date.parse(request.issued_at) >= Date.parse(request.expires_at)) throw new ShirubeV41TransitionError('RECEIPT_CLOCK_INVALID')
}

function validateResultAgainstState(result: WorkResultBinding, state: RuntimePlanState): void {
  const planFields: Array<keyof PlanBinding> = ['root_goal_run_id', 'plan_id', 'plan_digest', 'generation', 'graph_id', 'node_id', 'parent_graph_id', 'parent_node_id']
  if (!planFields.every((field) => (result[field] ?? null) === (state[field] ?? null))) throw new ShirubeV41TransitionError('RESULT_NODE_BINDING_MISMATCH')
  if (result.terminal_predicate_verified !== true || result.actor_agent_id !== state.actor_agent_id || result.active_function !== state.active_function) throw new ShirubeV41TransitionError('RESULT_NODE_BINDING_MISMATCH')
  if (digestObject(result.subject_tuple) !== digestObject(state.subject_tuple)) throw new ShirubeV41TransitionError('SUBJECT_TUPLE_MISMATCH')
  if (!Array.isArray(result.evidence_refs) || result.evidence_refs.length === 0 || result.evidence_refs.some((evidence) => !nonEmptyString(evidence?.ref) || !DIGEST.test(evidence?.digest ?? ''))) throw new ShirubeV41TransitionError('RESULT_NODE_BINDING_MISMATCH')
}

function validateGraphState(state: RuntimePlanState): void {
  const graph = state.graph_state
  if (!isObject(graph) || !Number.isInteger(graph.wip_limit) || graph.wip_limit < 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.terminal_predicates)) throw new ShirubeV41TransitionError('PLAN_BINDING_MISMATCH')
  if (state.state_digest !== deriveRuntimeStateDigest(state)) throw new ShirubeV41TransitionError('PLAN_BINDING_MISMATCH')
  const ids = new Set<string>()
  const workClasses = new Set(['IMPLEMENTATION', 'INDEPENDENT_EVIDENCE_AUDIT', 'INDEPENDENT_SCENARIO_VERIFICATION', 'GRAPH_AMENDMENT', 'PROTECTED_SURFACE_GATE', 'HUMAN_OWNER_DECISION'])
  for (const node of graph.nodes) {
    if (!isObject(node) || !nonEmptyString(node.node_id) || ids.has(node.node_id)
      || !Number.isInteger(node.plan_order) || node.plan_order < 0
      || !Array.isArray(node.depends_on) || new Set(node.depends_on).size !== node.depends_on.length
      || !['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE'].includes(node.lifecycle_state)
      || !workClasses.has(node.work_class)
      || !nonEmptyString(node.actor_agent_id) || !nonEmptyString(node.active_function)
      || typeof node.destination_registered !== 'boolean' || typeof node.owner_transport_available !== 'boolean'
      || !(node.maker_agent_id === null || nonEmptyString(node.maker_agent_id))
      || !(node.typed_wait_key === null || nonEmptyString(node.typed_wait_key))
      || !(node.protected_decision_key === null || nonEmptyString(node.protected_decision_key))
      || !validSubjectTuple(node.subject_tuple)
      || !Array.isArray(node.allowed_paths) || node.allowed_paths.length === 0 || node.allowed_paths.some((path) => !nonEmptyString(path))
      || !Array.isArray(node.required_checks) || node.required_checks.length === 0 || node.required_checks.some((check) => !nonEmptyString(check))) {
      throw new ShirubeV41TransitionError('PLAN_BINDING_MISMATCH')
    }
    ids.add(node.node_id)
  }
  if (graph.nodes.some((node) => node.depends_on.some((dependency) => !ids.has(dependency))) || hasGraphCycle(graph.nodes)) throw new ShirubeV41TransitionError('DEPENDENCY_OPEN')
  const selected = graph.nodes.find((node) => node.node_id === state.node_id)
  if (!selected || selected.actor_agent_id !== state.actor_agent_id || selected.active_function !== state.active_function || digestObject(selected.subject_tuple) !== digestObject(state.subject_tuple)) throw new ShirubeV41TransitionError('PLAN_BINDING_MISMATCH')
  if (graph.terminal_predicates.some((predicate) => !nonEmptyString(predicate?.predicate_id)
    || !['OPEN', 'VERIFIED'].includes(predicate?.status)
    || !Number.isInteger(predicate?.generation)
    || !DIGEST.test(predicate?.subject_tuple_digest ?? '')
    || (predicate.status === 'VERIFIED' && (!nonEmptyString(predicate.evidence_ref) || !DIGEST.test(predicate.evidence_digest ?? ''))))) {
    throw new ShirubeV41TransitionError('TERMINAL_EVIDENCE_BINDING_MISMATCH')
  }
}

function compareGraphNodes(left: RuntimeGraphNode, right: RuntimeGraphNode): number {
  return left.plan_order - right.plan_order || left.node_id.localeCompare(right.node_id)
}

function descendantOfTypedWait(nodeId: string, byId: Map<string, RuntimeGraphNode>, seen = new Set<string>()): boolean {
  if (seen.has(nodeId)) return false
  seen.add(nodeId)
  const node = byId.get(nodeId)
  return Boolean(node?.typed_wait_key) || (node?.depends_on ?? []).some((dependency) => descendantOfTypedWait(dependency, byId, seen))
}

function hasGraphCycle(nodes: RuntimeGraphNode[]): boolean {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visiting.add(nodeId)
    if ((byId.get(nodeId)?.depends_on ?? []).some(visit)) return true
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }
  return nodes.some((node) => visit(node.node_id))
}

function samePlanState(left: RuntimePlanState, right: RuntimePlanState): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function planBindingOf(state: RuntimePlanState): PlanBinding {
  return {
    root_goal_run_id: state.root_goal_run_id,
    plan_id: state.plan_id,
    plan_digest: state.plan_digest,
    generation: state.generation,
    graph_id: state.graph_id,
    node_id: state.node_id,
    parent_graph_id: state.parent_graph_id,
    parent_node_id: state.parent_node_id,
  }
}

function validTelemetry(telemetry: TransitionTelemetry): boolean {
  const token = (value: unknown) => value === 'NOT_AVAILABLE' || (Number.isInteger(value) && Number(value) >= 0)
  const timestampsValid = telemetry?.attempt_started_at === 'NOT_AVAILABLE' && telemetry?.decision_completed_at === 'NOT_AVAILABLE'
    || (isValidRfc3339(telemetry?.attempt_started_at)
    && isValidRfc3339(telemetry?.decision_completed_at)
    && Date.parse(telemetry.attempt_started_at) <= Date.parse(telemetry.decision_completed_at))
  return timestampsValid
    && nonEmptyString(telemetry.model)
    && token(telemetry.input_tokens)
    && token(telemetry.output_tokens)
    && token(telemetry.cached_tokens)
}

function validateDestination(transition: TransitionBinding, delivery: ReceiptPayload['delivery_binding']): string | null {
  const actor = transition.destination_actor_agent_id
  const fn = transition.destination_active_function
  const owner = transition.destination_owner_principal_id
  const authority = transition.destination_owner_authority_key
  const ownerSchema = transition.owner_decision_schema
  if (transition.destination_kind === 'AGENT_FUNCTION') {
    if (![actor, fn].every(nonEmptyString) || [owner, authority, ownerSchema].some((value) => value !== null)) return 'RECEIPT_DESTINATION_MISMATCH'
  } else if (transition.destination_kind === 'HUMAN_OWNER') {
    if (actor !== null || fn !== null || !nonEmptyString(owner) || !nonEmptyString(authority) || ownerSchema !== 'shirube-v3/owner_decision/v1') return 'RECEIPT_DESTINATION_MISMATCH'
  } else return 'RECEIPT_DESTINATION_MISMATCH'
  if (transition.delivery_class === 'PROTECTED_DECISION' && !nonEmptyString(transition.protected_decision_key)) return 'RECEIPT_DESTINATION_MISMATCH'
  if (transition.delivery_class === 'AUN_DELEGATE' && transition.destination_kind !== 'AGENT_FUNCTION') return 'RECEIPT_DESTINATION_MISMATCH'
  if (transition.delivery_class === 'PROTECTED_DECISION' && transition.delivery_subtype === 'PROTECTED_SURFACE_GATE' && (transition.destination_kind !== 'AGENT_FUNCTION' || transition.destination_active_function !== 'protected_surface_gate')) return 'RECEIPT_DESTINATION_MISMATCH'
  if (transition.delivery_class === 'PROTECTED_DECISION' && transition.delivery_subtype === 'HUMAN_OWNER_DECISION' && transition.destination_kind !== 'HUMAN_OWNER') return 'RECEIPT_DESTINATION_MISMATCH'
  if (delivery.queue_permission !== 'ALLOW_EXACTLY_ONE') return 'RECEIPT_QUEUE_NOT_PERMITTED'
  return null
}

function destinationMatches(transition: TransitionBinding, destination: JsonRecord | null | undefined): boolean {
  if (!destination) return false
  return ['destination_kind', 'destination_actor_agent_id', 'destination_active_function', 'destination_owner_principal_id', 'destination_owner_authority_key', 'owner_decision_schema', 'protected_decision_key']
    .every((field) => (destination[field] ?? null) === ((transition as JsonRecord)[field] ?? null))
}

function bindingMatches(payload: ReceiptPayload, expected: JsonRecord): boolean {
  if (!isObject(expected)) return false
  const plan = payload.plan_binding as JsonRecord
  const transition = payload.transition_binding
  const fields = ['root_goal_run_id', 'plan_id', 'plan_digest', 'generation', 'graph_id', 'node_id', 'parent_graph_id', 'parent_node_id']
  return fields.every((field) => (expected[field] ?? null) === (plan[field] ?? null))
    && expected.subject_tuple_digest === payload.subject_binding.subject_tuple_digest
    && expected.result_digest === transition.result_digest
    && expected.handoff_digest === transition.handoff_digest
}

function committedTransitionMatches(payload: ReceiptPayload, committed: JsonRecord): boolean {
  if (!isObject(committed)) return false
  const plan = payload.plan_binding
  const transition = payload.transition_binding
  return committed.from_state_digest === transition.from_state_digest
    && committed.to_state_digest === transition.to_state_digest
    && committed.plan_digest === plan.plan_digest
    && committed.generation === plan.generation
    && committed.graph_id === plan.graph_id
    && committed.node_id === plan.node_id
    && committed.result_digest === transition.result_digest
}

function localProvenance(wire: TransitionReceiptWire, queue: { queue_id: string; message_id: string }): JsonRecord {
  const payload = wire.receipt_payload
  const transition = payload.transition_binding
  return {
    controller_adapter_id: payload.receipt_identity.controller_adapter_id,
    receipt_id: payload.receipt_identity.receipt_id,
    payload_sha256: wire.payload_sha256,
    idempotency_key: payload.delivery_binding.idempotency_key,
    handoff_digest: transition.handoff_digest,
    destination_kind: transition.destination_kind,
    destination_actor_agent_id: transition.destination_actor_agent_id,
    destination_active_function: transition.destination_active_function,
    destination_owner_principal_id: transition.destination_owner_principal_id,
    destination_owner_authority_key: transition.destination_owner_authority_key,
    owner_decision_schema: transition.owner_decision_schema,
    protected_decision_key: transition.protected_decision_key,
    queue_id: queue.queue_id,
    message_id: queue.message_id,
  }
}

function validLocalConsumption(local: LocalConsumptionRecord, request: AunAdmissionRequest): boolean {
  if (local.controller_adapter_id !== request.controller_adapter_id || local.receipt_id !== request.receipt_id || local.payload_sha256 !== request.payload_sha256) return false
  if (!isObject(local.provenance) || local.provenance_digest !== digestObject(local.provenance)) return false
  if (!validLocalProvenance(local.provenance)) return false
  return LOCAL_PROVENANCE_FIELDS.every((field) => (local[field] ?? null) === (local.provenance[field] ?? null))
}

function validLocalProvenance(provenance: JsonRecord): boolean {
  const queueIdValid = (Number.isInteger(provenance.queue_id) && provenance.queue_id > 0) || (typeof provenance.queue_id === 'string' && /^[1-9]\d*$/.test(provenance.queue_id))
  if (!nonEmptyString(provenance.controller_adapter_id) || !RECEIPT_ID.test(provenance.receipt_id ?? '') || !/^[a-f0-9]{64}$/.test(provenance.payload_sha256 ?? '') || !/^owd:v2:[a-f0-9]{64}$/.test(provenance.idempotency_key ?? '') || !DIGEST.test(provenance.handoff_digest ?? '') || !queueIdValid || !nonEmptyString(provenance.message_id)) return false
  const delivery = { queue_permission: 'ALLOW_EXACTLY_ONE', maximum_hop_count: 1, idempotency_key: provenance.idempotency_key, issued_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-01T00:00:01Z' } as ReceiptPayload['delivery_binding']
  const transition = {
    delivery_class: provenance.destination_kind === 'HUMAN_OWNER' ? 'PROTECTED_DECISION' : 'AUN_DELEGATE',
    delivery_subtype: provenance.destination_kind === 'HUMAN_OWNER' ? 'HUMAN_OWNER_DECISION' : 'LOCAL_REPLAY',
    destination_kind: provenance.destination_kind,
    destination_actor_agent_id: provenance.destination_actor_agent_id ?? null,
    destination_active_function: provenance.destination_active_function ?? null,
    destination_owner_principal_id: provenance.destination_owner_principal_id ?? null,
    destination_owner_authority_key: provenance.destination_owner_authority_key ?? null,
    owner_decision_schema: provenance.owner_decision_schema ?? null,
    protected_decision_key: provenance.protected_decision_key ?? null,
  } as TransitionBinding
  return validateDestination(transition, delivery) === null
}

function validSubjectTuple(value: unknown): value is SubjectTuple {
  if (!isObject(value)) return false
  try { exactKeys(value, RECEIPT_KEYS.subjectTuple) } catch { return false }
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    && GIT_SHA.test(value.commit_sha)
    && GIT_SHA.test(value.tree_sha)
    && ['release_id', 'process_identity', 'environment'].every((field) => nonEmptyString(value[field]))
    && ['config_digest', 'policy_digest'].every((field) => DIGEST.test(value[field]))
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (!isObject(value)) throw new Error('object required')
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error('exact keys required')
}

function assertNfc(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path)
    if (value !== value.normalize('NFC')) throw new Error(`non-NFC string at ${path}`)
    return
  }
  if (Array.isArray(value)) value.forEach((entry, index) => assertNfc(entry, `${path}[${index}]`))
  else if (isObject(value)) Object.entries(value).forEach(([key, entry]) => {
    assertUnicodeScalarString(key, path)
    if (key !== key.normalize('NFC')) throw new Error(`non-NFC key at ${path}`)
    assertNfc(entry, `${path}.${key}`)
  })
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`invalid Unicode surrogate at ${path}`)
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error(`invalid Unicode surrogate at ${path}`)
  }
}

export function isValidRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = value.match(RFC3339)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59) return false
  if (zone !== 'Z' && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false
  return Number.isFinite(Date.parse(value))
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function reasonFromError(error: unknown): string {
  if (error instanceof ShirubeV41TransitionError) return error.reasonCode
  return 'TRANSACTION_ABORTED'
}

function passReport(
  decision: string,
  reason: string,
  queueRows: number,
  projections: number,
  effects: number,
  stateTransitions: number,
  receiptWire?: TransitionReceiptWire | null,
  queueId: string | null = null,
  messageId: string | null = null,
  authoritativeLookupPerformed?: boolean,
  telemetry: TransitionTelemetry = unavailableTelemetry(),
): RuntimeReport {
  return {
    schema: SHIRUBE_V41_TRANSITION_RUNTIME_VERSION,
    verdict: 'PASS',
    decision,
    reason_code: reason,
    queue_id: queueId,
    message_id: messageId,
    queue_rows: queueRows,
    projections,
    effects,
    state_transitions: stateTransitions,
    telemetry: validTelemetry(telemetry) ? telemetry : unavailableTelemetry(),
    receipt_wire: receiptWire,
    ...(authoritativeLookupPerformed === undefined ? {} : { authoritative_lookup_performed: authoritativeLookupPerformed }),
  }
}

function blockReport(reason: string, telemetry: TransitionTelemetry = unavailableTelemetry(), authoritativeLookupPerformed = false): RuntimeReport {
  return {
    schema: SHIRUBE_V41_TRANSITION_RUNTIME_VERSION,
    verdict: 'BLOCK',
    decision: 'REJECT',
    reason_code: reason,
    queue_id: null,
    message_id: null,
    queue_rows: 0,
    projections: 0,
    effects: 0,
    state_transitions: 0,
    telemetry: validTelemetry(telemetry) ? telemetry : unavailableTelemetry(),
    authoritative_lookup_performed: authoritativeLookupPerformed,
  }
}

function unavailableTelemetry(): TransitionTelemetry {
  return {
    attempt_started_at: 'NOT_AVAILABLE',
    decision_completed_at: 'NOT_AVAILABLE',
    model: 'NOT_AVAILABLE',
    input_tokens: 'NOT_AVAILABLE',
    output_tokens: 'NOT_AVAILABLE',
    cached_tokens: 'NOT_AVAILABLE',
  }
}
