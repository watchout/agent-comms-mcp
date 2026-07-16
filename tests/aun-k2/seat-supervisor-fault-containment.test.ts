import { describe, expect, test } from 'bun:test'
import type { DbAdapter } from '../../core/db/adapter'
import { runSeatSupervisorCycle } from '../../core/eventlog/seat-supervisor'

interface FakeAdapter extends DbAdapter {
  readonly connectionId: string
  readonly mutations: Array<{ owner: string; cycle: number; at: number }>
  closed: boolean
}

function adapter(connectionId: string): FakeAdapter {
  return {
    connectionId,
    mutations: [],
    closed: false,
    dialect: 'sqlite',
    async query() { return [] },
    async queryOne() { return null },
    async execute(_sql, params) {
      const [owner, cycle, at] = params ?? []
      if (typeof owner === 'string' && typeof cycle === 'number' && typeof at === 'number') {
        this.mutations.push({ owner, cycle, at })
      }
      return { rowCount: 0 }
    },
    async transaction<T>(fn: (tx: DbAdapter) => Promise<T>) { return fn(this) },
    async close() { this.closed = true },
  }
}

describe('K2 seat supervisor fault containment', () => {
  test('K2-SUPERVISOR-NONCOOPERATIVE-TIMEOUT-001 revokes late DB authority before terminal report', async () => {
    const raw = adapter('alpha:noncooperative')
    let lateRejections = 0
    let mutationsAfterClose = 0
    const originalExecute = raw.execute.bind(raw)
    raw.execute = async (sql, params) => {
      if (raw.closed) mutationsAfterClose += 1
      raw.mutations.push({ owner: 'alpha', cycle: 1, at: performance.now() })
      return originalExecute(sql, params)
    }

    const report = await runSeatSupervisorCycle({
      units: [{
        unitId: 'seat:alpha', kind: 'seat', seatId: 'alpha', adapterFactory: async () => raw,
        run: async db => {
          await new Promise(resolve => setTimeout(resolve, 30))
          try {
            await db.execute('UPDATE forbidden_late_mutation SET value = 1')
          } catch {
            lateRejections += 1
          }
          return { ignored_abort: true }
        },
      }],
      maxConcurrency: 1,
      unitTimeoutMs: 5,
      reconnectMaxAttempts: 1,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
    })

    const alpha = report.units[0]
    expect(alpha.status).toBe('unhealthy_exit')
    expect(alpha.stop_code).toBe('UNIT_TIMEOUT')
    expect(raw.closed).toBeTrue()
    expect(raw.mutations).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(lateRejections).toBe(1)
    expect(raw.mutations).toHaveLength(0)
    expect(mutationsAfterClose).toBe(0)
  })

  test('K2-TC-009 hung alpha does not delay beta or outbox deterministic cycles', async () => {
    const instances = new Map<string, FakeAdapter[]>()
    const started = performance.now()
    const factory = (id: string) => async () => {
      const db = adapter(`${id}:${(instances.get(id)?.length ?? 0) + 1}`)
      instances.set(id, [...(instances.get(id) ?? []), db])
      return db
    }
    const runCycles = (owner: string) => async (db: DbAdapter) => {
      let lastAt = 0
      for (let cycle = 1; cycle <= 100; cycle++) {
        lastAt = performance.now() - started
        await db.execute('SELECT $1::text, $2::int, $3::float8', [owner, cycle, lastAt])
        await Promise.resolve()
      }
      return { completed: 100, last_at_ms: lastAt }
    }

    const report = await runSeatSupervisorCycle({
      units: [
        {
          unitId: 'seat:alpha', kind: 'seat', seatId: 'alpha', adapterFactory: factory('seat:alpha'),
          run: async (_db, signal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('alpha aborted')), { once: true })
          }),
        },
        { unitId: 'seat:beta', kind: 'seat', seatId: 'beta', adapterFactory: factory('seat:beta'), run: runCycles('beta') },
        { unitId: 'outbox:v2', kind: 'outbox', adapterFactory: factory('outbox:v2'), run: runCycles('outbox') },
      ],
      maxConcurrency: 2,
      unitTimeoutMs: 5_000,
      reconnectMaxAttempts: 1,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
      jitterSeed: 20260716,
    })

    const alpha = report.units.find(unit => unit.unit_id === 'seat:alpha')!
    const beta = report.units.find(unit => unit.unit_id === 'seat:beta')!
    const outbox = report.units.find(unit => unit.unit_id === 'outbox:v2')!
    expect(alpha.status).toBe('unhealthy_exit')
    expect(alpha.stop_code).toBe('UNIT_TIMEOUT')
    expect(beta.status).toBe('completed')
    expect(outbox.status).toBe('completed')
    expect((beta.value as { completed: number }).completed).toBe(100)
    expect((outbox.value as { completed: number }).completed).toBe(100)
    expect((beta.value as { last_at_ms: number }).last_at_ms).toBeLessThanOrEqual(100)
    expect((outbox.value as { last_at_ms: number }).last_at_ms).toBeLessThanOrEqual(100)
    expect(instances.get('seat:alpha')![0].mutations).toHaveLength(0)
    expect(instances.get('seat:beta')![0].mutations.every(mutation => mutation.owner === 'beta')).toBeTrue()
    expect(instances.get('outbox:v2')![0].mutations.every(mutation => mutation.owner === 'outbox')).toBeTrue()
    expect(new Set([...instances.values()].flat().map(db => db.connectionId)).size).toBe(3)
    expect([...instances.values()].flat().every(db => db.closed)).toBeTrue()
    expect(report.global_exit).toBeFalse()
  }, 6_000)

  test('K2-TC-010 one exhausted seat is unhealthy while beta remains healthy', async () => {
    const adapters: FakeAdapter[] = []
    const report = await runSeatSupervisorCycle({
      units: [
        {
          unitId: 'seat:alpha', kind: 'seat', seatId: 'alpha',
          adapterFactory: async () => {
            const db = adapter(`alpha:${adapters.length + 1}`)
            adapters.push(db)
            return db
          },
          run: async () => { throw new Error('simulated retryable connection failure') },
          retryable: () => true,
        },
        {
          unitId: 'seat:beta', kind: 'seat', seatId: 'beta',
          adapterFactory: async () => {
            const db = adapter('beta:1')
            adapters.push(db)
            return db
          },
          run: async () => ({ state: 'running' }),
        },
      ],
      maxConcurrency: 2,
      unitTimeoutMs: 1_000,
      reconnectMaxAttempts: 3,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 4,
      jitterSeed: 20260716,
      sleep: async () => {},
    })
    const alpha = report.units.find(unit => unit.unit_id === 'seat:alpha')!
    const beta = report.units.find(unit => unit.unit_id === 'seat:beta')!
    expect(alpha.status).toBe('unhealthy_exit')
    expect(alpha.stop_code).toBe('RECONNECT_BUDGET_EXHAUSTED')
    expect(alpha.attempts).toBe(3)
    expect(beta.status).toBe('completed')
    expect(beta.attempts - 1).toBe(0)
    expect(report.global_exit).toBeFalse()
    expect(adapters.every(db => db.closed)).toBeTrue()
  })
})
