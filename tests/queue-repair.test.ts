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
        if (sql.includes('FROM agents')) return { rows: [{ agent_id: 'codex-aun', status: 'idle', metadata: {} }] }
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

  test('reassign defaults to dry-run', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) return { rows: [{ agent_id: 'codex-aun', status: 'idle', metadata: {} }] }
        if (sql.includes('FROM message_queue')) return { rows: [sample(10)] }
        return { rows: [] }
      },
    }

    const report = await reassignPendingQueueRows(db, {
      fromAgentId: 'lead-ama',
      toAgentId: 'codex-aun',
    })

    expect(report).toMatchObject({ action: 'reassign', dry_run: true })
    expect(calls).not.toContain('BEGIN')
  })

  test('reassign fails closed when the target is offline', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) return { rows: [{ agent_id: 'lead-ama', status: 'offline', metadata: {} }] }
        if (sql.includes('FROM message_queue')) return { rows: [sample(1)] }
        return { rows: [] }
      },
    }

    await expect(reassignPendingQueueRows(db, {
      fromAgentId: 'arc',
      toAgentId: 'lead-ama',
      dryRun: true,
    })).rejects.toThrow('QUEUE_REPAIR_TARGET_UNAVAILABLE:lead-ama:offline')

    expect(calls.join('\n')).not.toContain('FROM message_queue')
    expect(calls).not.toContain('BEGIN')
  })

  test('reassign fails closed when the target is retired even if status is idle', async () => {
    const calls: string[] = []
    const db = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('FROM agents')) {
          return { rows: [{ agent_id: 'lead-ama', status: 'idle', metadata: { retired: true }, retired: 'true' }] }
        }
        return { rows: [] }
      },
    }

    await expect(reassignPendingQueueRows(db, {
      fromAgentId: 'arc',
      toAgentId: 'lead-ama',
    })).rejects.toThrow('QUEUE_REPAIR_TARGET_UNAVAILABLE:lead-ama:idle')

    expect(calls).not.toContain('BEGIN')
  })

  test('close obsolete defaults to dry-run', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('FROM message_queue')) return { rows: [sample(3)] }
        return { rows: [] }
      },
    }

    const report = await closeObsoletePendingQueueRows(db, {
      agentId: 'lead-ama',
      reason: 'retired identity',
    })

    expect(report).toMatchObject({ action: 'close_obsolete', dry_run: true, affected_count: 2 })
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(false)
    expect(calls.join('\n')).not.toContain('UPDATE message_queue')
  })

  test('close obsolete writes audit on mutation', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('WITH before AS')) return { rows: [{ ...sample(3), status: 'skipped', before_status: 'pending' }] }
        return { rows: [] }
      },
    }

    const report = await closeObsoletePendingQueueRows(db, {
      agentId: 'lead-ama',
      reason: 'retired identity',
      dryRun: false,
    })

    expect(report).toMatchObject({ action: 'close_obsolete', dry_run: false, affected_count: 2 })
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(true)
    expect(calls.some((call) => call.sql.includes('INSERT INTO audit_log'))).toBe(true)
    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true)
    expect(calls.find((call) => call.sql.includes('WITH before AS'))?.params).toContain('OBSOLETE:retired identity')
  })

  test('close obsolete active rows requires an explicit queue id', async () => {
    const db = { async query() { return { rows: [] } } }

    await expect(closeObsoletePendingQueueRows(db, {
      agentId: 'codex-audit',
      reason: 'old claim',
      includeActive: true,
      dryRun: false,
    })).rejects.toThrow('QUEUE_REPAIR_INCLUDE_ACTIVE_REQUIRES_QUEUE_ID')
  })

  test('close obsolete can terminalize one explicit active row and refresh the agent', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        if (sql.includes('WITH before AS')) {
          return {
            rows: [{
              ...sample(73958, 'codex-audit'),
              status: 'skipped',
              before_status: 'received',
              total_count: 1,
            }],
          }
        }
        return { rows: [] }
      },
    }

    const report = await closeObsoletePendingQueueRows(db, {
      agentId: 'codex-audit',
      reason: 'ceo presence broadcast',
      queueId: '73958',
      includeActive: true,
      dryRun: false,
    })

    expect(report).toMatchObject({ action: 'close_obsolete', dry_run: false, affected_count: 1 })
    const mutation = calls.find((call) => call.sql.includes('WITH before AS'))
    expect(mutation?.sql).toContain("status IN ('pending', 'received', 'in_progress')")
    expect(mutation?.sql).toContain('claimed_by = NULL')
    expect(mutation?.sql).toContain('refreshed_agents AS')
    expect(mutation?.sql).toContain("WHEN a.status = 'busy' THEN 'idle'")
    expect(mutation?.sql).toContain('ELSE a.status')
    expect(mutation?.sql).toContain("WHEN a.status IN ('busy', 'idle') THEN NULL")
    expect(mutation?.params).toEqual(['codex-audit', '73958', 'OBSOLETE:ceo presence broadcast'])
    const audit = calls.find((call) => call.sql.includes('INSERT INTO audit_log'))
    expect(String(audit?.params?.[3])).toContain('"include_active":true')
    expect(String(audit?.params?.[3])).toContain('"before_statuses":{"received":1}')
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

    const report = await reclaimExpiredQueueClaims(db, { dryRun: false })

    expect(report).toMatchObject({ action: 'reclaim_expired', dry_run: false })
    const mutation = calls.find((call) => call.sql.includes('WITH reclaimed AS'))?.sql ?? ''
    expect(mutation).toContain('refreshed_agents AS')
    expect(mutation).toContain('SELECT DISTINCT agent_id FROM reclaimed')
    expect(mutation).toContain("WHEN a.status = 'busy' THEN 'idle'")
    expect(mutation).toContain('ELSE a.status')
    expect(mutation).not.toContain('id = ANY')
  })
})
