#!/usr/bin/env bun
import { Client } from 'pg'
import {
  SD_C8_REGISTRY_RETIREMENT_CELL,
  SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256,
  transitionSdC8RegistryCohort,
} from '../../core/registry-retirement'

type Options = {
  action: 'retire' | 'reinstate'
  databaseUrl: string
  execute: boolean
  confirmCell: string | null
  confirmControlSourceSha256: string | null
}

function usage(): string {
  return `SD-C8 exact-cohort registry retirement

Usage:
  bun scripts/operator/registry-retirement.ts --action retire|reinstate
    --database-url <postgres-url>
    [--execute --confirm-cell ${SD_C8_REGISTRY_RETIREMENT_CELL}
     --confirm-control-source-sha256 ${SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256}]

The default is a transactionally locked dry-run. --database-url is mandatory;
ambient DATABASE_URL is intentionally ignored. The cohort is compiled from the
published SD-C8 cell and cannot be widened from the command line.
`
}

export function parseRegistryRetirementArgs(argv: string[]): Options {
  let action: Options['action'] | null = null
  let databaseUrl = ''
  let execute = false
  let confirmCell: string | null = null
  let confirmControlSourceSha256: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--action') {
      const value = next()
      if (value !== 'retire' && value !== 'reinstate') throw new Error('--action must be retire or reinstate')
      action = value
    } else if (arg === '--database-url') databaseUrl = next().trim()
    else if (arg === '--execute') execute = true
    else if (arg === '--confirm-cell') confirmCell = next()
    else if (arg === '--confirm-control-source-sha256') confirmControlSourceSha256 = next()
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!action) throw new Error('--action is required')
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('--database-url requires an explicit PostgreSQL URL')
  if (execute) {
    if (confirmCell !== SD_C8_REGISTRY_RETIREMENT_CELL) throw new Error('execute requires the exact --confirm-cell')
    if (confirmControlSourceSha256 !== SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256) {
      throw new Error('execute requires the exact --confirm-control-source-sha256')
    }
  }
  return { action, databaseUrl, execute, confirmCell, confirmControlSourceSha256 }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseRegistryRetirementArgs(argv)
    const db = new Client({ connectionString: options.databaseUrl })
    await db.connect()
    try {
      const report = await transitionSdC8RegistryCohort(db, {
        action: options.action,
        execute: options.execute,
      })
      process.stdout.write(`${JSON.stringify(report)}\n`)
      return 0
    } finally {
      await db.end().catch(() => {})
    }
  } catch (error) {
    process.stderr.write(`registry-retirement: ${(error as Error).message ?? String(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exit(await main())
