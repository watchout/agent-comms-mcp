import { createHash } from 'node:crypto'
import type { RuntimeMemoryReadyGateResult } from '../runtime-memory-ready'

type BackoffState = {
  fingerprint: string
  attempts: number
  next_evaluate_at_ms: number
}

export type MemoryReadyBlockTransition = {
  alert: boolean
  attempts: number
  retry_delay_ms: number
  next_evaluate_at: string
  fingerprint: string
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) out[key] = stable(child)
    }
    return out
  }
  return value
}

export function memoryReadyBlockedFingerprint(gate: RuntimeMemoryReadyGateResult): string {
  const body = JSON.stringify(stable({
    reason: gate.reason,
    runtime_instance_id: gate.runtime_instance_id,
    evidence_id: gate.evidence_id,
    details: gate.details,
  }))
  return createHash('sha256').update(body).digest('hex')
}

export class MemoryReadyBackoff {
  private readonly states = new Map<number, BackoffState>()

  constructor(
    private readonly baseMs: number,
    private readonly capMs: number,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isSafeInteger(baseMs) || baseMs <= 0 || !Number.isSafeInteger(capMs) || capMs < baseMs
      || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('MEMORY_READY_BACKOFF_CONFIG_INVALID')
    }
  }

  shouldEvaluate(queueId: number, now: Date): boolean {
    const state = this.states.get(queueId)
    return !state || now.getTime() >= state.next_evaluate_at_ms
  }

  recordBlocked(queueId: number, gate: RuntimeMemoryReadyGateResult, now: Date): MemoryReadyBlockTransition {
    const fingerprint = memoryReadyBlockedFingerprint(gate)
    const previous = this.states.get(queueId)
    const attempts = previous?.fingerprint === fingerprint ? previous.attempts + 1 : 1
    const exponent = Math.min(attempts - 1, 30)
    const retryDelay = Math.min(this.capMs, this.baseMs * (2 ** exponent))
    const nextEvaluateAtMs = now.getTime() + retryDelay
    this.states.delete(queueId)
    this.states.set(queueId, { fingerprint, attempts, next_evaluate_at_ms: nextEvaluateAtMs })
    while (this.states.size > this.maxEntries) {
      const oldest = this.states.keys().next().value
      if (oldest === undefined) break
      this.states.delete(oldest)
    }
    return {
      alert: previous?.fingerprint !== fingerprint,
      attempts,
      retry_delay_ms: retryDelay,
      next_evaluate_at: new Date(nextEvaluateAtMs).toISOString(),
      fingerprint,
    }
  }

  recordReady(queueId: number): boolean {
    return this.states.delete(queueId)
  }

  forget(queueId: number): void {
    this.states.delete(queueId)
  }
}
