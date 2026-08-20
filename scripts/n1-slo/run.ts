#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Client } from 'pg'
import { runN1Measurement } from './harness'
import { publishN1Report } from './publisher'

interface Args {
  databaseUrl?: string
  databaseConfig?: string
  githubTokenFile?: string
  publish: boolean
}

function usage(): string {
  return `N1 communication SLO harness

Usage:
  bun scripts/n1-slo/run.ts measure (--database-url <postgres-url> | --database-config <config.json>) [--publish] [--github-token-file <path>]

DATABASE_URL is deliberately not read from the ambient environment. The observation
window is fixed by the N1 contract. Probe traffic is internal-only and no-op.
`
}

export function parseArgs(argv: string[]): Args {
  if (argv[0] !== 'measure') throw new Error('the measure command is required')
  const result: Args = { publish: false }
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--database-url') result.databaseUrl = next()
    else if (arg === '--database-config') result.databaseConfig = next()
    else if (arg === '--github-token-file') result.githubTokenFile = next()
    else if (arg === '--publish') result.publish = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return result
}

export function resolveExplicitDatabaseUrl(args: Pick<Args, 'databaseUrl' | 'databaseConfig'>): string {
  if (Boolean(args.databaseUrl) === Boolean(args.databaseConfig)) {
    throw new Error('exactly one of --database-url or --database-config is required')
  }
  const value = args.databaseUrl ?? (() => {
    const parsed = JSON.parse(readFileSync(args.databaseConfig!, 'utf8')) as { database_url?: unknown }
    if (typeof parsed.database_url !== 'string') throw new Error('database config must contain database_url')
    return parsed.database_url
  })()
  if (!/^postgres(?:ql)?:\/\//.test(value)) throw new Error('N1 harness requires an explicit PostgreSQL URL')
  return value
}

function currentCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dir, encoding: 'utf8' })
  const commit = result.status === 0 ? result.stdout.trim() : ''
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('unable to resolve source commit')
  return commit
}

async function main(): Promise<void> {
  let client: Client | null = null
  try {
    const args = parseArgs(process.argv.slice(2))
    client = new Client({ connectionString: resolveExplicitDatabaseUrl(args) })
    await client.connect()
    const report = await runN1Measurement(client, { sourceCommit: currentCommit() })
    const publication = args.publish
      ? await publishN1Report(report, { tokenFile: args.githubTokenFile })
      : null
    process.stdout.write(JSON.stringify({ report, publication }, null, 2) + '\n')
    if (publication && !publication.ok) process.exitCode = 1
    else if (report.verdict !== 'PASS') process.exitCode = 2
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error_code: 'N1_SLO_HARNESS_FAILED',
      summary: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n')
    process.exitCode = 1
  } finally {
    await client?.end().catch(() => {})
  }
}

if (import.meta.main) void main()
