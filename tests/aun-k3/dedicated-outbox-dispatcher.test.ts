import { describe, expect, test } from 'bun:test'
import type { DbAdapter } from '../../core/db/adapter'
import { runSeatSupervisorCycle } from '../../core/eventlog/seat-supervisor'

interface FixtureAdapter extends DbAdapter {
  id: string
  closed: boolean
}

function adapter(id: string): FixtureAdapter {
  return {
    id, closed: false, dialect: 'sqlite',
    async query() { return [] }, async queryOne() { return null },
    async execute() { return { rowCount: 0 } },
    async transaction<T>(fn: (tx: DbAdapter) => Promise<T>) { return fn(this) },
    async close() { this.closed = true },
  }
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

describe('K3 dedicated dispatcher liveness', () => {
  test('TC012 a hung seat cannot delay 100 dispatcher cycles or share its DB adapter', async () => {
    const seatDb = adapter('seat-db')
    const dispatcherDb = adapter('dispatcher-db')
    const reconcilerDb = adapter('reconciler-db')
    const cycleLatency: number[] = []
    const overallStart = performance.now()
    const report = await runSeatSupervisorCycle({
      units: [
        {
          unitId: 'seat:hung', kind: 'seat', seatId: 'hung', adapterFactory: async () => seatDb,
          run: async () => new Promise(() => {}),
        },
        {
          unitId: 'outbox:k3', kind: 'outbox', adapterFactory: async () => dispatcherDb,
          run: async db => {
            for (let cycle = 0; cycle < 100; cycle += 1) {
              const started = performance.now()
              await db.query('SELECT 1')
              cycleLatency.push(performance.now() - started)
            }
            return { cycles: 100 }
          },
        },
        {
          unitId: 'reconciler:k3', kind: 'reconciler', adapterFactory: async () => reconcilerDb,
          run: async db => {
            await db.query('SELECT 1')
            return { cycles: 1 }
          },
        },
      ],
      maxConcurrency: 1, unitTimeoutMs: 30, reconnectMaxAttempts: 1,
      reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 1,
    })
    const outbox = report.units.find(unit => unit.unit_id === 'outbox:k3')!
    expect(outbox.status).toBe('completed')
    expect((outbox.value as { cycles: number }).cycles).toBe(100)
    expect(cycleLatency).toHaveLength(100)
    expect(percentile95(cycleLatency)).toBeLessThanOrEqual(100)
    expect(performance.now() - overallStart).toBeLessThan(200)
    expect(new Set([seatDb.id, dispatcherDb.id, reconcilerDb.id]).size).toBe(3)
  })
})
