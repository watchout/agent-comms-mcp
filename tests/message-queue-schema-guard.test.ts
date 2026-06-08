import { describe, expect, test } from 'bun:test'
import {
  DbCodeDriftError,
  assertMessageQueueStatusVocabularyCompatible,
  buildMessageQueueStatusVocabularyReport,
  extractMessageQueueStatusVocabulary,
  formatMessageQueueStatusCodeDrift,
} from '../core/message-queue-schema-guard'

type FakeDb = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>
}

function pgConstraintDb(definition: string | null): FakeDb {
  return {
    async query<T = any>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('pg_constraint')) {
        return {
          rows: definition === null
            ? []
            : [{ constraint_definition: definition }] as T[],
        }
      }
      throw new Error('sqlite fallback should not be used')
    },
  }
}

function sqliteSchemaDb(definition: string): FakeDb {
  return {
    async query<T = any>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('pg_constraint')) throw new Error('not postgres')
      if (sql.includes('sqlite_master')) {
        return { rows: [{ constraint_definition: definition }] as T[] }
      }
      throw new Error('unexpected query')
    },
  }
}

describe('message_queue status schema drift guard', () => {
  test('extracts status vocabulary from Postgres ANY constraint definitions', () => {
    const statuses = extractMessageQueueStatusVocabulary(
      "CHECK ((status = ANY (ARRAY['pending'::text, 'received'::text, 'in_progress'::text, 'done'::text, 'replied'::text])))",
    )

    expect(statuses).toEqual(['pending', 'received', 'in_progress', 'done', 'replied'])
  })

  test('fails closed on v0.8-only constraint and reports DB_CODE_DRIFT details', async () => {
    const report = await buildMessageQueueStatusVocabularyReport(pgConstraintDb(
      "CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed'))",
    ), { operation: 'agent-com next' })

    expect(report.ok).toBe(false)
    expect(report.code).toBe('DB_CODE_DRIFT')
    expect(report.constraint).toBe('message_queue_status_check')
    expect(report.expected_vocabulary).toEqual(['pending', 'received', 'in_progress', 'done', 'replied'])
    expect(report.actual_vocabulary).toEqual(['pending', 'read', 'replied', 'skipped', 'failed'])
    expect(report.missing_statuses).toEqual(['received', 'in_progress', 'done'])

    const text = formatMessageQueueStatusCodeDrift(report)
    expect(text).toContain('Error [DB_CODE_DRIFT]')
    expect(text).toContain('message_queue_status_check')
    expect(text).toContain('expected_vocabulary')
    expect(text).toContain('actual_vocabulary')
    expect(text).toContain('missing_statuses')
    expect(text).toContain(report.constraint_definition!)
  })

  test('passes on v0.9-only constraint', async () => {
    const report = await buildMessageQueueStatusVocabularyReport(pgConstraintDb(
      "CHECK ((status = ANY (ARRAY['pending'::text, 'received'::text, 'in_progress'::text, 'done'::text, 'replied'::text])))",
    ), { operation: 'mcp.processing' })

    expect(report.ok).toBe(true)
    expect(report.missing_statuses).toEqual([])
    expect(report.source).toBe('postgres_constraint')
  })

  test('passes on forward-compatible union constraints', async () => {
    const report = await buildMessageQueueStatusVocabularyReport(pgConstraintDb(
      "CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'))",
    ), { operation: 'mcp.done' })

    expect(report.ok).toBe(true)
    expect(report.actual_vocabulary).toEqual(['pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'])
    expect(report.missing_statuses).toEqual([])
  })

  test('falls back to SQLite table SQL inspection', async () => {
    const report = await buildMessageQueueStatusVocabularyReport(sqliteSchemaDb(
      "CREATE TABLE message_queue (status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed')))",
    ))

    expect(report.ok).toBe(true)
    expect(report.source).toBe('sqlite_schema')
  })

  test('assert helper throws typed DbCodeDriftError when required statuses are missing', async () => {
    await expect(assertMessageQueueStatusVocabularyCompatible(pgConstraintDb(
      "CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed'))",
    ))).rejects.toBeInstanceOf(DbCodeDriftError)
  })
})
