import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Client } from 'pg'
import { applyDownMigration, applyUpMigrationFile } from '../../db/migrate'
import { assertDestructiveMigrationTestDatabase } from '../../db/destructive-migration-gate'
import { join, dirname } from 'node:path'

// PR #338 sub-PR 1 — M1-M7 contract tests for the destructive status enum
// migration (spec §4.1 + §4.3 canonical, dispatched per lead-ama
// msg b5584024). The migration under test is the paired SQL pair
// db/migrations/2026-05-13-status-enum-v0.9-destructive.{up,down}.sql.
//
// M1 read → received                          (rename verify)
// M2 failed IMPLICIT_ABANDON recent → pending (3-way branch a)
// M3 failed other → replied + message_queue_status_migration_audit       (3-way branch c, PERMANENT)
// M4 skipped → drop (audit + replied)         (skipped sink per §1.1b)
// M5 snapshot before/after                    (full row count + status histogram)
// M6 Phase 1/2/3 verify                       (constraint swap + done_at + failed_reason drop)
// M7 rollback dry-run                         (down.sql restores v0.8 vocab)
// M8 failed STALE_DISPATCH 3-way verify       (3-way branch b — auditor cycle 2 Finding 1)

const DATABASE_URL = process.env.AGENT_COM_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const UP = join(REPO_ROOT, 'db/migrations/2026-05-13-status-enum-v0.9-destructive.up.sql')
const DOWN = join(REPO_ROOT, 'db/migrations/2026-05-13-status-enum-v0.9-destructive.down.sql')

const DESTRUCTIVE_GATE_ENV = 'AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED'
const STATE_DAEMON_CONTRACT_LOCK = 'agent-comms-state-daemon-contract-tests'

dbDescribe('PR #338 sub-PR 1 — status enum destructive migration (M1-M7)', () => {
  let client: Client
  let priorDestructiveGate: string | undefined

  beforeAll(async () => {
    priorDestructiveGate = process.env[DESTRUCTIVE_GATE_ENV]
    process.env[DESTRUCTIVE_GATE_ENV] = '1'
    assertDestructiveMigrationTestDatabase(DATABASE_URL)
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    // This file temporarily swaps message_queue_status_check back to the
    // legacy 5-value vocabulary. Serialize with state-daemon contract tests,
    // which write v0.9 statuses such as `received` against the same CI DB.
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [STATE_DAEMON_CONTRACT_LOCK])
  })

  afterAll(async () => {
    // Best-effort restore so a partial failure does not leave the
    // shared test DB in the legacy down-migration vocabulary. Other
    // concurrent test files, especially state-daemon contracts, write
    // v0.9 statuses such as `received`; releasing the advisory lock
    // while the DB is still v0.8 causes constraint failures.
    try {
      await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })
    } catch {}
    // Re-assert the forward-compatible v0.9 union in case the paired
    // migration failed mid-way. This mirrors the production-safe union
    // used during rollout and keeps shared CI fixtures writable by both
    // legacy and new-status tests.
    await client.query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ`)
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'message_queue_status_check'
             AND conrelid = 'message_queue'::regclass
        ) THEN
          ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;
        END IF;
        ALTER TABLE message_queue
          ADD CONSTRAINT message_queue_status_check
          CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'));
      END $$;
    `)
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [STATE_DAEMON_CONTRACT_LOCK])
    } catch {}
    await client.end()
    if (priorDestructiveGate === undefined) {
      delete process.env[DESTRUCTIVE_GATE_ENV]
    } else {
      process.env[DESTRUCTIVE_GATE_ENV] = priorDestructiveGate
    }
  })

  // Each test starts from a clean slate of the message_queue rows we
  // own. We do NOT TRUNCATE message_queue because other suites may have
  // open rows; instead we tag our fixture rows with a sentinel agent_id
  // and clean those out between tests.
  const FIXTURE_AGENT = '__pr338_subpr1_fixture__'

  beforeEach(async () => {
    // Ensure we are in the legacy (pre-up) vocabulary at start of each
    // test. Some tests apply up.sql; this resets between them.
    try {
      await applyDownMigration(DOWN, { databaseUrl: DATABASE_URL })
    } catch {}
    await client.query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT`)
    await client.query(`ALTER TABLE message_queue DROP COLUMN IF EXISTS done_at`)
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'message_queue_status_check'
             AND conrelid = 'message_queue'::regclass
        ) THEN
          ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;
        END IF;
        ALTER TABLE message_queue
          ADD CONSTRAINT message_queue_status_check
          CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed'));
      END $$;
    `)
    await client.query(`DELETE FROM message_queue_status_migration_audit WHERE 1=1`).catch(() => {})
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [FIXTURE_AGENT])
    // M8 inserts into agent_messages: one inbound (some upstream sender) +
    // one outbound (our fixture bot's reply). Outbound has a reply_to FK
    // pointing at inbound, so we drop everything on the fixture channel
    // in one statement to avoid the FK ordering snag.
    await client.query(
      `DELETE FROM agent_messages WHERE channel_id = $1`,
      ['__pr338_subpr1_m8_channel__'],
    ).catch(() => {})
  })

  async function insertRow(opts: {
    status: string
    failed_reason?: string | null
    claim_expires_offset_sec?: number | null
    message_id?: string
  }): Promise<number> {
    const claimExpr =
      opts.claim_expires_offset_sec == null
        ? 'NULL'
        : `now() + interval '${opts.claim_expires_offset_sec} seconds'`
    const r = await client.query<{ id: number }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, failed_reason, claim_expires_at)
       VALUES ($1, $2, $3, $4, $5, ${claimExpr})
       RETURNING id`,
      [
        FIXTURE_AGENT,
        opts.message_id ?? `msg-${Math.random().toString(36).slice(2)}`,
        '{}',
        opts.status,
        opts.failed_reason ?? null,
      ],
    )
    return r.rows[0]!.id
  }

  async function statusOf(id: number): Promise<string | null> {
    const r = await client.query<{ status: string }>(
      `SELECT status FROM message_queue WHERE id = $1`,
      [id],
    )
    return r.rows[0]?.status ?? null
  }

  async function countByStatus(status: string): Promise<number> {
    const r = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_queue WHERE agent_id = $1 AND status = $2`,
      [FIXTURE_AGENT, status],
    )
    return Number.parseInt(r.rows[0]?.count ?? '0', 10)
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    const r = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    )
    return (r.rows[0]?.count ?? 0) > 0
  }

  async function checkConstraintAllows(value: string): Promise<boolean> {
    const r = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'message_queue_status_check'
          AND conrelid = 'message_queue'::regclass`,
    )
    return (r.rows[0]?.def ?? '').includes(`'${value}'`)
  }

  test('M1 read → received: all read rows renamed, count match', async () => {
    const ids = await Promise.all([
      insertRow({ status: 'read' }),
      insertRow({ status: 'read' }),
      insertRow({ status: 'read' }),
    ])
    expect(await countByStatus('read')).toBe(3)

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    expect(await countByStatus('received')).toBe(3)
    for (const id of ids) {
      expect(await statusOf(id)).toBe('received')
    }
  })

  test('M2 failed + IMPLICIT_ABANDON recent → pending', async () => {
    const id = await insertRow({
      status: 'failed',
      failed_reason: 'IMPLICIT_ABANDON',
      claim_expires_offset_sec: -30, // within 60s window per spec
    })

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    expect(await statusOf(id)).toBe('pending')
    // failed_reason column has been dropped, so we cannot grep it; the
    // status transition is sufficient evidence.
    const r = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_queue_status_migration_audit WHERE queue_id = $1`,
      [id],
    )
    // recoverable IMPLICIT_ABANDON does NOT write to message_queue_status_migration_audit (row stays alive).
    expect(Number.parseInt(r.rows[0]!.count, 10)).toBe(0)
  })

  test('M3 failed + other → replied + message_queue_status_migration_audit', async () => {
    const idPermanent = await insertRow({
      status: 'failed',
      failed_reason: 'SEND_FAILED_AFTER_N_RETRIES',
      claim_expires_offset_sec: null,
    })
    const idAbandonStale = await insertRow({
      status: 'failed',
      failed_reason: 'IMPLICIT_ABANDON',
      claim_expires_offset_sec: -120, // outside 60s window → PERMANENT-like
    })

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    expect(await statusOf(idPermanent)).toBe('replied')
    expect(await statusOf(idAbandonStale)).toBe('replied')

    const r = await client.query<{ queue_id: number; original_reason: string | null }>(
      `SELECT queue_id, original_reason FROM message_queue_status_migration_audit
        WHERE queue_id = ANY($1::bigint[]) ORDER BY queue_id`,
      [[idPermanent, idAbandonStale]],
    )
    expect(r.rows.length).toBe(2)
    expect(new Set(r.rows.map(x => x.original_reason))).toEqual(
      new Set(['SEND_FAILED_AFTER_N_RETRIES', 'IMPLICIT_ABANDON']),
    )
  })

  test('M4 skipped → drop (message_queue_status_migration_audit captured, status=replied, count of skipped=0)', async () => {
    const idA = await insertRow({ status: 'skipped', failed_reason: 'OBSOLETE' })
    const idB = await insertRow({ status: 'skipped', failed_reason: null })

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    expect(await countByStatus('skipped')).toBe(0)
    expect(await statusOf(idA)).toBe('replied')
    expect(await statusOf(idB)).toBe('replied')

    const r = await client.query<{ queue_id: number; original_status: string }>(
      `SELECT queue_id, original_status FROM message_queue_status_migration_audit
        WHERE queue_id = ANY($1::bigint[])`,
      [[idA, idB]],
    )
    expect(r.rows.length).toBe(2)
    expect(r.rows.every(x => x.original_status === 'skipped')).toBe(true)
  })

  test('M5 snapshot before/after: total fixture row count preserved', async () => {
    const ids = await Promise.all([
      insertRow({ status: 'pending' }),
      insertRow({ status: 'read' }),
      insertRow({ status: 'replied' }),
      insertRow({ status: 'failed', failed_reason: 'IMPLICIT_ABANDON', claim_expires_offset_sec: -10 }),
      insertRow({ status: 'failed', failed_reason: 'LOOP_DETECTED' }),
      insertRow({ status: 'skipped' }),
    ])

    const before = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_queue WHERE agent_id = $1`,
      [FIXTURE_AGENT],
    )
    expect(Number.parseInt(before.rows[0]!.count, 10)).toBe(ids.length)

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    const after = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_queue WHERE agent_id = $1`,
      [FIXTURE_AGENT],
    )
    expect(Number.parseInt(after.rows[0]!.count, 10)).toBe(ids.length)

    // No legacy status values survive.
    const leftover = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_queue
        WHERE agent_id = $1
          AND status NOT IN ('pending','received','in_progress','done','replied')`,
      [FIXTURE_AGENT],
    )
    expect(Number.parseInt(leftover.rows[0]!.count, 10)).toBe(0)
  })

  test('M6 Phase verify: CHECK constraint, done_at column added, failed_reason dropped', async () => {
    // pre-state
    expect(await columnExists('message_queue', 'failed_reason')).toBe(true)
    expect(await columnExists('message_queue', 'done_at')).toBe(false)
    expect(await checkConstraintAllows('failed')).toBe(true)
    expect(await checkConstraintAllows('received')).toBe(false)

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    // post-state
    expect(await columnExists('message_queue', 'failed_reason')).toBe(false)
    expect(await columnExists('message_queue', 'done_at')).toBe(true)
    expect(await checkConstraintAllows('received')).toBe(true)
    expect(await checkConstraintAllows('in_progress')).toBe(true)
    expect(await checkConstraintAllows('done')).toBe(true)
    expect(await checkConstraintAllows('failed')).toBe(false)
    expect(await checkConstraintAllows('read')).toBe(false)
  })

  test('M7 rollback dry-run: down.sql restores v0.8 vocab + failed_reason', async () => {
    const idRead = await insertRow({ status: 'read' })
    const idFailedPerm = await insertRow({ status: 'failed', failed_reason: 'LOOP_DETECTED' })
    const idSkipped = await insertRow({ status: 'skipped', failed_reason: 'OBSOLETE' })

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })
    // post-up state: idRead='received', idFailedPerm='replied', idSkipped='replied'
    expect(await statusOf(idRead)).toBe('received')
    expect(await statusOf(idFailedPerm)).toBe('replied')
    expect(await statusOf(idSkipped)).toBe('replied')

    await applyDownMigration(DOWN, { databaseUrl: DATABASE_URL })

    // down restores schema...
    expect(await columnExists('message_queue', 'failed_reason')).toBe(true)
    expect(await columnExists('message_queue', 'done_at')).toBe(false)
    expect(await checkConstraintAllows('failed')).toBe(true)
    expect(await checkConstraintAllows('read')).toBe(true)
    expect(await checkConstraintAllows('received')).toBe(false)

    // ...and restores data for rows whose original state was preserved
    // in message_queue_status_migration_audit. PERMANENT failures and skipped rows come back to
    // their legacy vocabulary; the read→received case is one-way (the
    // legacy 'read' literal is the closest match for v0.9 'received').
    expect(await statusOf(idFailedPerm)).toBe('failed')
    expect(await statusOf(idSkipped)).toBe('skipped')

    // failed_reason captured in message_queue_status_migration_audit is re-attached.
    const r = await client.query<{ failed_reason: string | null }>(
      `SELECT failed_reason FROM message_queue WHERE id = $1`,
      [idFailedPerm],
    )
    expect(r.rows[0]?.failed_reason).toBe('LOOP_DETECTED')
  })

  // M8 — STALE_DISPATCH 3-way verification (auditor cycle 2 Finding 1).
  //
  // spec §1.1a [v0.9-impl.md:105] STALE_DISPATCH branch:
  //   if verify_bot_replied(row) → replied (no audit)
  //   else                       → pending (no audit)
  //
  // verify_bot_replied SQL translation in up.sql:
  //   queue.replied_with IS NOT NULL
  //   OR EXISTS (outbound agent_messages with reply_to::text = queue.message_id
  //              AND author_id = queue.agent_id)
  //
  // M8a covers the (b1) replied path via an outbound agent_messages witness.
  // M8b covers the (b2) pending path with no witness.
  test('M8a STALE_DISPATCH + outbound agent_messages witness → replied', async () => {
    // agent_messages.reply_to has a self-FK to agent_messages.id, so the
    // outbound witness needs a real inbound row to reference. Pattern:
    //   inbound row (some upstream message) <—reply_to— outbound row (bot reply)
    // and the queue's message_id mirrors the inbound row's id (this is the
    // queue ↔ agent_messages link the production send-path uses).
    const inbound = await client.query<{ id: string }>(
      `INSERT INTO agent_messages
         (channel_id, author_id, author_bot, content, direction, role)
       VALUES ($1, $2, false, $3, 'inbound', 'user')
       RETURNING id::text AS id`,
      ['__pr338_subpr1_m8_channel__', 'fixture-sender', 'M8a inbound original'],
    )
    const messageId = inbound.rows[0]!.id

    const idReplied = await insertRow({
      status: 'failed',
      failed_reason: 'STALE_DISPATCH',
      message_id: messageId,
    })

    // Outbound witness: the bot already replied to the inbound message.
    await client.query(
      `INSERT INTO agent_messages
         (channel_id, author_id, author_bot, content, direction, role, reply_to)
       VALUES ($1, $2, true, $3, 'outbound', 'agent', $4::uuid)`,
      [
        '__pr338_subpr1_m8_channel__',
        FIXTURE_AGENT,
        'M8a witness reply',
        messageId,
      ],
    )

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    expect(await statusOf(idReplied)).toBe('replied')
    // STALE_DISPATCH (b1) does NOT write to message_queue_status_migration_audit.
    const auditCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_queue_status_migration_audit WHERE queue_id = $1`,
      [idReplied],
    )
    expect(Number.parseInt(auditCount.rows[0]!.count, 10)).toBe(0)
  })

  test('M8b STALE_DISPATCH + no witness → pending', async () => {
    const idPending = await insertRow({
      status: 'failed',
      failed_reason: 'STALE_DISPATCH',
      // Default random message_id (not a UUID) — even if cast were attempted,
      // no agent_messages row has reply_to pointing here, so EXISTS is false.
    })

    await applyUpMigrationFile(UP, { databaseUrl: DATABASE_URL })

    expect(await statusOf(idPending)).toBe('pending')
    // STALE_DISPATCH (b2) does NOT write to message_queue_status_migration_audit either.
    const auditCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_queue_status_migration_audit WHERE queue_id = $1`,
      [idPending],
    )
    expect(Number.parseInt(auditCount.rows[0]!.count, 10)).toBe(0)
  })
})
