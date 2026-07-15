// Deterministic V2-native direct/fanout routing over one frozen stage scope.

import type { DbAdapter } from '../db/adapter'
import { EventLog } from './store'
import { canonicalJson, sha256Utf8 } from './transport-contract'
import {
  appendV2NativeInbound,
  assertV2NativeMeshExecutionFence,
  v2NativeMeshScopeSha256,
  V2NativeMeshFenceError,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshScopeV1,
} from './v2-native-ingress'

export interface V2NativeRouteChildV1 {
  recipient_agent_id: string
  message_id: string
  delivery_id: string
}

export interface V2NativeRoutePlanV1 {
  schema_version: 'aun-v2-native-route-plan/v1'
  run_id: string
  scope_sha256: string
  route_id: string
  route_kind: 'direct' | 'fanout'
  source_agent_id: string
  conversation_id: string
  correlation_id: string
  content_sha256: string
  children: V2NativeRouteChildV1[]
  provider_dispatch: 'disabled'
  V1_mode: 'observe_only_no_traversal'
}

export type V2NativeRouteCommitPoint =
  | { point: 'after_plan' }
  | { point: 'after_child'; child_index: number }

export function buildV2NativeRoutePlan(
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
  input: {
    route_id: string
    route_kind: 'direct' | 'fanout'
    source_agent_id: string
    recipient_agent_ids: string[]
    content: string
    conversation_id?: string
    correlation_id?: string
  },
): { scope: V2NativeMeshScopeV1; plan: V2NativeRoutePlanV1 } {
  const scope = assertV2NativeMeshExecutionFence(scopeValue, fence)
  if (input.route_id.trim() === '' || input.route_id !== input.route_id.trim()) throw new V2NativeMeshFenceError('route_id must be non-empty and trimmed')
  if (typeof input.content !== 'string') throw new V2NativeMeshFenceError('content must be a string')
  const members = scope.frozen_enabled_set.map(agent => agent.agent_id)
  if (!members.includes(input.source_agent_id)) throw new V2NativeMeshFenceError('source is outside frozen_enabled_set')
  const recipients = [...input.recipient_agent_ids].sort()
  if (recipients.length === 0 || recipients.some((recipient, index) => index > 0 && recipient === recipients[index - 1])) {
    throw new V2NativeMeshFenceError('recipients must be non-empty and unique')
  }
  if (recipients.some(recipient => !members.includes(recipient) || recipient === input.source_agent_id)) {
    throw new V2NativeMeshFenceError('recipient is foreign or self-routed')
  }
  if (input.route_kind === 'direct' && recipients.length !== 1) {
    throw new V2NativeMeshFenceError('direct routing requires exactly one recipient')
  }
  const expectedFanout = members.filter(member => member !== input.source_agent_id).sort()
  if (input.route_kind === 'fanout' && canonicalJson(recipients) !== canonicalJson(expectedFanout)) {
    throw new V2NativeMeshFenceError('fanout must include every other frozen member exactly once')
  }
  const conversationId = input.conversation_id ?? `mesh:${scope.run_id}:${input.route_id}`
  const correlationId = input.correlation_id ?? `mesh-correlation:${scope.run_id}:${input.route_id}`
  const children = recipients.map(recipient => ({
    recipient_agent_id: recipient,
    message_id: `mesh-message:${scope.run_id}:${input.route_id}:${recipient}`,
    delivery_id: `mesh-delivery:${scope.run_id}:${input.route_id}:${recipient}`,
  }))
  return {
    scope,
    plan: {
      schema_version: 'aun-v2-native-route-plan/v1',
      run_id: scope.run_id,
      scope_sha256: v2NativeMeshScopeSha256(scope),
      route_id: input.route_id,
      route_kind: input.route_kind,
      source_agent_id: input.source_agent_id,
      conversation_id: conversationId,
      correlation_id: correlationId,
      content_sha256: sha256Utf8(input.content),
      children,
      provider_dispatch: 'disabled',
      V1_mode: 'observe_only_no_traversal',
    },
  }
}

/** Persist the immutable plan and every recipient placement in one transaction. */
export async function routeV2NativeMessage(
  db: DbAdapter,
  scopeValue: unknown,
  fence: V2NativeMeshExecutionFence,
  input: {
    route_id: string
    route_kind: 'direct' | 'fanout'
    source_agent_id: string
    recipient_agent_ids: string[]
    content: string
    conversation_id?: string
    correlation_id?: string
  },
  options: {
    onCommitPoint?: (point: V2NativeRouteCommitPoint) => void | Promise<void>
  } = {},
) {
  const { scope, plan } = buildV2NativeRoutePlan(scopeValue, fence, input)
  return db.transaction(async tx => {
    assertV2NativeMeshExecutionFence(scopeValue, fence)
    const planEvent = await new EventLog(db).append({
      eventId: `mesh-route-planned:${scope.run_id}:${plan.route_id}`,
      eventType: 'message.route_planned',
      seatId: plan.source_agent_id,
      conversationId: plan.conversation_id,
      correlationId: plan.correlation_id,
      payload: plan as unknown as Record<string, unknown>,
    }, tx)
    assertV2NativeMeshExecutionFence(scopeValue, fence)
    await options.onCommitPoint?.({ point: 'after_plan' })
    assertV2NativeMeshExecutionFence(scopeValue, fence)
    const placements = []
    for (const [index, child] of plan.children.entries()) {
      placements.push(await appendV2NativeInbound(db, scope, fence, {
        message_id: child.message_id,
        delivery_id: child.delivery_id,
        route_id: plan.route_id,
        route_kind: plan.route_kind === 'fanout' ? 'fanout_child' : 'direct',
        source_agent_id: plan.source_agent_id,
        recipient_agent_id: child.recipient_agent_id,
        content: input.content,
        conversation_id: plan.conversation_id,
        correlation_id: plan.correlation_id,
        causation_id: planEvent.event.event_id,
      }, tx))
      assertV2NativeMeshExecutionFence(scopeValue, fence)
      await options.onCommitPoint?.({ point: 'after_child', child_index: index })
      assertV2NativeMeshExecutionFence(scopeValue, fence)
    }
    assertV2NativeMeshExecutionFence(scopeValue, fence)
    return { plan, planEvent, placements, providerInvocations: 0 as const, V1Invocations: 0 as const }
  })
}
