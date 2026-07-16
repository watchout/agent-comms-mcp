import type { DbAdapter } from '../db/adapter'

export type SupervisionUnitKind = 'seat' | 'outbox' | 'reconciler'

export type SupervisionStopCode =
  | 'UNIT_TIMEOUT'
  | 'RECONNECT_BUDGET_EXHAUSTED'
  | 'UNIT_PERMANENT_FAILURE'

export interface SeatSupervisionUnitV1<T = unknown> {
  unitId: string
  kind: SupervisionUnitKind
  seatId?: string
  adapterFactory: () => Promise<DbAdapter>
  run: (db: DbAdapter, signal: AbortSignal) => Promise<T>
  retryable?: (error: unknown) => boolean
}

export interface SeatSupervisionConfigV1 {
  units: SeatSupervisionUnitV1[]
  maxConcurrency: number
  unitTimeoutMs: number
  reconnectMaxAttempts: number
  reconnectBaseDelayMs: number
  reconnectMaxDelayMs: number
  jitterSeed?: number
  sleep?: (ms: number) => Promise<void>
}

export interface SeatSupervisionUnitReportV1 {
  unit_id: string
  kind: SupervisionUnitKind
  seat_id: string | null
  status: 'completed' | 'unhealthy_exit'
  attempts: number
  adapter_instances: number
  closed_adapters: number
  duration_ms: number
  stop_code: SupervisionStopCode | null
  error: string | null
  value?: unknown
}

export interface SeatSupervisionReportV1 {
  schema_version: 'aun-seat-supervision-report/v1'
  started_at: string
  completed_at: string
  units: SeatSupervisionUnitReportV1[]
  unhealthy_units: number
  global_exit: false
}

class UnitTimeoutError extends Error {
  readonly code = 'UNIT_TIMEOUT' as const
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jitter(seed: number, attempt: number, ceiling: number): number {
  if (ceiling <= 0) return 0
  let value = (seed ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  return (value >>> 0) % (ceiling + 1)
}

async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new UnitTimeoutError(`unit exceeded ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runWithReconnect<T>(input: {
  unit: SeatSupervisionUnitV1<T>
  timeoutMs: number
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitterSeed?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<SeatSupervisionUnitReportV1> {
  const started = performance.now()
  let adapters = 0
  let closed = 0
  let lastError: unknown
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    let db: DbAdapter | null = null
    try {
      db = await input.unit.adapterFactory()
      adapters += 1
      const value = await runWithTimeout(signal => input.unit.run(db!, signal), input.timeoutMs)
      await db.close()
      closed += 1
      return {
        unit_id: input.unit.unitId,
        kind: input.unit.kind,
        seat_id: input.unit.seatId ?? null,
        status: 'completed',
        attempts: attempt,
        adapter_instances: adapters,
        closed_adapters: closed,
        duration_ms: performance.now() - started,
        stop_code: null,
        error: null,
        value,
      }
    } catch (error) {
      lastError = error
      if (db) {
        try {
          await db.close()
        } finally {
          closed += 1
        }
      }
      if (error instanceof UnitTimeoutError) {
        return {
          unit_id: input.unit.unitId,
          kind: input.unit.kind,
          seat_id: input.unit.seatId ?? null,
          status: 'unhealthy_exit',
          attempts: attempt,
          adapter_instances: adapters,
          closed_adapters: closed,
          duration_ms: performance.now() - started,
          stop_code: 'UNIT_TIMEOUT',
          error: message(error),
        }
      }
      if (!(input.unit.retryable?.(error) ?? true)) {
        return {
          unit_id: input.unit.unitId,
          kind: input.unit.kind,
          seat_id: input.unit.seatId ?? null,
          status: 'unhealthy_exit',
          attempts: attempt,
          adapter_instances: adapters,
          closed_adapters: closed,
          duration_ms: performance.now() - started,
          stop_code: 'UNIT_PERMANENT_FAILURE',
          error: message(error),
        }
      }
      if (attempt < input.maxAttempts) {
        const exponential = Math.min(input.maxDelayMs, input.baseDelayMs * (2 ** (attempt - 1)))
        const wait = exponential + jitter(input.jitterSeed ?? 0, attempt, Math.floor(exponential / 4))
        await (input.sleep ?? delay)(wait)
      }
    }
  }
  return {
    unit_id: input.unit.unitId,
    kind: input.unit.kind,
    seat_id: input.unit.seatId ?? null,
    status: 'unhealthy_exit',
    attempts: input.maxAttempts,
    adapter_instances: adapters,
    closed_adapters: closed,
    duration_ms: performance.now() - started,
    stop_code: 'RECONNECT_BUDGET_EXHAUSTED',
    error: message(lastError),
  }
}

export async function runSeatSupervisorCycle(
  config: SeatSupervisionConfigV1,
): Promise<SeatSupervisionReportV1> {
  if (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1) {
    throw new RangeError('maxConcurrency must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.unitTimeoutMs) || config.unitTimeoutMs < 1) {
    throw new RangeError('unitTimeoutMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.reconnectMaxAttempts) || config.reconnectMaxAttempts < 1) {
    throw new RangeError('reconnectMaxAttempts must be a positive safe integer')
  }
  const ids = new Set<string>()
  for (const unit of config.units) {
    if (!unit.unitId || ids.has(unit.unitId)) throw new Error(`duplicate or empty supervision unit id ${unit.unitId}`)
    ids.add(unit.unitId)
  }

  const startedAt = new Date().toISOString()
  const reports = new Array<SeatSupervisionUnitReportV1>(config.units.length)
  const seatIndexes = config.units
    .map((unit, index) => ({ unit, index }))
    .filter(entry => entry.unit.kind === 'seat')
    .map(entry => entry.index)
  const independentIndexes = config.units
    .map((unit, index) => ({ unit, index }))
    .filter(entry => entry.unit.kind !== 'seat')
    .map(entry => entry.index)
  const runIndex = async (index: number) => {
    reports[index] = await runWithReconnect({
      unit: config.units[index],
      timeoutMs: config.unitTimeoutMs,
      maxAttempts: config.reconnectMaxAttempts,
      baseDelayMs: config.reconnectBaseDelayMs,
      maxDelayMs: config.reconnectMaxDelayMs,
      jitterSeed: config.jitterSeed,
      sleep: config.sleep,
    })
  }
  let cursor = 0
  const seatWorkers = Array.from({ length: Math.min(config.maxConcurrency, seatIndexes.length) }, async () => {
    while (true) {
      const seatCursor = cursor++
      if (seatCursor >= seatIndexes.length) return
      await runIndex(seatIndexes[seatCursor])
    }
  })
  // Outbox and reconciler are independent liveness units: a saturated or
  // hung bounded seat pool can never keep either one from starting.
  await Promise.all([...seatWorkers, ...independentIndexes.map(runIndex)])
  return {
    schema_version: 'aun-seat-supervision-report/v1',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    units: reports,
    unhealthy_units: reports.filter(report => report.status === 'unhealthy_exit').length,
    global_exit: false,
  }
}
