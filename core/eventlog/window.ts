import type { DbAdapter } from '../db/adapter'
import { EventLog } from './store'
import { EventIdCanonicalMaterialCollisionError, parseEventPayload, type StoredEvent } from './types'
import { decodeReplyDeliveredPayload, decodeReplyHandoffAcceptedPayload, sha256Utf8 } from './transport-contract'
import { appendV2NativeInbound, assertV2NativeMeshExecutionFence, type V2NativeMeshExecutionFence } from './v2-native-ingress'

export interface V2WindowContext { agentId: string; scope: unknown; fence: V2NativeMeshExecutionFence; nowMs: number }
export class V2WindowError extends Error { constructor(readonly code: string) { super(code) } }
const fail = (code: string): never => { throw new V2WindowError(code) }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim()
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('REJECTED_INPUT')
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) return fail('REJECTED_INPUT')
  return value as Record<string, unknown>
}
function admitted(c: V2WindowContext) {
  let scope
  try { scope = assertV2NativeMeshExecutionFence(c.scope, c.fence) } catch { return fail('REJECTED_SCOPE') }
  if (!scope.frozen_enabled_set.some(a => a.agent_id === c.agentId)) return fail('REJECTED_IDENTITY')
  return scope
}
function owned(events: StoredEvent[], agentId: string) {
  const first = events.find(e => e.event_type === 'message.received')
  if (!first || parseEventPayload(first.payload).source_agent_id !== agentId) fail('REJECTED_SCOPE')
}
export function v2WindowFailure(error: unknown) {
  const code = error instanceof V2WindowError ? error.code : error instanceof EventIdCanonicalMaterialCollisionError ? 'CONFLICT' : 'UNOBSERVABLE'
  return { code, observed: false }
}
export async function v2Send(db: DbAdapter, c: V2WindowContext, value: unknown) {
  const scope = admitted(c)
  const input = object(value, ['to', 'conversation_id', 'idempotency_key', 'content', 'refs'])
  const refs = object(input.refs, ['principal_ref', 'pack_digest', 'approval_ref', 'onza_run_id'])
  if (!Object.values(refs).every(nonempty) || !nonempty(input.to) || !nonempty(input.idempotency_key) || typeof input.content !== 'string') fail('REJECTED_INPUT')
  if (input.conversation_id !== null && !nonempty(input.conversation_id)) fail('REJECTED_INPUT')
  const to = input.to as string, key = input.idempotency_key as string
  if (to === c.agentId || !scope.frozen_enabled_set.some(a => a.agent_id === to)) fail('REJECTED_ROUTE')
  const conversationId = input.conversation_id as string | null ?? `window:${sha256Utf8(JSON.stringify([c.agentId, key]))}`
  return db.transaction(async tx => {
    const log = new EventLog(tx)
    if (input.conversation_id !== null) owned(await log.readConversation(conversationId), c.agentId)
    const received = await appendV2NativeInbound(db, scope, c.fence, {
      message_id: `window:${key}`, delivery_id: `window:${key}`, route_id: key, route_kind: 'direct',
      source_agent_id: c.agentId, recipient_agent_id: to, content: input.content as string,
      conversation_id: conversationId, correlation_id: conversationId,
    }, tx)
    const link = await log.append({ eventId: `link:${key}`, eventType: 'conversation.linked', seatId: c.agentId,
      conversationId, causationId: received.event.event_id, correlationId: conversationId,
      payload: { schema_version: 'onza-conversation-link/v1', ...refs, linked_event_id: received.event.event_id },
    }, tx)
    admitted(c) // Recheck the deadline before committing both events.
    return { conversation_id: conversationId, event_id: received.event.event_id, link_event_id: link.event.event_id, state: 'queued' as const }
  })
}
export async function v2Status(db: DbAdapter, c: V2WindowContext, value: unknown) {
  admitted(c)
  const input = object(value, ['conversation_id'])
  if (!nonempty(input.conversation_id)) fail('REJECTED_INPUT')
  const events = await new EventLog(db).readConversation(input.conversation_id as string)
  if (events.length) owned(events, c.agentId)
  const states: Array<Record<string, unknown>> = [], links: Array<Record<string, unknown>> = []
  const claims = { turn: new Map<string, StoredEvent>(), delivery: new Map<string, StoredEvent>() }
  const terminalTurns = new Set<string>(), terminalReplies = new Set<string>()
  const repliedCompletions = new Set(events.filter(e => e.event_type === 'reply.enqueued').map(e => e.causation_id))
  let unprojected = 0
  for (const e of events) {
    const p = parseEventPayload<Record<string, any>>(e.payload), t = e.event_type
    const turn = e.turn_id ?? '', reply = e.reply_id ?? ''
    let state: string | undefined, receiptMode = 'none', terminal = false
    let detail: Record<string, unknown> = {}
    if (t === 'message.received') state = 'queued'
    if (t === 'conversation.linked' && p.schema_version === 'onza-conversation-link/v1') {
      links.push({ link_event_id: e.event_id, linked_event_id: p.linked_event_id, principal_ref: p.principal_ref,
        pack_digest: p.pack_digest, approval_ref: p.approval_ref, onza_run_id: p.onza_run_id, at: e.occurred_at })
    }
    if (t === 'reply.enqueued' && p.schema_version !== 'aun-delivery-unit/v1') unprojected++
    const kind = t.startsWith('turn.') ? 'turn' : 'delivery', id = kind === 'turn' ? turn : reply
    const current = claims[kind].get(id)
    if (t === 'turn.claimed' || t === 'reply.delivery_claimed') {
      if (!current || (e.claim_epoch ?? 0) > (current.claim_epoch ?? 0)) claims[kind].set(id, e)
      state = 'claimed'; detail = { kind, claim_epoch: e.claim_epoch }
    }
    if (t === 'turn.claim_released' || t === 'turn.attempt_failed' || t === 'reply.failed' || t === 'reply.delivery_unknown') {
      if (current && (e.claim_epoch ?? 0) >= (current.claim_epoch ?? 0)) claims[kind].delete(id)
    }
    if (['turn.completed', 'turn.blocked', 'turn.dead_lettered'].includes(t)) {
      terminalTurns.add(turn); terminal = true; state = 'terminal'
      detail = t === 'turn.completed' ? { outcome: p.outcome } : { reason_code: p.reason_code, reason_summary: p.reason_summary, attempt_count: p.attempt_count ?? null }
      if (t === 'turn.completed' && p.outcome === 'failed') state = 'failed'
      if (t === 'turn.completed' && p.outcome === 'replied' && repliedCompletions.has(e.event_id)) {
        states.push({ state: 'replied', event_id: e.event_id, seq: Number(e.seq), turn_id: turn, reply_id: e.reply_id, receipt_mode: 'none', detail: { ...detail, terminal } })
      }
    }
    if (t === 'turn.attempt_failed') { state = 'failed'; detail = { failure_code: p.failure_code, retryable: p.retryable } }
    if (t === 'turn.retry_scheduled') { state = 'queued'; detail = { available_at: p.available_at, backoff_ms: p.backoff_ms } }
    if (t === 'reply.failed') {
      state = 'failed'; terminal = p.permanent === true || p.kind === 'permanent'
      detail = { failure_code: p.failure_code ?? p.reason ?? null, permanent: terminal, retryable: !terminal }
      if (terminal) terminalReplies.add(reply)
    }
    if (t === 'reply.delivery_unknown') {
      state = 'unknown'; detail = { reconciliation_mode: p.reconciliation_mode ?? null, attempt_ordinal: p.attempt_ordinal ?? null,
        invocation_started_event_id: p.invocation_started_event_id ?? null, provider_request_digest: p.provider_request_digest ?? null, failure_code: null }
    }
    if (t === 'reply.delivered') {
      try { decodeReplyDeliveredPayload(p); state = 'delivered'; receiptMode = 'provider_verified' }
      catch { if (Object.keys(p).length !== 1 || !nonempty(p.transport_message_id)) fail('UNOBSERVABLE'); state = 'placed'; receiptMode = 'notify_accepted' }
      terminal = true; terminalReplies.add(reply); detail = { receipt_digest: p.receipt_digest ?? null }
    }
    if (t === 'reply.handoff_accepted') {
      decodeReplyHandoffAcceptedPayload(p); state = 'placed'; receiptMode = 'internal'
      terminal = true; terminalReplies.add(reply); detail = { receipt_digest: p.receipt_digest }
    }
    if (state) states.push({ state, event_id: e.event_id, seq: Number(e.seq), turn_id: e.turn_id, reply_id: e.reply_id, receipt_mode: receiptMode, detail: { ...detail, terminal } })
  }
  const active = (kind: 'turn' | 'delivery') => [...claims[kind]].filter(([id, e]) => {
    const expiry = parseEventPayload(e.payload).lease_expires_at
    return !(kind === 'turn' ? terminalTurns : terminalReplies).has(id) && (expiry == null || typeof expiry === 'string' && Date.parse(expiry) > c.nowMs)
  }).map(([, e]) => ({ event_id: e.event_id, turn_id: e.turn_id, reply_id: e.reply_id, claim_epoch: e.claim_epoch }))
  const currentClaims = { turn: active('turn'), delivery: active('delivery') }
  const ids = new Set([...currentClaims.turn, ...currentClaims.delivery].map(e => e.event_id))
  for (const state of states) if (state.state === 'claimed') state.current = ids.has(state.event_id as string)
  return { observed: true, max_seq: events.length ? Number(events[events.length - 1].seq) : 0, states, links, claims: currentClaims, unprojected_replies: unprojected }
}
