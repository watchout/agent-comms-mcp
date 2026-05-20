import { describe, expect, test } from 'bun:test'
import { buildQueueDoctorReport, formatQueueDoctorText } from '../core/queue-doctor'

function row(overrides: Record<string, unknown>) {
  return {
    id: 1,
    agent_id: 'codex-aun',
    status: 'pending',
    created_at: new Date('2026-05-20T00:00:00Z'),
    age_seconds: 900,
    author_id: 'codex-cto',
    content: 'sample',
    total_count: 1,
    ...overrides,
  }
}

describe('queue doctor', () => {
  test('builds stable blocker counts from diagnostic query rows', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('GROUP BY status')) {
          return { rows: [{ status: 'pending', count: 2 }, { status: 'received', count: 1 }] }
        }
        if (sql.includes('FROM outbound_queue')) {
          return { rows: [row({ id: 80, agent_id: 'codex-cto', total_count: 3 })] }
        }
        if (sql.includes("mq.status IN ('read', 'skipped', 'failed')")) {
          return { rows: [row({ id: 10, status: 'skipped', agent_id: 'auditor', total_count: 7 })] }
        }
        if (sql.includes('mq.claimed_by IS NULL')) {
          return { rows: [row({ id: 30, status: 'received', total_count: 1 })] }
        }
        if (sql.includes('mq.claim_expires_at < now()')) {
          return { rows: [row({ id: 40, status: 'in_progress', agent_id: 'agent-com-dev', total_count: 1 })] }
        }
        if (sql.includes("a.metadata->>'retired' = 'true'")) {
          return { rows: [row({ id: 50, agent_id: 'lead-ama', total_count: 2 })] }
        }
        if (sql.includes("a.runtime = 'TUI'")) {
          return { rows: [row({ id: 60, agent_id: 'cto', total_count: 1 })] }
        }
        if (sql.includes("LIKE 'ACK: received by %; queue_id=%'")) {
          return { rows: [row({ id: 70, agent_id: 'codex-cto', total_count: 4 })] }
        }
        if (sql.includes("mq.status = 'pending'")) {
          return { rows: [row({ id: 20, total_count: 5 })] }
        }
        return { rows: [] }
      },
    }

    const report = await buildQueueDoctorReport(db, { staleSeconds: 600 })
    const byCode = Object.fromEntries(report.blockers.map((b) => [b.code, b]))

    expect(report.summary).toEqual({ blocker_count: 6, warning_count: 2 })
    expect(report.status_counts).toEqual({ pending: 2, received: 1 })
    expect(byCode.stale_pending.count).toBe(5)
    expect(byCode.legacy_status_mix.count).toBe(7)
    expect(byCode.outbound_pending_stale.count).toBe(3)
    expect(byCode.retired_or_offline_recipient.sample_by_agent).toEqual({ 'lead-ama': 1 })
  })

  test('formats compact text for terminal operators', () => {
    const text = formatQueueDoctorText({
      ok: true,
      generated_at: '2026-05-20T00:00:00.000Z',
      scope: { agent_id: 'codex-cto', stale_minutes: 15 },
      status_counts: { pending: 1 },
      blockers: [
        {
          code: 'stale_pending',
          severity: 'blocker',
          title: 'pending rows older than 15 minutes',
          count: 1,
          sample_count: 1,
          sample_by_agent: { 'codex-cto': 1 },
          samples: [],
          action: 'wake or reassign',
        },
      ],
      summary: { blocker_count: 1, warning_count: 0 },
    })

    expect(text).toContain('Queue Doctor')
    expect(text).toContain('Scope: codex-cto / stale>15m')
    expect(text).toContain('[blocker] stale_pending: 1 (codex-cto)')
  })
})
