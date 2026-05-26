export type InboundQueueRow = {
  id: string | number
  agent_id: string
  message_id: string | null
  status: string
  claimed_by: string | null
  claim_expires_at: string | Date | null
  replied_with: string | null
  failed_reason: string | null
  done_at: string | Date | null
}

export type OutboundQueueRow = {
  id: string | number
  message_id: string
  agent_id: string
  consumer_agent_id?: string | null
  projection_identity_id?: string | null
  intended_projection_identity_id?: string | null
  projection_source?: string | null
  projection_fallback_reason?: string | null
  channel_external_id: string
  status: string
  attempts: number
  max_attempts: number
  last_error: string | null
  sent_at: string | Date | null
  discord_message_id: string | null
}

export function inferInboundTerminalWriter(row: InboundQueueRow): string | null {
  if (row.status === 'replied') return row.replied_with ? 'replied' : 'legacy_replied_missing_evidence'
  if (row.status === 'skipped') {
    if (row.failed_reason?.startsWith('AUTO_SKIP_PATTERN:')) return 'auto-skip'
    if (row.failed_reason?.startsWith('BULK_CLEANUP:') || row.failed_reason?.startsWith('STALE_BULK_DRAIN_')) return 'cleanup'
    return 'skipped'
  }
  if (row.status === 'failed') {
    if (row.failed_reason?.includes('STALE')) return 'stale'
    return 'failed'
  }
  return null
}

export function diagnoseInboundQueueRow(row: InboundQueueRow | null): Record<string, unknown> {
  if (!row) {
    return { ok: false, kind: 'inbound', reason: 'queue_row_not_found', next_returnable: false, recoverable: false }
  }
  const nextReturnable = row.status === 'pending'
  const terminal = ['replied', 'skipped', 'failed', 'done'].includes(row.status)
  return {
    ok: true,
    kind: 'inbound',
    queue_id: String(row.id),
    message_id: row.message_id,
    agent_id: row.agent_id,
    status: row.status,
    claimed_by: row.claimed_by,
    claim_expires_at: row.claim_expires_at,
    replied_with: row.replied_with,
    failed_reason: row.failed_reason,
    done_at: row.done_at,
    next_returnable: nextReturnable,
    reason: nextReturnable ? 'next_can_return_row' : terminal ? 'terminal_status_not_returned_by_next' : 'non_pending_status_not_returned_by_next',
    terminal_writer_class: inferInboundTerminalWriter(row),
    recoverable: row.status === 'pending' || row.status === 'received',
    recommended_action: nextReturnable ? 'run_next' : terminal ? 'resend_if_needed' : 'inspect_claim_or_reclaim',
  }
}

export function diagnoseOutboundQueueRow(
  row: OutboundQueueRow | null,
  consumer: {
    agent_id: string | null
    status: string | null
    has_discord_id?: boolean | null
    discord_ui_id?: string | null
    discord_ui_binding_status?: string | null
  } | null,
  projection: {
    agent_id: string | null
    status: string | null
    has_discord_id?: boolean | null
    discord_ui_id?: string | null
    discord_ui_binding_status?: string | null
  } | null = null,
): Record<string, unknown> {
  if (!row) {
    return { ok: false, kind: 'outbound', reason: 'outbound_row_not_found', deliverable: false }
  }
  const consumerAgentId = row.consumer_agent_id ?? row.agent_id
  const projectionIdentityId = row.projection_identity_id ?? null
  let projectionHealth = 'not_recorded'
  if (projectionIdentityId) {
    if (!projection) {
      projectionHealth = 'agent_not_registered'
    } else if (projection.has_discord_id === false) {
      projectionHealth = 'missing_discord_identity'
    } else if (projection.status === 'offline' || projection.status === 'disconnected' || projection.status === 'failed') {
      projectionHealth = 'unhealthy'
    } else {
      projectionHealth = 'healthy'
    }
  }
  let reason = 'deliverable_pending'
  let deliverable = row.status === 'pending'
  if (row.status === 'sent') {
    reason = 'already_sent'
    deliverable = false
  } else if (row.status === 'failed') {
    reason = 'terminal_failed'
    deliverable = false
  } else if (!consumerAgentId) {
    reason = 'missing_consumer_agent_id'
    deliverable = false
  } else if (!consumer) {
    reason = 'consumer_agent_not_registered'
    deliverable = false
  } else if (consumer.has_discord_id === false) {
    reason = 'consumer_missing_discord_identity'
    deliverable = false
  } else if (consumer.status !== 'online' && consumer.status !== 'idle' && consumer.status !== 'busy') {
    reason = 'consumer_agent_not_available'
    deliverable = false
  }
  return {
    ok: true,
    kind: 'outbound',
    outbound_queue_id: String(row.id),
    message_id: row.message_id,
    author_id: row.agent_id,
    consumer_agent_id: consumerAgentId,
    projection_identity_id: projectionIdentityId,
    intended_projection_identity_id: row.intended_projection_identity_id ?? null,
    projection_source: row.projection_source ?? null,
    projection_fallback_reason: row.projection_fallback_reason ?? null,
    projection_health: projectionHealth,
    channel_external_id: row.channel_external_id,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_error: row.last_error,
    sent_at: row.sent_at,
    discord_message_id: row.discord_message_id,
    consumer_status: consumer?.status ?? null,
    consumer_discord_ui_id: consumer?.discord_ui_id ?? null,
    consumer_discord_ui_binding_status: consumer?.discord_ui_binding_status ?? null,
    projection_status: projection?.status ?? null,
    projection_discord_ui_id: projection?.discord_ui_id ?? null,
    projection_discord_ui_binding_status: projection?.discord_ui_binding_status ?? null,
    deliverable,
    reason,
  }
}
