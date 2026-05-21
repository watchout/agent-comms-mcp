import { describe, expect, test } from 'bun:test'
import { deriveQueueNormalizationReport, formatQueueNormalizationText } from '../core/queue-normalization'
import type { QueueDoctorFinding, QueueDoctorReport } from '../core/queue-doctor'

function finding(code: string, count: number, overrides: Partial<QueueDoctorFinding> = {}): QueueDoctorFinding {
  return {
    code,
    severity: 'blocker',
    title: code,
    count,
    sample_count: count > 0 ? 1 : 0,
    sample_by_agent: count > 0 ? { 'lead-ama': 1 } : {},
    samples: count > 0 ? [{
      queue_id: 75765,
      agent_id: 'lead-ama',
      message_id: '5093b663-0efc-4abd-9088-876ad1df77b0',
      status: 'pending',
      created_at: '2026-05-22 05:59:09+09',
      age_seconds: 1200,
      author_id: 'auditor',
      content: 'L1 verdict relay',
    }] : [],
    action: 'inspect',
    ...overrides,
  }
}

function report(blockers: QueueDoctorFinding[]): QueueDoctorReport {
  return {
    ok: true,
    generated_at: '2026-05-22T00:00:00.000Z',
    scope: { agent_id: null, stale_minutes: 15 },
    status_counts: { pending: 1, replied: 7272 },
    blockers,
    summary: {
      blocker_count: blockers.filter((item) => item.severity === 'blocker' && item.count > 0).length,
      warning_count: blockers.filter((item) => item.severity === 'warning' && item.count > 0).length,
    },
  }
}

describe('queue normalization report', () => {
  test('turns doctor findings into scoped dry-run repair steps', () => {
    const normalized = deriveQueueNormalizationReport(report([
      finding('stale_pending', 1),
      finding('outbound_pending_stale', 187, {
        sample_by_agent: { 'agent-com-dev': 1 },
        samples: [{
          queue_id: 120,
          agent_id: 'agent-com-dev',
          message_id: 'outbound-message',
          status: 'pending',
          created_at: '2026-05-22 00:00:00+09',
          age_seconds: 3600,
          author_id: null,
          content: 'pending projection',
        }],
      }),
      finding('legacy_status_mix', 7162, { severity: 'warning' }),
    ]))

    expect(normalized.health).toEqual({
      inbound_runtime_clean: false,
      projection_clean: false,
      legacy_clean: false,
      overall_clean: false,
    })
    const stale = normalized.steps.find((step) => step.code === 'stale_pending')
    expect(stale?.status).toBe('needs_decision')
    expect(stale?.dry_run_command).toContain('queue close-obsolete --agent-id lead-ama --queue-id 75765')
    expect(stale?.execute_command).toContain('--execute')
    const outbound = normalized.steps.find((step) => step.code === 'outbound_pending_stale')
    expect(outbound?.dry_run_command).toBe('agent-com diagnose-delivery --outbound-message-id outbound-message')
    expect(outbound?.execute_command).toBeNull()
  })

  test('reports clean health when every doctor finding is empty', () => {
    const normalized = deriveQueueNormalizationReport(report([
      finding('stale_pending', 0),
      finding('active_claim_missing_owner', 0),
      finding('expired_active_claim', 0),
      finding('retired_or_offline_recipient', 0),
      finding('tui_without_tmux_session', 0),
      finding('outbound_pending_stale', 0),
      finding('legacy_status_mix', 0, { severity: 'warning' }),
      finding('ack_spam_pending', 0, { severity: 'warning' }),
    ]))

    expect(normalized.health.overall_clean).toBe(true)
    expect(formatQueueNormalizationText(normalized)).toContain('clean: no normalization candidates found')
  })
})
