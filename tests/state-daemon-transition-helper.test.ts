import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StateDaemon } from '../core/state-daemon'
import type { DBClient } from '../core/state-daemon/types'
import { isDbCodeDriftError } from '../core/message-queue-schema-guard'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
} from './contract/state-daemon/fakes'

const UNION_CONSTRAINT = "CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'))"
const V08_ONLY_CONSTRAINT = "CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed'))"

class FakeTransitionDb implements DBClient {
  queries: Array<{ sql: string; params?: unknown[] }> = []
  row = {
    status: 'received',
    claimed_by: 'worker-dev',
    claimed_at: new Date('2026-06-10T00:00:00.000Z'),
    claim_expires_at: new Date('2026-06-10T00:01:00.000Z'),
  }

  constructor(private readonly constraintDefinition = UNION_CONSTRAINT) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push({ sql, params })
    if (sql.includes('pg_constraint')) {
      return {
        rows: [{ constraint_definition: this.constraintDefinition }] as T[],
        rowCount: 1,
      }
    }
    if (sql.includes('sqlite_master')) {
      return { rows: [] as T[], rowCount: 0 }
    }
    if (/UPDATE\s+message_queue/i.test(sql)) {
      this.row.status = String(params?.[0] ?? this.row.status)
      if (sql.includes('claimed_by = NULL')) this.row.claimed_by = null as never
      if (sql.includes('claimed_at = NULL')) this.row.claimed_at = null as never
      if (sql.includes('claim_expires_at = NULL')) this.row.claim_expires_at = null as never
      return { rows: [] as T[], rowCount: 1 }
    }
    throw new Error(`unexpected SQL in fake transition db: ${sql}`)
  }
}

function buildDaemon(db: DBClient): StateDaemon {
  return new StateDaemon({
    db,
    pgListen: new FakePgListen(),
    tmux: new FakeTmux(),
    clock: new FakeClock('2026-06-10T00:00:00.000Z'),
    metrics: new FakeMetrics(),
    alert: new FakeAlertSink(),
  })
}

function queueRow(status = 'received') {
  return {
    id: 1,
    agent_id: 'worker-dev',
    status,
    payload: JSON.stringify({ content: 'no reply required', no_reply_required: true }),
    claim_expires_at: new Date('2026-06-10T00:01:00.000Z'),
    claimed_at: new Date('2026-06-10T00:00:00.000Z'),
    created_at: new Date('2026-06-09T23:59:00.000Z'),
    last_wake_attempt_at: null,
    last_heartbeat_at: null,
  }
}

describe('state_daemon message_queue transition helper wiring', () => {
  test('reclaim to pending clears claim columns through the transition helper', async () => {
    const db = new FakeTransitionDb()
    const daemon = buildDaemon(db)
    let observedWakeStatus: string | null = null
    ;(daemon as any).runWakeIfNotSuppressed = async (row: { status: string }) => {
      observedWakeStatus = row.status
      return false
    }

    await (daemon as any).reclaimRow(queueRow())

    expect(db.row).toEqual({
      status: 'pending',
      claimed_by: null,
      claimed_at: null,
      claim_expires_at: null,
    })
    expect(observedWakeStatus).toBe('pending')
    const update = db.queries.find((q) => /UPDATE\s+message_queue/i.test(q.sql))
    expect(update?.sql).toContain('status = $1')
    expect(update?.sql).toContain('claimed_by = NULL')
    expect(update?.sql).toContain('claimed_at = NULL')
    expect(update?.sql).toContain('claim_expires_at = NULL')
  })

  test('abandon reset path cannot create pending plus claimed_by mixed state', async () => {
    const db = new FakeTransitionDb()
    const daemon = buildDaemon(db)
    ;(daemon as any).status = 'running'
    ;(daemon as any).fetchReceivedExpired = async () => []
    ;(daemon as any).fetchObservableWork = async () => []
    ;(daemon as any).fetchPendingStale = async () => []
    ;(daemon as any).fetchAbandonRecent = async () => [queueRow('failed')]

    const result = await daemon.sweepStale()

    expect(result.abandonReset).toBe(1)
    expect(db.row.status).toBe('pending')
    expect(db.row.claimed_by).toBeNull()
    expect(db.row.claimed_at).toBeNull()
    expect(db.row.claim_expires_at).toBeNull()
  })

  test('state_daemon done writer fails with DB_CODE_DRIFT before mutation', async () => {
    const db = new FakeTransitionDb(V08_ONLY_CONSTRAINT)
    const daemon = buildDaemon(db)

    let thrown: unknown
    try {
      await (daemon as any).completeNoReplyIfRequired(queueRow('received'))
    } catch (err) {
      thrown = err
    }

    expect(isDbCodeDriftError(thrown)).toBe(true)
    expect(db.queries.some((q) => /UPDATE\s+message_queue/i.test(q.sql))).toBe(false)
  })

  test('state_daemon has no direct pending status writer left in the reset paths', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'core', 'state-daemon', 'index.ts'), 'utf8')
    expect(src).not.toMatch(/SET\s+status='pending'/)
    expect(src).toContain('transitionQueueStatus({ queueId: row.id, toStatus: \'pending\' })')
  })
})
