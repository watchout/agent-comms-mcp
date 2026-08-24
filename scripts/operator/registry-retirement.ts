#!/usr/bin/env bun
import { Client } from 'pg'
import {
  SEAT_DISPOSITION_CONTROL_SOURCE_SHA256,
  SEAT_DISPOSITION_RULING,
  SD_C8_REGISTRY_RETIREMENT_CELL,
  SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256,
  transitionKodamaCanaryDelivery,
  transitionSdC8RegistryCohort,
} from '../../core/registry-retirement'

type Options = {
  action: 'retire' | 'reinstate' | 'suspend-kodama' | 'reinstate-kodama'
  databaseUrl: string
  execute: boolean
  confirmCell: string | null
  confirmRuling: string | null
  confirmControlSourceSha256: string | null
  canaryReceiptUrl: string | null
  canaryReceiptSha256: string | null
}

function usage(): string {
  return `SD-C8 exact-cohort registry retirement

Usage:
  bun scripts/operator/registry-retirement.ts
    --action retire|reinstate|suspend-kodama|reinstate-kodama
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
  let confirmRuling: string | null = null
  let confirmControlSourceSha256: string | null = null
  let canaryReceiptUrl: string | null = null
  let canaryReceiptSha256: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--action') {
      const value = next()
      if (!['retire', 'reinstate', 'suspend-kodama', 'reinstate-kodama'].includes(value)) {
        throw new Error('--action must be retire, reinstate, suspend-kodama, or reinstate-kodama')
      }
      action = value
    } else if (arg === '--database-url') databaseUrl = next().trim()
    else if (arg === '--execute') execute = true
    else if (arg === '--confirm-cell') confirmCell = next()
    else if (arg === '--confirm-ruling') confirmRuling = next()
    else if (arg === '--confirm-control-source-sha256') confirmControlSourceSha256 = next()
    else if (arg === '--canary-receipt-url') canaryReceiptUrl = next()
    else if (arg === '--canary-receipt-sha256') canaryReceiptSha256 = next()
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!action) throw new Error('--action is required')
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('--database-url requires an explicit PostgreSQL URL')
  if (execute) {
    if (action === 'retire' || action === 'reinstate') {
      if (confirmCell !== SD_C8_REGISTRY_RETIREMENT_CELL) throw new Error('execute requires the exact --confirm-cell')
      if (confirmControlSourceSha256 !== SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256) {
        throw new Error('execute requires the exact --confirm-control-source-sha256')
      }
    } else {
      if (confirmRuling !== SEAT_DISPOSITION_RULING) throw new Error('execute requires the exact --confirm-ruling')
      if (confirmControlSourceSha256 !== SEAT_DISPOSITION_CONTROL_SOURCE_SHA256) {
        throw new Error('execute requires the exact ruling --confirm-control-source-sha256')
      }
      if (action === 'reinstate-kodama' && (!canaryReceiptUrl || !canaryReceiptSha256)) {
        throw new Error('reinstate-kodama requires immutable canary receipt URL and SHA-256')
      }
    }
  }
  return {
    action,
    databaseUrl,
    execute,
    confirmCell,
    confirmRuling,
    confirmControlSourceSha256,
    canaryReceiptUrl,
    canaryReceiptSha256,
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseRegistryRetirementArgs(argv)
    const db = new Client({ connectionString: options.databaseUrl })
    await db.connect()
    try {
      const report = options.action === 'retire' || options.action === 'reinstate'
        ? await transitionSdC8RegistryCohort(db, {
          action: options.action,
          execute: options.execute,
        })
        : await transitionKodamaCanaryDelivery(db, {
          action: options.action === 'suspend-kodama' ? 'suspend' : 'reinstate',
          execute: options.execute,
          canaryReceipt: options.canaryReceiptUrl && options.canaryReceiptSha256
            ? { url: options.canaryReceiptUrl, sha256: options.canaryReceiptSha256 }
            : null,
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
