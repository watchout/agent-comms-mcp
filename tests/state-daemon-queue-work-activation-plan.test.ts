import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbAdapter } from '../core/db'
import {
  buildQueueWorkActivationPlan as buildQueueWorkActivationPlanRaw,
  formatQueueWorkActivationPlanText,
} from '../core/state-daemon/queue-work-activation-plan'
import { STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST } from '../core/state-daemon/launchagent'

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

function probeCommand(body: string = 'echo \'{"ok":true,"summary":"probe passed"}\''): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'queue-work-posting-probe-'))
  const path = join(dir, 'probe.sh')
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(path, 0o755)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function row(patch: Partial<Record<string, unknown>> = {}) {
  return {
    id: 121877,
    agent_id: 'aun',
    message_id: 'msg-121877',
    status: 'pending',
    created_at: '2026-06-17T01:00:00.000Z',
    priority: 100,
    payload: '{"secret":"must-not-print"}',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    ...patch,
  }
}

function expiredSchedulerClaimRow(patch: Partial<Record<string, unknown>> = {}) {
  const claimedAt = '2026-08-08T08:00:01.000Z'
  return row({
    id: 154244,
    message_id: 'msg-154244',
    status: 'in_progress',
    created_at: '2026-08-08T08:00:00.000Z',
    claimed_by: 'aun',
    claimed_at: claimedAt,
    claim_expires_at: '2026-08-08T08:01:01.000Z',
    payload: JSON.stringify({
      content: 'inspect one exact subject',
      receive_claim: {
        source: 'state-daemon-queue-work-scheduler',
        agent_id: 'aun',
        queue_id: '154244',
      },
      queue_work_execution: {
        source: 'state-daemon-queue-work-scheduler',
        agent_id: 'aun',
        queue_id: '154244',
        runtime_id: 'codex-exec',
        claimed_by: 'aun',
        claimed_at: claimedAt,
        started_at: '2026-08-08T08:00:02.000Z',
      },
    }),
    ...patch,
  })
}

function reclaimedSchedulerClaimRow(patch: Partial<Record<string, unknown>> = {}) {
  const base = expiredSchedulerClaimRow()
  const payload = JSON.parse(String(base.payload))
  return {
    ...base,
    status: 'pending',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    payload: JSON.stringify({
      ...payload,
      runner_error: {
        code: 'ADAPTER_RESULT_NOT_OK',
        detail: 'prior runtime binding mismatch',
        runtime_id: 'codex-exec',
        invocation_source: 'state-daemon-queue-work-scheduler',
        claim_fence: {
          claimed_by: 'aun',
          claimed_at: '2026-08-08T08:00:01.000Z',
        },
      },
      queue_work_runner_error_recovery: {
        source: 'state-daemon-queue-work-scheduler',
        attempts: 2,
        max_reclaims: 3,
        last_action: 'reclaimed',
        last_at: '2026-08-08T08:10:00.000Z',
      },
    }),
    ...patch,
  }
}

function doneFinalizationRow(patch: Partial<Record<string, unknown>> = {}) {
  const claimedAt = '2026-08-08T08:00:01.000Z'
  return row({
    id: 154244,
    message_id: 'msg-154244',
    status: 'done',
    created_at: '2026-08-08T08:00:00.000Z',
    claimed_by: 'aun',
    claimed_at: claimedAt,
    claim_expires_at: '2026-08-08T08:01:01.000Z',
    payload: JSON.stringify({
      content: 'inspect one exact subject',
      receive_claim: {
        source: 'state-daemon-queue-work-scheduler',
        agent_id: 'aun',
        queue_id: '154244',
      },
      queue_work_execution: {
        source: 'state-daemon-queue-work-scheduler',
        agent_id: 'aun',
        queue_id: '154244',
        runtime_id: 'codex-exec',
        claimed_by: 'aun',
        claimed_at: claimedAt,
        started_at: '2026-08-08T08:00:02.000Z',
      },
      runner_result: {
        schema_version: 'queue_work_result_v1',
        ok: true,
        summary: 'audit completed',
        reply: 'audit result',
        next_action: 'reply',
        runtime_id: 'codex-exec',
        invocation_source: 'state-daemon-queue-work-scheduler',
        completed_at: '2026-08-08T08:05:00.000Z',
        claim_fence: { claimed_by: 'aun', claimed_at: claimedAt },
      },
      finalizer_error: { code: 'WRITEBACK_FAILED', attempts: 1 },
    }),
    ...patch,
  })
}

function githubHandoffRow(patch: Partial<Record<string, unknown>> = {}) {
  return row({
    id: 121926,
    agent_id: 'codex-audit',
    message_id: 'msg-121926',
    payload: JSON.stringify({
      message_type: 'phase_handoff',
      content: 'PR #779 L2 audit required. GitHub SSOT: https://github.com/watchout/agent-comms-mcp/pull/779',
    }),
    ...patch,
  })
}

const CANARY_OVERLAY = {
  canaryControlRef: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-5223398908',
  canaryOwnerDecisionRef: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-5213090076',
  canaryExpiresAt: '2099-08-08T14:59:59.000Z',
  canaryPriorPlistSha256: 'a'.repeat(64),
  canaryRollbackCommand: 'cp /evidence/prior.plist /evidence/installed.plist',
  canaryObservedStateDestination: 'https://github.com/watchout/agent-comms-mcp/issues/917#issuecomment-observed',
  canarySubjectDigest: STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST,
}

async function buildQueueWorkActivationPlan(
  db: DbAdapter,
  options: Parameters<typeof buildQueueWorkActivationPlanRaw>[1] = {},
) {
  return buildQueueWorkActivationPlanRaw(db, { ...CANARY_OVERLAY, ...options })
}

function shirubeD1GithubHandoffRow(patch: Partial<Record<string, unknown>> = {}) {
  const githubRow = githubHandoffRow()
  return {
    ...githubRow,
    payload: JSON.stringify({
      ...JSON.parse(String(githubRow.payload)),
      shirube_v4_d1: {
        schema_version: 'shirube-v4/d1-runtime-binding/v1',
      },
    }),
    ...patch,
  }
}

describe('queue-work activation planner', () => {
  test('builds an exact-row read-only restore command without echoing payload', async () => {
    const db = new FakeDb({ 121877: [row()] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
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
      STATE_DAEMON_AGENT_ALLOWLIST: 'aun',
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
    const overlayArgIndex = report.dry_run_command.indexOf('--canary-overlay-env-json')
    expect(overlayArgIndex).toBeGreaterThan(-1)
    expect(JSON.parse(report.dry_run_command[overlayArgIndex + 1]!)).toEqual({
      STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF: CANARY_OVERLAY.canaryControlRef,
      STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF: CANARY_OVERLAY.canaryOwnerDecisionRef,
      STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT: CANARY_OVERLAY.canaryExpiresAt,
      STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256: CANARY_OVERLAY.canaryPriorPlistSha256,
      STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND: CANARY_OVERLAY.canaryRollbackCommand,
      STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION: CANARY_OVERLAY.canaryObservedStateDestination,
      STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST: CANARY_OVERLAY.canarySubjectDigest,
    })
    expect(report.mutation_performed).toBe(false)
    expect(report.restart_performed).toBe(false)
    expect(json).not.toContain('secret')
    expect(text).not.toContain('secret')
    expect(db.calls.some((call) => call.sql.includes('UPDATE message_queue'))).toBe(false)
  })

  test('requires --queue-id when an agent has multiple pending rows', async () => {
    const db = new FakeDb({}, {
      aun: [
        row({ id: 1, message_id: 'old' }),
        row({ id: 2, message_id: 'new' }),
      ],
    })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      commit: '42d2c0a',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_id_required_for_multiple_pending')
    expect(report.dry_run_command).toEqual([])
    expect(report.execute_command).toEqual([])
  })

  test('serial exact pending activation defers only newer untouched pending work', async () => {
    const target = row({
      id: 164249,
      message_id: 'msg-164249',
      created_at: '2026-08-08T08:10:00.000Z',
      payload: JSON.stringify({ content: 'current exact work' }),
    })
    const newer = row({
      id: 164254,
      message_id: 'msg-164254',
      created_at: '2026-08-08T08:20:00.000Z',
      payload: JSON.stringify({ content: 'newer untouched work' }),
    })
    const report = await buildQueueWorkActivationPlan(
      new FakeDb({ 164249: [target] }, {}, [newer]),
      {
        agentId: 'aun',
        queueId: '164249',
        commit: '40b5a37',
      },
    )

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.activation_env.STATE_DAEMON_QUEUE_WORK_DEFER_NEWER_PENDING).toBe('1')
    expect(report.execute_command).toContain('--defer-newer-pending')
    expect(report.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'queue_work_exact_serial_pending',
      'queue_work_serial_pending_newer_pending_deferred',
    ]))
  })

  test('serial exact pending activation blocks claimed or previously executed residue', async () => {
    const target = row({
      id: 154249,
      message_id: 'msg-154249',
      created_at: '2026-08-08T08:10:00.000Z',
      payload: JSON.stringify({ content: 'current exact work' }),
    })
    const unsafe = row({
      id: 154254,
      message_id: 'msg-154254',
      created_at: '2026-08-08T08:20:00.000Z',
      payload: JSON.stringify({
        receive_claim: { source: 'state-daemon-queue-work-scheduler' },
      }),
    })
    const report = await buildQueueWorkActivationPlan(
      new FakeDb({ 154249: [target] }, {}, [unsafe]),
      {
        agentId: 'aun',
        queueId: '154249',
        commit: '40b5a37',
      },
    )

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_work_defer_newer_pending_unsafe_residue')
    expect(report.execute_command).toEqual([])
  })

  test('serial exact pending activation defers governed native-agent work to its own lifecycle', async () => {
    const target = row({
      id: 154300,
      agent_id: 'codex-audit',
      message_id: 'msg-154300',
      created_at: '2026-08-09T12:00:00.000Z',
      payload: JSON.stringify({ content: 'fresh exact audit' }),
    })
    const nativeWork = row({
      id: 154254,
      agent_id: 'codex-audit',
      message_id: '60ea96f6-bdab-4db2-95cb-e9287885f7b3',
      created_at: '2026-08-09T10:03:42.480Z',
      payload: JSON.stringify({ source: 'cli-notify', content: 'daily PDCA native work' }),
    })
    const report = await buildQueueWorkActivationPlan(
      new FakeDb({ 154300: [target] }, {}, [nativeWork]),
      {
        agentId: 'codex-audit',
        queueId: '154300',
        commit: '40b5a37',
      },
    )

    expect(report.ok).toBe(true)
    expect(report.warnings.map((warning) => warning.code)).toContain('queue_work_governed_residue_deferred')
    expect(report.execute_command).toContain('--defer-newer-pending')
  })

  test('blocks exact rows that are not pending', async () => {
    const db = new FakeDb({ 121877: [row({ status: 'in_progress' })] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      queueId: '121877',
      commit: '42d2c0a',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_row_not_pending')
    expect(report.candidate?.status).toBe('in_progress')
  })

  test('plans exact expired scheduler claim recovery while deferring newer untouched pending work', async () => {
    const db = new FakeDb({ 154244: [expiredSchedulerClaimRow()] }, {}, [
      row({
        id: 154249,
        message_id: 'msg-154249',
        created_at: '2026-08-08T08:10:00.000Z',
        payload: JSON.stringify({ content: 'newer work' }),
      }),
    ])
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      queueId: '154244',
      commit: 'a829d9e',
      recoverExpiredSchedulerClaim: true,
      now: () => new Date('2026-08-08T08:20:00.000Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.activation_env.STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM).toBe('1')
    expect(report.execute_command).toContain('--recover-expired-scheduler-claim')
    expect(report.activation_env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS).toBe('154244')
    expect(report.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'queue_work_exact_expired_scheduler_claim_recovery',
      'queue_work_expired_claim_recovery_newer_pending_deferred',
    ]))
  })

  test('expired scheduler claim recovery requires one explicit queue id', async () => {
    const report = await buildQueueWorkActivationPlan(new FakeDb(), {
      agentId: 'aun',
      commit: 'a829d9e',
      recoverExpiredSchedulerClaim: true,
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_id_required_for_expired_claim_recovery')
    expect(report.execute_command).toEqual([])
  })

  test('plans exact done-row stored-result finalization without replaying the runtime', async () => {
    const db = new FakeDb({ 154244: [doneFinalizationRow()] }, {}, [
      row({
        id: 154249,
        message_id: 'msg-154249',
        created_at: '2026-08-08T08:10:00.000Z',
        payload: JSON.stringify({ content: 'newer work' }),
      }),
    ])
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      queueId: '154244',
      commit: 'ee98ade',
      resumeDoneFinalization: true,
      now: () => new Date('2026-08-08T08:20:00.000Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.candidate?.status).toBe('done')
    expect(report.warnings.map((warning) => warning.code)).toContain('queue_work_exact_done_finalization_resume')
    expect(report.warnings.map((warning) => warning.code)).toContain('queue_work_done_finalization_resume_newer_pending_deferred')
    expect(report.activation_env.STATE_DAEMON_QUEUE_WORK_RESUME_DONE_FINALIZATION).toBe('1')
    expect(report.execute_command).toContain('--resume-done-finalization')
  })

  test('done-row finalization resume fails closed on result-fence drift or retry exhaustion', async () => {
    const target = doneFinalizationRow()
    const payload = JSON.parse(String(target.payload))
    payload.runner_result.claim_fence.claimed_at = '2026-08-08T08:00:03.000Z'
    payload.finalizer_error.attempts = 3
    target.payload = JSON.stringify(payload)
    const report = await buildQueueWorkActivationPlan(new FakeDb({ 154244: [target] }), {
      agentId: 'aun',
      queueId: '154244',
      commit: 'ee98ade',
      resumeDoneFinalization: true,
      now: () => new Date('2026-08-08T08:20:00.000Z'),
    })

    expect(report.ok).toBe(false)
    const blocker = report.blockers.find((item) => item.code === 'queue_work_done_finalization_resume_identity_mismatch')
    expect(blocker?.evidence?.mismatches).toEqual(expect.arrayContaining([
      'runner_result.claim_fence.claimed_at',
      'finalizer_error.attempts',
    ]))
  })

  test('continues the exact recovery chain from its provenance-bound reclaimed pending successor', async () => {
    const db = new FakeDb({ 154244: [reclaimedSchedulerClaimRow()] }, {}, [
      row({
        id: 154249,
        message_id: 'msg-154249',
        created_at: '2026-08-08T08:10:00.000Z',
        payload: JSON.stringify({ content: 'newer work' }),
      }),
    ])
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      queueId: '154244',
      commit: '568694b',
      recoverExpiredSchedulerClaim: true,
      now: () => new Date('2026-08-08T08:20:00.000Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.candidate?.status).toBe('pending')
    expect(report.activation_env.STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM).toBe('1')
    expect(report.warnings.map((warning) => warning.code)).toContain('queue_work_expired_claim_recovery_newer_pending_deferred')
  })

  test('continues a reclaimed successor after a newer execution superseded its prior runner error', async () => {
    const target = reclaimedSchedulerClaimRow()
    const payload = JSON.parse(String(target.payload))
    target.payload = JSON.stringify({
      ...payload,
      queue_work_execution: {
        ...payload.queue_work_execution,
        claimed_at: '2026-08-08T08:05:01.000Z',
        started_at: '2026-08-08T08:05:02.000Z',
      },
      runner_error: {
        ...payload.runner_error,
        failed_at: '2026-08-08T08:04:00.000Z',
      },
      queue_work_runner_error_recovery: {
        ...payload.queue_work_runner_error_recovery,
        last_at: '2026-08-08T08:06:00.000Z',
      },
    })
    const report = await buildQueueWorkActivationPlan(new FakeDb({ 154244: [target] }), {
      agentId: 'aun',
      queueId: '154244',
      commit: 'aac05f3',
      recoverExpiredSchedulerClaim: true,
      now: () => new Date('2026-08-08T08:20:00.000Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
  })

  test('blocks a reclaimed successor when prior runner-error chronology is not exact', async () => {
    const target = reclaimedSchedulerClaimRow()
    const payload = JSON.parse(String(target.payload))
    target.payload = JSON.stringify({
      ...payload,
      queue_work_execution: {
        ...payload.queue_work_execution,
        claimed_at: '2026-08-08T08:05:01.000Z',
        started_at: '2026-08-08T08:05:02.000Z',
      },
      runner_error: {
        ...payload.runner_error,
        failed_at: '2026-08-08T08:06:00.000Z',
      },
      queue_work_runner_error_recovery: {
        ...payload.queue_work_runner_error_recovery,
        last_at: '2026-08-08T08:06:30.000Z',
      },
    })
    const report = await buildQueueWorkActivationPlan(new FakeDb({ 154244: [target] }), {
      agentId: 'aun',
      queueId: '154244',
      commit: 'aac05f3',
      recoverExpiredSchedulerClaim: true,
      now: () => new Date('2026-08-08T08:20:00.000Z'),
    })

    expect(report.ok).toBe(false)
    const blocker = report.blockers.find((item) => item.code === 'queue_work_expired_scheduler_claim_recovery_identity_mismatch')
    expect(blocker?.evidence?.mismatches).toContain('runner_error.claim_fence.claimed_at')
  })

  test('expired scheduler claim recovery fails closed on live leases and provenance drift', async () => {
    const cases = [
      {
        name: 'live lease',
        target: expiredSchedulerClaimRow({ claim_expires_at: '2026-08-08T09:00:00.000Z' }),
        mismatch: 'claim_expires_at',
      },
      {
        name: 'foreign owner',
        target: expiredSchedulerClaimRow({ claimed_by: 'other-agent' }),
        mismatch: 'claimed_by',
      },
      {
        name: 'provenance drift',
        target: expiredSchedulerClaimRow({
          payload: JSON.stringify({
            receive_claim: { source: 'manual-next', agent_id: 'aun', queue_id: '154244' },
            queue_work_execution: {},
          }),
        }),
        mismatch: 'receive_claim.source',
      },
    ]

    for (const fixture of cases) {
      const report = await buildQueueWorkActivationPlan(new FakeDb({ 154244: [fixture.target] }), {
        agentId: 'aun',
        queueId: '154244',
        commit: 'a829d9e',
        recoverExpiredSchedulerClaim: true,
        now: () => new Date('2026-08-08T08:20:00.000Z'),
      })
      expect(report.ok, fixture.name).toBe(false)
      const blocker = report.blockers.find((item) => item.code === 'queue_work_expired_scheduler_claim_recovery_identity_mismatch')
      expect(blocker, fixture.name).toBeDefined()
      expect(blocker?.evidence?.mismatches, fixture.name).toContain(fixture.mismatch)
    }
  })

  test('expired scheduler claim recovery blocks claimed or non-newer residue', async () => {
    const db = new FakeDb({ 154244: [expiredSchedulerClaimRow()] }, {}, [
      row({
        id: 154249,
        message_id: 'msg-154249',
        created_at: '2026-08-08T08:00:00.000Z',
        claimed_by: 'aun',
        claimed_at: '2026-08-08T08:00:00.000Z',
        claim_expires_at: '2026-08-08T08:02:00.000Z',
      }),
    ])
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      queueId: '154244',
      commit: 'a829d9e',
      recoverExpiredSchedulerClaim: true,
      now: () => new Date('2026-08-08T08:20:00.000Z'),
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_work_expired_claim_recovery_unsafe_residue')
  })

  test('blocks GitHub-backed role handoffs when codex-exec has no mediated posting contract', async () => {
    const db = new FakeDb({ 121926: [githubHandoffRow()] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'codex-audit',
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
    const command = probeCommand()
    const db = new FakeDb({ 121926: [githubHandoffRow()] })
    try {
      const report = await buildQueueWorkActivationPlan(db, {
        agentId: 'codex-audit',
        queueId: '121926',
        commit: 'c8bb4415e5a3276e4f2c1b5882547fce23108402',
        githubWritebackMode: 'mediated',
        mediatedPostingCommand: command.path,
        mediatedPostingArgsJson: '["--allow-repo","watchout/agent-comms-mcp"]',
      })

      expect(report.ok).toBe(true)
      expect(report.handoff_contract).toMatchObject({
        kind: 'github_backed_role_handoff',
        github_backed: true,
        posting_mode: 'mediated',
      })
      expect(report.mediated_posting).toMatchObject({
        command_path: command.path,
        command_present: true,
        command_probe: 'passed',
      })
      expect(report.activation_env).toMatchObject({
        STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT: 'github_backed_role_handoff',
        STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE: 'mediated',
        STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND: command.path,
        STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON: '["--allow-repo","watchout/agent-comms-mcp"]',
      })
      expect(report.execute_command).toEqual(expect.arrayContaining([
        '--queue-work-github-writeback-mode',
        'mediated',
        '--queue-work-mediated-posting-command',
        command.path,
      ]))
    } finally {
      command.cleanup()
    }
  })

  test('forwards a token-file reference to mediated probe and restore without exposing token bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-work-token-file-'))
    const tokenFile = join(dir, 'github-token')
    writeFileSync(tokenFile, 'test-token-value\n', { mode: 0o600 })
    const db = new FakeDb({ 121926: [githubHandoffRow()] })
    try {
      const report = await buildQueueWorkActivationPlan(db, {
        agentId: 'codex-audit',
        queueId: '121926',
        commit: 'c8bb4415e5a3276e4f2c1b5882547fce23108402',
        githubWritebackMode: 'mediated',
        mediatedPostingCommand: process.execPath,
        mediatedPostingArgsJson: JSON.stringify([
          join(import.meta.dir, '..', 'scripts', 'queue-work-github-writeback.ts'),
          '--allow-repo',
          'watchout/agent-comms-mcp',
        ]),
        githubTokenFile: tokenFile,
      })
      const serialized = JSON.stringify(report)

      expect(report.ok).toBe(true)
      expect(report.mediated_posting.command_probe).toBe('passed')
      expect(report.activation_env.STATE_DAEMON_GITHUB_TOKEN_FILE).toBe(tokenFile)
      expect(report.execute_command).toEqual(expect.arrayContaining(['--github-token-file', tokenFile]))
      expect(serialized).not.toContain('test-token-value')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('blocks a Shirube D1 canary when the runtime is not deterministic', async () => {
    const command = probeCommand()
    const db = new FakeDb({ 121926: [shirubeD1GithubHandoffRow()] })
    try {
      const report = await buildQueueWorkActivationPlan(db, {
        agentId: 'codex-audit',
        queueId: '121926',
        commit: 'c8bb4415e5a3276e4f2c1b5882547fce23108402',
        runtime: 'codex-exec',
        githubWritebackMode: 'mediated',
        mediatedPostingCommand: command.path,
      })

      expect(report.ok).toBe(false)
      expect(report.go_no_go).toBe('NO_GO')
      expect(report.blockers.map((blocker) => blocker.code)).toContain('NO_GO_RUNTIME_NOT_DETERMINISTIC')
      expect(report.mediated_posting.command_probe).toBe('not_run')
      expect(report.dry_run_command).toEqual([])
      expect(report.execute_command).toEqual([])
    } finally {
      command.cleanup()
    }
  })

  test('allows a Shirube D1 canary with the deterministic command-json runtime', async () => {
    const command = probeCommand()
    const db = new FakeDb({ 121926: [shirubeD1GithubHandoffRow()] })
    try {
      const report = await buildQueueWorkActivationPlan(db, {
        agentId: 'codex-audit',
        queueId: '121926',
        commit: 'c8bb4415e5a3276e4f2c1b5882547fce23108402',
        runtime: 'command-json',
        queueWorkCommand: 'bun scripts/shirube-d1-github-canary-runtime.ts',
        githubWritebackMode: 'mediated',
        mediatedPostingCommand: command.path,
      })

      expect(report.ok).toBe(true)
      expect(report.go_no_go).toBe('GO')
      expect(report.activation_env).toMatchObject({
        STATE_DAEMON_QUEUE_WORK_RUNTIME: 'command-json',
        STATE_DAEMON_QUEUE_WORK_COMMAND: 'bun scripts/shirube-d1-github-canary-runtime.ts',
      })
      expect(report.mediated_posting.command_probe).toBe('passed')
      expect(report.dry_run_command).toContain('--queue-work-command')
      expect(report.execute_command).toContain('--execute')
    } finally {
      command.cleanup()
    }
  })

  test('blocks GitHub-backed role handoffs when mediated posting probe fails', async () => {
    const command = probeCommand('echo \'{"ok":false,"summary":"token missing"}\'; exit 1')
    const db = new FakeDb({ 121926: [githubHandoffRow()] })
    try {
      const report = await buildQueueWorkActivationPlan(db, {
        agentId: 'codex-audit',
        queueId: '121926',
        commit: 'c8bb4415e5a3276e4f2c1b5882547fce23108402',
        githubWritebackMode: 'mediated',
        mediatedPostingCommand: command.path,
      })

      expect(report.ok).toBe(false)
      expect(report.go_no_go).toBe('NO_GO')
      expect(report.mediated_posting.command_probe).toBe('failed')
      expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_work_mediated_posting_command_probe_failed')
      expect(report.execute_command).toEqual([])
    } finally {
      command.cleanup()
    }
  })

  test('uses the exact serial residue preflight before producing executable commands', async () => {
    const db = new FakeDb({ 121877: [row()] }, {}, [
      row({
        id: 121800,
        message_id: 'older-work',
        payload: '{}',
      }),
    ])
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      queueId: '121877',
      commit: '42d2c0a',
      residuePolicyFile: null,
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_work_defer_newer_pending_unsafe_residue')
    expect(report.dry_run_command).toEqual([])
    expect(report.execute_command).toEqual([])
  })

  test('returns NO_GO instead of throwing when residue policy cannot be loaded', async () => {
    const db = new FakeDb({ 121877: [row()] })
    const report = await buildQueueWorkActivationPlan(db, {
      agentId: 'aun',
      queueId: '121877',
      commit: '42d2c0a',
      residuePolicyFile: 'missing-residue-policy.json',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((blocker) => blocker.code)).toContain('queue_work_residue_policy_load_failed')
    expect(report.dry_run_command).toEqual([])
    expect(report.execute_command).toEqual([])
  })

  test('blocks missing, expired, retired, wrong-subject, and outside-cohort overlays', async () => {
    const cases = [
      {
        name: 'missing',
        agentId: 'aun',
        row: row(),
        overlay: { ...CANARY_OVERLAY, canaryRollbackCommand: '' },
        code: 'state_daemon_canary_overlay_identity_incomplete',
      },
      {
        name: 'expired',
        agentId: 'aun',
        row: row(),
        overlay: { ...CANARY_OVERLAY, canaryExpiresAt: '2026-08-06T00:00:00.000Z' },
        code: 'state_daemon_canary_overlay_expired',
      },
      {
        name: 'retired',
        agentId: 'codex-aun',
        row: row({ agent_id: 'codex-aun' }),
        overlay: CANARY_OVERLAY,
        code: 'state_daemon_canary_overlay_retired_target',
      },
      {
        name: 'wrong-subject',
        agentId: 'aun',
        row: row(),
        overlay: { ...CANARY_OVERLAY, canarySubjectDigest: `sha256:${'b'.repeat(64)}` },
        code: 'state_daemon_canary_overlay_subject_digest_mismatch',
      },
      {
        name: 'outside-cohort',
        agentId: 'check',
        row: row({ agent_id: 'check' }),
        overlay: CANARY_OVERLAY,
        code: 'state_daemon_canary_overlay_target_outside_cohort',
      },
    ] as const

    for (const fixture of cases) {
      const db = new FakeDb({ 121877: [fixture.row] })
      const report = await buildQueueWorkActivationPlanRaw(db, {
        ...fixture.overlay,
        agentId: fixture.agentId,
        queueId: '121877',
        commit: '42d2c0a',
        now: () => new Date('2026-08-07T00:00:00.000Z'),
      })
      expect(report.go_no_go, fixture.name).toBe('NO_GO')
      expect(report.blockers.map((blocker) => blocker.code), fixture.name).toContain(fixture.code)
      expect(report.dry_run_command, fixture.name).toEqual([])
      expect(report.execute_command, fixture.name).toEqual([])
    }
  })
})
