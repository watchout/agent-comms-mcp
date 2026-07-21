import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  closeDuplicatePendingQueueRows,
  closeObsoletePendingQueueRows,
  closeObsoleteOutboundRows,
  reassignPendingQueueRows,
  reclaimExpiredQueueClaims,
  _internal as queueRepairInternal,
} from '../core/queue-repair'
import {
  buildQueueDaemonStatusReport,
  buildQueueSmokeReadiness,
} from '../core/queue-runtime'

const REPO_ROOT = join(import.meta.dir, '..')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')
const REPAIR_SRC = readFileSync(join(REPO_ROOT, 'core', 'queue-repair.ts'), 'utf-8')

class FakeDb {
  calls: Array<{ sql: string; params?: unknown[] }> = []
  constructor(private readonly rows: any[] = []) {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
    this.calls.push({ sql, params })
    if (sql.includes('FROM message_queue')) return { rows: this.rows }
    return { rows: [] }
  }

  called(pattern: RegExp): boolean {
    return this.calls.some((call) => pattern.test(call.sql))
  }
}

describe('queue operations CLI namespace', () => {
  test('doctor and repair commands are routed through agent-com queue', () => {
    expect(CLI_SRC).toMatch(/command === 'diagnose-queue'[\s\S]{0,120}?diagnoseQueue/)
    expect(CLI_SRC).toMatch(/command === 'queue' && subcommand === 'doctor'[\s\S]{0,120}?diagnoseQueue/)
    expect(CLI_SRC).toMatch(/command === 'queue'[\s\S]{0,120}?repairQueue/)
    expect(CLI_SRC).toMatch(/subcommand === 'daemon-status'/)
    expect(CLI_SRC).toMatch(/subcommand === 'smoke'/)
    expect(CLI_SRC).toMatch(/subcommand === 'close-duplicates'/)
    expect(CLI_SRC).toMatch(/subcommand === 'close-outbound-obsolete'/)
  })

  test('repair commands are dry-run by default and require --execute to write', () => {
    expect(CLI_SRC).toMatch(/function parseRepairDryRun/)
    expect(CLI_SRC).toMatch(/return !hasFlag\(flags, 'execute'\)/)
    expect(CLI_SRC).toMatch(/--execute/)
  })
})

describe('queue repair primitives', () => {
  test('duration parser accepts m/h/d and rejects malformed values', () => {
    expect(queueRepairInternal.parseDurationToSeconds('15m')).toBe(900)
    expect(queueRepairInternal.parseDurationToSeconds('12h')).toBe(43_200)
    expect(queueRepairInternal.parseDurationToSeconds('2d')).toBe(172_800)
    expect(queueRepairInternal.parseDurationToSeconds('1w')).toBeNaN()
  })

  test('close-obsolete dry-run previews rows but does not begin or update', async () => {
    const db = new FakeDb([
      {
        id: 101,
        agent_id: 'lead-ama',
        status: 'pending',
        message_id: 'm1',
        payload: JSON.stringify({ content: 'old work' }),
        created_at: '2026-05-19 00:00:00+00',
      },
    ])

    const result = await closeObsoletePendingQueueRows(db as any, {
      agentId: 'lead-ama',
      reason: 'retired identity',
    })

    expect(result.dry_run).toBe(true)
    expect(result.affected_count).toBe(1)
    expect(db.called(/^BEGIN$/)).toBe(false)
    expect(db.called(/UPDATE message_queue/)).toBe(false)
    expect(db.called(/INSERT INTO audit_log/)).toBe(false)
  })

  test('reassign dry-run skips rows already present on the target identity', async () => {
    let call = 0
    const db = {
      calls: [] as Array<{ sql: string; params?: unknown[] }>,
      async query(sql: string, params?: unknown[]) {
        this.calls.push({ sql, params })
        call++
        if (call === 1) return { rows: [{ agent_id: 'codex-aun' }] }
        if (call === 2) {
          return {
            rows: [{
              id: 1,
              agent_id: 'lead-ama',
              status: 'pending',
              message_id: 'unique-message',
              payload: '{}',
              created_at: '2026-05-20T00:00:00.000Z',
            }],
          }
        }
        if (call === 3) {
          return {
            rows: [{
              id: 2,
              agent_id: 'lead-ama',
              status: 'pending',
              message_id: 'already-on-target',
              payload: '{}',
              created_at: '2026-05-20T00:01:00.000Z',
            }],
          }
        }
        return { rows: [] }
      },
    }

    const result = await reassignPendingQueueRows(db as any, {
      fromAgentId: 'lead-ama',
      toAgentId: 'codex-aun',
    })

    expect(result.dry_run).toBe(true)
    expect(result.affected_count).toBe(1)
    expect(result.skipped_count).toBe(1)
    expect(result.skipped_reason).toBe('target_already_has_message_id')
  })

  test('reclaim-expired execute clears claims, returns pending, and writes audit', async () => {
    const rows = [
      {
        id: 202,
        agent_id: 'codex-aun',
        status: 'received',
        message_id: 'm2',
        payload: JSON.stringify({ content: 'claimed work' }),
        created_at: '2026-05-20 00:00:00+00',
      },
    ]
    const db = new FakeDb(rows)

    const result = await reclaimExpiredQueueClaims(db as any, {
      agentId: 'codex-aun',
      dryRun: false,
    })

    expect(result.dry_run).toBe(false)
    expect(db.called(/^BEGIN$/)).toBe(true)
    expect(db.called(/SET status = 'pending'[\s\S]*claimed_by = NULL[\s\S]*claim_expires_at = NULL/)).toBe(true)
    expect(db.called(/INSERT INTO audit_log/)).toBe(true)
    expect(db.called(/^COMMIT$/)).toBe(true)
  })

  test('reclaim-expired can be scoped to one queue row', async () => {
    const exactFence = '2000-01-01 00:00:00.123456+00'
    const db = new FakeDb([
      {
        id: 71026,
        agent_id: 'agent-com-dev',
        status: 'in_progress',
        message_id: 'm3',
        payload: '{}',
        claim_expires_at: exactFence,
        created_at: '2026-05-15 00:00:00+00',
      },
    ])

    const result = await reclaimExpiredQueueClaims(db as any, {
      queueId: '71026',
    })

    expect(result.dry_run).toBe(true)
    expect(result.affected_count).toBe(1)
    expect(db.called(/id = \$2/)).toBe(true)
    expect(db.calls[0].params).toContain('71026')
    expect(db.calls[0].sql).toContain("status IN ('received', 'in_progress')")
    expect(db.calls[0].sql).toContain('claim_expires_at::text AS claim_expires_at')
    expect(result.samples[0]?.claim_expires_at).toBe(exactFence)
  })

  test('bulk reclaim excludes in-progress work and exact execute requires a lease fence', async () => {
    const db = new FakeDb([])

    await reclaimExpiredQueueClaims(db as any, { agentId: 'agent-com-dev' })
    expect(db.calls[0].sql).toContain("status = 'received'")
    expect(db.calls[0].sql).not.toContain("status IN ('received', 'in_progress')")

    await expect(reclaimExpiredQueueClaims(db as any, {
      queueId: '71026',
      dryRun: false,
    })).rejects.toThrow('CLAIM_FENCE_REQUIRED')
  })

  test('exact expired execute binds expected lease and clears runtime fence', async () => {
    const db = new FakeDb([{
      id: 71026,
      agent_id: 'agent-com-dev',
      status: 'in_progress',
      message_id: 'm3',
      claimed_runtime_instance_id: 'old-runtime',
      claim_expires_at: '2000-01-01T00:00:00.000Z',
      created_at: '2026-05-15 00:00:00+00',
    }])

    const result = await reclaimExpiredQueueClaims(db as any, {
      queueId: '71026',
      expectedClaimExpiresAt: '2000-01-01T00:00:00.000Z',
      dryRun: false,
    })

    expect(result.dry_run).toBe(false)
    expect(db.calls.some((call) => call.params?.includes('2000-01-01T00:00:00.000Z'))).toBe(true)
    expect(db.called(/claimed_runtime_instance_id = NULL/)).toBe(true)
  })

  test('close-duplicates closes only pending rows already present on the target identity', async () => {
    let call = 0
    const db = {
      calls: [] as Array<{ sql: string; params?: unknown[] }>,
      async query(sql: string, params?: unknown[]) {
        this.calls.push({ sql, params })
        call++
        if (call === 1) return { rows: [{ agent_id: 'codex-aun' }] }
        if (call === 2) {
          return {
            rows: [{
              id: 73938,
              agent_id: 'lead-ama',
              status: 'pending',
              message_id: 'already-on-target',
              payload: '{}',
              created_at: '2026-05-20T00:00:00.000Z',
            }],
          }
        }
        return { rows: [] }
      },
    }

    const result = await closeDuplicatePendingQueueRows(db as any, {
      fromAgentId: 'lead-ama',
      toAgentId: 'codex-aun',
      reason: 'target-already-has-message',
    })

    expect(result.dry_run).toBe(true)
    expect(result.action).toBe('close_duplicates')
    expect(result.affected_count).toBe(1)
    expect(db.calls[1].sql).toMatch(/EXISTS \(/)
  })

  test('close-outbound-obsolete dry-run previews stale outbound rows without mutation', async () => {
    const db = {
      calls: [] as Array<{ sql: string; params?: unknown[] }>,
      async query(sql: string, params?: unknown[]) {
        this.calls.push({ sql, params })
        if (sql.includes('FROM outbound_queue')) {
          return {
            rows: [{
              id: 11096,
              agent_id: 'codex-test',
              status: 'pending',
              message_id: 'm-out',
              content: 'old Discord projection',
              created_at: '2026-05-14T00:00:00.000Z',
            }],
          }
        }
        return { rows: [] }
      },
      called(pattern: RegExp): boolean {
        return this.calls.some((call) => pattern.test(call.sql))
      },
    }

    const result = await closeObsoleteOutboundRows(db as any, {
      agentId: 'codex-test',
      reason: 'old projection',
    })

    expect(result.dry_run).toBe(true)
    expect(result.action).toBe('close_outbound_obsolete')
    expect(result.affected_count).toBe(1)
    expect(result.samples[0].content).toBe('old Discord projection')
    expect(db.called(/^BEGIN$/)).toBe(false)
    expect(db.called(/UPDATE outbound_queue/)).toBe(false)
  })

  test('repair execute paths include before and after state in audit detail', () => {
    expect(REPAIR_SRC).toMatch(/before_statuses/)
    expect(REPAIR_SRC).toMatch(/after_status: 'skipped'/)
    expect(REPAIR_SRC).toMatch(/after_status: 'pending'/)
    expect(REPAIR_SRC).toMatch(/after_status: 'failed'/)
  })
})

describe('queue runtime diagnostics', () => {
  test('daemon-status reports DB-observed wake and claim heartbeat evidence', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('GROUP BY status')) {
          return { rows: [{ status: 'pending', count: 2 }] }
        }
        if (sql.includes('max(last_wake_attempt_at)')) {
          return {
            rows: [{
              last_wake_attempt_at: '2026-05-20T00:00:00.000Z',
              last_claim_heartbeat_at: '2026-05-20T00:01:00.000Z',
              oldest_pending_at: '2026-05-20T00:02:00.000Z',
              pending_count: 2,
              active_claim_count: 1,
              expired_claim_count: 1,
              stale_pending_count: 2,
            }],
          }
        }
        return { rows: [{ count: 1 }] }
      },
    }

    const report = await buildQueueDaemonStatusReport(db as any)
    expect(report.daemon.liveness_source).toBe('message_queue_observation')
    expect(report.queue.pending_count).toBe(2)
    expect(report.queue.expired_claim_count).toBe(1)
    expect(report.queue.retired_or_offline_pending_count).toBe(1)
  })

  test('smoke readiness blocks active smoke when the agent has active claims', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('FROM agents')) return { rows: [{ agent_id: 'codex-aun' }] }
        if (sql.includes("status = 'pending'")) return { rows: [{ count: 0 }] }
        if (sql.includes('claim_expires_at < now()')) return { rows: [{ count: 0 }] }
        if (sql.includes("status IN ('received', 'in_progress')")) return { rows: [{ count: 1 }] }
        return { rows: [] }
      },
    }

    const report = await buildQueueSmokeReadiness(db as any, 'codex-aun')
    expect(report.safe_to_execute).toBe(false)
    expect(report.blockers).toContain('agent_has_active_claim')
    expect(report.execute_command).toContain('agent-com queue smoke --agent-id codex-aun --execute')
  })
})
