import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildAunRuntimeV2ClaimDryRun,
  type AunRuntimeV2ClaimDryRun,
} from '../core/aun-runtime-v2-claim-plan'
import type { QueueWorkDb } from '../core/queue-work'

const NOW = new Date('2026-06-19T00:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dir, '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

class FakeRuntimeV2ClaimPlanDb implements QueueWorkDb {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    public queueRows: any[],
    public runtimeRows: any[] = [runtimeRow()],
  ) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })
    const compact = sql.replace(/\s+/g, ' ').trim()
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/i.test(compact)) {
      throw new Error(`mutation SQL is forbidden in claim dry-run test: ${compact}`)
    }

    if (compact.includes('FROM message_queue') && compact.includes("status IN ('received', 'in_progress')")) {
      const agentId = params?.[0]
      const now = Date.parse(String(params?.[1]))
      const row = this.queueRows.find((item) => {
        if (item.agent_id !== agentId) return false
        if (!['received', 'in_progress'].includes(item.status)) return false
        if (!item.claim_expires_at) return true
        return Date.parse(String(item.claim_expires_at)) >= now
      })
      return row ? { rows: [{ ...row }] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (compact.includes('FROM message_queue') && compact.includes('WHERE id = $1')) {
      const row = this.queueRows.find((item) => String(item.id) === String(params?.[0]))
      return row ? { rows: [{ ...row }] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (compact.includes('FROM message_queue')) {
      const agentId = params?.[0]
      const messageParamIndex = compact.match(/message_id = \$(\d+)/)?.[1]
      const createdAfterParamIndex = compact.match(/created_at >= \$(\d+)/)?.[1]
      const messageId = messageParamIndex ? params?.[Number(messageParamIndex) - 1] : undefined
      const createdAfter = createdAfterParamIndex ? params?.[Number(createdAfterParamIndex) - 1] : undefined
      const row = this.queueRows
        .filter((item) => item.agent_id === agentId)
        .filter((item) => item.status === 'pending')
        .filter((item) => messageId === undefined || item.message_id === messageId)
        .filter((item) => createdAfter === undefined || Date.parse(item.created_at) >= Date.parse(String(createdAfter)))
        .sort((a, b) => {
          const priority = Number(b.priority ?? 0) - Number(a.priority ?? 0)
          if (priority !== 0) return priority
          return Date.parse(a.created_at) - Date.parse(b.created_at)
        })[0]
      return row ? { rows: [{ ...row }] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (compact.includes('FROM agent_runtime_instances')) {
      const agentId = params?.[0]
      const row = this.runtimeRows
        .filter((item) => item.agent_id === agentId)
        .sort((a, b) => Date.parse(b.last_seen_at ?? b.started_at) - Date.parse(a.last_seen_at ?? a.started_at))[0]
      return row ? { rows: [{ ...row }] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    throw new Error(`unexpected SQL in runtime-v2 claim dry-run fake: ${sql}`)
  }

  snapshot(): string {
    return JSON.stringify({ queueRows: this.queueRows, runtimeRows: this.runtimeRows })
  }
}

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    agent_id: 'kodama',
    message_id: 'msg-kodama-1',
    status: 'pending',
    payload: JSON.stringify({ content: 'runtime-v2 claim fixture' }),
    priority: 0,
    created_at: '2026-06-18T23:50:00.000Z',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    ...overrides,
  }
}

function runtimeRow(overrides: Record<string, unknown> = {}) {
  return {
    runtime_instance_id: 'runtime-kodama-1',
    agent_id: 'kodama',
    status: 'active',
    started_at: '2026-06-18T23:00:00.000Z',
    stopped_at: null,
    last_seen_at: '2026-06-18T23:59:00.000Z',
    ...overrides,
  }
}

async function claimPlanWithMutationAssert(
  db: FakeRuntimeV2ClaimPlanDb,
  opts: Parameters<typeof buildAunRuntimeV2ClaimDryRun>[1],
): Promise<AunRuntimeV2ClaimDryRun> {
  const before = db.snapshot()
  const result = await buildAunRuntimeV2ClaimDryRun(db, {
    now: () => NOW,
    env: {} as NodeJS.ProcessEnv,
    dryRun: true,
    ...opts,
  })
  const after = db.snapshot()
  expect(after).toBe(before)
  expect(db.calls.every((call) => !/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/i.test(call.sql))).toBe(true)
  if ('error' in result) throw new Error(`unexpected claim dry-run error: ${result.error} ${result.message}`)
  expect(result.claim_plan.applied_mutations).toEqual([])
  return result
}

describe('AUN runtime-v2 claim dry-run planner', () => {
  test('emits claim operation packet for claimable exact target without mutation', async () => {
    const result = await claimPlanWithMutationAssert(new FakeRuntimeV2ClaimPlanDb([queueRow()]), {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-18T23:00:00.000Z',
    })

    expect(result).toMatchObject({
      schema_version: 'aun-runtime-v2-claim-dryrun/v1',
      agent_id: 'kodama',
      target: {
        queue_id: '1001',
        message_id: 'msg-kodama-1',
        created_after: '2026-06-18T23:00:00.000Z',
      },
      claim_plan: {
        claimable: true,
        planned_operation: 'claim',
        planned_mutation: {
          op: 'update_queue_row',
          table: 'message_queue',
          set: {
            owner: 'kodama',
            claimed_by: 'kodama',
            lease_state: 'claimed',
          },
          where: {
            queue_id: '1001',
            expected_status: 'pending',
          },
        },
        preconditions_checked: [
          'row_pending',
          'identity_match',
          'runtime_alive',
          'no_conflicting_claim',
          'exact_fence',
        ],
        applied_mutations: [],
      },
    })
  })

  test('emits non-claimable reason codes without mutation', async () => {
    const cases: Array<{
      name: string
      db: FakeRuntimeV2ClaimPlanDb
      opts?: Partial<Parameters<typeof buildAunRuntimeV2ClaimDryRun>[1]>
      reason: string
    }> = [
      {
        name: 'not_pending',
        db: new FakeRuntimeV2ClaimPlanDb([
          queueRow({ status: 'in_progress', claimed_by: 'kodama', claim_expires_at: '2026-06-19T00:05:00.000Z' }),
        ]),
        reason: 'not_pending',
      },
      {
        name: 'identity_mismatch',
        db: new FakeRuntimeV2ClaimPlanDb([queueRow({ agent_id: 'other-agent' })]),
        reason: 'identity_mismatch',
      },
      {
        name: 'runtime_not_alive',
        db: new FakeRuntimeV2ClaimPlanDb([queueRow()], [runtimeRow({ last_seen_at: '2026-06-18T23:00:00.000Z' })]),
        opts: { runtimeStaleSeconds: 60 },
        reason: 'runtime_not_alive',
      },
      {
        name: 'conflicting_active_claim',
        db: new FakeRuntimeV2ClaimPlanDb([
          queueRow(),
          queueRow({
            id: 1002,
            message_id: 'msg-active',
            status: 'received',
            claimed_by: 'kodama',
            claimed_at: '2026-06-18T23:58:00.000Z',
            claim_expires_at: '2026-06-19T00:05:00.000Z',
          }),
        ]),
        reason: 'conflicting_active_claim',
      },
      {
        name: 'fence_mismatch',
        db: new FakeRuntimeV2ClaimPlanDb([queueRow()]),
        opts: { messageId: 'wrong-message-id' },
        reason: 'fence_mismatch',
      },
      {
        name: 'row_not_found',
        db: new FakeRuntimeV2ClaimPlanDb([queueRow()]),
        opts: { queueId: '404' },
        reason: 'row_not_found',
      },
    ]

    for (const item of cases) {
      const result = await claimPlanWithMutationAssert(item.db, {
        agentId: 'kodama',
        queueId: '1001',
        messageId: 'msg-kodama-1',
        createdAfter: '2026-06-18T23:00:00.000Z',
        ...item.opts,
      })
      expect(result.claim_plan, item.name).toMatchObject({
        claimable: false,
        planned_operation: 'none',
        planned_mutation: null,
        reason_code: item.reason,
        applied_mutations: [],
      })
    }
  })

  test('rejects missing dry-run before DB access', async () => {
    const db = new FakeRuntimeV2ClaimPlanDb([queueRow()])
    const result = await buildAunRuntimeV2ClaimDryRun(db, {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-18T23:00:00.000Z',
      env: {} as NodeJS.ProcessEnv,
      dryRun: false,
    })

    expect(result).toMatchObject({
      error: 'live_claim_not_authorized_in_this_cell',
    })
    expect(db.calls).toEqual([])
  })

  test('requires exact fence before DB access', async () => {
    const db = new FakeRuntimeV2ClaimPlanDb([queueRow()])
    const result = await buildAunRuntimeV2ClaimDryRun(db, {
      agentId: 'kodama',
      queueId: '1001',
      createdAfter: '2026-06-18T23:00:00.000Z',
      env: {} as NodeJS.ProcessEnv,
      dryRun: true,
    })

    expect(result).toMatchObject({
      error: 'fence_required',
    })
    expect(db.calls).toEqual([])
  })

  test('CLI emits claim dry-run JSON against sqlite fixture without mutating rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-runtime-v2-claim-plan-cli-'))
    const dbPath = join(dir, 'fixture.sqlite')
    try {
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE message_queue (
          id INTEGER PRIMARY KEY,
          agent_id TEXT NOT NULL,
          message_id TEXT,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER,
          created_at TEXT NOT NULL,
          claimed_by TEXT,
          claimed_at TEXT,
          claim_expires_at TEXT
        );
        CREATE TABLE agent_runtime_instances (
          runtime_instance_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          status TEXT,
          started_at TEXT,
          stopped_at TEXT,
          last_seen_at TEXT
        );
        INSERT INTO message_queue
          (id, agent_id, message_id, payload, status, priority, created_at, claimed_by, claimed_at, claim_expires_at)
        VALUES
          (1001, 'kodama', 'msg-kodama-1', '{"content":"cli fixture"}', 'pending', 0,
           '2026-06-18T23:50:00.000Z', NULL, NULL, NULL);
        INSERT INTO agent_runtime_instances
          (runtime_instance_id, agent_id, status, started_at, stopped_at, last_seen_at)
        VALUES
          ('runtime-kodama-1', 'kodama', 'active', '2026-06-18T23:00:00.000Z', NULL,
           '2099-01-01T00:00:00.000Z');
      `)
      const before = JSON.stringify(db.prepare('SELECT * FROM message_queue ORDER BY id').all())
      db.close()

      const result = spawnSync('bun', [
        'run',
        AUN_CLI,
        'runtime-v2',
        'claim',
        '--agent-id',
        'kodama',
        '--queue-id',
        '1001',
        '--message-id',
        'msg-kodama-1',
        '--created-after',
        '2026-06-18T23:00:00.000Z',
        '--dry-run',
        '--json',
      ], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: dbPath,
          DATABASE_URL: '',
        },
        timeout: 20_000,
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      const parsed = JSON.parse(result.stdout)
      expect(parsed).toMatchObject({
        schema_version: 'aun-runtime-v2-claim-dryrun/v1',
        agent_id: 'kodama',
        claim_plan: {
          claimable: true,
          planned_operation: 'claim',
          applied_mutations: [],
        },
      })

      const afterDb = new Database(dbPath)
      const after = JSON.stringify(afterDb.prepare('SELECT * FROM message_queue ORDER BY id').all())
      afterDb.close()
      expect(after).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI rejects missing dry-run without opening the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-runtime-v2-claim-plan-no-db-'))
    try {
      const result = spawnSync('bun', [
        'run',
        AUN_CLI,
        'runtime-v2',
        'claim',
        '--agent-id',
        'kodama',
        '--queue-id',
        '1001',
        '--message-id',
        'msg-kodama-1',
        '--created-after',
        '2026-06-18T23:00:00.000Z',
        '--json',
      ], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: join(dir, 'missing.sqlite'),
          DATABASE_URL: '',
        },
        timeout: 20_000,
      })

      expect(result.status).toBe(2)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: 'live_claim_not_authorized_in_this_cell',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
