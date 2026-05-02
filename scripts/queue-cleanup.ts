#!/usr/bin/env bun
/**
 * Bulk queue cleanup script (PR-Q1).
 *
 * Marks long-pending, unclaimed message_queue rows as 'skipped' so that
 * obsolete cycle chatter does not block agent inboxes after a major
 * post-merge state change (e.g. PR #288/#309/#310 fleet restart).
 *
 * Safety contract (5-section §3 forbidden):
 *   - DELETE は使わない (status update only, reversible)
 *   - 12h 以内 pending は touch しない (active 可能性を保護)
 *   - claimed_by != NULL は touch しない (in-flight 保護)
 *   - status != 'pending' は touch しない (failed/replied/skipped/read)
 *
 * Usage:
 *   bun scripts/queue-cleanup.ts            # dry-run (default)
 *   bun scripts/queue-cleanup.ts --dry-run  # explicit dry-run
 *   bun scripts/queue-cleanup.ts --execute  # actually perform UPDATE
 *
 * Exit code: 0 on success, 1 on connection / query failure.
 */
import { Client } from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const REASON =
  'BULK_CLEANUP: pre-Phase 5 obsolete chatter (lead-ama 2026-05-02)'
const AGE_INTERVAL = "INTERVAL '12 hours'"

/**
 * Resolve the Postgres connection string with explicit precedence:
 *   1. process.env.DATABASE_URL (truthy = non-empty string) — wins
 *   2. config.json `database_url` — fallback when env is unset / empty
 *   3. built-in default `postgresql://localhost/agent_comms`
 *
 * The cycle 1 implementation read config.json unconditionally and let it
 * override env, which inverted operator expectations (env should win on
 * Unix). config.json fallback is preserved per CTO directive to keep the
 * existing operator workflow that relies on it.
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

interface CandidateBreakdown {
  total: number
  perBot: { agent_id: string; count: number }[]
  sample: { agent_id: string; created_at: string; message_id: string | null }[]
}

async function gatherCandidates(client: Client): Promise<CandidateBreakdown> {
  const totalQ = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM message_queue
      WHERE status = 'pending'
        AND created_at < NOW() - ${AGE_INTERVAL}
        AND claimed_by IS NULL`,
  )
  const perBotQ = await client.query(
    `SELECT agent_id, COUNT(*)::int AS count
       FROM message_queue
      WHERE status = 'pending'
        AND created_at < NOW() - ${AGE_INTERVAL}
        AND claimed_by IS NULL
      GROUP BY agent_id
      ORDER BY count DESC`,
  )
  const sampleQ = await client.query(
    `SELECT agent_id, created_at::text AS created_at, message_id
       FROM message_queue
      WHERE status = 'pending'
        AND created_at < NOW() - ${AGE_INTERVAL}
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

function logBreakdown(mode: 'dry-run' | 'execute', b: CandidateBreakdown) {
  const banner =
    mode === 'dry-run'
      ? `Bulk Queue Cleanup — DRY RUN (would update ${b.total} rows)`
      : `Bulk Queue Cleanup — EXECUTE (target ${b.total} rows)`
  process.stderr.write(`${banner}\n`)
  process.stderr.write(
    `Per-bot pending breakdown (created_at < NOW() - 12h, claimed_by IS NULL):\n`,
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

async function runDryRun(client: Client): Promise<number> {
  const breakdown = await gatherCandidates(client)
  process.stderr.write(`Started: ${new Date().toISOString()}\n`)
  logBreakdown('dry-run', breakdown)

  // §2.2: BEGIN/UPDATE/ROLLBACK to prove the UPDATE form is valid against
  // live schema without committing any mutation.
  await client.query('BEGIN')
  const upd = await client.query(
    `UPDATE message_queue
        SET status = 'skipped', failed_reason = $1
      WHERE status = 'pending'
        AND created_at < NOW() - ${AGE_INTERVAL}
        AND claimed_by IS NULL`,
    [REASON],
  )
  await client.query('ROLLBACK')

  process.stderr.write(`Dry-run UPDATE matched ${upd.rowCount ?? 0} rows (rolled back).\n`)
  process.stderr.write(`Finished: ${new Date().toISOString()}\n`)
  return upd.rowCount ?? 0
}

async function runExecute(client: Client): Promise<number> {
  const breakdown = await gatherCandidates(client)
  process.stderr.write(`Started: ${new Date().toISOString()}\n`)
  logBreakdown('execute', breakdown)

  const t0 = Date.now()
  await client.query('BEGIN')
  const upd = await client.query(
    `UPDATE message_queue
        SET status = 'skipped', failed_reason = $1
      WHERE status = 'pending'
        AND created_at < NOW() - ${AGE_INTERVAL}
        AND claimed_by IS NULL`,
    [REASON],
  )
  await client.query('COMMIT')
  const ms = Date.now() - t0

  const verify = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM message_queue
      WHERE status = 'skipped'
        AND failed_reason = $1`,
    [REASON],
  )
  process.stderr.write(`Updated ${upd.rowCount ?? 0} rows in ${ms} ms\n`)
  process.stderr.write(
    `Verify: ${verify.rows[0]?.n ?? 0} rows currently match (status='skipped' AND failed_reason=BULK_CLEANUP).\n`,
  )
  process.stderr.write(`Finished: ${new Date().toISOString()}\n`)
  return upd.rowCount ?? 0
}

export async function runQueueCleanup(
  mode: 'dry-run' | 'execute',
  databaseUrl: string,
): Promise<number> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    if (mode === 'execute') return await runExecute(client)
    return await runDryRun(client)
  } finally {
    await client.end().catch(() => {})
  }
}

export const _internal = {
  REASON,
  AGE_INTERVAL,
  parseMode,
  resolveDatabaseUrl,
  defaultConfigPath,
  gatherCandidates,
}

if (import.meta.main) {
  const mode = parseMode(process.argv.slice(2))
  const url = resolveDatabaseUrl()
  runQueueCleanup(mode, url)
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`queue-cleanup failed: ${err?.message ?? err}\n`)
      process.exit(1)
    })
}
