import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const CATALOG_PATH = join(REPO_ROOT, 'config', 'normalization-e-measurements.v12a.json')
const FROZEN_CATALOG_FILE_SHA256 = '5eccf5b8816140886aef46bfaa3d5e52e78890fd068b821713af85f5c0ef1ff5'
const FROZEN_MEASUREMENTS_SHA256 = '9cd176174b179249bb25c023d9565c1753b5297b6d1ded8036be966cd94a4ba5'
const FROZEN_STATUS_CHECK = "CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'))"

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

describe('normalization E measurements remain frozen', () => {
  test('e-catalog-digest-unchanged', () => {
    const raw = readFileSync(CATALOG_PATH, 'utf8')
    const catalog = JSON.parse(raw)

    expect(sha256(raw)).toBe(FROZEN_CATALOG_FILE_SHA256)
    expect(catalog.source).toEqual({
      url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5500811424',
      raw_body_sha256: '8afb2ea5a97d7d56b331b225d747715c881efb3bc9221f70c26f21f45aebe5e1',
    })
    expect(catalog.approval).toEqual({
      decision_id: 'OD-SD-940-NORMALIZATION-V12A-FREEZE-20260902-001',
      url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5501762709',
      raw_body_sha256: 'bfea08c05c9db7c8ea6ec0e1499cc3dd458b001a3d60957327007fffe2fa2d56',
    })
    expect(catalog.measurements.map((measurement: { id: string }) => measurement.id)).toEqual([
      'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9',
    ])
    expect(sha256(canonicalJson(catalog.measurements))).toBe(FROZEN_MEASUREMENTS_SHA256)
    expect(catalog.catalog_digest).toBe(`sha256:${FROZEN_MEASUREMENTS_SHA256}`)
  })

  test('status-check-unchanged', () => {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
    const postgresMigration = readFileSync(join(REPO_ROOT, 'db', 'migrate.ts'), 'utf8')
    const sqliteMigration = readFileSync(join(REPO_ROOT, 'db', 'migrate-sqlite.ts'), 'utf8')

    expect(catalog.message_queue_status_check).toBe(FROZEN_STATUS_CHECK)
    expect(postgresMigration).toContain(FROZEN_STATUS_CHECK)
    expect(sqliteMigration).toContain(FROZEN_STATUS_CHECK)
  })
})
