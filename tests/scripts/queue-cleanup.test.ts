#!/usr/bin/env bun
/**
 * PR-Q1 — bulk queue cleanup script tests.
 *
 * Behavioral pins (5-section §4 merge gate):
 *   1. dry-run does not mutate any row
 *   2. execute changes target rows to status='skipped' with a reason
 *   3. rows newer than 12h are not touched
 *   4. rows with claimed_by != NULL are not touched
 *   5. re-running execute is idempotent (0 additional rows)
 *   6. reason taxonomy is emitted to stderr and persisted in failed_reason.
 *
 * PostgreSQL execute cases run only when AGENT_COM_TEST_DATABASE_URL names an
 * isolated test database. Generic DATABASE_URL and the operator default are
 * intentionally ignored so this test file can never clean a live local queue.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Client } from 'pg'
import { join } from 'node:path'
import { runQueueCleanup, _internal } from '../../scripts/queue-cleanup'
import { assertDestructiveMigrationTestDatabase } from '../../db/destructive-migration-gate'

function resolveQueueCleanupTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.AGENT_COM_TEST_DATABASE_URL?.trim()
  return explicit || undefined
}

function requireQueueCleanupTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = resolveQueueCleanupTestDatabaseUrl(env)
  if (!databaseUrl) {
    throw new Error('AGENT_COM_TEST_DATABASE_URL is required for queue-cleanup execute tests')
  }
  assertDestructiveMigrationTestDatabase(databaseUrl, env)
  return databaseUrl
}

const TEST_DATABASE_URL = resolveQueueCleanupTestDatabaseUrl()
const TEST_AGENT_PREFIX = '__test_qcleanup_'

let client: Client | null = null
let available = false

async function probe(): Promise<boolean> {
  try {
    const c = new Client({ connectionString: requireQueueCleanupTestDatabaseUrl() })
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
}

async function seedRow(r: SeedRow): Promise<number> {
  const status = r.status ?? 'pending'
  const ageHours = r.ageHours ?? 24
  const claimedBy = r.claimedBy ?? null
  const res = await client!.query(
    `INSERT INTO message_queue
       (agent_id, payload, status, created_at, claimed_by)
     VALUES ($1, $2, $3, NOW() - ($4::text)::interval, $5)
     RETURNING id`,
    [r.agent_id, '{}', status, `${ageHours} hours`, claimedBy],
  )
  return Number(res.rows[0].id)
}

async function statusOf(id: number): Promise<{ status: string; failed_reason: string | null; done_at: Date | null }> {
  const r = await client!.query(
    `SELECT status, failed_reason, done_at FROM message_queue WHERE id = $1`,
    [id],
  )
  return r.rows[0]
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  available = await probe()
  if (!available) return
  client = new Client({ connectionString: requireQueueCleanupTestDatabaseUrl() })
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

describe('PR-Q1 queue-cleanup test database safety', () => {
  test('generic DATABASE_URL never opts destructive integration cases in', () => {
    expect(resolveQueueCleanupTestDatabaseUrl({
      DATABASE_URL: 'postgresql://localhost/agent_comms',
    })).toBeUndefined()
  })

  test('the production database is rejected even when passed as the test variable', () => {
    const unsafe = 'postgresql://localhost/agent_comms'
    expect(() => requireQueueCleanupTestDatabaseUrl({
      AGENT_COM_TEST_DATABASE_URL: unsafe,
    })).toThrow(/Refusing target database agent_comms/)
  })
})

if (TEST_DATABASE_URL) describe('PR-Q1 queue-cleanup script', () => {
  test('case 1: dry-run does not mutate (BEGIN/ROLLBACK)', async () => {
    if (!available) return
    const id = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c1`, ageHours: 24 })
    const pre = await statusOf(id)

    const matched = await runQueueCleanup('dry-run', requireQueueCleanupTestDatabaseUrl())

    const post = await statusOf(id)
    expect(pre.status).toBe('pending')
    expect(post.status).toBe('pending')
    expect(matched).toBeGreaterThanOrEqual(1)
  })

  test('case 2: execute flips target rows to skipped with reason/timestamp', async () => {
    if (!available) return
    const id = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c2`, ageHours: 24 })

    const matched = await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl())

    const post = await statusOf(id)
    expect(post.status).toBe('skipped')
    expect(post.failed_reason).toBe(_internal.DEFAULT_REASON)
    expect(post.done_at).not.toBeNull()
    expect(matched).toBeGreaterThanOrEqual(1)
  })

  test('case 3: rows newer than 12h are not touched', async () => {
    if (!available) return
    const youngId = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c3y`, ageHours: 1 })
    const oldId = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c3o`, ageHours: 24 })

    await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl())

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

    await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl())

    const claimed = await statusOf(claimedId)
    const unclaimed = await statusOf(unclaimedId)
    expect(claimed.status).toBe('pending')
    expect(unclaimed.status).toBe('skipped')
  })

  test('case 5: re-running execute is idempotent (0 additional rows)', async () => {
    if (!available) return
    await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c5`, ageHours: 24 })

    const first = await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl())
    expect(first).toBeGreaterThanOrEqual(1)

    const second = await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl())
    expect(second).toBe(0)
  })

  test('case 6: reason taxonomy starts with BULK_CLEANUP prefix (stderr-only + literal emit pinned)', async () => {
    if (!available) return
    const id = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c6`, ageHours: 24 })

    // v0.9 (sub-PR 1 #347 + sub-PR 8 #338, cycle 2 axis 3): pin the
    // actual stderr emit, not just the _internal export, so the
    // taxonomy is verified end-to-end (script → stderr).
    const captured: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: any) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
    try {
      await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl())
    } finally {
      process.stderr.write = orig
    }

    const post = await statusOf(id)
    expect(post.status).toBe('skipped')
    expect(post.failed_reason).toBe(_internal.DEFAULT_REASON)
    expect(_internal.REASON).toMatch(/^BULK_CLEANUP:/)
    expect(_internal.REASON).toBe(_internal.DEFAULT_REASON)
    const stderrText = captured.join('')
    expect(stderrText).toContain(_internal.DEFAULT_REASON)
    expect(stderrText).toMatch(/taxonomy=BULK_CLEANUP:/)
  })

  test('parseMode: default is dry-run, --execute switches', () => {
    expect(_internal.parseMode([])).toBe('dry-run')
    expect(_internal.parseMode(['--dry-run'])).toBe('dry-run')
    expect(_internal.parseMode(['--execute'])).toBe('execute')
    expect(_internal.parseMode(['--something', '--execute'])).toBe('execute')
  })

  test('case 7: --max-age 30d skips 24h-old rows but catches 31d-old rows', async () => {
    if (!available) return
    const recentId = await seedRow({
      agent_id: `${TEST_AGENT_PREFIX}c7r`,
      ageHours: 24,
    })
    const staleId = await seedRow({
      agent_id: `${TEST_AGENT_PREFIX}c7s`,
      ageHours: 31 * 24,
    })

    // cycle 2 axis 3: pin the actual stderr emit for the 30d taxonomy.
    const captured: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: any) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
    try {
      await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl(), { maxAge: '30d' })
    } finally {
      process.stderr.write = orig
    }

    const recent = await statusOf(recentId)
    const stale = await statusOf(staleId)
    expect(recent.status).toBe('pending')
    expect(stale.status).toBe('skipped')
    expect(stale.failed_reason).toBe(_internal.reasonFor('30d'))
    expect(_internal.reasonFor('30d')).toMatch(/^STALE_BULK_DRAIN_2026-05-04:/)
    const stderrText = captured.join('')
    expect(stderrText).toMatch(/STALE_BULK_DRAIN_2026-05-04: max-age=30d/)
    expect(stderrText).toMatch(/will mark skipped/)
  })

  test('case 8: --max-age 30d execute → idempotent rerun (no-op)', async () => {
    if (!available) return
    await seedRow({
      agent_id: `${TEST_AGENT_PREFIX}c8`,
      ageHours: 31 * 24,
    })

    const first = await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl(), { maxAge: '30d' })
    expect(first).toBeGreaterThanOrEqual(1)
    const second = await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl(), { maxAge: '30d' })
    expect(second).toBe(0)
  })

  test('case 9: default behavior unchanged when maxAge omitted (12h floor, BULK_CLEANUP reason)', async () => {
    if (!available) return
    const id = await seedRow({ agent_id: `${TEST_AGENT_PREFIX}c9`, ageHours: 24 })

    await runQueueCleanup('execute', requireQueueCleanupTestDatabaseUrl())

    const post = await statusOf(id)
    expect(post.status).toBe('skipped')
    expect(post.failed_reason).toBe(_internal.DEFAULT_REASON)
    expect(_internal.DEFAULT_REASON).toMatch(/^BULK_CLEANUP:/)
  })
})

describe('PR-Q1 cycle 3 — --max-age flag parsing & floor', () => {
  const { parseMaxAge, parseDurationToHours, validateMaxAge, ageIntervalSql, reasonFor } =
    _internal

  test('parseMaxAge: default = 12h when flag absent', () => {
    expect(parseMaxAge([])).toBe('12h')
    expect(parseMaxAge(['--execute'])).toBe('12h')
  })

  test('parseMaxAge: extracts value when flag present', () => {
    expect(parseMaxAge(['--max-age', '30d'])).toBe('30d')
    expect(parseMaxAge(['--execute', '--max-age', '7d'])).toBe('7d')
  })

  test('parseMaxAge: missing value throws', () => {
    expect(() => parseMaxAge(['--max-age'])).toThrow(/requires a value/)
  })

  test('parseDurationToHours: <n>h and <n>d forms', () => {
    expect(parseDurationToHours('12h')).toBe(12)
    expect(parseDurationToHours('30d')).toBe(720)
    expect(parseDurationToHours('1d')).toBe(24)
  })

  test('parseDurationToHours: malformed → NaN', () => {
    expect(parseDurationToHours('30')).toBeNaN()
    expect(parseDurationToHours('1w')).toBeNaN()
    expect(parseDurationToHours('abc')).toBeNaN()
    expect(parseDurationToHours('0h')).toBeNaN()
    expect(parseDurationToHours('-5h')).toBeNaN()
  })

  test('validateMaxAge: accepts 12h floor exactly', () => {
    expect(validateMaxAge('12h').hours).toBe(12)
  })

  test('validateMaxAge: accepts 30d', () => {
    expect(validateMaxAge('30d').hours).toBe(720)
  })

  test('validateMaxAge: rejects < 12h', () => {
    expect(() => validateMaxAge('1h')).toThrow(/safety floor/)
    expect(() => validateMaxAge('11h')).toThrow(/safety floor/)
  })

  test('validateMaxAge: rejects malformed', () => {
    expect(() => validateMaxAge('1w')).toThrow(/Invalid --max-age/)
    expect(() => validateMaxAge('forever')).toThrow(/Invalid --max-age/)
  })

  test('ageIntervalSql: yields the right INTERVAL literal', () => {
    expect(ageIntervalSql('12h')).toBe(`INTERVAL '12 hours'`)
    expect(ageIntervalSql('30d')).toBe(`INTERVAL '30 days'`)
  })

  test('reasonFor: 12h default keeps BULK_CLEANUP marker', () => {
    expect(reasonFor('12h')).toBe(_internal.DEFAULT_REASON)
  })

  test('reasonFor: longer windows get STALE_BULK_DRAIN_2026-05-04 prefix', () => {
    expect(reasonFor('30d')).toMatch(/^STALE_BULK_DRAIN_2026-05-04:/)
    expect(reasonFor('30d')).toContain('max-age=30d')
  })

  test('runQueueCleanup: rejects --max-age < 12h before connecting', async () => {
    // Should reject from validateMaxAge before any DB call (uses bogus URL on purpose).
    await expect(
      runQueueCleanup('dry-run', 'postgresql://nowhere:1/none', { maxAge: '1h' }),
    ).rejects.toThrow(/safety floor/)
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
