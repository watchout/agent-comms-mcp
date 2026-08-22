#!/usr/bin/env bun
import { PgAdapter } from '../../core/db/pg-adapter'
import { toLegacy } from '../../core/db/adapter'
import { DEFAULT_STATE_DAEMON_DENYLIST } from '../../core/state-daemon/launchagent'
import { runRuntimeMemoryReadyFleetRefresh } from '../../core/runtime-memory-ready-refresher'
import { loadRuntimeMemoryReadyPolicy } from '../../core/runtime-current-resolver'

type CliOptions = {
  databaseUrl: string
  denylist: string[]
  dryRun: boolean
  validForSeconds: number
  policyPath: string | undefined
}

function usage(): string {
  return `memory-ready fleet refresher

Usage:
  bun scripts/operator/memory-ready-refresh.ts [--dry-run]
    [--database-url <postgres-url>] [--denylist <csv>]
    [--valid-for-seconds <n>] [--policy <path>]

DATABASE_URL must be explicit through the flag or environment. The refresher
never falls back to SQLite. Every idle/busy enabled seat produces one terminal
result; one seat failure does not abort the batch.
`
}

export function parseMemoryReadyRefreshArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  let databaseUrl = env.DATABASE_URL?.trim() ?? ''
  let denylistRaw = env.STATE_DAEMON_AGENT_DENYLIST?.trim() || DEFAULT_STATE_DAEMON_DENYLIST
  let dryRun = false
  let validForSeconds = 86_400
  let policyPath = env.RUNTIME_MEMORY_READY_POLICY_FILE?.trim() || undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--database-url') databaseUrl = next()
    else if (arg === '--denylist') denylistRaw = next()
    else if (arg === '--policy') policyPath = next()
    else if (arg === '--valid-for-seconds') {
      validForSeconds = Number.parseInt(next(), 10)
      if (!Number.isSafeInteger(validForSeconds) || validForSeconds <= 0) {
        throw new Error('--valid-for-seconds requires a positive integer')
      }
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED')
  return {
    databaseUrl,
    denylist: denylistRaw.split(',').map(value => value.trim()).filter(Boolean),
    dryRun,
    validForSeconds,
    policyPath,
  }
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const options = parseMemoryReadyRefreshArgs(argv, env)
    const db = new PgAdapter(options.databaseUrl)
    try {
      const report = await runRuntimeMemoryReadyFleetRefresh(toLegacy(db), {
        denylist: options.denylist,
        dryRun: options.dryRun,
        validForSeconds: options.validForSeconds,
        policy: loadRuntimeMemoryReadyPolicy(options.policyPath),
      })
      process.stdout.write(`${JSON.stringify(report)}\n`)
      return report.ok ? 0 : 1
    } finally {
      await db.close().catch(() => {})
    }
  } catch (error) {
    process.stderr.write(`memory-ready-refresh: ${(error as Error).message}\n`)
    return 2
  }
}

if (import.meta.main) process.exit(await main())
