import { describe, expect, test } from 'bun:test'
import { StateDaemon } from '../core/state-daemon'
import type { DBClient, QueueWorkScheduler } from '../core/state-daemon/types'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
} from './contract/state-daemon/fakes'

class SingleRowDb implements DBClient {
  constructor(private readonly row: any) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes('FROM message_queue WHERE id = $1')) {
      if (String(this.row.id) === String(params?.[0])) {
        return { rows: [{ ...this.row }] as T[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }
}

describe('state_daemon queue work scheduler boundary', () => {
  test('received queue events schedule the runner without using tmux wake', async () => {
    const calls: Array<{ queueId: number; agentId: string }> = []
    const scheduler: QueueWorkScheduler = {
      async runReceived(input) {
        calls.push(input)
      },
    }
    const metrics = new FakeMetrics()
    const tmux = new FakeTmux()
    const daemon = new StateDaemon({
      db: new SingleRowDb({
        id: 489,
        agent_id: 'codex-audit',
        status: 'received',
        claim_expires_at: null,
        created_at: new Date('2026-05-21T00:00:00.000Z'),
        last_wake_attempt_at: null,
        last_heartbeat_at: null,
      }),
      pgListen: new FakePgListen(),
      tmux,
      clock: new FakeClock(),
      metrics,
      alert: new FakeAlertSink(),
      queueWorkScheduler: scheduler,
    })

    await daemon.start()
    try {
      await daemon.__testHandleEvent({
        op: 'UPDATE',
        id: 489,
        agent_id: 'codex-audit',
        status: 'received',
        claim_expires_at: null,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await daemon.stop()
    }

    expect(calls).toEqual([{ queueId: 489, agentId: 'codex-audit' }])
    expect(tmux.sentKeys).toEqual([])
    expect(metrics.countInc('state_daemon_queue_work_actions_total', {
      result: 'received_runner_invoked',
    })).toBe(1)
  })
})
