#!/usr/bin/env bun
import { Client } from 'pg'
import {
  reconcileWithGithub,
  type AgentRuntimeStatus,
  type PhaseHandoffQueueRow,
  type PhaseEvidenceComment,
} from '../core/phase-evidence'

type Args = {
  repo?: string
  pr?: number
  head?: string
  ttlSeconds: number
  queueLimit: number
  includeDb: boolean
  help: boolean
}

type GhPrView = {
  number: number
  headRefOid: string
  labels: Array<{ name: string }>
  comments: Array<{
    body: string
    url?: string
    createdAt?: string
    author?: { login?: string }
  }>
}

function usage(): string {
  return `GitHub/AUN phase reconciliation report

Usage:
  bun scripts/reconcile-with-github.ts --repo <owner/repo> --pr <number> [--head <sha>] [--ttl-seconds 3600] [--no-db]

This is read-only. It compares machine-readable GitHub phase evidence comments,
PR conveyor labels, and optional AUN message_queue rows. It does not mutate
labels, queue rows, GitHub comments, LaunchAgents, or runtime state.
`
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    ttlSeconds: 3600,
    queueLimit: 100,
    includeDb: true,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--repo') {
      args.repo = next()
    } else if (arg === '--pr') {
      const value = Number.parseInt(next(), 10)
      if (!Number.isInteger(value)) throw new Error('--pr requires an integer')
      args.pr = value
    } else if (arg === '--head') {
      args.head = next()
    } else if (arg === '--ttl-seconds') {
      const value = Number.parseInt(next(), 10)
      if (!Number.isInteger(value) || value <= 0) throw new Error('--ttl-seconds requires a positive integer')
      args.ttlSeconds = value
    } else if (arg === '--queue-limit') {
      const value = Number.parseInt(next(), 10)
      if (!Number.isInteger(value) || value <= 0) throw new Error('--queue-limit requires a positive integer')
      args.queueLimit = value
    } else if (arg === '--no-db') {
      args.includeDb = false
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function requireArg<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function runGhJson<T>(args: string[]): T {
  const proc = Bun.spawnSync(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${proc.exitCode})\n${proc.stderr.toString()}`)
  }
  return JSON.parse(proc.stdout.toString()) as T
}

function fetchPr(repo: string, pr: number): GhPrView {
  return runGhJson<GhPrView>([
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'number,headRefOid,labels,comments',
  ])
}

async function fetchQueueRows(
  databaseUrl: string,
  input: { repo: string; pr: number; head: string; limit: number },
): Promise<{ rows: PhaseHandoffQueueRow[]; agents: AgentRuntimeStatus[] }> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const urlPattern = `%github.com/${input.repo}/pull/${input.pr}%`
    const prPattern = `%PR #${input.pr}%`
    const headPattern = `%${input.head}%`
    const queue = await client.query<PhaseHandoffQueueRow>(
      `SELECT id::text,
              agent_id,
              status,
              created_at::text,
              claimed_at::text,
              read_at::text,
              replied_at::text,
              done_at::text,
              failed_reason,
              payload
         FROM message_queue
        WHERE payload::text ILIKE $1
           OR payload::text ILIKE $2
           OR payload::text ILIKE $3
        ORDER BY created_at DESC
        LIMIT $4`,
      [urlPattern, prPattern, headPattern, input.limit],
    )
    const agentIds = Array.from(new Set(queue.rows.map((row) => row.agent_id).filter(Boolean)))
    if (agentIds.length === 0) return { rows: queue.rows, agents: [] }
    const agents = await client.query<AgentRuntimeStatus>(
      `SELECT agent_id,
              status,
              runtime,
              last_seen_at::text
         FROM agents
        WHERE agent_id = ANY($1::text[])
        ORDER BY agent_id`,
      [agentIds],
    )
    return { rows: queue.rows, agents: agents.rows }
  } finally {
    await client.end()
  }
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(usage())
    return 0
  }

  const repo = requireArg(args.repo, '--repo')
  const prNumber = requireArg(args.pr, '--pr')
  const pr = fetchPr(repo, prNumber)
  const head = args.head ?? pr.headRefOid
  if (args.head && args.head !== pr.headRefOid) {
    process.stdout.write(JSON.stringify({
      ok: false,
      blocker: {
        code: 'exact_head_mismatch',
        expected: args.head,
        current: pr.headRefOid,
      },
    }, null, 2) + '\n')
    return 2
  }

  let queueRows: PhaseHandoffQueueRow[] = []
  let agentStatuses: AgentRuntimeStatus[] = []
  const databaseUrl = process.env.DATABASE_URL
  if (args.includeDb && databaseUrl) {
    const db = await fetchQueueRows(databaseUrl, {
      repo,
      pr: prNumber,
      head,
      limit: args.queueLimit,
    })
    queueRows = db.rows
    agentStatuses = db.agents
  }

  const comments: PhaseEvidenceComment[] = pr.comments.map((comment) => ({
    body: comment.body,
    url: comment.url,
    createdAt: comment.createdAt,
    author: comment.author?.login ?? null,
  }))
  const report = reconcileWithGithub({
    repo,
    pr: prNumber,
    currentHead: head,
    labels: pr.labels.map((label) => label.name),
    comments,
    queueRows,
    agentStatuses,
    ttlSeconds: args.ttlSeconds,
  })

  process.stdout.write(JSON.stringify({
    ok: report.findings.every((finding) => finding.severity !== 'blocker'),
    db_included: args.includeDb && Boolean(databaseUrl),
    ...report,
  }, null, 2) + '\n')
  return report.findings.some((finding) => finding.severity === 'blocker') ? 2 : 0
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
