import { describe, expect, test } from 'bun:test'
import type { DbAdapter } from '../core/db'
import {
  buildQueueWorkReservationPlan,
  formatQueueWorkReservationPlanText,
} from '../core/state-daemon/queue-work-reservation-plan'

class FakeDb implements DbAdapter {
  readonly calls: Array<{ sql: string; params?: any[] }> = []

  constructor(
    private readonly agentRows: any[] = [],
    private readonly openRows: any[] = [],
    private readonly duplicateRows: any[] = [],
    private readonly doneRows: any[] = [],
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    this.calls.push({ sql, params })
    if (sql.includes('FROM agents')) return this.agentRows as T[]
    if (sql.includes("status = 'done'")) return this.doneRows as T[]
    if (sql.includes('status = ANY')) return this.openRows as T[]
    if (sql.includes('message_id = $2')) return this.duplicateRows as T[]
    return []
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null
  }

  async execute(): Promise<{ rowCount: number }> {
    throw new Error('execute must not be called')
  }

  async transaction<T>(): Promise<T> {
    throw new Error('transaction must not be called')
  }

  async close(): Promise<void> {}
}

function agent(patch: Partial<Record<string, unknown>> = {}) {
  return {
    agent_id: 'kodama',
    status: 'online',
    runtime: 'codex',
    disabled_at: null,
    ...patch,
  }
}

function openRow(patch: Partial<Record<string, unknown>> = {}) {
  return {
    id: 121926,
    agent_id: 'kodama',
    message_id: 'old-message',
    status: 'in_progress',
    created_at: '2026-06-17T01:00:00.000Z',
    claimed_by: 'state-daemon',
    ...patch,
  }
}

describe('queue-work reservation planner', () => {
  test('builds a read-only fresh row reservation packet for a DB-primary canary', async () => {
    const db = new FakeDb([agent()])
    const report = await buildQueueWorkReservationPlan(db, {
      agentId: 'kodama',
      commit: 'b45f113c3be60601ae635fc9fe36a9aed45fdbe6',
      messageId: '3a6d1779-6c99-47f7-a5a8-21e926dfef01',
      content: 'DB-primary queue consumer canary for #722',
      now: () => new Date('2026-06-17T02:00:00.000Z'),
    })
    const text = formatQueueWorkReservationPlanText(report)

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.issue_ref).toBe('#722')
    expect(report.policy).toMatchObject({
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_live_runner_enablement: true,
      no_queue_drain: true,
      no_discord_live_write: true,
      reservation_requires_separate_approval: true,
      execute_requires_separate_approval: true,
    })
    expect(report.reservation.message_id).toBe('3a6d1779-6c99-47f7-a5a8-21e926dfef01')
    expect(report.reservation.payload).toMatchObject({
      source: 'state-daemon-queue-work-canary-reservation',
      issue: '#722',
      author_id: 'agent-com-dev',
      message_type: 'instruction',
      reply_contract: { required: false },
      canary_contract: {
        target_agent_id: 'kodama',
        max_canary_count: 1,
      },
    })
    expect(report.reservation.sql?.text).toContain('INSERT INTO message_queue')
    expect(report.reservation.sql?.text).toContain('ON CONFLICT (agent_id, message_id)')
    expect(report.reservation.sql?.params[0]).toBe('kodama')
    expect(report.reservation.sql?.params[1]).toBe('3a6d1779-6c99-47f7-a5a8-21e926dfef01')
    expect(report.post_reservation.activation_plan_command).toEqual([
      'bun',
      'cli/index.ts',
      'state-daemon',
      'queue-work-activation-plan',
      '--agent-id',
      'kodama',
      '--queue-id',
      '<returned_queue_id>',
      '--commit',
      'b45f113c3be60601ae635fc9fe36a9aed45fdbe6',
      '--runtime',
      'codex-exec',
      '--format',
      'json',
    ])
    expect(report.mutation_performed).toBe(false)
    expect(report.restart_performed).toBe(false)
    expect(db.calls.some((call) => /INSERT|UPDATE|DELETE/i.test(call.sql))).toBe(false)
    expect(text).toContain('Queue-work reservation plan: GO')
  })

  test('blocks reservation when the target agent already has non-terminal rows', async () => {
    const db = new FakeDb([agent()], [openRow()])
    const report = await buildQueueWorkReservationPlan(db, {
      agentId: 'kodama',
      commit: 'b45f113c',
      messageId: 'fresh-message-id',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('target_agent_has_open_queue_rows')
    expect(report.open_rows).toEqual([{
      queue_id: '121926',
      agent_id: 'kodama',
      message_id: 'old-message',
      status: 'in_progress',
      created_at: '2026-06-17T01:00:00.000Z',
      claimed_by: 'state-daemon',
    }])
    expect(report.post_reservation.activation_plan_command).toEqual([])
  })

  test('warns but does not block on done-state residue rows', async () => {
    const db = new FakeDb([agent()], [], [], [openRow({ id: 90218, status: 'done', claimed_by: 'kodama' })])
    const report = await buildQueueWorkReservationPlan(db, {
      agentId: 'kodama',
      commit: 'b45f113c',
      messageId: 'fresh-message-id',
    })

    expect(report.ok).toBe(true)
    expect(report.warnings.map((warning) => warning.code)).toContain('target_agent_has_done_residue_rows')
    expect(report.blockers).toEqual([])
    expect(report.post_reservation.activation_plan_command).toContain('<returned_queue_id>')
  })

  test('blocks disabled or missing targets before producing an executable follow-up command', async () => {
    const disabled = await buildQueueWorkReservationPlan(new FakeDb([agent({ disabled_at: '2026-06-17T00:00:00.000Z' })]), {
      agentId: 'kodama',
      commit: 'b45f113c',
      messageId: 'fresh-message-id',
    })
    const missing = await buildQueueWorkReservationPlan(new FakeDb([]), {
      agentId: 'kodama',
      commit: 'b45f113c',
      messageId: 'fresh-message-id',
    })

    expect(disabled.blockers.map((blocker) => blocker.code)).toContain('target_agent_disabled')
    expect(disabled.post_reservation.activation_plan_command).toEqual([])
    expect(missing.blockers.map((blocker) => blocker.code)).toContain('target_agent_not_found')
    expect(missing.post_reservation.activation_plan_command).toEqual([])
  })

  test('fails closed on duplicate message id and invalid operator input', async () => {
    const duplicate = await buildQueueWorkReservationPlan(new FakeDb([agent()], [], [openRow({ id: 1, status: 'pending' })]), {
      agentId: 'kodama',
      commit: 'b45f113c',
      messageId: 'duplicate-message',
    })
    const invalid = await buildQueueWorkReservationPlan(new FakeDb(), {
      agentId: 'bad agent',
      commit: 'not-a-sha',
      priority: '-1',
    })

    expect(duplicate.blockers.map((blocker) => blocker.code)).toContain('message_id_already_reserved')
    expect(duplicate.post_reservation.activation_plan_command).toEqual([])
    expect(invalid.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'agent_id_invalid',
      'commit_required',
      'priority_invalid',
    ]))
    expect(invalid.reservation.sql).toBeNull()
  })
})
