#!/usr/bin/env bun
import { PgAdapter } from '../../core/db/pg-adapter'
import { toLegacy } from '../../core/db/adapter'
import { measureRuntimeMemoryReadyCoverage } from '../../core/runtime-memory-ready-coverage'

function usage(): string {
  return `strict memory-ready coverage

Usage:
  bun scripts/operator/memory-ready-coverage.ts --database-url <postgres-url>

The database URL is mandatory and ambient DATABASE_URL is ignored. The report
uses the centralized active execution-seat definition and the unchanged strict
memory-ready gate for every member of that population.
`
}

export function parseMemoryReadyCoverageArgs(argv: string[]): { databaseUrl: string } {
  let databaseUrl = ''
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--database-url') {
      const value = argv[++index]
      if (!value) throw new Error('--database-url requires a value')
      databaseUrl = value.trim()
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('--database-url requires an explicit PostgreSQL URL')
  }
  return { databaseUrl }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseMemoryReadyCoverageArgs(argv)
    const db = new PgAdapter(options.databaseUrl)
    try {
      const report = await measureRuntimeMemoryReadyCoverage(toLegacy(db))
      process.stdout.write(`${JSON.stringify(report)}\n`)
      return report.complete ? 0 : 1
    } finally {
      await db.close().catch(() => {})
    }
  } catch (error) {
    process.stderr.write(`memory-ready-coverage: ${(error as Error).message ?? String(error)}\n`)
    return 2
  }
}

if (import.meta.main) process.exit(await main())
