#!/usr/bin/env bun
import { Client } from 'pg'
import {
  LEGACY_OUTBOUND_OBSOLETE_REASON,
  classifyLegacyOutboundCandidate,
  summarizeLegacyOutboundClassifications,
  type LegacyOutboundCandidate,
  type LegacyOutboundAction,
} from '../core/legacy-outbound-cleanup'

const DEFAULT_CHANNEL = '1487368919613444156'
const DEFAULT_ADAPTER_OWNER = 'agent-com-dev'
const APPLY_GUARD_ENV = 'AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED'

interface Args {
  apply: boolean
  limit: number
  channelExternalId: string
  adapterOwner: string
  backfillMessageIds: Set<string>
  obsoleteMessageIds: Set<string>
}

function usage(): string {
  return `Usage:
  bun scripts/legacy-outbound-cleanup.ts [--limit N]
  bun scripts/legacy-outbound-cleanup.ts --backfill-message-id <uuid> [--apply]
  bun scripts/legacy-outbound-cleanup.ts --obsolete-message-id <uuid> [--apply]

Dry-run is the default. Mutating mode requires both --apply and ${APPLY_GUARD_ENV}=1.
`
}

function readList(argv: string[], flag: string): Set<string> {
  const values = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    for (const item of value.split(',')) {
      const trimmed = item.trim()
      if (trimmed) values.add(trimmed)
    }
    i++
  }
  return values
}

function parseArgs(argv: string[]): Args {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage())
    process.exit(0)
  }
  const valueAfter = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag)
    if (idx === -1) return fallback
    const value = argv[idx + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    return value
  }
  const limitRaw = valueAfter('--limit', '500')
  const limit = Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error('--limit must be an integer between 1 and 5000')
  }
  return {
    apply: argv.includes('--apply'),
    limit,
    channelExternalId: valueAfter('--channel-external-id', DEFAULT_CHANNEL),
    adapterOwner: valueAfter('--adapter-owner', DEFAULT_ADAPTER_OWNER),
    backfillMessageIds: readList(argv, '--backfill-message-id'),
    obsoleteMessageIds: readList(argv, '--obsolete-message-id'),
  }
}

function requireApplyGuard(args: Args): void {
  if (!args.apply) return
  if (process.env[APPLY_GUARD_ENV] !== '1') {
    throw new Error(`--apply requires ${APPLY_GUARD_ENV}=1`)
  }
}

async function fetchCandidates(client: Client, args: Args): Promise<LegacyOutboundCandidate[]> {
  const res = await client.query(
    `SELECT id::text,
            message_id,
            agent_id,
            consumer_agent_id,
            channel_external_id,
            status,
            attempts,
            max_attempts,
            last_error,
            created_at::text AS created_at,
            content
       FROM outbound_queue
      WHERE consumer_agent_id IS NULL
        AND status = 'pending'
        AND attempts = 0
        AND channel_external_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [args.channelExternalId, args.limit],
  )
  return res.rows
}

async function applyActions(
  client: Client,
  rows: Array<{ row: LegacyOutboundCandidate; action: LegacyOutboundAction; reason: string }>,
  args: Args,
): Promise<{ backfilled: number; obsolete: number }> {
  let backfilled = 0
  let obsolete = 0
  await client.query('BEGIN')
  try {
    for (const item of rows) {
      if (item.action === 'backfill_consumer') {
        const res = await client.query(
          `UPDATE outbound_queue
              SET consumer_agent_id = $1
            WHERE id = $2
              AND consumer_agent_id IS NULL
              AND status = 'pending'
              AND attempts = 0`,
          [args.adapterOwner, item.row.id],
        )
        backfilled += res.rowCount ?? 0
      } else if (item.action === 'mark_obsolete') {
        const res = await client.query(
          `UPDATE outbound_queue
              SET status = 'failed',
                  last_error = $1,
                  claimed_at = NULL,
                  next_retry_at = NULL
            WHERE id = $2
              AND consumer_agent_id IS NULL
              AND status = 'pending'
              AND attempts = 0`,
          [LEGACY_OUTBOUND_OBSOLETE_REASON, item.row.id],
        )
        obsolete += res.rowCount ?? 0
      }
    }
    await client.query('COMMIT')
    return { backfilled, obsolete }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

async function main() {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
    requireApplyGuard(args)
  } catch (err) {
    process.stderr.write(`legacy-outbound-cleanup: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write(usage())
    process.exit(2)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    process.stderr.write('legacy-outbound-cleanup: DATABASE_URL is required\n')
    process.exit(2)
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const candidates = await fetchCandidates(client, args)
    const planned = candidates.map(row => {
      const c = classifyLegacyOutboundCandidate(row, {
        adapterOwner: args.adapterOwner,
        channelExternalId: args.channelExternalId,
        backfillMessageIds: args.backfillMessageIds,
        obsoleteMessageIds: args.obsoleteMessageIds,
      })
      return { row, ...c }
    })
    const summary = summarizeLegacyOutboundClassifications(planned)
    const output: Record<string, unknown> = {
      ok: true,
      mode: args.apply ? 'apply' : 'dry-run',
      channel_external_id: args.channelExternalId,
      adapter_owner: args.adapterOwner,
      limit: args.limit,
      summary,
      rows: planned.map(item => ({
        outbound_queue_id: String(item.row.id),
        message_id: item.row.message_id,
        author_id: item.row.agent_id,
        created_at: item.row.created_at,
        attempts: item.row.attempts,
        proposed_action: item.action,
        reason: item.reason,
        proposed_consumer_agent_id: item.consumer_agent_id,
        content_preview: item.row.content.slice(0, 160),
      })),
    }
    if (args.apply) {
      output.applied = await applyActions(client, planned, args)
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } finally {
    await client.end()
  }
}

if (import.meta.main) {
  main().catch(err => {
    process.stderr.write(`legacy-outbound-cleanup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}
