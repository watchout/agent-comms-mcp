import { describe, expect, test } from 'bun:test'
import {
  buildQueueTerminalStatePreflightReport,
  formatQueueTerminalStatePreflightText,
} from '../core/queue-terminal-state-preflight'

const REQUIRED_COLUMNS = [
  'id',
  'agent_id',
  'message_id',
  'payload',
  'status',
  'created_at',
  'claimed_by',
  'claimed_at',
  'claim_expires_at',
  'replied_at',
  'replied_with',
  'done_at',
  'failed_reason',
]

function sample(overrides: Record<string, unknown>) {
  return {
    id: 100,
    agent_id: 'codex-aun',
    message_id: 'message-1',
    status: 'replied',
    created_at: '2026-06-08T00:00:00.000Z',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    replied_at: null,
    replied_with: null,
    done_at: null,
    payload_bytes: 24,
    payload_shape: 'json_like',
    ...overrides,
  }
}

function countFor(sql: string): number {
  if (sql.includes("status = 'replied'")) return 2
  if (sql.includes("status = 'pending' AND")) return 1
  if (sql.includes("status IN ('received', 'in_progress')")) return 0
  if (sql.includes("status = 'done'")) return 1
  if (sql.includes("status IN ('read', 'skipped', 'failed')")) return 7
  return 0
}

describe('queue terminal-state preflight', () => {
  test('blocks broad legacy status checks and impossible queue states', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('information_schema.columns')) {
          return { rows: REQUIRED_COLUMNS.map((column_name) => ({ column_name, data_type: 'text', is_nullable: 'YES' })) }
        }
        if (sql.includes('pg_constraint')) {
          return {
            rows: [{
              constraint_name: 'message_queue_status_check',
              definition: "CHECK ((status = ANY (ARRAY['pending','read','received','in_progress','done','replied','skipped','failed'])))",
            }],
          }
        }
        if (sql.includes('GROUP BY status')) {
          return { rows: [{ status: 'replied', count: 10 }, { status: 'skipped', count: 7 }] }
        }
        if (sql.includes('count(*) AS count')) {
          return { rows: [{ count: countFor(sql) }] }
        }
        if (sql.includes("status = 'replied'")) {
          return { rows: [sample({ id: 1, status: 'replied' })] }
        }
        if (sql.includes("status = 'pending' AND")) {
          return { rows: [sample({ id: 2, status: 'pending', claimed_by: 'codex-aun' })] }
        }
        if (sql.includes("status = 'done'")) {
          return { rows: [sample({ id: 3, status: 'done' })] }
        }
        if (sql.includes("status IN ('read', 'skipped', 'failed')")) {
          return { rows: [sample({ id: 4, status: 'skipped' })] }
        }
        return { rows: [] }
      },
    }

    const report = await buildQueueTerminalStatePreflightReport(db)

    expect(report.policy).toMatchObject({
      read_only: true,
      no_db_mutation: true,
      no_queue_mutation: true,
      no_schema_migration: true,
    })
    expect(report.schema.status_check.legacy_statuses_allowed).toEqual(['read', 'skipped', 'failed'])
    expect(report.schema.status_check.contract_ready).toBe(false)
    expect(report.preflight.ok).toBe(false)
    expect(report.preflight.blocker_codes).toContain('terminal_status_contract_not_enforced')
    expect(report.preflight.blocker_codes).toContain('replied_missing_reply_evidence')
    expect(report.preflight.blocker_codes).toContain('pending_with_claim')
    expect(report.preflight.blocker_codes).toContain('done_missing_done_at')
    expect(report.preflight.blocker_codes).toContain('legacy_status_rows')
    expect(report.status_counts).toEqual({ replied: 10, skipped: 7 })
  })

  test('passes when schema and terminal-state evidence are clean', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('information_schema.columns')) {
          return { rows: REQUIRED_COLUMNS.map((column_name) => ({ column_name, data_type: 'text', is_nullable: 'YES' })) }
        }
        if (sql.includes('pg_constraint')) {
          return {
            rows: [{
              constraint_name: 'message_queue_status_check',
              definition: "CHECK ((status = ANY (ARRAY['pending','received','in_progress','done','replied'])))",
            }],
          }
        }
        if (sql.includes('GROUP BY status')) {
          return { rows: [{ status: 'pending', count: 1 }, { status: 'replied', count: 2 }] }
        }
        if (sql.includes('count(*) AS count')) return { rows: [{ count: 0 }] }
        return { rows: [] }
      },
    }

    const report = await buildQueueTerminalStatePreflightReport(db, { agentId: 'codex-aun' })

    expect(report.scope.agent_id).toBe('codex-aun')
    expect(report.schema.status_check.contract_ready).toBe(true)
    expect(report.preflight).toMatchObject({ ok: true, blocker_count: 0, migration_ready: true })
    expect(formatQueueTerminalStatePreflightText(report)).toContain('Preflight: ok')
  })

  test('fails closed when schema inspection is unavailable', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes('information_schema.columns') || sql.includes('pg_constraint')) {
          throw new Error('catalog unavailable')
        }
        if (sql.includes('GROUP BY status')) return { rows: [] }
        if (sql.includes('count(*) AS count')) return { rows: [{ count: 0 }] }
        return { rows: [] }
      },
    }

    const report = await buildQueueTerminalStatePreflightReport(db)

    expect(report.schema.inspection_ok).toBe(false)
    expect(report.schema.inspection_errors).toEqual(['catalog unavailable', 'catalog unavailable'])
    expect(report.preflight.ok).toBe(false)
    expect(report.preflight.blocker_codes).toContain('schema_inspection_failed')
    expect(report.preflight.blocker_codes).toContain('message_queue_status_check_missing')
  })
})
