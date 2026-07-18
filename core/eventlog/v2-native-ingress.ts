// AUN V2-native mesh — typed stage scope and provider/V1-free ingress.
//
// The scope is the mechanical fence for every mesh mutation.  S0 callers
// must present the exact implementation head, isolated database identity,
// and frozen runtime snapshot.  Provider dispatch and V1 traversal are
// literals, not advisory flags.

import type { DbAdapter } from '../db/adapter'
import { canonicalJson, sha256Utf8 } from './transport-contract'
import { receiveMessage } from './turns'

export const V2_NATIVE_MESH_SCOPE_SCHEMA_VERSION = 'aun-v2-native-mesh-scope/v1' as const
export const V2_NATIVE_MESSAGE_SCHEMA_VERSION = 'aun-v2-native-message/v1' as const

export type V2NativeMeshStageId =
  | 'S0_IMPLEMENTATION'
  | 'S1_TWO_AGENT'
  | 'S2_SELECTED_ENABLED'
  | 'S3_ALL_ENABLED'

export interface V2NativeMeshFrozenAgentV1 {
  agent_id: string
  profile_revision: string
  runtime_engine: string
  runtime_instance_id: string
  runtime_checkout_root: string
  runtime_checkout_sha: string
}

export interface V2NativeMeshScopeV1 {
  schema_version: typeof V2_NATIVE_MESH_SCOPE_SCHEMA_VERSION
  run_id: string
  stage_id: V2NativeMeshStageId
  repository: string
  exact_implementation_head: string
  database_identity: string
  frozen_enabled_set: V2NativeMeshFrozenAgentV1[]
  frozen_enabled_set_sha256: string
  runtime_snapshot_sha256: string
  provider_dispatch: 'disabled'
  V1_mode: 'observe_only_no_traversal'
  deadline_ms: number
}

export interface V2NativeMeshExecutionFence {
  stage_id: V2NativeMeshStageId
  exact_implementation_head: string
  database_identity: string
  runtime_snapshot_sha256: string
}

export interface V2NativeInboundPayloadV1 {
  schema_version: typeof V2_NATIVE_MESSAGE_SCHEMA_VERSION
  mesh_native: true
  message_id: string
  run_id: string
  stage_id: V2NativeMeshStageId
  scope_sha256: string
  delivery_id: string
  route_id: string
  route_kind: 'direct' | 'fanout_child' | 'reply'
  source_agent_id: string
  recipient_agent_id: string
  content: string
  provider_dispatch: 'disabled'
  V1_mode: 'observe_only_no_traversal'
}

const SCOPE_FIELDS = [
  'schema_version',
  'run_id',
  'stage_id',
  'repository',
  'exact_implementation_head',
  'database_identity',
  'frozen_enabled_set',
  'frozen_enabled_set_sha256',
  'runtime_snapshot_sha256',
  'provider_dispatch',
  'V1_mode',
  'deadline_ms',
] as const

const FROZEN_AGENT_FIELDS = [
  'agent_id',
  'profile_revision',
  'runtime_engine',
  'runtime_instance_id',
  'runtime_checkout_root',
  'runtime_checkout_sha',
] as const

const INBOUND_FIELDS = [
  'schema_version',
  'mesh_native',
  'message_id',
  'run_id',
  'stage_id',
  'scope_sha256',
  'delivery_id',
  'route_id',
  'route_kind',
  'source_agent_id',
  'recipient_agent_id',
  'content',
  'provider_dispatch',
  'V1_mode',
] as const

export class V2NativeMeshFenceError extends Error {
  readonly code = 'V2_NATIVE_MESH_FENCE_FAILED' as const
}

function fail(message: string): never {
  throw new V2NativeMeshFenceError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactFields(value: unknown, fields: readonly string[], name: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    const missing = expected.filter(field => !actual.includes(field))
    const extra = actual.filter(field => !expected.includes(field))
    fail(`${name} fields differ missing=[${missing.join(',')}] extra=[${extra.join(',')}]`)
  }
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    fail(`${field} must be a non-empty trimmed string`)
  }
}

function sha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${field} must be lowercase sha256`)
}

function commitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) fail(`${field} must be a full lowercase commit SHA`)
}

export function frozenEnabledSetSha256(agents: readonly V2NativeMeshFrozenAgentV1[]): string {
  return sha256Utf8(canonicalJson(agents))
}

export function runtimeSnapshotSha256(agents: readonly V2NativeMeshFrozenAgentV1[]): string {
  return sha256Utf8(canonicalJson(agents.map(agent => ({
    agent_id: agent.agent_id,
    runtime_engine: agent.runtime_engine,
    runtime_instance_id: agent.runtime_instance_id,
    runtime_checkout_root: agent.runtime_checkout_root,
    runtime_checkout_sha: agent.runtime_checkout_sha,
  }))))
}

export function v2NativeMeshScopeSha256(scope: V2NativeMeshScopeV1): string {
  return sha256Utf8(canonicalJson(scope))
}

export function decodeV2NativeMeshScope(value: unknown): V2NativeMeshScopeV1 {
  assertExactFields(value, SCOPE_FIELDS, 'V2NativeMeshScopeV1')
  const scope = value as unknown as V2NativeMeshScopeV1
  if (scope.schema_version !== V2_NATIVE_MESH_SCOPE_SCHEMA_VERSION) fail('scope schema_version differs')
  nonEmpty(scope.run_id, 'run_id')
  if (!['S0_IMPLEMENTATION', 'S1_TWO_AGENT', 'S2_SELECTED_ENABLED', 'S3_ALL_ENABLED'].includes(scope.stage_id)) {
    fail('stage_id is not admitted')
  }
  if (scope.repository !== 'watchout/agent-comms-mcp') fail('repository differs from watchout/agent-comms-mcp')
  commitSha(scope.exact_implementation_head, 'exact_implementation_head')
  nonEmpty(scope.database_identity, 'database_identity')
  if (!Array.isArray(scope.frozen_enabled_set) || scope.frozen_enabled_set.length < 2) {
    fail('frozen_enabled_set must contain at least two agents')
  }
  let previous = ''
  for (const [index, agent] of scope.frozen_enabled_set.entries()) {
    assertExactFields(agent, FROZEN_AGENT_FIELDS, `frozen_enabled_set[${index}]`)
    for (const field of FROZEN_AGENT_FIELDS) nonEmpty(agent[field], `frozen_enabled_set[${index}].${field}`)
    commitSha(agent.runtime_checkout_sha, `frozen_enabled_set[${index}].runtime_checkout_sha`)
    if (agent.agent_id <= previous) fail('frozen_enabled_set must be unique and ordered by agent_id ascending')
    previous = agent.agent_id
  }
  sha(scope.frozen_enabled_set_sha256, 'frozen_enabled_set_sha256')
  sha(scope.runtime_snapshot_sha256, 'runtime_snapshot_sha256')
  if (scope.frozen_enabled_set_sha256 !== frozenEnabledSetSha256(scope.frozen_enabled_set)) {
    fail('frozen_enabled_set_sha256 differs from canonical frozen_enabled_set')
  }
  if (scope.runtime_snapshot_sha256 !== runtimeSnapshotSha256(scope.frozen_enabled_set)) {
    fail('runtime_snapshot_sha256 differs from canonical runtime evidence')
  }
  if (scope.provider_dispatch !== 'disabled') fail('provider_dispatch must be disabled')
  if (scope.V1_mode !== 'observe_only_no_traversal') fail('V1_mode must be observe_only_no_traversal')
  if (!Number.isSafeInteger(scope.deadline_ms) || scope.deadline_ms <= Date.now()) {
    fail('deadline_ms must be a future Unix epoch millisecond deadline')
  }
  return scope
}

/** Fail before the first event-log mutation when any S0 execution identity drifts. */
export function assertV2NativeMeshExecutionFence(
  value: unknown,
  expected: V2NativeMeshExecutionFence,
): V2NativeMeshScopeV1 {
  const scope = decodeV2NativeMeshScope(value)
  if (scope.stage_id !== expected.stage_id) fail(`stage mismatch expected=${expected.stage_id} actual=${scope.stage_id}`)
  if (scope.exact_implementation_head !== expected.exact_implementation_head) fail('exact implementation head drift')
  if (scope.database_identity !== expected.database_identity) fail('database identity drift')
  if (scope.runtime_snapshot_sha256 !== expected.runtime_snapshot_sha256) fail('runtime snapshot drift')
  return scope
}

export function decodeV2NativeInboundPayload(value: unknown): V2NativeInboundPayloadV1 {
  assertExactFields(value, INBOUND_FIELDS, 'V2NativeInboundPayloadV1')
  const payload = value as unknown as V2NativeInboundPayloadV1
  if (payload.schema_version !== V2_NATIVE_MESSAGE_SCHEMA_VERSION || payload.mesh_native !== true) fail('message is not V2-native')
  for (const field of ['message_id', 'run_id', 'scope_sha256', 'delivery_id', 'route_id', 'source_agent_id', 'recipient_agent_id'] as const) {
    nonEmpty(payload[field], field)
  }
  sha(payload.scope_sha256, 'scope_sha256')
  if (!['S0_IMPLEMENTATION', 'S1_TWO_AGENT', 'S2_SELECTED_ENABLED', 'S3_ALL_ENABLED'].includes(payload.stage_id)) fail('message stage_id is not admitted')
  if (!['direct', 'fanout_child', 'reply'].includes(payload.route_kind)) fail('message route_kind is not admitted')
  if (typeof payload.content !== 'string') fail('message content must be a string')
  if (payload.provider_dispatch !== 'disabled' || payload.V1_mode !== 'observe_only_no_traversal') {
    fail('message escaped provider/V1 fence')
  }
  return payload
}

export async function appendV2NativeInbound(
  db: DbAdapter,
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
  input: {
    message_id: string
    delivery_id: string
    route_id: string
    route_kind: V2NativeInboundPayloadV1['route_kind']
    source_agent_id: string
    recipient_agent_id: string
    content: string
    conversation_id: string
    correlation_id: string
    causation_id?: string | null
  },
  transaction?: DbAdapter,
) {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  const members = new Set(scope.frozen_enabled_set.map(agent => agent.agent_id))
  if (!members.has(input.source_agent_id) || !members.has(input.recipient_agent_id)) fail('source or recipient is outside frozen_enabled_set')
  if (input.source_agent_id === input.recipient_agent_id) fail('self-routing is not admitted')
  for (const field of ['message_id', 'delivery_id', 'route_id', 'conversation_id', 'correlation_id'] as const) nonEmpty(input[field], field)
  if (typeof input.content !== 'string') fail('content must be a string')
  const payload: V2NativeInboundPayloadV1 = {
    schema_version: V2_NATIVE_MESSAGE_SCHEMA_VERSION,
    mesh_native: true,
    message_id: input.message_id,
    run_id: scope.run_id,
    stage_id: scope.stage_id,
    scope_sha256: v2NativeMeshScopeSha256(scope),
    delivery_id: input.delivery_id,
    route_id: input.route_id,
    route_kind: input.route_kind,
    source_agent_id: input.source_agent_id,
    recipient_agent_id: input.recipient_agent_id,
    content: input.content,
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
  }
  return receiveMessage(db, {
    messageId: input.message_id,
    seatId: input.recipient_agent_id,
    conversationId: input.conversation_id,
    correlationId: input.correlation_id,
    causationId: input.causation_id ?? null,
    payload: payload as unknown as Record<string, unknown>,
  }, transaction)
}
