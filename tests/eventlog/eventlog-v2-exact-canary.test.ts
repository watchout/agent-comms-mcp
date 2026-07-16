import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbAdapter } from '../../core/db/adapter'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { ensureEventLogSchema } from '../../core/eventlog/schema'
import {
  importExactPendingV1Row,
  type ExactV1QueueTuple,
} from '../../core/eventlog/v1-import'
import {
  claimExactTurn,
  claimNextTurn,
  recoverExactTurnClaim,
  StaleClaimError,
  turnIdFor,
} from '../../core/eventlog/turns'
import { runExactTurnWorkerOnce, type TurnRuntime } from '../../core/eventlog/worker'
import {
  ExactCanaryArgumentError,
  ExactCanaryNegativePhaseError,
  PlannedCrashAfterClaimError,
  exactCanaryHelp,
  parseExactCanaryArgs,
  runExactCanary,
  type ExactCanaryArgs,
  type ExactCanaryResumeResult,
} from '../../bin/aun/v2-exact-canary'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI_PATH = join(REPO_ROOT, 'bin', 'aun', 'v2-exact-canary.ts')
const FENCE = '2026-07-14T00:00:00.000Z'
const CREATED = '2026-07-14T00:00:01.000Z'
const TARGET_MESSAGE = '11111111-1111-4111-8111-111111111111'
const OTHER_MESSAGE = '22222222-2222-4222-8222-222222222222'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-v2-exact-canary-'))
  db = new SqliteAdapter(join(dir, 'canary.db'))
  await ensureEventLogSchema(db)
  await db.execute(`CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY, channel_id TEXT, thread_id TEXT,
    author_id TEXT NOT NULL, content TEXT NOT NULL
  )`)
  await db.execute(`CREATE TABLE message_queue (
    id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, message_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
    failed_reason TEXT, done_at TEXT, created_at TEXT NOT NULL
  )`)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

function args(overrides: Partial<ExactCanaryArgs> = {}): ExactCanaryArgs {
  return {
    seatId: 'aun',
    queueId: 1001,
    messageId: TARGET_MESSAGE,
    createdAfter: FENCE,
    phase: 'resume',
    runtime: 'deterministic-no-reply',
    providerDispatch: 'disabled',
    maxTurns: 1,
    ...overrides,
  }
}

async function seedV1(
  adapter: DbAdapter,
  tuple: { queueId: number; messageId: string; createdAt?: string; threadId?: string },
): Promise<void> {
  await adapter.execute(
    `INSERT INTO agent_messages (id, channel_id, thread_id, author_id, content)
     VALUES ($1, 'chan-canary', $2, 'arc', 'exact canary fixture')`,
    [tuple.messageId, tuple.threadId ?? `thread-${tuple.queueId}`],
  )
  await adapter.execute(
    `INSERT INTO message_queue (id, agent_id, message_id, payload, status, created_at)
     VALUES ($1, 'aun', $2, '{}', 'pending', $3)`,
    [tuple.queueId, tuple.messageId, tuple.createdAt ?? CREATED],
  )
}

async function snapshot(adapter: DbAdapter): Promise<string> {
  const queue = await adapter.query(
    `SELECT id, agent_id, message_id, status, failed_reason, done_at, created_at
     FROM message_queue ORDER BY id`,
  )
  const events = await adapter.query(
    `SELECT event_type, seat_id, seat_instance_id, turn_id, claim_epoch
     FROM event_log ORDER BY seq`,
  )
  return JSON.stringify({ queue, events })
}

async function eventCount(adapter: DbAdapter, turnId: string, eventType: string): Promise<number> {
  const row = await adapter.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log WHERE turn_id = $1 AND event_type = $2`,
    [turnId, eventType],
  )
  return Number(row?.n ?? 0)
}

async function crash(adapter: DbAdapter, input: ExactCanaryArgs = args({ phase: 'crash-after-claim' })) {
  try {
    await runExactCanary(adapter, input)
  } catch (error) {
    if (error instanceof PlannedCrashAfterClaimError) return error
    throw error
  }
  throw new Error('crash phase unexpectedly returned')
}

async function resume(adapter: DbAdapter, input: ExactCanaryArgs = args()): Promise<ExactCanaryResumeResult> {
  return runExactCanary(adapter, input)
}

function tupleFor(input: ExactCanaryArgs): ExactV1QueueTuple {
  return {
    seatId: input.seatId,
    queueId: input.queueId,
    messageId: input.messageId,
    createdAfter: input.createdAfter,
  }
}

describe('AUN V2 exact-canary mechanism', () => {
  test('ECAN-001-wrong-queue: wrong queue_id plus correct message_id is nonzero and zero-mutation', async () => {
    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const before = await snapshot(db)
    const execution = runExactCanary(db, args({ queueId: 9999, phase: 'negative' }))
    await expect(execution).rejects.toBeInstanceOf(ExactCanaryNegativePhaseError)
    expect(await snapshot(db)).toBe(before)
  })

  test('ECAN-002-wrong-message: correct queue_id plus wrong message_id is nonzero and zero-mutation', async () => {
    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const before = await snapshot(db)
    await expect(runExactCanary(db, args({ messageId: OTHER_MESSAGE, phase: 'negative' })))
      .rejects.toBeInstanceOf(ExactCanaryNegativePhaseError)
    expect(await snapshot(db)).toBe(before)
  })

  test('ECAN-003-created-after: stale created_after relation fails before mutation', async () => {
    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const before = await snapshot(db)
    await expect(runExactCanary(db, args({ createdAfter: CREATED, phase: 'negative' })))
      .rejects.toBeInstanceOf(ExactCanaryNegativePhaseError)
    expect(await snapshot(db)).toBe(before)
  })

  test('ECAN-004-two-candidates: only exact tuple is imported, claimed, completed, and V1-closed', async () => {
    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    await seedV1(db, { queueId: 1002, messageId: OTHER_MESSAGE })
    await crash(db)
    const result = await resume(db)
    expect(result).toMatchObject({ runtime_calls: 1, provider_effects: 0, v1_typed_close: 1 })

    const rows = await db.query<{ id: number; status: string }>(
      `SELECT id, status FROM message_queue ORDER BY id`,
    )
    expect(rows).toEqual([{ id: 1001, status: 'skipped' }, { id: 1002, status: 'pending' }])
    expect(await eventCount(db, turnIdFor('aun', TARGET_MESSAGE), 'turn.completed')).toBe(1)
    expect(await eventCount(db, turnIdFor('aun', OTHER_MESSAGE), 'message.received')).toBe(0)
  })

  test('ECAN-005-one-turn: nonliteral max_turns rejects and a second turn cannot be claimed', async () => {
    const argv = validArgv()
    argv[argv.indexOf('--max-turns') + 1] = '2'
    expect(() => parseExactCanaryArgs(argv)).toThrow(ExactCanaryArgumentError)

    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const beforeForgedRun = await snapshot(db)
    await expect(runExactCanary(db, { ...args({ phase: 'negative' }), maxTurns: 2 as 1 }))
      .rejects.toBeInstanceOf(ExactCanaryArgumentError)
    expect(await snapshot(db)).toBe(beforeForgedRun)

    await seedV1(db, { queueId: 1002, messageId: OTHER_MESSAGE })
    const target = await importExactPendingV1Row(db, tupleFor(args()))
    await importExactPendingV1Row(db, tupleFor(args({ queueId: 1002, messageId: OTHER_MESSAGE })))
    expect(await claimExactTurn(db, {
      ...tupleFor(args({ queueId: 9999 })),
      turnId: target.turnId,
      seatInstanceId: 'wrong-queue',
    })).toBeNull()
    const runtime: TurnRuntime = { async runTurn() { return { outcome: 'no_reply', replies: [] } } }
    await runExactTurnWorkerOnce(db, {
      ...tupleFor(args()), turnId: target.turnId, seatInstanceId: 'ecan-one', runtime,
    })
    expect(await eventCount(db, target.turnId, 'turn.completed')).toBe(1)
    expect(await eventCount(db, turnIdFor('aun', OTHER_MESSAGE), 'turn.claimed')).toBe(0)
  })

  test('ECAN-006-provider-disabled: non-disabled provider rejects and dispatcher remains unreachable', async () => {
    const argv = validArgv()
    argv[argv.indexOf('--provider-dispatch') + 1] = 'enabled'
    expect(() => parseExactCanaryArgs(argv)).toThrow(ExactCanaryArgumentError)

    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const beforeForgedRun = await snapshot(db)
    await expect(runExactCanary(db, {
      ...args({ phase: 'negative' }), providerDispatch: 'enabled' as 'disabled',
    })).rejects.toBeInstanceOf(ExactCanaryArgumentError)
    expect(await snapshot(db)).toBe(beforeForgedRun)
    await crash(db)
    const result = await resume(db)
    expect(result).toMatchObject({ reply_enqueued: 0, external_send_attempts: 0, provider_effects: 0 })
    const replyEvents = await db.query(`SELECT event_id FROM event_log WHERE event_type LIKE 'reply.%'`)
    expect(replyEvents).toEqual([])
  })

  test('ECAN-007-fake-only: non-fake runtime rejects and only one injected no-reply runtime runs', async () => {
    const argv = validArgv()
    argv[argv.indexOf('--runtime') + 1] = 'codex'
    expect(() => parseExactCanaryArgs(argv)).toThrow(ExactCanaryArgumentError)

    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const beforeForgedRun = await snapshot(db)
    await expect(runExactCanary(db, {
      ...args({ phase: 'negative' }), runtime: 'codex' as 'deterministic-no-reply',
    })).rejects.toBeInstanceOf(ExactCanaryArgumentError)
    expect(await snapshot(db)).toBe(beforeForgedRun)
    const target = await importExactPendingV1Row(db, tupleFor(args()))
    let calls = 0
    const fake: TurnRuntime = {
      async runTurn() {
        calls += 1
        return { outcome: 'no_reply', replies: [] }
      },
    }
    await runExactTurnWorkerOnce(db, {
      ...tupleFor(args()), turnId: target.turnId, seatInstanceId: 'ecan-fake', runtime: fake,
    })
    expect(calls).toBe(1)
    expect(await eventCount(db, target.turnId, 'reply.enqueued')).toBe(0)
  })

  test('ECAN-008-planned-crash: crash is after durable exact claim and before every later effect', async () => {
    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const planned = await crash(db)
    expect(planned.result.exitCode).toBe(86)
    const turnId = turnIdFor('aun', TARGET_MESSAGE)
    expect(await eventCount(db, turnId, 'message.received')).toBe(1)
    expect(await eventCount(db, turnId, 'turn.claimed')).toBe(1)
    expect(await eventCount(db, turnId, 'turn.presented')).toBe(0)
    expect(await eventCount(db, turnId, 'turn.completed')).toBe(0)
    expect(await eventCount(db, turnId, 'reply.enqueued')).toBe(0)
    expect((await db.queryOne<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = 1001`,
    ))?.status).toBe('pending')
  })

  test('ECAN-009-exact-resume: same tuple recovers and completes target once without duplicates', async () => {
    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    const planned = await crash(db)
    await expect(recoverExactTurnClaim(db, {
      ...tupleFor(args({ queueId: 9999 })),
      turnId: planned.result.turnId,
      activeInstanceId: 'wrong-recovery',
    })).rejects.toBeInstanceOf(StaleClaimError)
    expect(await eventCount(db, planned.result.turnId, 'turn.claim_released')).toBe(0)
    const result = await resume(db)
    expect(result.recovered_claim_event_id).toBe(planned.result.claimEventId)
    const turnId = turnIdFor('aun', TARGET_MESSAGE)
    expect(await eventCount(db, turnId, 'turn.claimed')).toBe(2)
    expect(await eventCount(db, turnId, 'turn.claim_released')).toBe(1)
    expect(await eventCount(db, turnId, 'turn.completed')).toBe(1)
    expect((await db.queryOne<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = 1001`,
    ))?.status).toBe('skipped')
  })

  test('ECAN-010-concurrent-wrong-worker: same-target foreign claim is never recovered, completed, or closed', async () => {
    await seedV1(db, { queueId: 1001, messageId: TARGET_MESSAGE })
    await importExactPendingV1Row(db, tupleFor(args()))
    const targetTurn = turnIdFor('aun', TARGET_MESSAGE)
    const foreignClaim = await claimNextTurn(db, {
      seatId: 'aun',
      seatInstanceId: 'foreign-production-worker',
    })
    expect(foreignClaim?.turn.turn_id).toBe(targetTurn)
    const before = await snapshot(db)

    await expect(resume(db)).rejects.toBeInstanceOf(StaleClaimError)
    expect(await snapshot(db)).toBe(before)
    expect(await eventCount(db, targetTurn, 'turn.claimed')).toBe(1)
    expect(await eventCount(db, targetTurn, 'turn.claim_released')).toBe(0)
    expect(await eventCount(db, targetTurn, 'turn.presented')).toBe(0)
    expect(await eventCount(db, targetTurn, 'turn.completed')).toBe(0)
    expect(await eventCount(db, targetTurn, 'reply.enqueued')).toBe(0)
    expect(await eventCount(db, targetTurn, 'reply.provider_invocation_started')).toBe(0)
    expect((await db.queryOne<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = 1001`,
    ))?.status).toBe('pending')
  })

  test('ECAN-011-invalid-args: missing, duplicate, malformed, unknown args reject before DB open', () => {
    const variants = [
      validArgv().slice(0, -2),
      [...validArgv(), '--seat', 'aun'],
      validArgv().map(value => value === TARGET_MESSAGE ? 'not-a-uuid' : value),
      [...validArgv(), '--unknown', 'x'],
    ]
    for (const variant of variants) expect(() => parseExactCanaryArgs(variant)).toThrow(ExactCanaryArgumentError)
    expect(exactCanaryHelp()).toContain('--provider-dispatch disabled')
    expect(exactCanaryHelp()).toContain('--max-turns 1')

    const help = spawnSync(process.execPath, [CLI_PATH, '--help'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: '' },
      encoding: 'utf8',
    })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('One-shot exact-target mechanism')
  })

  test('ECAN-012-postgres-rollback: PostgreSQL fixture rolls back and leaves no live residue', async () => {
    const url = postgresTestUrl()
    if (!url) throw new Error('ECAN-012 requires an isolated migrated PostgreSQL test DB')
    const pg = new PgAdapter(url)
    const messageId = randomUUID()
    let queueId = 0
    let rolledBack = false
    class RollbackFixture extends Error {}
    try {
      await pg.transaction(async tx => {
        const bound = transactionBound(tx)
        await bound.execute(
          `INSERT INTO agent_messages (id, channel_id, thread_id, author_id, content)
           VALUES ($1, 'chan-canary', $2, 'arc', 'postgres exact canary fixture')`,
          [messageId, `thread-${messageId}`],
        )
        const inserted = await bound.queryOne<{ id: number | string; created_at: Date | string }>(
          `INSERT INTO message_queue (agent_id, message_id, payload, status)
           VALUES ('aun', $1, '{}', 'pending') RETURNING id, created_at`,
          [messageId],
        )
        if (!inserted) throw new Error('PostgreSQL fixture insert returned no row')
        queueId = Number(inserted.id)
        const createdAt = inserted.created_at instanceof Date
          ? inserted.created_at
          : new Date(inserted.created_at)
        const pgArgs = args({
          queueId,
          messageId,
          createdAfter: new Date(createdAt.getTime() - 1000).toISOString(),
        })
        await crash(bound, { ...pgArgs, phase: 'crash-after-claim' })
        const result = await resume(bound, pgArgs)
        expect(result).toMatchObject({ provider_effects: 0, external_send_attempts: 0 })
        expect((await bound.queryOne<{ status: string }>(
          `SELECT status FROM message_queue WHERE id = $1`, [queueId],
        ))?.status).toBe('skipped')
        throw new RollbackFixture()
      })
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error
      rolledBack = true
    }
    expect(rolledBack).toBe(true)
    expect(await pg.queryOne(`SELECT id FROM message_queue WHERE id = $1`, [queueId])).toBeNull()
    expect(await pg.queryOne(`SELECT event_id FROM event_log WHERE turn_id = $1`, [turnIdFor('aun', messageId)])).toBeNull()
    await pg.close()
  })
})

function postgresTestUrl(): string | undefined {
  if (process.env.AGENT_COM_TEST_DATABASE_URL) return process.env.AGENT_COM_TEST_DATABASE_URL
  const url = process.env.DATABASE_URL
  if (!url) return undefined
  const dbName = url.split('?')[0]!.split('/').pop() ?? ''
  return dbName.endsWith('_test') ? url : undefined
}

function validArgv(): string[] {
  return [
    '--seat', 'aun',
    '--queue-id', '1001',
    '--message-id', TARGET_MESSAGE,
    '--created-after', FENCE,
    '--phase', 'resume',
    '--runtime', 'deterministic-no-reply',
    '--provider-dispatch', 'disabled',
    '--max-turns', '1',
  ]
}

function transactionBound(tx: DbAdapter): DbAdapter {
  let bound: DbAdapter
  bound = {
    dialect: tx.dialect,
    query: (sql, params) => tx.query(sql, params),
    queryOne: (sql, params) => tx.queryOne(sql, params),
    execute: (sql, params) => tx.execute(sql, params),
    transaction: fn => fn(bound),
    close: async () => {},
  }
  return bound
}
