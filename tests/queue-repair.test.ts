import { describe, expect, test } from 'bun:test'
import { closeObsoletePendingQueueRows, reassignPendingQueueRows, reclaimExpiredQueueClaims } from '../core/queue-repair'

function sample(id: number, agentId = 'lead-ama') {
  return {
    id,
    agent_id: agentId,
    status: 'pending',
    message_id: `msg-${id}`,
    created_at: new Date('2026-05-20T00:00:00Z'),
    content: 'sample',
    total_count: 2,
  }
}

describe('queue repair helpers', () => {
  test('reassign dry-run requires target identity and does not mutate', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) return { rows: [{ agent_id: 'codex-aun' }] }
        if (sql.includes('FROM message_queue')) return { rows: [sample(1), sample(2)] }
        return { rows: [] }
      },
    }

    const report = await reassignPendingQueueRows(db, {
      fromAgentId: 'lead-ama',
      toAgentId: 'codex-aun',
      dryRun: true,
    })

    expect(report).toMatchObject({ action: 'reassign', dry_run: true, affected_count: 2 })
    expect(calls.join('\n')).not.toContain('UPDATE message_queue')
  })

  test('close obsolete writes audit on mutation', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('UPDATE message_queue')) return { rows: [sample(3)] }
        return { rows: [] }
      },
    }

    const report = await closeObsoletePendingQueueRows(db, {
      agentId: 'lead-ama',
      reason: 'retired identity',
    })

    expect(report).toMatchObject({ action: 'close_obsolete', dry_run: false, affected_count: 2 })
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(true)
    expect(calls.some((call) => call.sql.includes('INSERT INTO audit_log'))).toBe(true)
    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true)
    expect(calls.find((call) => call.sql.includes('UPDATE message_queue'))?.params).toContain('OBSOLETE:retired identity')
  })

  test('reclaim expired supports agent-scoped dry-run', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('FROM message_queue')) return { rows: [sample(4, 'codex-cto')] }
        return { rows: [] }
      },
    }

    const report = await reclaimExpiredQueueClaims(db, { agentId: 'codex-cto', dryRun: true })

    expect(report).toMatchObject({ action: 'reclaim_expired', dry_run: true, affected_count: 2 })
    expect(calls[0].params).toEqual(['codex-cto'])
    expect(calls[0].sql).toContain('claim_expires_at < now()')
  })

  test('reclaim expired refreshes every affected agent from the mutation CTE', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('WITH reclaimed AS')) return { rows: [sample(5, 'codex-cto')] }
        return { rows: [] }
      },
    }

    const report = await reclaimExpiredQueueClaims(db)

    expect(report).toMatchObject({ action: 'reclaim_expired', dry_run: false })
    const mutation = calls.find((call) => call.sql.includes('WITH reclaimed AS'))?.sql ?? ''
    expect(mutation).toContain('refreshed_agents AS')
    expect(mutation).toContain('SELECT DISTINCT agent_id FROM reclaimed')
    expect(mutation).not.toContain('id = ANY')
  })
})
