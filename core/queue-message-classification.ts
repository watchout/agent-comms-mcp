import { parseQueuePayload } from './no-reply-policy'
import { decideQueueRouting, type QueueRoutingDecisionEvidence } from './routing-decision'

export type QueueMessageClassification = 'actionable' | 'non_action' | 'unknown'
export type DeterministicNonActionableMessageType = 'report' | 'chat' | 'notice' | 'projection'

export type NonActionableDispositionReason =
  | 'NON_ACTIONABLE_REPORT'
  | 'NON_ACTIONABLE_CHAT'
  | 'NON_ACTIONABLE_NOTICE'
  | 'NON_ACTIONABLE_PROJECTION'

export interface QueueClassificationAgent {
  agent_id: string
  runtime?: string | null
  status?: string | null
  metadata?: unknown
  profile_enabled?: boolean | null
  disabled_at?: string | Date | null
  expected_provider_identity?: unknown
}

export interface QueueSurfaceClassificationInput {
  agentId: string
  payload: unknown
  agent?: QueueClassificationAgent | null
}

export interface QueueNonActionableDisposition {
  reason: NonActionableDispositionReason
  message_type: DeterministicNonActionableMessageType
  source: 'deterministic_queue_routing'
}

export interface QueueSurfaceClassification {
  message_type: string
  routing: QueueRoutingDecisionEvidence
  actionable: boolean
  deterministic_non_actionable: QueueNonActionableDisposition | null
  diagnostic: 'UNKNOWN_OR_AMBIGUOUS_MESSAGE_TYPE' | 'NON_ACTIONABLE_ROUTING_DECISION' | null
}

export interface QueueDispositionStamp {
  code: NonActionableDispositionReason
  set_by: 'state_daemon'
  set_at: string
  source: 'deterministic_queue_routing'
  message_type: DeterministicNonActionableMessageType
  routing_decision: QueueRoutingDecisionEvidence['routing_decision']
  route_reason: QueueRoutingDecisionEvidence['route_reason']
}

export const ACTIONABLE_MESSAGE_TYPES = new Set(['instruction', 'request', 'question'])
export const NON_ACTIONABLE_MESSAGE_TYPES = new Set(['chat', 'notice', 'projection', 'report'])

const DETERMINISTIC_NON_ACTIONABLE_REASONS: Record<DeterministicNonActionableMessageType, NonActionableDispositionReason> = {
  report: 'NON_ACTIONABLE_REPORT',
  chat: 'NON_ACTIONABLE_CHAT',
  notice: 'NON_ACTIONABLE_NOTICE',
  projection: 'NON_ACTIONABLE_PROJECTION',
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  return stringValue(value)
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function normalizeMessageType(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown'
}

export function classifyQueueMessageType(messageType: unknown): QueueMessageClassification {
  const normalized = normalizeMessageType(messageType)
  if (ACTIONABLE_MESSAGE_TYPES.has(normalized)) return 'actionable'
  if (NON_ACTIONABLE_MESSAGE_TYPES.has(normalized)) return 'non_action'
  return 'unknown'
}

export function isNonActionableMessageType(messageType: unknown): boolean {
  return classifyQueueMessageType(messageType) === 'non_action'
}

export function parseQueuePayloadObject(payload: unknown): Record<string, unknown> {
  return parseObject(payload)
}

function booleanFromUnknown(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return null
}

function stringsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return stringsFromUnknown(parsed)
  } catch {}
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function targetDiscordId(agent: QueueClassificationAgent | null | undefined): string | null {
  if (!agent) return null
  const metadata = parseObject(agent.metadata)
  const expected = parseObject(agent.expected_provider_identity)
  const candidates = [
    metadata.discord_id,
    metadata.discord_user_id,
    expected.subject,
    expected.discord_id,
    expected.discord_user_id,
  ]
  for (const candidate of candidates) {
    const value = stringValue(candidate)
    if (value) return value
  }
  return null
}

function deterministicNonActionableType(messageType: string): DeterministicNonActionableMessageType | null {
  return Object.prototype.hasOwnProperty.call(DETERMINISTIC_NON_ACTIONABLE_REASONS, messageType)
    ? messageType as DeterministicNonActionableMessageType
    : null
}

export function classifyQueueSurface(input: QueueSurfaceClassificationInput): QueueSurfaceClassification {
  const payload = parseQueuePayload(input.payload)
  const messageType = stringValue(payload.message_type) ?? 'unknown'
  const agent = input.agent ?? null
  const routing = decideQueueRouting({
    target_agent_id: input.agentId,
    target_runtime: stringValue(agent?.runtime),
    target_status: stringValue(agent?.status),
    target_profile_enabled: booleanFromUnknown(agent?.profile_enabled),
    target_disabled_at: normalizeDate(agent?.disabled_at),
    target_discord_id: targetDiscordId(agent),
    message_type: messageType,
    source: stringValue(payload.source),
    content: stringValue(payload.content),
    author_id: stringValue(payload.author_id),
    mentions: [
      ...stringsFromUnknown(payload.mentions),
      ...stringsFromUnknown(payload.input_mentions),
    ],
    channel_policy: null,
  })
  if (routing.routing_decision === 'wake_agent') {
    return {
      message_type: messageType,
      routing,
      actionable: true,
      deterministic_non_actionable: null,
      diagnostic: null,
    }
  }

  const deterministicType = deterministicNonActionableType(messageType)
  if (deterministicType) {
    return {
      message_type: messageType,
      routing,
      actionable: false,
      deterministic_non_actionable: {
        reason: DETERMINISTIC_NON_ACTIONABLE_REASONS[deterministicType],
        message_type: deterministicType,
        source: 'deterministic_queue_routing',
      },
      diagnostic: 'NON_ACTIONABLE_ROUTING_DECISION',
    }
  }

  return {
    message_type: messageType,
    routing,
    actionable: false,
    deterministic_non_actionable: null,
    diagnostic: 'UNKNOWN_OR_AMBIGUOUS_MESSAGE_TYPE',
  }
}

export function withQueueDispositionStamp(
  payload: Record<string, unknown>,
  stamp: QueueDispositionStamp,
): Record<string, unknown> {
  const current = payload.queue_disposition
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const currentObject = current as Record<string, unknown>
    if (typeof currentObject.code === 'string' && currentObject.code.trim()) {
      return { ...payload, queue_disposition: currentObject }
    }
  }
  return {
    ...payload,
    queue_disposition: stamp,
  }
}

export function messageTypeFromQueuePayload(payload: unknown, fallback?: unknown): string {
  const parsed = parseQueuePayloadObject(payload)
  return normalizeMessageType(parsed.message_type ?? fallback)
}
