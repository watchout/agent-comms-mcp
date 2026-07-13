import { randomUUID } from 'node:crypto'

import {
  outboundProjectionSkipCode,
  outboundProjectionSkipReason,
  resolveOutboundProjectionDecision,
} from './outbound-projection'
import { decorateProjectedContent } from './projection-text-decorator'
import { truncateForDiscord } from './truncate'

export interface AnchoredReplyDb {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>
}

export interface AnchoredReplyInput {
  sourceQueueId: string | number
  expectedSourceStatus: 'received' | 'in_progress' | 'done'
  senderAgentId: string
  recipientAgentId: string
  replyTo: string
  channelId: string
  threadId?: string | null
  content: string
  messageType?: string
  queueSource?: string
  metadata?: Record<string, unknown>
  closeSource?: boolean
  now?: Date
  messageId?: string
}

export interface AnchoredReplyResult {
  message_id: string
  recipient_queue_id: string
  outbound_queued: boolean
  outbound_skip_reason: string | null
}

export class AnchoredReplyError extends Error {
  constructor(
    public readonly code:
      | 'RECIPIENT_QUEUE_NOT_CREATED'
      | 'SOURCE_CLOSE_RACE'
      | 'ANCHORED_REPLY_WRITE_FAILED',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AnchoredReplyError'
  }
}

async function auditLog(
  db: AnchoredReplyDb,
  eventType: string,
  agentId: string,
  target: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    'INSERT INTO audit_log (event_type, agent_id, target, detail, org_id) VALUES ($1, $2, $3, $4, $5)',
    [eventType, agentId, target, JSON.stringify(detail), 'default'],
  )
}

/**
 * Persist the canonical reply and its one active-owner receipt using the
 * caller's already-open transaction.
 */
export async function persistAnchoredReplyMessageAndRecipientInTransaction(
  db: AnchoredReplyDb,
  input: Omit<AnchoredReplyInput, 'closeSource' | 'expectedSourceStatus'> & {
    metadata: Record<string, unknown>
    messageId: string
  },
): Promise<{ message_id: string; recipient_queue_id: string }> {
  const threadId = input.threadId ?? null
  const messageType = input.messageType ?? 'chat'
  const now = input.now ?? new Date()
  await db.query(
    `INSERT INTO agent_messages
       (id, channel_id, author_id, content, message_type, reply_to, metadata,
        depth, source, thread_id, direction, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'agent-comms', $8, 'outbound', 'agent')`,
    [input.messageId, input.channelId, input.senderAgentId, input.content, messageType, input.replyTo, JSON.stringify(input.metadata), threadId],
  )
  const payload = JSON.stringify({
    channel_id: input.channelId,
    thread_id: threadId,
    author_id: input.senderAgentId,
    author_name: null,
    content: input.content,
    message_id: input.messageId,
    message_type: messageType,
    source: input.queueSource ?? 'transaction-native-reply',
    ts: now.toISOString(),
  })
  const fanout = await db.query<{ id: string | number }>(
    `INSERT INTO message_queue (agent_id, message_id, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.recipientAgentId, input.messageId, payload],
  )
  const recipientQueueId = fanout.rows[0]?.id
  if (recipientQueueId === undefined || recipientQueueId === null) {
    throw new AnchoredReplyError(
      'RECIPIENT_QUEUE_NOT_CREATED',
      `active-owner queue row was not created for ${input.recipientAgentId}`,
    )
  }
  return { message_id: input.messageId, recipient_queue_id: String(recipientQueueId) }
}

/**
 * Persist an anchored reply using the caller's already-open transaction.
 *
 * This function deliberately owns no BEGIN/COMMIT and launches no child
 * process. The caller must hold the source queue row lock. Every write below
 * therefore commits or rolls back with the source status transition.
 */
export async function writeAnchoredReplyInTransaction(
  db: AnchoredReplyDb,
  input: AnchoredReplyInput,
): Promise<AnchoredReplyResult> {
  const id = input.messageId ?? randomUUID()
  const now = input.now ?? new Date()
  const threadId = input.threadId ?? null
  const messageType = input.messageType ?? 'chat'
  const mentions = [input.recipientAgentId]
  const metadata = {
    mentions,
    routing_scope: {
      mode: 'anchored_queue_claim',
      surface: 'transaction-native-reply',
      channel_id: input.channelId,
      thread_id: threadId,
      reply_to: input.replyTo,
      queue_id: input.sourceQueueId,
      alias_resolution: false,
    },
    aun_control_plane: {
      active_owner: input.recipientAgentId,
      cc: [],
      fyi: [],
      observers: [],
    },
    ...(input.metadata ?? {}),
  }

  try {
    const persisted = await persistAnchoredReplyMessageAndRecipientInTransaction(db, {
      sourceQueueId: input.sourceQueueId,
      senderAgentId: input.senderAgentId,
      recipientAgentId: input.recipientAgentId,
      replyTo: input.replyTo,
      channelId: input.channelId,
      threadId,
      content: input.content,
      messageType,
      queueSource: input.queueSource,
      metadata,
      now,
      messageId: id,
    })

    const projection = await resolveOutboundProjectionDecision(db as any, {
      channelId: input.channelId,
      threadId,
      senderAgentId: input.senderAgentId,
      recipientAgentIds: mentions,
    })
    const outboundSkipReason = outboundProjectionSkipReason(projection)
    let outboundQueued = false
    if (outboundSkipReason) {
      await auditLog(db, 'outbound.enqueue_skipped', input.senderAgentId, input.channelId, {
        code: outboundProjectionSkipCode(outboundSkipReason),
        message_id: id,
        channel_external_id: projection.channelExternalId,
        consumer_source: projection.consumerSource,
        consumer_evidence: projection.consumerEvidence,
        projection_source: projection.projectionSource,
        delivery_fallback_reason: projection.deliveryFallbackReason,
        delivery_diagnostics: projection.deliveryDiagnostics,
        reason: outboundSkipReason,
      })
    } else {
      await db.query(
        `INSERT INTO outbound_queue
           (message_id, agent_id, consumer_agent_id, consumer_source,
            delivery_connector_instance_id, channel_binding_id, provider_channel_access_id,
            projection_identity_id, intended_projection_identity_id, projection_source,
            projection_fallback_reason, delivery_fallback_reason, delivery_diagnostics,
            channel_external_id, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          id,
          input.senderAgentId,
          projection.consumerAgentId,
          projection.consumerSource,
          projection.consumerEvidence?.connector_instance_id ?? null,
          projection.consumerEvidence?.channel_binding_id ?? null,
          projection.consumerEvidence?.provider_channel_access_id ?? null,
          projection.projectionIdentityId,
          projection.intendedProjectionIdentityId,
          projection.projectionSource,
          projection.projectionFallbackReason,
          projection.deliveryFallbackReason,
          JSON.stringify(projection.deliveryDiagnostics),
          projection.channelExternalId,
          truncateForDiscord(decorateProjectedContent({
            content: input.content,
            authorAgentId: input.senderAgentId,
            consumerAgentId: projection.consumerAgentId,
            recipients: mentions,
          })),
        ],
      )
      outboundQueued = true
    }

    if (input.closeSource !== false) {
      const closed = await db.query<{ id: string | number }>(
        `UPDATE message_queue
            SET status = 'replied',
                replied_at = $2,
                replied_with = $3,
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
          WHERE id = $1
            AND status = $4
          RETURNING id`,
        [input.sourceQueueId, now, id, input.expectedSourceStatus],
      )
      if (!closed.rows[0]) {
        throw new AnchoredReplyError(
          'SOURCE_CLOSE_RACE',
          `source queue ${input.sourceQueueId} was not ${input.expectedSourceStatus}`,
        )
      }
    }

    await db.query(
      `UPDATE agents SET
         status = CASE WHEN EXISTS(
           SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status IN ('received', 'in_progress')
         ) THEN 'busy' ELSE 'idle' END,
         status_detail = CASE WHEN EXISTS(
           SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status IN ('received', 'in_progress')
         ) THEN 'メッセージ処理中' ELSE NULL END,
         status_updated_at = now()
       WHERE agent_id = $1`,
      [input.senderAgentId],
    )
    await auditLog(db, 'message.send', input.senderAgentId, input.channelId, {
      message_id: id,
      reply_to: input.replyTo,
      queue_id: input.sourceQueueId,
      channel_id: input.channelId,
      thread_id: threadId,
      sender: input.senderAgentId,
      recipients: mentions,
      surface: 'transaction-native-reply',
      alias_resolution: false,
    })

    return {
      message_id: id,
      recipient_queue_id: persisted.recipient_queue_id,
      outbound_queued: outboundQueued,
      outbound_skip_reason: outboundSkipReason,
    }
  } catch (error) {
    if (error instanceof AnchoredReplyError) throw error
    throw new AnchoredReplyError('ANCHORED_REPLY_WRITE_FAILED', (error as Error)?.message ?? String(error), error)
  }
}
