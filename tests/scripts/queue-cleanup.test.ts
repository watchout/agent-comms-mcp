#!/usr/bin/env bun
/**
 * PR-Q1 — bulk queue cleanup script tests.
 *
 * Behavioral pins (5-section §4 merge gate):
 *   1. dry-run does not mutate any row
 *   2. execute changes target rows to status='skipped'
 *   3. rows newer than 12h are not touched
 *   4. rows with claimed_by != NULL are not touched
 *   5. re-running execute is idempotent (0 additional rows)
 *   6. failed_reason starts with "BULK_CLEANUP"
 *
 * Skipped automatically when no DATABASE_URL is reachable so CI without
 * Postgres does not red-line.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Client } from 'pg'
import { join } from 'node:path'
import { runQueueCleanup, _internal } from '../../scripts/queue-cleanup'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const TEST_AGENT_PREFIX = '__test_qcleanup_'

let client: Client | null = null
let available = false

async function probe(): Promise<boolean> {
  try {
    const c = new Client({ connectionString: DATABASE_URL })
    await c.connect()
    await c.query('SELECT 1 FROM message_queue LIMIT 1')
    await c.end()
    return true
  } catch {
    return false
  }
}

async function clearTestRows() {
  if (!client) return
  await client.query(
    `DELETE FROM message_queue WHERE agent_id LIKE $1`,
    [`${TEST_AGENT_PREFIX}%`],
  )
}

interface SeedRow {
  agent_id: string
  status?: string
  ageHours?: number
  claimedBy?: string | null
  failedReason?: string | null
}

async function seedRow(r: SeedRow): Promise<number> {
  const status = r.status ?? 'pending'
  const ageHours = r.ageHours ?? 24
  const claimedBy = r.claimedBy ?? null
  const failedReason = r.failedReason ?? null
  const res = await client!.query(
    `INSERT INTO message_queue
       (agent_id, payload, status, created_at, claimed_by, failed_reason)
     VALUES ($1, $2, $3, NOW() - ($4::text)::interval, $5, $6)
     RETURNING id`,
    [r.agent_id, '{}', status, `${ageHours} hours`, claimedBy, failedReason],
  )
  return Number(res.rows[0].id)
}

async function statusOf(id: number): Promise<{ status: string; failed_reason: string | null }> {
  const r = await client!.query(
    `SELECT status, failed_reason FROM message_queue WHERE id = $1`,
    [id],
  )
  return r.rows[0]
}

beforeAll(async () => {
  available = await probe()
  if (!available) return
  client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
})

afterAll(async () => {
  if (client) {
    await clearTestRows().catch(() => {})
    await client.end().catch(() => {})
  }
})

beforeEach(async () => {
  if (available) await clearTestRows()
})

describe('PR-Q1 queue-cleanup script', () => {
  test('case 1: dry-run does not mutate (BEGIN/ROLLBACK)', async () => {
    if (!available) return
    const id = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c1`, ageHours: 24 })
    const pre = await statusOf(id)

    const matched = await runQueueCleanup('dry-run', DATABASE_URL)

    const post = await statusOf(id)
    expect(pre.status).toBe('pending')
    expect(post.status).toBe('pending')
    expect(post.failed_reason).toBeNull()
    expect(matched).toBeGreaterThanOrEqual(1)
  })

  test('case 2: execute flips target rows to skipped', async () => {
    if (!available) return
    const id = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c2`, ageHours: 24 })

    const matched = await runQueueCleanup('execute', DATABASE_URL)

    const post = await statusOf(id)
    expect(post.status).toBe('skipped')
    expect(matched).toBeGreaterThanOrEqual(1)
  })

  test('case 3: rows newer than 12h are not touched', async () => {
    if (!available) return
    const youngId = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c3y`, ageHours: 1 })
    const oldId = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c3o`, ageHours: 24 })

    await runQueueCleanup('execute', DATABASE_URL)

    const young = await statusOf(youngId)
    const old = await statusOf(oldId)
    expect(young.status).toBe('pending')
    expect(old.status).toBe('skipped')
  })

  test('case 4: claimed_by != NULL rows are not touched', async () => {
    if (!available) return
    const claimedId = await seedRow({
      agent_id: `${TEST_AGENT_PREFIX}c4c`,
      ageHours: 24,
      claimedBy: 'some-bot',
    })
    const unclaimedId = await seedRow({
      agent_id: `${TEST_AGENT_PREFIX}c4u`,
      ageHours: 24,
    })

    await runQueueCleanup('execute', DATABASE_URL)

    const claimed = await statusOf(claimedId)
    const unclaimed = await statusOf(unclaimedId)
    expect(claimed.status).toBe('pending')
    expect(unclaimed.status).toBe('skipped')
  })

  test('case 5: re-running execute is idempotent (0 additional rows)', async () => {
    if (!available) return
    await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c5`, ageHours: 24 })

    const first = await runQueueCleanup('execute', DATABASE_URL)
    expect(first).toBeGreaterThanOrEqual(1)

    const second = await runQueueCleanup('execute', DATABASE_URL)
    expect(second).toBe(0)
  })

  test('case 6: failed_reason carries BULK_CLEANUP prefix', async () => {
    if (!available) return
    const id = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c6`, ageHours: 24 })

    await runQueueCleanup('execute', DATABASE_URL)

    const post = await statusOf(id)
    expect(post.status).toBe('skipped')
    expect(post.failed_reason ?? '').toMatch(/^BULK_CLEANUP:/)
    expect(post.failed_reason ?? '').toBe(_internal.REASON)
  })

  test('parseMode: default is dry-run, --execute switches', () => {
    expect(_internal.parseMode([])).toBe('dry-run')
    expect(_internal.parseMode(['--dry-run'])).toBe('dry-run')
    expect(_internal.parseMode(['--execute'])).toBe('execute')
    expect(_internal.parseMode(['--something', '--execute'])).toBe('execute')
  })
})

describe('PR-Q1 cycle 2 — resolveDatabaseUrl precedence (env > config.json > default)', () => {
  const { resolveDatabaseUrl } = _internal
  const tmpDir = join(import.meta.dir, '.qc-tmp')
  const tmpConfig = join(tmpDir, 'config.json')

  beforeAll(() => {
    require('node:fs').mkdirSync(tmpDir, { recursive: true })
  })

  afterAll(() => {
    try {
      require('node:fs').rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  function writeConfig(url: string | null) {
    const fs = require('node:fs')
    if (url === null) {
      try { fs.unlinkSync(tmpConfig) } catch {}
      return
    }
    fs.writeFileSync(tmpConfig, JSON.stringify({ database_url: url }))
  }

  test('case A: env set + config present → env wins', () => {
    writeConfig('postgresql://from-config/db')
    const url = resolveDatabaseUrl(
      { DATABASE_URL: 'postgresql://from-env/db' } as any,
      tmpConfig,
    )
    expect(url).toBe('postgresql://from-env/db')
  })

  test('case B: env unset + config present → config wins', () => {
    writeConfig('postgresql://from-config/db')
    const url = resolveDatabaseUrl({} as any, tmpConfig)
    expect(url).toBe('postgresql://from-config/db')
  })

  test('case C: env empty string + config present → config wins (empty = absent)', () => {
    writeConfig('postgresql://from-config/db')
    const url = resolveDatabaseUrl(
      { DATABASE_URL: '' } as any,
      tmpConfig,
    )
    expect(url).toBe('postgresql://from-config/db')
  })

  test('case D: env set + config absent → env wins', () => {
    writeConfig(null)
    const url = resolveDatabaseUrl(
      { DATABASE_URL: 'postgresql://from-env/db' } as any,
      tmpConfig,
    )
    expect(url).toBe('postgresql://from-env/db')
  })

  test('case E: both absent → built-in default', () => {
    writeConfig(null)
    const url = resolveDatabaseUrl({} as any, tmpConfig)
    expect(url).toBe('postgresql://localhost/agent_comms')
  })
})
