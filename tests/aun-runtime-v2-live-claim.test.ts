import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildAunRuntimeV2LiveClaim,
  type AunRuntimeV2LiveClaim,
} from '../core/aun-runtime-v2-live-claim'
import type { QueueWorkDb } from '../core/queue-work'

const NOW = new Date('2026-06-27T00:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dir, '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

class FakeRuntimeV2LiveClaimDb implements QueueWorkDb {
  calls: Array<{ sql: string; params?: unknown[] }> = []
  updateCount = 0

  constructor(
    public queueRows: any[],
    public runtimeRows: any[] = [runtimeRow()],
  ) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params })
    const compact = sql.replace(/\s+/g, ' ').trim()

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(compact)) {
      return { rows: [], rowCount: 0 }
    }

    if (/^UPDATE message_queue\b/i.test(compact)) {
      this.updateCount += 1
      const [queueId, agentId, messageId, createdAfter, claimedAt, claimExpiresAt, payload] = params ?? []
      const row = this.queueRows.find((item) => (
        String(item.id) === String(queueId)
        && item.agent_id === agentId
        && item.message_id === messageId
        && item.status === 'pending'
        && Date.parse(item.created_at) >= Date.parse(String(createdAfter))
      ))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'received'
      row.read_at = claimedAt
      row.claimed_by = agentId
      row.claimed_at = claimedAt
      row.claim_expires_at = claimExpiresAt
      row.payload = payload
      return { rows: [{ ...row }] as T[], rowCount: 1 }
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

    throw new Error(`unexpected SQL in runtime-v2 live claim fake: ${sql}`)
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
    payload: JSON.stringify({ content: 'runtime-v2 live claim fixture' }),
    priority: 0,
    created_at: '2026-06-26T23:50:00.000Z',
    read_at: null,
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
    started_at: '2026-06-26T23:00:00.000Z',
    stopped_at: null,
    last_seen_at: '2026-06-26T23:59:00.000Z',
    ...overrides,
  }
}

async function liveClaim(
  db: FakeRuntimeV2LiveClaimDb,
  opts: Partial<Parameters<typeof buildAunRuntimeV2LiveClaim>[1]> = {},
): Promise<AunRuntimeV2LiveClaim> {
  const result = await buildAunRuntimeV2LiveClaim(db, {
    agentId: 'kodama',
    queueId: '1001',
    messageId: 'msg-kodama-1',
    createdAfter: '2026-06-26T23:00:00.000Z',
    env: {} as NodeJS.ProcessEnv,
    now: () => NOW,
    liveCanary: true,
    ...opts,
  })
  if ('error' in result) throw new Error(`unexpected live claim error: ${result.error} ${result.message}`)
  return result
}

describe('AUN runtime-v2 live kodama canary claim', () => {
  test('rejects non-kodama agents before DB access', async () => {
    const db = new FakeRuntimeV2LiveClaimDb([queueRow()])
    const result = await buildAunRuntimeV2LiveClaim(db, {
      agentId: 'codex-audit',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-26T23:00:00.000Z',
      env: {} as NodeJS.ProcessEnv,
      liveCanary: true,
    })

    expect(result).toMatchObject({ error: 'target_agent_not_allowed' })
    expect(db.calls).toEqual([])
  })

  test('requires explicit live-canary authorization before DB access', async () => {
    const db = new FakeRuntimeV2LiveClaimDb([queueRow()])
    const result = await buildAunRuntimeV2LiveClaim(db, {
      agentId: 'kodama',
      queueId: '1001',
      messageId: 'msg-kodama-1',
      createdAfter: '2026-06-26T23:00:00.000Z',
      env: {} as NodeJS.ProcessEnv,
      liveCanary: false,
    })

    expect(result).toMatchObject({ error: 'live_canary_not_authorized' })
    expect(db.calls).toEqual([])
  })

  test('requires exact queue, message, and created-after fence before DB access', async () => {
    const db = new FakeRuntimeV2LiveClaimDb([queueRow()])
    const result = await buildAunRuntimeV2LiveClaim(db, {
      agentId: 'kodama',
      queueId: '1001',
      createdAfter: '2026-06-26T23:00:00.000Z',
      env: {} as NodeJS.ProcessEnv,
      liveCanary: true,
    })

    expect(result).toMatchObject({ error: 'fence_required' })
    expect(db.calls).toEqual([])
  })

  test('claims only an exact claimable kodama target and records runtime-v2 source evidence', async () => {
    const db = new FakeRuntimeV2LiveClaimDb([queueRow()])
    const result = await liveClaim(db)

    expect(result).toMatchObject({
      schema_version: 'aun-runtime-v2-live-claim/v1',
      agent_id: 'kodama',
      target: {
        queue_id: '1001',
        message_id: 'msg-kodama-1',
        created_after: '2026-06-26T23:00:00.000Z',
      },
      claim: {
        claimed: true,
        reason_code: 'claimed',
        claim_source: 'aun-runtime-v2',
        applied_mutations: [{
          op: 'update_queue_row',
          table: 'message_queue',
          queue_id: '1001',
          agent_id: 'kodama',
          message_id: 'msg-kodama-1',
          status: 'received',
          claimed_by: 'kodama',
          claim_source: 'aun-runtime-v2',
        }],
        claimed_row: {
          queue_id: '1001',
          status: 'received',
          claimed_by: 'kodama',
          claimed_at: NOW.toISOString(),
        },
      },
    })
    expect(db.updateCount).toBe(1)
    expect(db.queueRows[0].status).toBe('received')
    expect(JSON.parse(db.queueRows[0].payload).receive_claim).toMatchObject({
      mode: 'canonical-runtime-v2',
      source: 'aun-runtime-v2',
      runtime_version: 2,
      agent_id: 'kodama',
      queue_id: '1001',
      message_id: 'msg-kodama-1',
      live_canary: true,
    })
  })

  test('does not mutate stale holder, wrong fence, non-pending, runtime-dead, or conflicting-claim cases', async () => {
    const cases: Array<{
      name: string
      db: FakeRuntimeV2LiveClaimDb
      opts?: Partial<Parameters<typeof buildAunRuntimeV2LiveClaim>[1]>
      reason: string
    }> = [
      {
        name: 'stale_holder_non_pending',
        db: new FakeRuntimeV2LiveClaimDb([
          queueRow({
            status: 'received',
            claimed_by: 'kodama',
            claim_expires_at: '2026-06-26T23:55:00.000Z',
          }),
        ]),
        reason: 'not_pending',
      },
      {
        name: 'wrong_fence',
        db: new FakeRuntimeV2LiveClaimDb([queueRow()]),
        opts: { messageId: 'wrong-message-id' },
        reason: 'fence_mismatch',
      },
      {
        name: 'runtime_not_alive',
        db: new FakeRuntimeV2LiveClaimDb([queueRow()], [runtimeRow({ last_seen_at: '2026-06-26T23:00:00.000Z' })]),
        opts: { runtimeStaleSeconds: 60 },
        reason: 'runtime_not_alive',
      },
      {
        name: 'conflicting_active_claim',
        db: new FakeRuntimeV2LiveClaimDb([
          queueRow(),
          queueRow({
            id: 1002,
            message_id: 'msg-active',
            status: 'received',
            claimed_by: 'kodama',
            claimed_at: '2026-06-26T23:58:00.000Z',
            claim_expires_at: '2026-06-27T00:05:00.000Z',
          }),
        ]),
        reason: 'conflicting_active_claim',
      },
    ]

    for (const item of cases) {
      const before = item.db.snapshot()
      const result = await liveClaim(item.db, item.opts)
      expect(result.claim, item.name).toMatchObject({
        claimed: false,
        reason_code: item.reason,
        applied_mutations: [],
      })
      expect(item.db.updateCount, item.name).toBe(0)
      expect(item.db.snapshot(), item.name).toBe(before)
    }
  })

  test('CLI performs a live-canary claim against an isolated sqlite fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-runtime-v2-live-claim-cli-'))
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
          read_at TEXT,
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
          (id, agent_id, message_id, payload, status, priority, created_at, read_at, claimed_by, claimed_at, claim_expires_at)
        VALUES
          (1001, 'kodama', 'msg-kodama-1', '{"content":"cli live fixture"}', 'pending', 0,
           '2026-06-26T23:50:00.000Z', NULL, NULL, NULL, NULL);
        INSERT INTO agent_runtime_instances
          (runtime_instance_id, agent_id, status, started_at, stopped_at, last_seen_at)
        VALUES
          ('runtime-kodama-1', 'kodama', 'active', '2026-06-26T23:00:00.000Z', NULL,
           '2099-01-01T00:00:00.000Z');
      `)
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
        '2026-06-26T23:00:00.000Z',
        '--live-canary',
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
        schema_version: 'aun-runtime-v2-live-claim/v1',
        agent_id: 'kodama',
        claim: {
          claimed: true,
          reason_code: 'claimed',
        },
      })

      const afterDb = new Database(dbPath)
      const row = afterDb.prepare('SELECT status, claimed_by, payload FROM message_queue WHERE id = 1001').get() as any
      afterDb.close()
      expect(row.status).toBe('received')
      expect(row.claimed_by).toBe('kodama')
      expect(JSON.parse(row.payload).receive_claim).toMatchObject({
        source: 'aun-runtime-v2',
        live_canary: true,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI rejects non-kodama live-canary before opening a missing sqlite database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-runtime-v2-live-claim-no-db-'))
    try {
      const result = spawnSync('bun', [
        'run',
        AUN_CLI,
        'runtime-v2',
        'claim',
        '--agent-id',
        'codex-audit',
        '--queue-id',
        '1001',
        '--message-id',
        'msg-kodama-1',
        '--created-after',
        '2026-06-26T23:00:00.000Z',
        '--live-canary',
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
        error: 'target_agent_not_allowed',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
