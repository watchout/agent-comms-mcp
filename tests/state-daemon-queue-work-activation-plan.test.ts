import { describe, expect, test } from 'bun:test'
import type { DbAdapter } from '../core/db'
import {
  buildQueueWorkActivationPlan,
  formatQueueWorkActivationPlanText,
} from '../core/state-daemon/queue-work-activation-plan'

class FakeDb implements DbAdapter {
  readonly calls: Array<{ sql: string; params?: any[] }> = []

  constructor(
    private readonly rowsById: Record<string, any[]> = {},
    private readonly rowsByAgent: Record<string, any[]> = {},
    private readonly residueRows: any[] = [],
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    this.calls.push({ sql, params })
    if (sql.includes('FROM message_queue mq') && sql.includes("status IN ('pending', 'received', 'in_progress')")) {
      return this.residueRows as T[]
    }
    if (sql.includes('WHERE id = $1')) {
      return (this.rowsById[String(params?.[0])] ?? []) as T[]
    }
    if (sql.includes('WHERE agent_id = $1') && sql.includes("status = 'pending'")) {
      return (this.rowsByAgent[String(params?.[0])] ?? []) as T[]
    }
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

function row(patch: Partial<Record<string, unknown>> = {}) {
  return {
    id: 121877,
    agent_id: 'check',
    message_id: 'msg-121877',
    status: 'pending',
    created_at: '2026-06-17T01:00:00.000Z',
    priority: 100,
    payload: '{"secret":"must-not-print"}',
    ...patch,
  }
}

function githubHandoffRow(patch: Partial<Record<string, unknown>> = {}) {
  return row({
    id: 121926,
    agent_id: 'l2auditor',
    message_id: 'msg-121926',
    payload: JSON.stringify({
      message_type: 'phase_handoff',
      content: 'PR #779 L2 audit required. GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/779',
    }),
    ...patch,
  })
}

describe('queue-work activation planner', () => {
  test('builds an exact-row read-only restore command without echoing payload', async () => {
    const db = new FakeDb({ 121877: [row()] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'check',
      queueId: '121877',
      commit: '42d2c0a2624554369d9536ed4dd0e5d2ad1ccffe',
      now: () => new Date('2026-06-17T01:10:00.000Z'),
    })
    const json = JSON.stringify(report)
    const text = formatQueueWorkActivationPlanText(report)

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.policy).toMatchObject({
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_live_runner_enablement: true,
      execute_requires_separate_approval: true,
    })
    expect(report.activation_env).toMatchObject({
      STATE_DAEMON_CODEX_RUNNER_ENABLED: '0',
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
      STATE_DAEMON_AGENT_ALLOWLIST: 'check',
      STATE_DAEMON_QUEUE_WORK_RUNTIME: 'codex-exec',
      STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
      STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS: '121877',
      STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS: 'msg-121877',
      STATE_DAEMON_QUEUE_WORK_CODEX_SANDBOX: 'read-only',
    })
    expect(report.dry_run_command).toContain('--queue-work-fence-queue-ids')
    expect(report.dry_run_command).toContain('121877')
    expect(report.dry_run_command).not.toContain('--execute')
    expect(report.execute_command).toContain('--execute')
    expect(report.mutation_performed).toBe(false)
    expect(report.restart_performed).toBe(false)
    expect(json).not.toContain('secret')
    expect(text).not.toContain('secret')
    expect(db.calls.some((call) => call.sql.includes('UPDATE message_queue'))).toBe(false)
  })

  test('requires --queue-id when an agent has multiple pending rows', async () => {
    const db = new FakeDb({}, {
      check: [
        row({ id: 1, message_id: 'old' }),
        row({ id: 2, message_id: 'new' }),
      ],
    })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'check',
      commit: '42d2c0a',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_id_required_for_multiple_pending')
    expect(report.dry_run_command).toEqual([])
    expect(report.execute_command).toEqual([])
  })

  test('blocks exact rows that are not pending', async () => {
    const db = new FakeDb({ 121877: [row({ status: 'in_progress' })] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'check',
      queueId: '121877',
      commit: '42d2c0a',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_row_not_pending')
    expect(report.candidate?.status).toBe('in_progress')
  })

  test('blocks GitHub-backed role handoffs when codex-exec has no mediated posting contract', async () => {
    const db = new FakeDb({ 121926: [githubHandoffRow()] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'l2auditor',
      queueId: '121926',
      commit: 'c8bb4415e5a3276e4f2c1b5882547fce23108402',
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.handoff_contract).toMatchObject({
      kind: 'github_backed_role_handoff',
      github_backed: true,
      posting_mode: 'none',
    })
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'queue_work_github_handoff_requires_mediated_posting',
      'queue_work_mediated_posting_command_required',
    ]))
    expect(report.dry_run_command).toEqual([])
    expect(report.execute_command).toEqual([])
  })

  test('allows GitHub-backed role handoffs only with an explicit mediated posting command', async () => {
    const db = new FakeDb({ 121926: [githubHandoffRow()] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'l2auditor',
      queueId: '121926',
      commit: 'c8bb4415e5a3276e4f2c1b5882547fce23108402',
      githubWritebackMode: 'mediated',
      mediatedPostingCommand: '/repo/scripts/post-github-comment',
      mediatedPostingArgsJson: '["--dry-run"]',
    })

    expect(report.ok).toBe(true)
    expect(report.handoff_contract).toMatchObject({
      kind: 'github_backed_role_handoff',
      github_backed: true,
      posting_mode: 'mediated',
    })
    expect(report.activation_env).toMatchObject({
      STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT: 'github_backed_role_handoff',
      STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE: 'mediated',
      STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND: '/repo/scripts/post-github-comment',
      STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON: '["--dry-run"]',
    })
    expect(report.execute_command).toEqual(expect.arrayContaining([
      '--queue-work-github-writeback-mode',
      'mediated',
      '--queue-work-mediated-posting-command',
      '/repo/scripts/post-github-comment',
    ]))
  })

  test('uses the existing residue preflight before producing executable commands', async () => {
    const db = new FakeDb({ 121877: [row()] }, {}, [
      row({
        id: 121800,
        message_id: 'older-work',
        payload: '{}',
      }),
    ])
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'check',
      queueId: '121877',
      commit: '42d2c0a',
      residuePolicyFile: null,
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_work_residue_policy_missing')
    expect(report.dry_run_command).toEqual([])
    expect(report.execute_command).toEqual([])
  })

  test('returns NO_GO instead of throwing when residue policy cannot be loaded', async () => {
    const db = new FakeDb({ 121877: [row()] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'check',
      queueId: '121877',
      commit: '42d2c0a',
      residuePolicyFile: 'missing-residue-policy.json',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_work_residue_policy_load_failed')
    expect(report.dry_run_command).toEqual([])
    expect(report.execute_command).toEqual([])
  })
})
