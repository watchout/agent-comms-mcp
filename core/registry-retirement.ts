import { isDeepStrictEqual } from 'node:util'

export const SD_C8_REGISTRY_RETIREMENT_SCHEMA = 'registry-retirement-transition/v1' as const
export const SD_C8_REGISTRY_RETIREMENT_CELL = 'CH-ARC-940-SD-C8-REGISTRY-HYGIENE-20260822-001' as const
export const SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE =
  'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5380342151' as const
export const SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256 =
  'fc6e120540c34cac9ea760265d9d34cfd36ccc32ae1acac6b5d93d56bd15032b' as const

export const SD_C8_REGISTRY_RETIREMENT_AGENT_IDS = [
  'lead-override-163445f2',
  'lead-override-f020ad60',
  'lead-test-2001c9a4',
  'lead-test-52d6b47f',
  'test-self-kick-22844',
  'test-self-kick-43791',
  'test-self-kick-5562',
  'test-self-kick-62185',
  'ceo',
  'auditor',
  'lead-sus',
  'codex-aun',
] as const

export type RegistryRetirementDb = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

type RegistryAgentRow = {
  agent_id: string
  status: string | null
  profile_enabled: unknown
  disabled_at: string | Date | null
  metadata: unknown
  metadata_is_sql_null: boolean
}

type RegistryRetirementPreimage = {
  status: string
  profile_enabled: boolean
  disabled_at: string | null
  metadata: unknown
  metadata_is_sql_null: boolean
}

type RegistryRetirementRecord = {
  schema_version: typeof SD_C8_REGISTRY_RETIREMENT_SCHEMA
  cell_id: typeof SD_C8_REGISTRY_RETIREMENT_CELL
  control_source_ref: {
    url: typeof SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE
    sha256: typeof SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256
  }
  retired_at: string
  preimage: RegistryRetirementPreimage
}

export type RegistryRetirementReport = {
  schema_version: 'registry-retirement-report/v1'
  cell_id: typeof SD_C8_REGISTRY_RETIREMENT_CELL
  control_source_ref: {
    url: typeof SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE
    sha256: typeof SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256
  }
  action: 'retire' | 'reinstate'
  execute: boolean
  transitioned_at: string
  cohort: readonly string[]
  transitioned: number
  readback: Array<{
    agent_id: string
    status: string | null
    profile_enabled: boolean
    disabled_at: string | null
    retired: boolean
  }>
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return structuredClone(value as Record<string, unknown>)
  }
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    throw new Error('REGISTRY_RETIREMENT_METADATA_INVALID')
  }
}

function profileEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function iso(value: string | Date | null): string | null {
  if (value == null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('REGISTRY_RETIREMENT_DISABLED_AT_INVALID')
  return parsed.toISOString()
}

function exactCohort(rows: RegistryAgentRow[]): void {
  const actual = rows.map(row => row.agent_id).sort()
  const expected = [...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(id => !actual.includes(id))
    const extra = actual.filter(id => !expected.includes(id as typeof SD_C8_REGISTRY_RETIREMENT_AGENT_IDS[number]))
    throw new Error(`REGISTRY_RETIREMENT_COHORT_MISMATCH missing=${missing.join(',')} extra=${extra.join(',')}`)
  }
}

function retirementRecord(metadata: Record<string, unknown>): RegistryRetirementRecord | null {
  const candidate = metadata.registry_retirement
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const record = candidate as Partial<RegistryRetirementRecord>
  if (
    record.schema_version !== SD_C8_REGISTRY_RETIREMENT_SCHEMA
    || record.cell_id !== SD_C8_REGISTRY_RETIREMENT_CELL
    || record.control_source_ref?.url !== SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE
    || record.control_source_ref?.sha256 !== SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256
    || typeof record.retired_at !== 'string'
    || !record.preimage
    || typeof record.preimage.status !== 'string'
    || typeof record.preimage.profile_enabled !== 'boolean'
    || typeof record.preimage.metadata_is_sql_null !== 'boolean'
    || !Object.prototype.hasOwnProperty.call(record.preimage, 'metadata')
    || record.preimage.metadata === undefined
  ) return null
  return record as RegistryRetirementRecord
}

async function loadLockedCohort(db: RegistryRetirementDb): Promise<RegistryAgentRow[]> {
  const result = await db.query<RegistryAgentRow>(
    `SELECT agent_id, status, profile_enabled, disabled_at, metadata,
            metadata IS NULL AS metadata_is_sql_null
       FROM agents
      WHERE agent_id = ANY($1::text[])
      ORDER BY agent_id
      FOR UPDATE`,
    [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]],
  )
  exactCohort(result.rows)
  return result.rows
}

async function assertNoActiveClaims(db: RegistryRetirementDb): Promise<void> {
  const result = await db.query<{ agent_id: string; active_claims: number | string }>(
    `SELECT agent_id, count(*)::int AS active_claims
       FROM message_queue
      WHERE agent_id = ANY($1::text[])
        AND status IN ('received', 'in_progress')
      GROUP BY agent_id
      ORDER BY agent_id`,
    [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]],
  )
  if (result.rows.some(row => Number(row.active_claims) > 0)) {
    throw new Error(`REGISTRY_RETIREMENT_ACTIVE_CLAIMS:${result.rows.map(row => row.agent_id).join(',')}`)
  }
}

function reportReadback(rows: RegistryAgentRow[]): RegistryRetirementReport['readback'] {
  return rows.map(row => {
    const metadata = metadataObject(row.metadata)
    return {
      agent_id: row.agent_id,
      status: row.status,
      profile_enabled: profileEnabled(row.profile_enabled),
      disabled_at: iso(row.disabled_at),
      retired: metadata.retired === true || metadata.retired === 'true',
    }
  })
}

function exactPreimageRestored(row: RegistryAgentRow, preimage: RegistryRetirementPreimage): boolean {
  return row.status === preimage.status
    && profileEnabled(row.profile_enabled) === preimage.profile_enabled
    && iso(row.disabled_at) === preimage.disabled_at
    && row.metadata_is_sql_null === preimage.metadata_is_sql_null
    && isDeepStrictEqual(row.metadata, preimage.metadata)
}

export async function transitionSdC8RegistryCohort(
  db: RegistryRetirementDb,
  options: { action: 'retire' | 'reinstate'; execute?: boolean; now?: Date },
): Promise<RegistryRetirementReport> {
  const execute = options.execute ?? false
  const now = options.now ?? new Date()
  const transitionedAt = now.toISOString()
  await db.query('BEGIN')
  try {
    const rows = await loadLockedCohort(db)
    await assertNoActiveClaims(db)

    if (options.action === 'retire') {
      for (const row of rows) {
        const metadata = metadataObject(row.metadata)
        if (!row.status?.trim()) throw new Error(`REGISTRY_RETIREMENT_STATUS_INVALID:${row.agent_id}`)
        if (row.status === 'busy') throw new Error(`REGISTRY_RETIREMENT_TARGET_BUSY:${row.agent_id}`)
        if (
          row.status === 'retired'
          || metadata.retired === true
          || metadata.retired === 'true'
          || Object.prototype.hasOwnProperty.call(metadata, 'registry_retirement')
        ) {
          throw new Error(`REGISTRY_RETIREMENT_ALREADY_RETIRED:${row.agent_id}`)
        }
      }
    } else {
      for (const row of rows) {
        const record = retirementRecord(metadataObject(row.metadata))
        if (row.status !== 'retired' || !record) {
          throw new Error(`REGISTRY_REINSTATEMENT_PREIMAGE_MISSING:${row.agent_id}`)
        }
      }
    }

    const reinstatementPreimages = options.action === 'reinstate'
      ? new Map(rows.map(row => {
        const record = retirementRecord(metadataObject(row.metadata))!
        return [row.agent_id, record.preimage] as const
      }))
      : null

    if (!execute) {
      await db.query('ROLLBACK')
      return {
        schema_version: 'registry-retirement-report/v1',
        cell_id: SD_C8_REGISTRY_RETIREMENT_CELL,
        control_source_ref: {
          url: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE,
          sha256: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256,
        },
        action: options.action,
        execute: false,
        transitioned_at: transitionedAt,
        cohort: SD_C8_REGISTRY_RETIREMENT_AGENT_IDS,
        transitioned: 0,
        readback: reportReadback(rows),
      }
    }

    for (const row of rows) {
      const metadata = metadataObject(row.metadata)
      let nextStatus: string
      let nextProfileEnabled: boolean
      let nextDisabledAt: string | null
      let nextMetadata: unknown
      let nextMetadataIsSqlNull: boolean
      let eventType: string
      if (options.action === 'retire') {
        const record: RegistryRetirementRecord = {
          schema_version: SD_C8_REGISTRY_RETIREMENT_SCHEMA,
          cell_id: SD_C8_REGISTRY_RETIREMENT_CELL,
          control_source_ref: {
            url: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE,
            sha256: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256,
          },
          retired_at: transitionedAt,
          preimage: {
            status: row.status!,
            profile_enabled: profileEnabled(row.profile_enabled),
            disabled_at: iso(row.disabled_at),
            metadata: row.metadata,
            metadata_is_sql_null: row.metadata_is_sql_null,
          },
        }
        nextStatus = 'retired'
        nextProfileEnabled = false
        nextDisabledAt = transitionedAt
        nextMetadata = { ...metadata, retired: true, registry_retirement: record }
        nextMetadataIsSqlNull = false
        eventType = 'registry.identity.retired'
      } else {
        const record = retirementRecord(metadata)!
        nextStatus = record.preimage.status
        nextProfileEnabled = record.preimage.profile_enabled
        nextDisabledAt = record.preimage.disabled_at
        nextMetadata = record.preimage.metadata
        nextMetadataIsSqlNull = record.preimage.metadata_is_sql_null
        eventType = 'registry.identity.reinstated'
      }
      await db.query(
        `UPDATE agents
            SET status = $2,
                profile_enabled = $3,
                disabled_at = $4,
                metadata = CASE WHEN $6::boolean THEN NULL ELSE $5::jsonb END,
                status_updated_at = $7
          WHERE agent_id = $1`,
        [
          row.agent_id,
          nextStatus,
          nextProfileEnabled,
          nextDisabledAt,
          JSON.stringify(nextMetadata),
          nextMetadataIsSqlNull,
          transitionedAt,
        ],
      )
      await db.query(
        `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
         VALUES ($1, $2, $2, $3::jsonb, 'default')`,
        [eventType, row.agent_id, JSON.stringify({
          schema_version: SD_C8_REGISTRY_RETIREMENT_SCHEMA,
          cell_id: SD_C8_REGISTRY_RETIREMENT_CELL,
          control_source_ref: {
            url: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE,
            sha256: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256,
          },
          transitioned_at: transitionedAt,
          from_status: row.status,
          to_status: nextStatus,
        })],
      )
    }

    const readbackRows = await loadLockedCohort(db)
    const readback = reportReadback(readbackRows)
    const valid = options.action === 'retire'
      ? readback.every(row => row.status === 'retired' && !row.profile_enabled && row.disabled_at === transitionedAt && row.retired)
      : readbackRows.every(row => {
        const preimage = reinstatementPreimages?.get(row.agent_id)
        return preimage != null && exactPreimageRestored(row, preimage)
      })
    if (!valid) throw new Error('REGISTRY_RETIREMENT_READBACK_FAILED')
    await db.query('COMMIT')
    return {
      schema_version: 'registry-retirement-report/v1',
      cell_id: SD_C8_REGISTRY_RETIREMENT_CELL,
      control_source_ref: {
        url: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE,
        sha256: SD_C8_REGISTRY_RETIREMENT_CONTROL_SOURCE_SHA256,
      },
      action: options.action,
      execute: true,
      transitioned_at: transitionedAt,
      cohort: SD_C8_REGISTRY_RETIREMENT_AGENT_IDS,
      transitioned: rows.length,
      readback,
    }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}
