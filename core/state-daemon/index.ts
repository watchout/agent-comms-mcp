/**
 * StateDaemon — queue-state-driven dispatch supervisor (Issue #323, spec v0.6).
 *
 * Replaces `bin/wake-daemon.ts` with a single daemon that:
 *   - Subscribes to `pg_notify('queue_event')` for immediate dispatch (§6.2).
 *   - Runs a 30s cron sweep over message_queue rows for §4.3 row 2-6.
 *   - Refreshes claim TTLs every 30s for live `agents.status='online'` bots
 *     holding `read` rows (§5.1 / R4 / 補強 #1).
 *   - Polls `agents.last_seen_at` every 30s; restarts TUI bots with missing
 *     tmux sessions (§5.4 / R7 / 補強 #5), with a 1h/N rate limit (F8).
 *   - Manages a dynamic-capacity wake pool (§5.2 / 補強 #2).
 *   - Emits abnormal-activity alerts (§10.3 / 「出てから制御」).
 *
 * All public methods are idempotent (§1.4 invariants). DI per §1.2 — clock,
 * metrics, alert, tmux, db, pg-listen are injected for test fakes.
 *
 * Forbidden behaviors (§3 F1-F12 enforced by code review + this comment):
 *   F1 prevention checks (chain analysis / pair detection / ack pattern /
 *      rate limit) are NOT implemented here. TUI 統一 + B4 system prompt +
 *      reactive control 担当. 再導入 PR は block.
 *   F5 SIG runtime に wake 試行 path 禁止 — `wakeRow` throws on non-TUI.
 *   F6 wake-daemon 並行稼働中の重複 wake は許容 (idempotent + duplicate
 *      suppression で吸収).
 *   F7 既 expired claim の TTL 延長禁止 — heartbeat は `claim_expires_at >
 *      now()` の row のみ update.
 *   F8 bot restart 1h N 回上限超で抑止 + CEO escalate alert.
 *   F12 `bot_registry` table / `bot-registry.txt` の参照禁止 — `agents`
 *      table が SoT (CTO 検証済).
 */
import {
  AlreadyStartedError,
  BotRestartLimitError,
  DEFAULT_CONFIG,
  DBConnectionError,
  TmuxSendKeysError,
  type AlertSink,
  type Clock,
  type DBClient,
  type LivenessResult,
  type Metrics,
  type PgListenClient,
  type QueueEvent,
  type RefreshResult,
  type StateDaemonConfig,
  type StateDaemonDeps,
  type SweepResult,
  type TmuxClient,
} from './types'
import { WakePool } from './wake-pool'

interface QueueRow {
  id: number
  agent_id: string
  status: string
  claim_expires_at: Date | null
  created_at: Date
  last_wake_attempt_at: Date | null
  last_heartbeat_at: Date | null
  failed_reason: string | null
  attempts?: number | null
}

interface AgentRow {
  agent_id: string
  runtime: string | null
  status: string | null
  tmux_session: string | null
  last_seen_at: Date | null
}

interface RestartRecord {
  /** Restart timestamps within the last hour, oldest first. */
  recent: Date[]
}

export class StateDaemon {
  private readonly db: DBClient
  private readonly pgListen: PgListenClient
  private readonly tmux: TmuxClient
  private readonly clock: Clock
  private readonly metrics: Metrics
  private readonly alert: AlertSink
  private readonly config: StateDaemonConfig
  private readonly wakePool: WakePool

  private status: 'stopped' | 'running' | 'stopping' = 'stopped'
  private dbErrorStreak = 0
  private readonly restartHistory = new Map<string, RestartRecord>()
  private readonly inflightWakes = new Set<Promise<void>>()
  private readonly intervalHandles: ReturnType<typeof setInterval>[] = []

  constructor(deps: StateDaemonDeps) {
    this.db = deps.db
    this.pgListen = deps.pgListen
    this.tmux = deps.tmux
    this.clock = deps.clock
    this.metrics = deps.metrics
    this.alert = deps.alert
    this.config = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) }
    this.wakePool = new WakePool({
      config: this.config,
      metrics: this.metrics,
      alert: this.alert,
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the daemon: establish LISTEN, schedule cron / heartbeat / liveness
   * intervals. Idempotent only via the AlreadyStartedError throw — calling
   * start twice is a programming error, not a no-op (§1.2).
   */
  async start(): Promise<void> {
    if (this.status !== 'stopped') {
      throw new AlreadyStartedError()
    }
    this.status = 'running'

    await this.pgListen.listen('queue_event', (raw) => {
      try {
        const ev = JSON.parse(raw) as QueueEvent
        const lagStart = this.clock.now().getTime()
        // fire-and-forget; latency observed in handler
        void this.handleQueueEvent(ev).then(() => {
          const lag = this.clock.now().getTime() - lagStart
          this.metrics.observe('state_daemon_pg_notify_lag_ms', lag)
        })
      } catch (err) {
        this.metrics.inc('state_daemon_invalid_payload_total')
      }
    })

    this.intervalHandles.push(
      setInterval(
        () => void this.sweepStale().catch((e) => this.recordDbError(e)),
        this.config.pollSweepIntervalMs,
      ),
    )
    this.intervalHandles.push(
      setInterval(
        () => void this.refreshClaims().catch((e) => this.recordDbError(e)),
        this.config.heartbeatIntervalMs,
      ),
    )
    this.intervalHandles.push(
      setInterval(
        () => void this.checkBotLiveness().catch((e) => this.recordDbError(e)),
        this.config.botLivenessCheckIntervalMs,
      ),
    )
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return
    this.status = 'stopping'
    for (const h of this.intervalHandles) clearInterval(h)
    this.intervalHandles.length = 0
    // Wait up to 5s for in-flight wake jobs to finish (§1.2 invariants).
    const deadline = this.clock.now().getTime() + 5000
    while (this.inflightWakes.size > 0 && this.clock.now().getTime() < deadline) {
      await Promise.race([
        Promise.all(Array.from(this.inflightWakes)),
        new Promise((r) => setTimeout(r, 50)),
      ])
    }
    await this.pgListen.unlisten()
    this.status = 'stopped'
  }

  // ── Queue event handler (§4.3 row 1, pg_notify path) ───────────────────────

  /**
   * Process a single pg_notify event. Re-fetches the row to avoid stale
   * snapshots, then dispatches per §4.3 (typically row 1 — new pending → wake).
   * Other rows fall through to sweepStale, which is the SoT for batch.
   */
  async handleQueueEvent(event: QueueEvent): Promise<void> {
    if (this.status !== 'running') return
    const { rows } = await this.dbQuery<QueueRow>(
      `SELECT id, agent_id, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at, failed_reason
         FROM message_queue WHERE id = $1`,
      [event.id],
    )
    const row = rows[0]
    if (!row) return // row may have been deleted

    if (row.status === 'pending') {
      await this.runWakeIfNotSuppressed(row, /* dedupResult */ 'dedup_skipped')
    }
    // For other status values, the cron sweep handles (idempotent overlap OK).
  }

  // ── Cron sweep (§4.3 row 2-6) ──────────────────────────────────────────────

  async sweepStale(): Promise<SweepResult> {
    if (this.status !== 'running') {
      return { scanned: 0, rewoken: 0, reclaimed: 0, abandonReset: 0, permanentlyFailed: 0, durationMs: 0, budgetWarn: false }
    }
    const t0 = this.clock.now().getTime()
    const result: SweepResult = {
      scanned: 0, rewoken: 0, reclaimed: 0, abandonReset: 0, permanentlyFailed: 0, durationMs: 0, budgetWarn: false,
    }

    // priority order per T15: row 3 (read-expired) > row 2 (pending-stale)
    const expired = await this.fetchReadExpired()
    for (const row of expired) {
      result.scanned++
      await this.reclaimRow(row)
      result.reclaimed++
    }

    const stale = await this.fetchPendingStale()
    for (const row of stale) {
      // Skip if same row was already handled as read-expired this tick
      if (expired.some((e) => e.id === row.id)) continue
      result.scanned++
      const acted = await this.runWakeIfNotSuppressed(row, 'dedup_skipped')
      if (acted) result.rewoken++
    }

    const abandon = await this.fetchAbandonRecent()
    for (const row of abandon) {
      result.scanned++
      await this.dbQuery(
        `UPDATE message_queue SET status='pending', failed_reason=NULL WHERE id=$1`,
        [row.id],
      )
      result.abandonReset++
    }

    // §4.3 row 5+6: stuck pending OR stuck read both → STALE_DISPATCH (v0.5
    // 単一固定 per α). The schema has no `attempts` column, so the "attempts
    // >= max" clause from row 5 is interpreted age-based (read row that has
    // been parked beyond stuckAfter is functionally indistinguishable from a
    // max-attempts loop and tripping the same terminal handles both).
    const stuck = await this.fetchStuck()
    const seenStuckIds = new Set<number>()
    for (const row of stuck) {
      if (seenStuckIds.has(row.id)) continue
      seenStuckIds.add(row.id)
      // Skip rows we already terminally handled this tick via reclaim/abandon
      // paths — they're already in `pending` again, the stuck branch should
      // not bounce them straight to failed.
      if (
        expired.some((e) => e.id === row.id) ||
        abandon.some((a) => a.id === row.id)
      ) continue
      result.scanned++
      await this.failPermanently(row, 'STALE_DISPATCH', `stale beyond ${this.config.stuckAfter}`)
      result.permanentlyFailed++
    }

    result.durationMs = this.clock.now().getTime() - t0
    this.metrics.observe('state_daemon_sweep_duration_ms', result.durationMs)
    if (result.durationMs > this.config.budgetWarnMs) {
      result.budgetWarn = true
    }
    return result
  }

  // ── Heartbeat (§5.1 / R4 / 補強 #1) ────────────────────────────────────────

  async refreshClaims(): Promise<RefreshResult> {
    if (this.status !== 'running') return { refreshed: 0, skipped: 0 }
    let sql = `UPDATE message_queue mq
          SET claim_expires_at = $1::timestamptz + ($2 || ' seconds')::interval,
              last_heartbeat_at = $1::timestamptz
        WHERE mq.status = 'read'
          AND mq.claim_expires_at > $1::timestamptz
          AND EXISTS (
            SELECT 1 FROM agents a
             WHERE a.agent_id = mq.agent_id AND a.status = 'online'
          )`
    const params: unknown[] = [this.clock.now(), this.config.claimTtlSec]
    if (this.config.agentIdPrefix) {
      sql += ` AND mq.agent_id LIKE $3`
      params.push(this.config.agentIdPrefix + '%')
    }
    const { rowCount } = await this.dbQuery(sql, params)
    this.metrics.inc('state_daemon_heartbeat_refresh_total', { result: 'ok' }, rowCount)
    return { refreshed: rowCount, skipped: 0 }
  }

  // ── Bot liveness (§5.4 / R7 / 補強 #5) ─────────────────────────────────────

  async checkBotLiveness(): Promise<LivenessResult> {
    if (this.status !== 'running') return { checked: 0, restarted: 0, escalated: 0 }
    let sql = `SELECT agent_id, runtime, status, (metadata->>'tmux_session') AS tmux_session, last_seen_at FROM agents`
    const params: unknown[] = []
    if (this.config.agentIdPrefix) {
      sql += ` WHERE agent_id LIKE $1`
      params.push(this.config.agentIdPrefix + '%')
    }
    const { rows } = await this.dbQuery<AgentRow>(sql, params)
    const result: LivenessResult = { checked: 0, restarted: 0, escalated: 0 }
    const now = this.clock.now().getTime()
    for (const bot of rows) {
      result.checked++
      const lastSeen = bot.last_seen_at ? new Date(bot.last_seen_at).getTime() : 0
      const stale = now - lastSeen
      if (stale <= this.config.botDeadThresholdMs) continue
      if (bot.runtime !== 'TUI' || !bot.tmux_session) {
        await this.alert.alert(
          `bot ${bot.agent_id} dead (runtime=${bot.runtime}, manual intervention)`,
        )
        result.escalated++
        continue
      }
      const exists = await this.tmux.sessionExists(bot.tmux_session)
      if (exists) continue

      if (this.exceededRestartLimit(bot.agent_id)) {
        this.metrics.inc('state_daemon_bot_dead_total', { agent_id: bot.agent_id })
        await this.alert.alert(
          `bot ${bot.agent_id} restart loop limit reached — CEO escalate (limit ${this.config.botRestartMaxPerHour}/hour)`,
        )
        result.escalated++
        continue
      }
      try {
        await this.tmux.restartSession(bot.agent_id)
        this.recordRestart(bot.agent_id)
        await this.dbQuery(
          `UPDATE agents SET status='restarting' WHERE agent_id=$1 AND status='online'`,
          [bot.agent_id],
        )
        this.metrics.inc('state_daemon_bot_restarts_total', { agent_id: bot.agent_id })
        await this.alert.alert(`bot ${bot.agent_id} restarted (tmux session missing)`)
        result.restarted++
      } catch (err) {
        await this.alert.alert(
          `bot ${bot.agent_id} restart failed: ${(err as Error).message ?? String(err)}`,
        )
        result.escalated++
      }
    }
    return result
  }

  // ── Wake execution + duplicate suppression ─────────────────────────────────

  /**
   * Attempt to wake a row. Returns `true` if a tmux send-keys was issued,
   * `false` if duplicate-suppressed. Throws TmuxSendKeysError on tmux failure
   * (caller decides recovery).
   */
  private async runWakeIfNotSuppressed(
    row: QueueRow,
    dedupResultLabel: string,
  ): Promise<boolean> {
    const now = this.clock.now()
    if (row.last_wake_attempt_at) {
      const sinceLast = (now.getTime() - new Date(row.last_wake_attempt_at).getTime()) / 1000
      if (sinceLast < this.config.wakeDuplicateSuppressSec) {
        this.metrics.inc('state_daemon_wake_actions_total', { result: dedupResultLabel })
        return false
      }
    }
    const runPromise = this.wakePool.run({ exec: () => this.executeWake(row, now) })
    this.inflightWakes.add(runPromise)
    try {
      await runPromise
      return true
    } finally {
      this.inflightWakes.delete(runPromise)
    }
  }

  private async executeWake(row: QueueRow, now: Date): Promise<void> {
    const { rows } = await this.dbQuery<AgentRow>(
      `SELECT agent_id, runtime, (metadata->>'tmux_session') AS tmux_session, last_seen_at, status FROM agents WHERE agent_id=$1`,
      [row.agent_id],
    )
    const bot = rows[0]
    if (!bot) {
      await this.alert.alert(`wake target ${row.agent_id} not in agents table`)
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'agent_missing' })
      return
    }
    if (bot.runtime !== 'TUI') {
      // §6.3 / R8 / F5 — SIG runtime に wake 試行は throw + DB fail.
      await this.failPermanently(row, 'WAKE_FAILED', `SIG mode 廃止済、TUI のみ allowed (got ${bot.runtime})`)
      await this.alert.alert(`SIG mode wake attempt blocked: ${row.agent_id} (runtime=${bot.runtime})`)
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'sig_blocked' })
      throw new Error(`SIG mode 廃止済、TUI のみ allowed (got ${bot.runtime})`)
    }
    if (!bot.tmux_session) {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'no_tmux_session' })
      return
    }
    try {
      await this.tmux.sendKeys(bot.tmux_session, 'check inbox\n')
    } catch (err) {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'tmux_error' })
      throw new TmuxSendKeysError((err as Error).message ?? String(err))
    }
    await this.dbQuery(
      `UPDATE message_queue SET last_wake_attempt_at=$1 WHERE id=$2`,
      [now, row.id],
    )
    this.metrics.inc('state_daemon_wake_actions_total', { result: 'ok' })
  }

  // ── State transition helpers (§4.3) ────────────────────────────────────────

  private async reclaimRow(row: QueueRow): Promise<void> {
    const newExpiry = new Date(this.clock.now().getTime() + this.config.claimTtlSec * 1000)
    await this.dbQuery(
      `UPDATE message_queue
          SET status='pending', claim_expires_at=$1, claimed_by=NULL, claimed_at=NULL
        WHERE id=$2`,
      [newExpiry, row.id],
    )
    this.metrics.inc('state_daemon_wake_actions_total', { result: 'reclaimed' })
    // After reclaim, re-wake (T10 expects sendKeys 1).
    await this.runWakeIfNotSuppressed({ ...row, status: 'pending', last_wake_attempt_at: null }, 'dedup_skipped')
  }

  private async failPermanently(row: QueueRow, reason: string, detail: string): Promise<void> {
    await this.dbQuery(
      `UPDATE message_queue SET status='failed', failed_reason=$1 WHERE id=$2`,
      [reason, row.id],
    )
    await this.alert.alert(`row ${row.id} permanently failed: ${reason} (${detail}) — max_attempts or stale`)
    this.metrics.inc('state_daemon_wake_actions_total', { result: 'permanently_failed' })
  }

  // ── Sweep fetch helpers ────────────────────────────────────────────────────

  /**
   * Test-only scope filter. Returns the SQL fragment + params suffix so each
   * fetch helper can append it. In production (`agentIdPrefix` null) returns
   * `''` and no extra params — zero behavioural impact.
   */
  private prefixClause(): { sql: string; params: unknown[] } {
    if (!this.config.agentIdPrefix) return { sql: '', params: [] }
    return { sql: ` AND agent_id LIKE $__::text`, params: [this.config.agentIdPrefix + '%'] }
  }

  private async fetchPendingStale(): Promise<QueueRow[]> {
    const prefix = this.config.agentIdPrefix ? ` AND agent_id LIKE $3` : ''
    const params: unknown[] = [this.clock.now(), this.config.pendingStaleAfter, this.config.batchLimit]
    let sql = `SELECT id, agent_id, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at, failed_reason
         FROM message_queue
        WHERE status='pending'
          AND created_at < $1::timestamptz - ($2)::interval`
    if (this.config.agentIdPrefix) {
      sql += ` AND agent_id LIKE $4`
      params.push(this.config.agentIdPrefix + '%')
    }
    sql += ` ORDER BY created_at LIMIT $3`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchReadExpired(): Promise<QueueRow[]> {
    let sql = `SELECT id, agent_id, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at, failed_reason
         FROM message_queue
        WHERE status='read' AND claim_expires_at < $1::timestamptz`
    const params: unknown[] = [this.clock.now(), this.config.batchLimit]
    if (this.config.agentIdPrefix) {
      sql += ` AND agent_id LIKE $3`
      params.push(this.config.agentIdPrefix + '%')
    }
    sql += ` ORDER BY claim_expires_at LIMIT $2`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchAbandonRecent(): Promise<QueueRow[]> {
    let sql = `SELECT id, agent_id, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at, failed_reason
         FROM message_queue
        WHERE status='failed'
          AND failed_reason='IMPLICIT_ABANDON'
          AND claim_expires_at > $1::timestamptz - ($2)::interval`
    const params: unknown[] = [this.clock.now(), this.config.abandonRecent, this.config.batchLimit]
    if (this.config.agentIdPrefix) {
      sql += ` AND agent_id LIKE $4`
      params.push(this.config.agentIdPrefix + '%')
    }
    sql += ` LIMIT $3`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchStuck(): Promise<QueueRow[]> {
    // §4.3 row 5 (read stale, max_attempts proxy via age) + row 6 (pending
    // stuck) — both terminate as STALE_DISPATCH (v0.5 単一固定).
    let sql = `SELECT id, agent_id, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at, failed_reason
         FROM message_queue
        WHERE status IN ('pending', 'read')
          AND created_at < $1::timestamptz - ($2)::interval`
    const params: unknown[] = [this.clock.now(), this.config.stuckAfter, this.config.batchLimit]
    if (this.config.agentIdPrefix) {
      sql += ` AND agent_id LIKE $4`
      params.push(this.config.agentIdPrefix + '%')
    }
    sql += ` LIMIT $3`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  // ── Restart rate limiter (§5.4 / F8) ───────────────────────────────────────

  private exceededRestartLimit(agentId: string): boolean {
    const rec = this.restartHistory.get(agentId)
    if (!rec) return false
    const now = this.clock.now().getTime()
    rec.recent = rec.recent.filter((t) => now - t.getTime() < 3_600_000)
    return rec.recent.length >= this.config.botRestartMaxPerHour
  }

  private recordRestart(agentId: string): void {
    const rec = this.restartHistory.get(agentId) ?? { recent: [] }
    const now = this.clock.now()
    rec.recent = rec.recent.filter((t) => now.getTime() - t.getTime() < 3_600_000)
    rec.recent.push(now)
    this.restartHistory.set(agentId, rec)
  }

  // ── DB error tracking ──────────────────────────────────────────────────────

  private async dbQuery<T = any>(sql: string, params?: unknown[]) {
    try {
      const r = await this.db.query<T>(sql, params)
      this.dbErrorStreak = 0
      return r
    } catch (err) {
      this.metrics.inc('state_daemon_db_errors_total')
      this.dbErrorStreak++
      if (this.dbErrorStreak >= this.config.dbErrorAlertThreshold) {
        await this.alert.alert(
          `state_daemon DB error streak ${this.dbErrorStreak} ≥ ${this.config.dbErrorAlertThreshold}`,
        )
      }
      throw new DBConnectionError((err as Error).message ?? String(err), err)
    }
  }

  private recordDbError(_err: unknown): void {
    // dbQuery already counts and may alert; this is the catch hook for setInterval.
  }

  // ── Test helpers (used by contract tests via `as any`) ─────────────────────

  /** Snapshot of current pool state for assertions. */
  inspectWakePool() {
    return {
      capacity: this.wakePool.currentCapacity,
      active: this.wakePool.activeCount,
      queued: this.wakePool.queuedDepth,
    }
  }

  /** Direct entry for test fixtures that simulate pg_notify without a real LISTEN. */
  async __testHandleEvent(event: QueueEvent): Promise<void> {
    return this.handleQueueEvent(event)
  }

  /** Access to wake pool for capacity tests. */
  get __wakePool(): WakePool {
    return this.wakePool
  }

  /** Status accessor for test assertions. */
  get __status() {
    return this.status
  }
}
