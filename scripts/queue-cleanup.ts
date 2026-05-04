#!/usr/bin/env bun
/**
 * Bulk queue cleanup script (PR-Q1, extended 2026-05-04 with --max-age).
 *
 * Marks long-pending, unclaimed message_queue rows as 'skipped' so that
 * obsolete cycle chatter does not block agent inboxes after a major
 * post-merge state change (e.g. PR #288/#309/#310 fleet restart) or when
 * a 30d+ stale backlog accrues (CTO/ARC/hotel-dev 2026-04-01 era rows).
 *
 * Safety contract (5-section §3 forbidden):
 *   - DELETE は使わない (status update only, reversible)
 *   - --max-age 未満 pending は touch しない (active 可能性を保護)
 *   - claimed_by != NULL は touch しない (in-flight 保護)
 *   - status != 'pending' は touch しない (failed/replied/skipped/read)
 *   - --max-age < 12h は CLI が拒否 (12h 床、accident-proof)
 *
 * Usage:
 *   bun scripts/queue-cleanup.ts                   # dry-run (default 12h age)
 *   bun scripts/queue-cleanup.ts --dry-run         # explicit dry-run
 *   bun scripts/queue-cleanup.ts --execute         # actually perform UPDATE (12h)
 *   bun scripts/queue-cleanup.ts --max-age 30d     # dry-run, 30 days backlog
 *   bun scripts/queue-cleanup.ts --max-age 30d --execute   # commit at 30d
 *
 * Exit code: 0 on success, 1 on connection / query failure, 2 on arg failure.
 */
import { Client } from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DEFAULT_REASON =
  'BULK_CLEANUP: pre-Phase 5 obsolete chatter (lead-ama 2026-05-02)'
const STALE_DRAIN_REASON_PREFIX = 'STALE_BULK_DRAIN_2026-05-04'
const DEFAULT_MAX_AGE = '12h'
const MIN_MAX_AGE_HOURS = 12

/**
 * Resolve the Postgres connection string with explicit precedence:
 *   1. process.env.DATABASE_URL (truthy = non-empty string) — wins
 *   2. config.json `database_url` — fallback when env is unset / empty
 *   3. built-in default `postgresql://localhost/agent_comms`
 */
function defaultConfigPath(): string {
  return join(
    dirname(new URL(import.meta.url).pathname),
    '..',
    'config.json',
  )
}

function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = defaultConfigPath(),
): string {
  const fromEnv = env.DATABASE_URL
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv
  }
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (typeof config.database_url === 'string' && config.database_url.length > 0) {
        return config.database_url
      }
    } catch {}
  }
  return 'postgresql://localhost/agent_comms'
}

function parseMode(argv: string[]): 'dry-run' | 'execute' {
  if (argv.includes('--execute')) return 'execute'
  return 'dry-run'
}

/**
 * Parse `--max-age <value>` from argv. Accepts forms like `12h`, `30d`.
 * Returns the raw string (default '12h') for the caller to interpret.
 */
function parseMaxAge(argv: string[]): string {
  const idx = argv.indexOf('--max-age')
  if (idx === -1) return DEFAULT_MAX_AGE
  const v = argv[idx + 1]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error('--max-age requires a value (e.g. --max-age 30d)')
  }
  return v
}

/** Parse `<n>h` or `<n>d` into hours. NaN if malformed. */
function parseDurationToHours(value: string): number {
  const m = /^(\d+)([hd])$/.exec(value)
  if (!m) return NaN
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return NaN
  return m[2] === 'd' ? n * 24 : n
}

/**
 * Validate the parsed --max-age value:
 *   - well-formed (`<n>h` or `<n>d`, n>0)
 *   - >= MIN_MAX_AGE_HOURS (12h floor, accident-proof per §3 forbidden)
 * Throws Error on rejection — CLI surface exits non-zero.
 */
function validateMaxAge(value: string): { hours: number } {
  const hours = parseDurationToHours(value)
  if (!Number.isFinite(hours)) {
    throw new Error(
      `Invalid --max-age '${value}'. Expected form: <n>h or <n>d (e.g. 12h, 30d).`,
    )
  }
  if (hours < MIN_MAX_AGE_HOURS) {
    throw new Error(
      `--max-age '${value}' (${hours}h) is below the ${MIN_MAX_AGE_HOURS}h safety floor. ` +
        `Refusing to touch rows newer than ${MIN_MAX_AGE_HOURS}h.`,
    )
  }
  return { hours }
}

/**
 * Build the Postgres INTERVAL literal for a validated max-age.
 * Value is already validated as `<digits>(h|d)` so injection is impossible.
 */
function ageIntervalSql(maxAge: string): string {
  const m = /^(\d+)([hd])$/.exec(maxAge)
  if (!m) throw new Error(`ageIntervalSql: invalid pre-validated input '${maxAge}'`)
  const unit = m[2] === 'd' ? 'days' : 'hours'
  return `INTERVAL '${m[1]} ${unit}'`
}

/**
 * Pick a `failed_reason` string. The default 12h run keeps the original
 * BULK_CLEANUP marker (backwards compat with PR #311 ops); longer runs
 * get the STALE_BULK_DRAIN_2026-05-04 prefix per §2.5 of the dispatch.
 */
function reasonFor(maxAge: string): string {
  if (maxAge === DEFAULT_MAX_AGE) return DEFAULT_REASON
  return `${STALE_DRAIN_REASON_PREFIX}: max-age=${maxAge}`
}

interface CandidateBreakdown {
  total: number
  perBot: { agent_id: string; count: number }[]
  sample: { agent_id: string; created_at: string; message_id: string | null }[]
}

async function gatherCandidates(
  client: Client,
  ageInterval: string,
): Promise<CandidateBreakdown> {
  const totalQ = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM message_queue
      WHERE status = 'pending'
        AND created_at < NOW() - ${ageInterval}
        AND claimed_by IS NULL`,
  )
  const perBotQ = await client.query(
    `SELECT agent_id, COUNT(*)::int AS count
       FROM message_queue
      WHERE status = 'pending'
        AND created_at < NOW() - ${ageInterval}
        AND claimed_by IS NULL
      GROUP BY agent_id
      ORDER BY count DESC`,
  )
  const sampleQ = await client.query(
    `SELECT agent_id, created_at::text AS created_at, message_id
       FROM message_queue
      WHERE status = 'pending'
        AND created_at < NOW() - ${ageInterval}
        AND claimed_by IS NULL
      ORDER BY created_at ASC
      LIMIT 5`,
  )
  return {
    total: totalQ.rows[0]?.n ?? 0,
    perBot: perBotQ.rows,
    sample: sampleQ.rows,
  }
}

function logBreakdown(
  mode: 'dry-run' | 'execute',
  b: CandidateBreakdown,
  maxAge: string,
) {
  const banner =
    mode === 'dry-run'
      ? `Bulk Queue Cleanup — DRY RUN (max-age=${maxAge}, would update ${b.total} rows)`
      : `Bulk Queue Cleanup — EXECUTE (max-age=${maxAge}, target ${b.total} rows)`
  process.stderr.write(`${banner}\n`)
  process.stderr.write(
    `Per-bot pending breakdown (created_at < NOW() - ${maxAge}, claimed_by IS NULL):\n`,
  )
  for (const r of b.perBot) {
    const verb = mode === 'dry-run' ? 'would skip' : 'will skip'
    process.stderr.write(`  ${r.agent_id}: ${r.count} → ${verb}\n`)
  }
  process.stderr.write(`Sample 5 rows (oldest):\n`)
  for (const s of b.sample) {
    const idSnippet = (s.message_id ?? '<null>').slice(0, 8)
    process.stderr.write(
      `  [${s.agent_id}] [${s.created_at}] [${idSnippet}]\n`,
    )
  }
  process.stderr.write(`Total candidates: ${b.total}\n`)
}

interface RunOptions {
  maxAge?: string
}

async function runDryRun(client: Client, opts: RunOptions = {}): Promise<number> {
  const maxAge = opts.maxAge ?? DEFAULT_MAX_AGE
  const ageInterval = ageIntervalSql(maxAge)
  const reason = reasonFor(maxAge)

  const breakdown = await gatherCandidates(client, ageInterval)
  process.stderr.write(`Started: ${new Date().toISOString()}\n`)
  logBreakdown('dry-run', breakdown, maxAge)

  // §2.2: BEGIN/UPDATE/ROLLBACK to prove the UPDATE form is valid against
  // live schema without committing any mutation.
  await client.query('BEGIN')
  const upd = await client.query(
    `UPDATE message_queue
        SET status = 'skipped', failed_reason = $1
      WHERE status = 'pending'
        AND created_at < NOW() - ${ageInterval}
        AND claimed_by IS NULL`,
    [reason],
  )
  await client.query('ROLLBACK')

  process.stderr.write(`Dry-run UPDATE matched ${upd.rowCount ?? 0} rows (rolled back).\n`)
  process.stderr.write(`Finished: ${new Date().toISOString()}\n`)
  return upd.rowCount ?? 0
}

async function runExecute(client: Client, opts: RunOptions = {}): Promise<number> {
  const maxAge = opts.maxAge ?? DEFAULT_MAX_AGE
  const ageInterval = ageIntervalSql(maxAge)
  const reason = reasonFor(maxAge)

  const breakdown = await gatherCandidates(client, ageInterval)
  process.stderr.write(`Started: ${new Date().toISOString()}\n`)
  logBreakdown('execute', breakdown, maxAge)
  process.stderr.write(
    `REMINDER: snapshot first → pg_dump -t message_queue agent_comms > backup.sql\n`,
  )

  const t0 = Date.now()
  await client.query('BEGIN')
  const upd = await client.query(
    `UPDATE message_queue
        SET status = 'skipped', failed_reason = $1
      WHERE status = 'pending'
        AND created_at < NOW() - ${ageInterval}
        AND claimed_by IS NULL`,
    [reason],
  )
  await client.query('COMMIT')
  const ms = Date.now() - t0

  const verify = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM message_queue
      WHERE status = 'skipped'
        AND failed_reason = $1`,
    [reason],
  )
  process.stderr.write(`Updated ${upd.rowCount ?? 0} rows in ${ms} ms\n`)
  process.stderr.write(
    `Verify: ${verify.rows[0]?.n ?? 0} rows currently match (status='skipped' AND failed_reason='${reason}').\n`,
  )
  process.stderr.write(`Finished: ${new Date().toISOString()}\n`)
  return upd.rowCount ?? 0
}

export async function runQueueCleanup(
  mode: 'dry-run' | 'execute',
  databaseUrl: string,
  opts: RunOptions = {},
): Promise<number> {
  // Validate at the entry of the run, not just CLI surface — programmatic
  // callers (tests) get the same floor enforcement.
  if (opts.maxAge !== undefined) {
    validateMaxAge(opts.maxAge)
  }
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    if (mode === 'execute') return await runExecute(client, opts)
    return await runDryRun(client, opts)
  } finally {
    await client.end().catch(() => {})
  }
}

export const _internal = {
  DEFAULT_REASON,
  STALE_DRAIN_REASON_PREFIX,
  DEFAULT_MAX_AGE,
  MIN_MAX_AGE_HOURS,
  // Backwards-compatible exports — kept stable for downstream tooling.
  REASON: DEFAULT_REASON,
  AGE_INTERVAL: "INTERVAL '12 hours'",
  parseMode,
  parseMaxAge,
  parseDurationToHours,
  validateMaxAge,
  ageIntervalSql,
  reasonFor,
  resolveDatabaseUrl,
  defaultConfigPath,
  gatherCandidates,
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  try {
    const mode = parseMode(argv)
    const maxAge = parseMaxAge(argv)
    validateMaxAge(maxAge)
    const url = resolveDatabaseUrl()
    runQueueCleanup(mode, url, { maxAge })
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(`queue-cleanup failed: ${err?.message ?? err}\n`)
        process.exit(1)
      })
  } catch (err: any) {
    process.stderr.write(`queue-cleanup arg error: ${err?.message ?? err}\n`)
    process.exit(2)
  }
}
