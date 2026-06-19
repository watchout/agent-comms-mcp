import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildAunRuntimeV2ReadOnlyPlan,
  type AunRuntimeV2ReadOnlyPlan,
} from '../core/aun-runtime-v2-plan'
import type { QueueWorkDb } from '../core/queue-work'

const NOW = new Date('2026-06-19T00:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dir, '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

class FakeRuntimeV2PlanDb implements QueueWorkDb {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    public queueRows: any[],
    public runtimeRows: any[] = [runtimeRow()],
  ) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })
    const compact = sql.replace(/\s+/g, ' ').trim()
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/i.test(compact)) {
      throw new Error(`mutation SQL is forbidden in planner test: ${compact}`)
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

    throw new Error(`unexpected SQL in runtime-v2 planner fake: ${sql}`)
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
    payload: JSON.stringify({ content: 'runtime-v2 plan fixture' }),
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

async function planWithMutationAssert(
  db: FakeRuntimeV2PlanDb,
  opts: Parameters<typeof buildAunRuntimeV2ReadOnlyPlan>[1],
): Promise<AunRuntimeV2ReadOnlyPlan> {
  const before = db.snapshot()
  const result = await buildAunRuntimeV2ReadOnlyPlan(db, {
    now: () => NOW,
    env: {} as NodeJS.ProcessEnv,
    ...opts,
  })
  const after = db.snapshot()
  expect(after).toBe(before)
  expect(db.calls.every((call) => !/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/i.test(call.sql))).toBe(true)
  if ('error' in result) throw new Error(`unexpected planner error: ${result.error} ${result.message}`)
  expect(result.plan.mutations).toEqual([])
  return result
}

describe('AUN runtime-v2 read-only planner', () => {
  test('plans claim for pending kodama row with live runtime and no conflict', async () => {
    const result = await planWithMutationAssert(new FakeRuntimeV2PlanDb([queueRow()]), {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-18T23:00:00.000Z',
    })

    expect(result).toMatchObject({
      schema_version: 'aun-runtime-v2-plan/v1',
      agent_id: 'kodama',
      target: {
        queue_id: '1001',
        message_id: 'msg-kodama-1',
        created_after: '2026-06-18T23:00:00.000Z',
      },
      evaluation: {
        row_found: true,
        row_status: 'pending',
        owned_by_expected_agent: true,
        runtime_alive: true,
        conflicting_active_claim: false,
        exact_fence_satisfied: true,
      },
      plan: {
        action: 'claim',
        reason_code: 'claimable',
        would_claim: true,
        mutations: [],
      },
    })
  })

  test('reports not_pending for an exact in_progress row', async () => {
    const result = await planWithMutationAssert(new FakeRuntimeV2PlanDb([
      queueRow({ status: 'in_progress', claimed_by: 'kodama', claim_expires_at: '2026-06-19T00:05:00.000Z' }),
    ]), {
      agentId: 'kodama',
      queueId: '1001',
    })

    expect(result.plan).toMatchObject({
      action: 'skip',
      reason_code: 'not_pending',
      would_claim: false,
    })
  })

  test('reports identity_mismatch for an exact row owned by another agent', async () => {
    const result = await planWithMutationAssert(new FakeRuntimeV2PlanDb([
      queueRow({ agent_id: 'other-agent' }),
    ]), {
      agentId: 'kodama',
      queueId: '1001',
    })

    expect(result.evaluation).toMatchObject({
      row_found: true,
      owned_by_expected_agent: false,
    })
    expect(result.plan.reason_code).toBe('identity_mismatch')
  })

  test('reports runtime_not_alive when heartbeat is stale', async () => {
    const result = await planWithMutationAssert(new FakeRuntimeV2PlanDb([
      queueRow(),
    ], [
      runtimeRow({ last_seen_at: '2026-06-18T23:00:00.000Z' }),
    ]), {
      agentId: 'kodama',
      queueId: '1001',
      runtimeStaleSeconds: 60,
    })

    expect(result.evaluation.runtime_alive).toBe(false)
    expect(result.plan).toMatchObject({
      action: 'blocked',
      reason_code: 'runtime_not_alive',
      would_claim: false,
    })
  })

  test('reports row_not_found for a missing exact queue id', async () => {
    const result = await planWithMutationAssert(new FakeRuntimeV2PlanDb([queueRow()]), {
      agentId: 'kodama',
      queueId: '404',
    })

    expect(result.evaluation).toMatchObject({
      row_found: false,
      row_status: null,
    })
    expect(result.plan.reason_code).toBe('row_not_found')
  })

  test('reports conflicting_active_claim when another live claim exists for the agent', async () => {
    const result = await planWithMutationAssert(new FakeRuntimeV2PlanDb([
      queueRow(),
      queueRow({
        id: 1002,
        message_id: 'msg-active',
        status: 'received',
        claimed_by: 'kodama',
        claimed_at: '2026-06-18T23:58:00.000Z',
        claim_expires_at: '2026-06-19T00:05:00.000Z',
      }),
    ]), {
      agentId: 'kodama',
      queueId: '1001',
    })

    expect(result.evaluation.conflicting_active_claim).toBe(true)
    expect(result.plan).toMatchObject({
      action: 'blocked',
      reason_code: 'conflicting_active_claim',
      would_claim: false,
    })
  })

  test('reports fence_mismatch for exact row with mismatched message fence', async () => {
    const result = await planWithMutationAssert(new FakeRuntimeV2PlanDb([queueRow()]), {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'wrong-message-id',
    })

    expect(result.evaluation.exact_fence_satisfied).toBe(false)
    expect(result.plan.reason_code).toBe('fence_mismatch')
  })

  test('returns invalid_arguments for bad created-after without DB access', async () => {
    const db = new FakeRuntimeV2PlanDb([queueRow()])
    const result = await buildAunRuntimeV2ReadOnlyPlan(db, {
      agentId: 'kodama',
      createdAfter: 'not-a-date',
      env: {} as NodeJS.ProcessEnv,
    })

    expect(result).toMatchObject({
      error: 'invalid_arguments',
    })
    expect(db.calls).toEqual([])
  })

  test('returns fence_required without DB access when exact fence policy is enabled', async () => {
    const db = new FakeRuntimeV2PlanDb([queueRow()])
    const result = await buildAunRuntimeV2ReadOnlyPlan(db, {
      agentId: 'kodama',
      env: {
        AUN_RUNTIME_V2_PLAN_REQUIRE_EXACT_FENCE: 'true',
      } as NodeJS.ProcessEnv,
    })

    expect(result).toMatchObject({
      error: 'fence_required',
    })
    expect(db.calls).toEqual([])
  })

  test('CLI emits claimable JSON against sqlite fixture without mutating rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-runtime-v2-plan-cli-'))
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
        'plan',
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
          AGENT_COM_SQLITE_PATH: dbPath,
          DATABASE_URL: '',
        },
        timeout: 20_000,
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      const parsed = JSON.parse(result.stdout)
      expect(parsed).toMatchObject({
        schema_version: 'aun-runtime-v2-plan/v1',
        agent_id: 'kodama',
        plan: {
          action: 'claim',
          reason_code: 'claimable',
          would_claim: true,
          mutations: [],
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
})
