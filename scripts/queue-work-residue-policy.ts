#!/usr/bin/env bun
/**
 * Read-only #758 queue-work residue policy classifier.
 *
 * This script validates an exact-row residue policy and, unless --no-db is
 * provided, reads only the listed message_queue rows to verify identity. It
 * never mutates DB rows, starts runtimes, touches launchd, or performs cleanup.
 */
import { Client } from 'pg'
import {
  classifyQueueWorkResidueRows,
  loadQueueWorkResiduePolicyFile,
  queueWorkResidueExcludedQueueIds,
  type QueueWorkResiduePolicyReport,
  type QueueWorkResidueRow,
} from '../core/state-daemon/queue-work-residue-policy'

type ParsedArgs = {
  policy: string
  databaseUrl: string
  format: 'json' | 'text'
  noDb: boolean
}

function usage(): string {
  return `queue-work residue policy classifier

Usage:
  bun scripts/queue-work-residue-policy.ts [--policy config/queue-work-residue-policy.json]
    [--database-url postgresql:///agent_comms?host=/tmp] [--format json|text] [--no-db]

Read-only only. No DB mutation, cleanup, scheduler activation, LaunchAgent
mutation, Discord recovery, or runtime invocation is performed.
`
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    policy: 'config/queue-work-residue-policy.json',
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql:///agent_comms?host=/tmp',
    format: 'json',
    noDb: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--policy') args.policy = next()
    else if (arg === '--database-url') args.databaseUrl = next()
    else if (arg === '--format') {
      const value = next()
      if (value !== 'json' && value !== 'text') throw new Error('--format must be json or text')
      args.format = value
    } else if (arg === '--no-db') args.noDb = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

async function fetchRows(databaseUrl: string, queueIds: number[]): Promise<QueueWorkResidueRow[]> {
  if (queueIds.length === 0) return []
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query<QueueWorkResidueRow>(
      `SELECT id, agent_id, message_id, status, payload, created_at,
              claimed_by, claimed_at, claim_expires_at
         FROM message_queue
        WHERE id = ANY($1::bigint[])
        ORDER BY id ASC`,
      [queueIds],
    )
    return result.rows
  } finally {
    await client.end()
  }
}

function policyOnlyReport(policyPath: string): Record<string, unknown> {
  const policy = loadQueueWorkResiduePolicyFile(policyPath)
  return {
    ok: true,
    mode: 'policy_only',
    mutation_performed: false,
    cleanup_performed: false,
    policy_path: policyPath,
    schema_version: policy.schema_version,
    issue: policy.issue,
    policy_entry_count: policy.entries.length,
    excluded_queue_ids: queueWorkResidueExcludedQueueIds(policy),
  }
}

function printText(report: QueueWorkResiduePolicyReport | Record<string, unknown>): void {
  process.stdout.write(`ok=${String(report.ok)}\n`)
  process.stdout.write(`schema_version=${String(report.schema_version)}\n`)
  process.stdout.write(`issue=${String(report.issue)}\n`)
  process.stdout.write(`policy_entry_count=${String(report.policy_entry_count)}\n`)
  if ('row_count' in report) process.stdout.write(`row_count=${String(report.row_count)}\n`)
  if ('blockers' in report && Array.isArray(report.blockers)) {
    for (const blocker of report.blockers) {
      process.stdout.write(`blocker=${JSON.stringify(blocker)}\n`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  if (args.noDb) {
    const report = policyOnlyReport(args.policy)
    if (args.format === 'json') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else printText(report)
    return
  }

  const policy = loadQueueWorkResiduePolicyFile(args.policy)
  const rows = await fetchRows(args.databaseUrl, queueWorkResidueExcludedQueueIds(policy))
  const report = classifyQueueWorkResidueRows(policy, rows, { requirePolicyRows: true })
  const output = {
    ...report,
    mutation_performed: false,
    cleanup_performed: false,
    policy_path: args.policy,
  }
  if (args.format === 'json') process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  else printText(output)
  if (!report.ok) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`queue-work-residue-policy: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
