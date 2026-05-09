/**
 * Subprocess wake pool with dynamic capacity (spec v0.6 §5.2 / R5、補強 #2).
 *
 * - Active job count strictly ≤ capacity (semaphore semantic).
 * - When capacity is exhausted and queue depth crosses
 *   `wakePoolQueueHighWatermark`, capacity grows by `wakePoolGrowStep` up to
 *   `wakePoolMaxCapacity`.
 * - When the queue empties and capacity > `wakePoolMinCapacity`, each finished
 *   job step-shrinks the pool (capacity-- by `wakePoolShrinkStep`).
 * - Saturation (capacity at MAX + queue overflow) → metric inc + alert.
 *
 * Pure async; no DB / tmux dependency. Tested via T20 / T24 / T25.
 */
import type { Metrics, AlertSink, StateDaemonConfig } from './types'

export interface WakeJob {
  exec(): Promise<void>
}

export interface WakePoolDeps {
  config: Pick<
    StateDaemonConfig,
    | 'wakePoolMinCapacity'
    | 'wakePoolMaxCapacity'
    | 'wakePoolGrowStep'
    | 'wakePoolShrinkStep'
    | 'wakePoolQueueHighWatermark'
  >
  metrics: Metrics
  alert: AlertSink
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export class WakePool {
  private active = 0
  private capacity: number
  private readonly waiters: Array<() => void> = []
  private alertedSaturated = false

  constructor(private deps: WakePoolDeps) {
    this.capacity = deps.config.wakePoolMinCapacity
  }

  get currentCapacity(): number {
    return this.capacity
  }
  get queuedDepth(): number {
    return this.waiters.length
  }
  get activeCount(): number {
    return this.active
  }

  /**
   * Run a job. Resolves when the job's exec completes; if pool is full, awaits
   * a free slot. Grows capacity if queued depth > high watermark.
   */
  async run(job: WakeJob): Promise<void> {
    if (this.active >= this.capacity) {
      // queue and possibly grow before we wait
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        if (this.waiters.length > this.deps.config.wakePoolQueueHighWatermark) {
          this.maybeGrow()
        }
      })
    }
    this.active++
    try {
      await job.exec()
    } finally {
      this.active--
      this.maybeShrink()
      const next = this.waiters.shift()
      if (next) next()
    }
  }

  private maybeGrow(): void {
    const { wakePoolMaxCapacity, wakePoolGrowStep } = this.deps.config
    if (this.capacity < wakePoolMaxCapacity) {
      const before = this.capacity
      this.capacity = Math.min(this.capacity + wakePoolGrowStep, wakePoolMaxCapacity)
      this.deps.log?.('wake_pool_grown', { new_capacity: this.capacity })
      this.alertedSaturated = false
      // Release waiters into the freshly-created slots so the added headroom
      // takes effect now, not after in-flight jobs finish — matches CTO
      // intent ("load 応じた wake 並列度") and the T24 fixture expectation.
      const slots = this.capacity - before
      for (let i = 0; i < slots; i++) {
        const next = this.waiters.shift()
        if (!next) break
        next()
      }
    } else if (!this.alertedSaturated) {
      this.deps.metrics.inc('state_daemon_wake_pool_saturated_total')
      void this.deps.alert.alert(
        `wake_pool saturated at MAX capacity ${wakePoolMaxCapacity}, queued=${this.waiters.length}`,
      )
      this.alertedSaturated = true
    }
  }

  private maybeShrink(): void {
    const { wakePoolMinCapacity, wakePoolShrinkStep } = this.deps.config
    if (this.waiters.length === 0 && this.capacity > wakePoolMinCapacity) {
      this.capacity = Math.max(this.capacity - wakePoolShrinkStep, wakePoolMinCapacity)
    }
  }
}
