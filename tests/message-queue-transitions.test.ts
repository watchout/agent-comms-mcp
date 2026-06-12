import { describe, expect, test } from 'bun:test'
import {
  buildMessageQueueTransition,
  transitionMessageQueueStatus,
} from '../core/message-queue-transitions'

describe('message_queue transition helper', () => {
  test('transitions to pending always clear claim columns atomically', async () => {
    let captured: { sql: string; params?: unknown[] } | null = null
    const result = await transitionMessageQueueStatus({
      db: {
        async query(sql, params) {
          captured = { sql, params }
          return { rows: [], rowCount: 1 }
        },
      },
      queueId: 42,
      toStatus: 'pending',
      set: [{ column: 'last_wake_attempt_at', value: null }],
    })

    expect(result.rowCount).toBe(1)
    expect(captured?.params).toEqual(['pending', null, 42])
    expect(captured?.sql).toContain('status = $1')
    expect(captured?.sql).toContain('last_wake_attempt_at = $2')
    expect(captured?.sql).toContain('claimed_by = NULL')
    expect(captured?.sql).toContain('claimed_at = NULL')
    expect(captured?.sql).toContain('claim_expires_at = NULL')
    expect(captured?.sql).toContain('WHERE id = $3')
  })

  test('non-pending transitions clear claim columns only when requested', () => {
    const received = buildMessageQueueTransition({
      queueId: 7,
      toStatus: 'received',
      set: [{ column: 'read_at', value: 'now' }],
    })
    expect(received.sql).not.toContain('claimed_by = NULL')

    const done = buildMessageQueueTransition({
      queueId: 8,
      toStatus: 'done',
      clearClaim: true,
      set: [{ column: 'done_at', value: 'now' }],
      where: [{ sql: "status IN ('pending', 'received', 'in_progress')" }],
    })
    expect(done.params).toEqual(['done', 'now', 8])
    expect(done.sql).toContain('done_at = $2')
    expect(done.sql).toContain('claimed_by = NULL')
    expect(done.sql).toContain("status IN ('pending', 'received', 'in_progress')")
  })
})
