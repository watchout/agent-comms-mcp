import { describe, test, expect } from 'bun:test'
import { diagnoseInboundQueueRow, diagnoseOutboundQueueRow } from '../../core/delivery-diagnostics'

describe('#410 delivery diagnostics classifiers', () => {
  test('terminal inbound row explains why next will not return it', () => {
    const report = diagnoseInboundQueueRow({
      id: 71984,
      agent_id: 'agent-com-dev',
      message_id: 'm1',
      status: 'failed',
      claimed_by: null,
      claim_expires_at: null,
      replied_with: null,
      failed_reason: 'STALE_DISPATCH',
      done_at: new Date('2026-05-16T00:00:00Z'),
    })
    expect(report.next_returnable).toBe(false)
    expect(report.reason).toBe('terminal_status_not_returned_by_next')
    expect(report.terminal_writer_class).toBe('stale')
    expect(report.recommended_action).toBe('resend_if_needed')
  })

  test('pending outbound row reports adapter owner separate from author', () => {
    const report = diagnoseOutboundQueueRow(
      {
        id: 11664,
        message_id: 'b807',
        agent_id: 'codex-aun',
        consumer_agent_id: 'agent-com-dev',
        projection_identity_id: 'agent-com-dev',
        intended_projection_identity_id: null,
        projection_source: 'fallback_adapter_owner',
        projection_fallback_reason: null,
        channel_external_id: '1487368919613444156',
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        last_error: null,
        sent_at: null,
        discord_message_id: null,
      },
      { agent_id: 'agent-com-dev', status: 'online', has_discord_id: true },
      { agent_id: 'agent-com-dev', status: 'online', has_discord_id: true },
    )
    expect(report.author_id).toBe('codex-aun')
    expect(report.consumer_agent_id).toBe('agent-com-dev')
    expect(report.projection_identity_id).toBe('agent-com-dev')
    expect(report.projection_source).toBe('fallback_adapter_owner')
    expect(report.projection_health).toBe('healthy')
    expect(report.deliverable).toBe(true)
    expect(report.reason).toBe('deliverable_pending')
  })

  test('outbound diagnostics preserve native projection fallback evidence', () => {
    const report = diagnoseOutboundQueueRow(
      {
        id: 11665,
        message_id: 'b808',
        agent_id: 'codex-cto',
        consumer_agent_id: 'agent-com-dev',
        projection_identity_id: 'agent-com-dev',
        intended_projection_identity_id: 'codex-cto',
        projection_source: 'fallback_adapter_owner',
        projection_fallback_reason: 'native_projection_unhealthy',
        channel_external_id: '1487368919613444156',
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        last_error: null,
        sent_at: null,
        discord_message_id: null,
      },
      { agent_id: 'agent-com-dev', status: 'online', has_discord_id: true },
      { agent_id: 'agent-com-dev', status: 'online', has_discord_id: true },
    )
    expect(report.projection_identity_id).toBe('agent-com-dev')
    expect(report.intended_projection_identity_id).toBe('codex-cto')
    expect(report.projection_source).toBe('fallback_adapter_owner')
    expect(report.projection_fallback_reason).toBe('native_projection_unhealthy')
    expect(report.projection_health).toBe('healthy')
    expect(report.reason).toBe('deliverable_pending')
  })

  test('pending outbound row without adapter Discord identity is an explicit block', () => {
    const report = diagnoseOutboundQueueRow({
      id: 11664,
      message_id: 'b807',
      agent_id: 'codex-aun',
      consumer_agent_id: null,
      channel_external_id: '1487368919613444156',
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      sent_at: null,
      discord_message_id: null,
    }, { agent_id: 'codex-aun', status: 'idle', has_discord_id: false })
    expect(report.consumer_agent_id).toBe('codex-aun')
    expect(report.deliverable).toBe(false)
    expect(report.reason).toBe('consumer_missing_discord_identity')
  })
})
