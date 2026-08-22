#!/usr/bin/env bun
import { PgAdapter } from '../../core/db/pg-adapter'
import { toLegacy } from '../../core/db/adapter'
import { loadRuntimeMemoryReadyPolicy } from '../../core/runtime-current-resolver'
import { queryRuntimeMemoryReadyIdentityMonitor } from '../../core/runtime-memory-ready-identity'

type CliOptions = {
  databaseUrl: string
  policyPath: string | undefined
}

function usage(): string {
  return `memory-ready runtime identity monitor

Usage:
  bun scripts/operator/memory-ready-identity-monitor.ts
    --database-url <postgres-url> [--policy <path>]

The command runs in an explicit read-only transaction and reports typed
REGISTRATION_PROFILE_MISMATCH, PROFILE_MISMATCH_DEPRIORITIZED, and
SUPERSEDED_EVIDENCE_BINDING findings.
`
}

export function parseMemoryReadyIdentityMonitorArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  let databaseUrl = env.DATABASE_URL?.trim() ?? ''
  let policyPath = env.RUNTIME_MEMORY_READY_POLICY_FILE?.trim() || undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--database-url') databaseUrl = next()
    else if (arg === '--policy') policyPath = next()
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED')
  return { databaseUrl, policyPath }
}

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const options = parseMemoryReadyIdentityMonitorArgs(argv, env)
    const db = new PgAdapter(options.databaseUrl)
    try {
      await db.execute('BEGIN TRANSACTION READ ONLY')
      try {
        const report = await queryRuntimeMemoryReadyIdentityMonitor(toLegacy(db), {
          policy: loadRuntimeMemoryReadyPolicy(options.policyPath),
        })
        process.stdout.write(`${JSON.stringify(report)}\n`)
      } finally {
        await db.execute('ROLLBACK').catch(() => {})
      }
      return 0
    } finally {
      await db.close().catch(() => {})
    }
  } catch (error) {
    process.stderr.write(`memory-ready-identity-monitor: ${(error as Error).message}\n`)
    return 2
  }
}

if (import.meta.main) process.exit(await main())
