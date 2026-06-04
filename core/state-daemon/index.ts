/**
 * StateDaemon — queue-state-driven dispatch supervisor (Issue #323, spec v0.6).
 *
 * Replaces `bin/wake-daemon.ts` with a single daemon that:
 *   - Subscribes to `pg_notify('queue_event')` for immediate dispatch (§6.2).
 *   - Runs a 30s cron sweep over message_queue rows for §4.3 row 2-6.
 *   - Refreshes claim TTLs every 30s for live `agents.status IN
 *     ('online','busy')` bots holding active `received` / `in_progress` rows,
 *     but only inside a bounded active-claim age window (§5.1 / R4 /
 *     補強 #1). A coarse agent status is not enough to keep a claim alive
 *     forever; stale claims must expire and be reclaimable.
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
  loadGcOverridesFromEnv,
  DBConnectionError,
  type AlertSink,
  type Clock,
  type CodexRunnerInvoker,
  type HostRuntimeInvoker,
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
import {
  buildHostRuntimeFailureResult,
  selectHostRuntimeAdapter,
  type HostRuntimeRunnerInvocation,
  type RuntimeInvocationProfile,
} from './host-runtime-invocation'
import { WakePool } from './wake-pool'
import { defaultConfigPort } from '../ports/config-port'
import {
  createDefaultStallDetector,
  loadStallThresholdsFromEnv,
  type StallDetector,
  type BotContext,
  type StallVerdict,
} from './stall-detector'
import { planQueueAction, type PlannedQueueAction } from './action-planner'
import {
  detectNoReplyIntent,
  parseQueuePayload,
  type NoReplyDecision,
} from '../no-reply-policy'

const CODEX_RUNNER_RUNTIMES = new Set(['codex', 'codex-runner', 'CODEX', 'CODEX_RUNNER'])
const INACTIVE_AGENT_STATUSES = new Set(['disabled', 'offline', 'retired'])

function isCodexRunnerRuntime(runtime: string | null): boolean {
  return runtime !== null && CODEX_RUNNER_RUNTIMES.has(runtime)
}

function effectiveRuntime(agent: AgentRow): string | null {
  return agent.runtime_engine_preference?.trim() || agent.runtime
}

function isInactiveAgentStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && INACTIVE_AGENT_STATUSES.has(status)
}

interface QueueRow {
  id: number
  agent_id: string
  message_id?: string | null
  payload?: unknown
  status: string
  claim_expires_at: Date | null
  claimed_at?: Date | null
  created_at: Date
  last_wake_attempt_at: Date | null
  last_heartbeat_at: Date | null
  attempts?: number | null
}

interface AgentRow {
  agent_id: string
  runtime: string | null
  runtime_engine_preference?: string | null
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
  private readonly codexRunner: CodexRunnerInvoker | null
  private readonly hostRuntimeInvoker: HostRuntimeInvoker | null
  private readonly clock: Clock
  private readonly metrics: Metrics
  private readonly alert: AlertSink
  private readonly config: StateDaemonConfig
  private readonly wakePool: WakePool
  // v0.9 sub-PR 2: wake-time stall gate (§1.3a 3-layer abstraction). Sits
  // before queue action execution; if it returns a non-empty verdict array,
  // wake is skipped and a metric is emitted tagged with the verdict kind.
  private readonly stallDetector: StallDetector = createDefaultStallDetector()

  private status: 'stopped' | 'running' | 'stopping' = 'stopped'
  private dbErrorStreak = 0
  private readonly restartHistory = new Map<string, RestartRecord>()
  private readonly inflightWakes = new Set<Promise<boolean>>()
  private readonly intervalHandles: ReturnType<typeof setInterval>[] = []

  constructor(deps: StateDaemonDeps) {
    this.db = deps.db
    this.pgListen = deps.pgListen
    this.tmux = deps.tmux
    this.codexRunner = deps.codexRunner ?? null
    this.hostRuntimeInvoker = deps.hostRuntimeInvoker ?? null
    this.clock = deps.clock
    this.metrics = deps.metrics
    this.alert = deps.alert
    // cycle 2 Fix (auditor verdict `ab541187`): the GC env overrides have
    // to land in `this.config` to actually take effect at runtime.
    // Merge order, lowest → highest precedence:
    //   DEFAULT_CONFIG (compile-time) → env overrides (operator) → deps.config (caller / test).
    // Test fakes that pass an explicit `config` keep their values because
    // `deps.config` sits last in the spread.
    this.config = {
      ...DEFAULT_CONFIG,
      ...loadGcOverridesFromEnv(),
      ...(deps.config ?? {}),
    }
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
        }).catch((err) => {
          this.metrics.inc('state_daemon_pg_notify_errors_total')
          void this.alert.alert(
            `pg_notify handler failed for row ${ev.id}: ${(err as Error).message ?? String(err)}`,
          )
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
    // PR #338 sub-PR 5 — 7-day GC of replied rows. Runs on its own
    // schedule (default 1h) so the main sweep cadence is unaffected.
    this.intervalHandles.push(
      setInterval(
        () => void this.gcRepliedRows().catch((e) => this.recordDbError(e)),
        this.config.gcIntervalMs,
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
   * snapshots, then records/runs the typed action per §4.3. Other rows fall
   * through to sweepStale, which is the SoT for batch.
   */
  async handleQueueEvent(event: QueueEvent): Promise<void> {
    if (this.status !== 'running') return
    if (!this.isAgentInScope(event.agent_id)) {
      this.metrics.inc('state_daemon_scope_skipped_total', { agent_id: event.agent_id, path: 'notify' })
      return
    }
    const { rows } = await this.dbQuery<QueueRow>(
      `SELECT id, agent_id, message_id, payload, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at
         FROM message_queue WHERE id = $1`,
      [event.id],
    )
    const row = rows[0]
    if (!row) return // row may have been deleted

    if (row.status === 'pending' || row.status === 'received') {
      await this.runWakeIfNotSuppressed(row)
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

    // priority order per T15: row 3 (received-expired) > row 2 (pending-stale)
    const expired = await this.fetchReceivedExpired()
    for (const row of expired) {
      result.scanned++
      this.recordQueueAction(this.planAction(row, null, false, this.clock.now()), row)
      await this.reclaimRow(row)
      result.reclaimed++
    }

    const observed = await this.fetchObservableWork()
    for (const row of observed) {
      if (expired.some((e) => e.id === row.id)) continue
      result.scanned++
      if (row.status === 'received') {
        const acted = await this.runWakeIfNotSuppressed(row)
        if (acted) result.rewoken++
      } else {
        this.recordQueueAction(this.planAction(row, null, true, this.clock.now()), row)
      }
    }

    const stale = await this.fetchPendingStale()
    for (const row of stale) {
      // Skip if same row was already handled as received-expired this tick
      if (expired.some((e) => e.id === row.id)) continue
      result.scanned++
      const acted = await this.runWakeIfNotSuppressed(row)
      if (acted) result.rewoken++
    }

    const abandon = await this.fetchAbandonRecent()
    for (const row of abandon) {
      result.scanned++
      await this.dbQuery(
        `UPDATE message_queue
            SET status='pending',
                claimed_by=NULL,
                claimed_at=NULL,
                claim_expires_at=NULL
          WHERE id=$1`,
        [row.id],
      )
      result.abandonReset++
    }

    result.durationMs = this.clock.now().getTime() - t0
    this.metrics.observe('state_daemon_sweep_duration_ms', result.durationMs)
    if (result.durationMs > this.config.budgetWarnMs) {
      result.budgetWarn = true
    }
    return result
  }

  // ── 7-day GC (§1.6 GC job, PR #338 sub-PR 5) ───────────────────────────────

  /**
   * Delete `replied` rows whose `replied_at` is older than the configured
   * GC age. Spec §1.6 invariant: `failed` rows are NOT garbage-collected
   * (retention policy). Default cutoff is 7 days; env overrides via
   * `STATE_DAEMON_GC_AGE_DAYS` / `STATE_DAEMON_GC_INTERVAL_MS` /
   * `STATE_DAEMON_GC_BATCH_LIMIT` are wired through `loadGcOverridesFromEnv`
   * at config construction time.
   *
   * Deletes are batched (default 1000 rows/tick) to avoid long-held
   * locks. Returns the number of rows actually deleted.
   */
  async gcRepliedRows(): Promise<{ deleted: number }> {
    const cutoffSec = this.config.gcRepliedAfterSec
    const batchLimit = this.config.gcBatchLimit
    const params: unknown[] = [String(cutoffSec), batchLimit]
    const scopeClause = this.agentScopeClause(params, 'agent_id')
    const r = await this.dbQuery<{ id: number }>(
      `DELETE FROM message_queue
         WHERE id IN (
           SELECT id FROM message_queue
            WHERE status = 'replied'
              AND replied_at IS NOT NULL
              AND replied_at < now() - ($1 || ' seconds')::interval
              ${scopeClause}
            ORDER BY replied_at ASC
            LIMIT $2
         )
         RETURNING id`,
      params,
    )
    const deleted = r.rowCount
    if (deleted > 0) {
      this.metrics.inc('state_daemon_gc_deleted_total', {}, deleted)
    }
    this.metrics.inc('state_daemon_gc_runs_total')
    return { deleted }
  }

  // ── Heartbeat (§5.1 / R4 / 補強 #1) ────────────────────────────────────────

  async refreshClaims(): Promise<RefreshResult> {
    if (this.status !== 'running') return { refreshed: 0, skipped: 0 }
    let sql = `UPDATE message_queue mq
          SET claim_expires_at = $1::timestamptz + ($2 || ' seconds')::interval,
              last_heartbeat_at = $1::timestamptz
        WHERE mq.status IN ('received', 'in_progress')
          AND mq.claim_expires_at > $1::timestamptz
          AND mq.claimed_by = mq.agent_id
          AND mq.claimed_at IS NOT NULL
          AND mq.claimed_at >= $1::timestamptz - ($3 || ' seconds')::interval
          AND EXISTS (
            SELECT 1 FROM agents a
             WHERE a.agent_id = mq.agent_id
               AND a.status IN ('online', 'busy')
          )`
    const now = this.clock.now()
    const params: unknown[] = [now, this.config.claimTtlSec, this.config.activeClaimMaxAgeSec]
    sql += this.agentScopeClause(params, 'mq.agent_id')
    const { rowCount } = await this.dbQuery(sql, params)
    this.metrics.inc('state_daemon_heartbeat_refresh_total', { result: 'ok' }, rowCount)

    const skippedParams: unknown[] = [now, this.config.activeClaimMaxAgeSec]
    let skippedSql = `SELECT count(*)::int AS n
        FROM message_queue mq
       WHERE mq.status IN ('received', 'in_progress')
         AND mq.claim_expires_at > $1::timestamptz
         AND (
           mq.claimed_by IS DISTINCT FROM mq.agent_id
           OR mq.claimed_at IS NULL
           OR mq.claimed_at < $1::timestamptz - ($2 || ' seconds')::interval
         )`
    skippedSql += this.agentScopeClause(skippedParams, 'mq.agent_id')
    const skippedRows = await this.dbQuery<{ n: number }>(skippedSql, skippedParams)
    const skipped = Number(skippedRows.rows[0]?.n ?? 0)
    if (skipped > 0) {
      this.metrics.inc('state_daemon_heartbeat_refresh_total', { result: 'active_claim_max_age_skipped' }, skipped)
    }
    return { refreshed: rowCount, skipped }
  }

  // ── Bot liveness (§5.4 / R7 / 補強 #5) ─────────────────────────────────────

  async checkBotLiveness(): Promise<LivenessResult> {
    if (this.status !== 'running') return { checked: 0, restarted: 0, escalated: 0 }
    let sql = `SELECT agent_id, runtime, runtime_engine_preference, status, (metadata->>'tmux_session') AS tmux_session, last_seen_at FROM agents`
    const params: unknown[] = []
    const scopeClause = this.agentScopeClause(params, 'agent_id')
    if (scopeClause) sql += ` WHERE ${scopeClause.replace(/^ AND /, '')}`
    const { rows } = await this.dbQuery<AgentRow>(sql, params)
    const result: LivenessResult = { checked: 0, restarted: 0, escalated: 0 }
    const now = this.clock.now().getTime()
    for (const bot of rows) {
      if (isInactiveAgentStatus(bot.status)) {
        this.metrics.inc('state_daemon_bot_liveness_skipped_total', { status: bot.status ?? 'unknown' })
        continue
      }
      result.checked++
      const lastSeen = bot.last_seen_at ? new Date(bot.last_seen_at).getTime() : 0
      const stale = now - lastSeen
      if (stale <= this.config.botDeadThresholdMs) continue
      const runtime = effectiveRuntime(bot)
      if (isCodexRunnerRuntime(runtime)) {
        this.metrics.inc('state_daemon_bot_liveness_skipped_total', { runtime: runtime ?? 'unknown' })
        continue
      }
      // §5.4 / R7: TUI bot with stale last_seen_at gets restart attempted
      // regardless of whether the tmux_session field is currently populated
      // — the launcher (restart-bot.sh) reattaches or recreates the session
      // by agent_id, so a missing tmux_session value is not a blocker; it is
      // exactly the case we want restarted. Non-TUI runtimes are still alert-
      // only (cycle 1 auditor Axis 1: tmux_session 欠落 path も restart 試行へ).
      if (bot.runtime !== defaultConfigPort.getDefaultRuntime()) {
        await this.alert.alert(
          `bot ${bot.agent_id} dead (runtime=${bot.runtime}, manual intervention)`,
        )
        result.escalated++
        continue
      }
      // tmux_session may be NULL (per-agent metadata not yet seeded) — when
      // it is, treat the session as absent and let the restart path run.
      const exists = bot.tmux_session
        ? await this.tmux.sessionExists(bot.tmux_session)
        : false
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

  // ── Wake execution + approved-runner duplicate suppression ─────────────────

  /**
   * Attempt to dispatch work. Returns `true` only when an approved runner path
   * was invoked. TUI prompt injection is hard-disabled: natural-language wake
   * rows are observed through metrics and left open for deterministic runners
   * or explicit operator repair.
   */
  private async runWakeIfNotSuppressed(row: QueueRow): Promise<boolean> {
    const now = this.clock.now()
    // v0.9 sub-PR 2 §1.3a stall gate: evaluated before typed action
    // execution. If any of the three layers reports a stall the wake is
    // skipped; the existing sweep / heartbeat paths own the recovery action
    // separately. The gate is fail-open: any unexpected error in detection
    // logs and falls through to typed action execution.
    if (row.status === 'pending') {
      try {
        const verdicts = await this.evaluateStallGate(row, now)
        if (verdicts.length > 0) {
          for (const v of verdicts) {
            this.metrics.inc('state_daemon_stall_skipped_total', {
              layer: v.layer,
              kind: v.kind,
            })
          }
          this.metrics.inc('state_daemon_wake_actions_total', { result: 'stall_skipped' })
          return false
        }
      } catch (e) {
        this.metrics.inc('state_daemon_stall_detector_error_total', {})
        this.recordDbError(e)
        // fail open into typed action execution.
      }
    }
    const runPromise = this.wakePool.run({
      exec: () => this.executeWake(row, now),
    })
    this.inflightWakes.add(runPromise)
    try {
      return await runPromise
    } finally {
      this.inflightWakes.delete(runPromise)
    }
  }

  /**
   * Build a BotContext and run it through the stall detector. Kept private
   * because it is only used from `runWakeIfNotSuppressed`; the detector
   * itself is the testable seam. tmuxPaneTail is left null for now — the
   * L3 input_residue check stays inert until the daemon grows its own
   * capture-pane caller (the existing capture is in server.ts:3371).
   */
  private async evaluateStallGate(
    row: QueueRow,
    now: Date,
  ): Promise<readonly StallVerdict[]> {
    const { rows } = await this.dbQuery<AgentRow>(
      `SELECT agent_id, runtime, runtime_engine_preference, (metadata->>'tmux_session') AS tmux_session, last_seen_at, status FROM agents WHERE agent_id=$1`,
      [row.agent_id],
    )
    const ctx: BotContext = {
      now,
      row: row as unknown as BotContext['row'],
      agent: (rows[0] ?? null) as unknown as BotContext['agent'],
      tmuxPaneTail: null,
      // cycle 2 Fix 3: thresholds read from env at each gate evaluation
      // (no module-level cache) so that an operator-level override via
      // STATE_DAEMON_STUCK_AFTER_SEC / STATE_DAEMON_STALL_AFTER_SEC is
      // picked up without daemon restart. The function returns the
      // FALLBACK_STALL_THRESHOLDS literal when the env var is unset or
      // malformed, preserving the previous hardcoded behaviour.
      thresholds: loadStallThresholdsFromEnv(),
    }
    return this.stallDetector.detect(ctx)
  }

  private async executeWake(
    row: QueueRow,
    now: Date,
  ): Promise<boolean> {
    const { rows } = await this.dbQuery<AgentRow>(
      `SELECT agent_id, runtime, runtime_engine_preference, (metadata->>'tmux_session') AS tmux_session, last_seen_at, status FROM agents WHERE agent_id=$1`,
      [row.agent_id],
    )
    const bot = rows[0]
    const defaultRuntime = defaultConfigPort.getDefaultRuntime()
    let hasActiveClaim = false
    if (bot) {
      const activeClaims = await this.dbQuery(
        `SELECT 1 FROM message_queue
          WHERE agent_id=$1
            AND claimed_by=$1
            AND status IN ('received', 'in_progress')
          LIMIT 1`,
        [row.agent_id],
      )
      hasActiveClaim = activeClaims.rows.length > 0
    }

    const action = planQueueAction({
      row,
      agent: bot ?? null,
      now,
      defaultRuntime,
      hasActiveClaim,
    })
    this.recordQueueAction(action, row)
    if (action.kind !== 'wake_pending' && action.kind !== 'wake_received') {
      return this.runObservedQueueAction(action, row)
    }

    this.metrics.inc('state_daemon_wake_actions_total', {
      result: 'tui_wake_disabled',
      action: action.kind,
    })
    return false
  }

  // ── State transition helpers (§4.3) ────────────────────────────────────────

  private async reclaimRow(row: QueueRow): Promise<void> {
    await this.dbQuery(
      `UPDATE message_queue
          SET status='pending',
              claim_expires_at=NULL,
              claimed_by=NULL,
              claimed_at=NULL
        WHERE id=$1`,
      [row.id],
    )
    this.metrics.inc('state_daemon_wake_actions_total', { result: 'reclaimed' })
    // After reclaim, observe the pending row without prompt injection.
    await this.runWakeIfNotSuppressed({ ...row, status: 'pending', last_wake_attempt_at: null })
  }

  private recordQueueAction(action: PlannedQueueAction, row: QueueRow): void {
    this.metrics.inc('state_daemon_state_actions_total', {
      action: action.kind,
      status: row.status,
      terminal: action.terminal ? 'true' : 'false',
    })
  }

  private async runObservedQueueAction(action: PlannedQueueAction, row: QueueRow): Promise<boolean> {
    switch (action.kind) {
      case 'invoke_codex_runner':
        return this.invokeCodexRunner(row)
      case 'agent_missing':
        await this.alert.alert(`wake target ${row.agent_id} not in agents table`)
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'agent_missing' })
        return false
      case 'runtime_skip':
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'non_tui_skipped' })
        return false
      case 'tmux_missing':
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'no_tmux_session' })
        return false
      case 'agent_inactive':
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'agent_inactive_skipped' })
        return false
      case 'observe_busy':
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'active_claim_skipped' })
        return false
      default:
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'observed' })
        return false
    }
  }

  private requesterFromPayload(payload: unknown): string | null {
    if (!payload) return null
    try {
      const obj = typeof payload === 'string' ? JSON.parse(payload) : payload
      if (!obj || typeof obj !== 'object') return null
      const rec = obj as Record<string, unknown>
      const requester = rec.author_id ?? rec.from ?? rec.requester
      return typeof requester === 'string' && requester.trim() ? requester.trim() : null
    } catch {
      return null
    }
  }

  private noReplyDecisionForRow(row: QueueRow): NoReplyDecision {
    const payload = parseQueuePayload(row.payload)
    return detectNoReplyIntent({
      payload,
      content: payload.content,
    })
  }

  private boundedAckContent(row: QueueRow, noReplyDecision: NoReplyDecision): string {
    const finalClose = noReplyDecision.no_reply_required
      ? 'final close will be auto-completed as no-reply.'
      : 'final close requires explicit --close.'
    const raw = `ACK: received by ${row.agent_id}; queue_id={queue_id}; message_id={message_id}; ${finalClose}`
    return raw.length <= this.config.codexRunnerAckContentMaxChars
      ? raw
      : raw.slice(0, this.config.codexRunnerAckContentMaxChars)
  }

  private buildHostRuntimeInvocation(
    row: QueueRow,
    profile: RuntimeInvocationProfile | null,
    now: Date,
  ): HostRuntimeRunnerInvocation {
    return {
      invocation_id: `cp40d-${row.id}-${now.getTime()}`,
      queue_id: Number(row.id),
      message_id: row.message_id ?? undefined,
      agent_id: row.agent_id,
      task_kind: 'receive',
      trusted_instruction: [
        `Run the AUN receive runner for exact queue_id=${row.id}.`,
        'Return typed evidence only; queue, baton, turn, completion, retry, quarantine, and close lifecycle changes remain control-plane-owned.',
      ].join(' '),
      policy_refs: ['policy://aun/cp-40d/host-runtime-adapter-gate'],
      untrusted_context_refs: [`message_queue://${row.id}/payload`],
      context_pack_refs: [],
      expected_result_schema_ref: profile?.final_output_schema_ref ?? 'schema://aun/runtime-runner-result',
      runtime_profile_ref: profile?.profile_id ?? 'profile://disabled',
    }
  }

  private hostRuntimeResultOk(result: { exit_status: number; schema_valid: boolean; failure_code?: string; parser_outcome?: string }): boolean {
    return result.exit_status === 0 && result.schema_valid && !result.failure_code && result.parser_outcome === 'success'
  }

  private async invokeCodexRunner(row: QueueRow): Promise<boolean> {
    if (!this.config.codexRunnerEnabled) {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_disabled' })
      return false
    }

    const now = this.clock.now()
    const reserved = await this.dbQuery(
      `UPDATE agents
          SET last_wake_attempt_at=$1
        WHERE agent_id=$2
          AND (
            last_wake_attempt_at IS NULL
            OR last_wake_attempt_at <= $1::timestamptz - ($3 || ' seconds')::interval
          )`,
      [now, row.agent_id, this.config.wakeDuplicateSuppressSec],
    )
    if (reserved.rowCount === 0) {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'dedup_skipped' })
      return false
    }

    const current = await this.dbQuery<{ status: string }>(
      `SELECT status FROM message_queue WHERE id=$1`,
      [row.id],
    )
    if (current.rows[0]?.status !== 'pending') {
      await this.dbQuery(
        `UPDATE agents SET last_wake_attempt_at=NULL
          WHERE agent_id=$1 AND last_wake_attempt_at=$2`,
        [row.agent_id, now],
      )
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_stale_skipped' })
      return false
    }

    const noReplyDecision = this.noReplyDecisionForRow(row)
    const completeNoReply = this.config.codexRunnerAutoCompleteNoReply && noReplyDecision.no_reply_required
    const runnerInput = {
      agentId: row.agent_id,
      queueId: Number(row.id),
      messageId: row.message_id ?? null,
      requester: this.requesterFromPayload(row.payload),
      databaseUrl: this.config.codexRunnerDatabaseUrl,
      ackContent: this.boundedAckContent(row, noReplyDecision),
      completeNoReply,
      completionReason: completeNoReply
        ? noReplyDecision.reason ?? 'state_daemon_auto_no_reply'
        : null,
      payload: row.payload,
    }
    const hostSelection = selectHostRuntimeAdapter({
      enabled: this.config.hostRuntimeAdapterEnabled,
      profile: this.config.hostRuntimeInvocationProfile,
      invocation: this.buildHostRuntimeInvocation(row, this.config.hostRuntimeInvocationProfile, now),
      schemaPath: this.config.hostRuntimeInvocationSchemaPath,
      schemaJson: this.config.hostRuntimeInvocationSchemaJson,
      outputLastMessagePath: this.config.hostRuntimeInvocationOutputLastMessagePath,
      supportedFlags: this.config.hostRuntimeInvocationSupportedFlags ?? undefined,
      timestamp: now.toISOString(),
    })
    if (!hostSelection.ok) {
      await this.dbQuery(
        `UPDATE agents SET last_wake_attempt_at=NULL
          WHERE agent_id=$1 AND last_wake_attempt_at=$2`,
        [row.agent_id, now],
      )
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_failed' })
      await this.alert.alert(
        `host runtime adapter failed closed for ${row.agent_id} queue_id=${row.id}: ${hostSelection.failure.failure_code}`,
      )
      return false
    }
    if (hostSelection.selected === 'host-runtime') {
      if (!this.hostRuntimeInvoker) {
        const failure = buildHostRuntimeFailureResult({
          invocation_id: hostSelection.invocation.invocation_id,
          runtime: hostSelection.profile.runtime,
          code: 'RUNTIME_INVOKER_UNCONFIGURED',
          message: 'host runtime invoker is not configured',
          timestamp: now.toISOString(),
        })
        await this.dbQuery(
          `UPDATE agents SET last_wake_attempt_at=NULL
            WHERE agent_id=$1 AND last_wake_attempt_at=$2`,
          [row.agent_id, now],
        )
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'host_runtime_invoker_unconfigured' })
        await this.alert.alert(
          `host runtime adapter failed closed for ${row.agent_id} queue_id=${row.id}: ${failure.failure_code}`,
        )
        return false
      }
      const result = await this.hostRuntimeInvoker.invoke({
        profile: hostSelection.profile,
        invocation: hostSelection.invocation,
        command: hostSelection.command,
      })
      if (!this.hostRuntimeResultOk(result)) {
        await this.dbQuery(
          `UPDATE agents SET last_wake_attempt_at=NULL
            WHERE agent_id=$1 AND last_wake_attempt_at=$2`,
          [row.agent_id, now],
        )
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_error' })
        await this.alert.alert(
          `host runtime adapter failed for ${row.agent_id} queue_id=${row.id}: ${result.failure_code ?? result.parser_outcome}`,
        )
        return false
      }

      await this.dbQuery(
        `UPDATE message_queue SET last_wake_attempt_at=$1
           WHERE id=$2 AND status='pending'`,
        [now, row.id],
      )
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'host_runtime_adapter_invoked' })
      return true
    }

    if (!this.codexRunner) {
      await this.dbQuery(
        `UPDATE agents SET last_wake_attempt_at=NULL
          WHERE agent_id=$1 AND last_wake_attempt_at=$2`,
        [row.agent_id, now],
      )
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_unconfigured' })
      await this.alert.alert(`codex runner unavailable for ${row.agent_id}`)
      return false
    }

    const result = await this.codexRunner.invoke(runnerInput)
    if (!result.ok) {
      await this.dbQuery(
        `UPDATE agents SET last_wake_attempt_at=NULL
          WHERE agent_id=$1 AND last_wake_attempt_at=$2`,
        [row.agent_id, now],
      )
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_error' })
      await this.alert.alert(`codex runner failed for ${row.agent_id} queue_id=${row.id}: ${result.stderr ?? `exit ${result.code}`}`)
      return false
    }

    await this.dbQuery(
      `UPDATE message_queue SET last_wake_attempt_at=$1
         WHERE id=$2 AND status='pending'`,
      [now, row.id],
    )
    const completionOutcome = result.typed_result?.completion_outcome
    if (completionOutcome === 'completed_no_reply') {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_terminal_completed' })
    } else if (completionOutcome === 'completion_failed') {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_completion_failed' })
    } else if (completionOutcome === 'open') {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_open' })
    } else {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_invoked' })
    }
    return true
  }

  private planAction(
    row: QueueRow,
    agent: AgentRow | null,
    hasActiveClaim: boolean,
    now: Date,
  ): PlannedQueueAction {
    return planQueueAction({
      row,
      agent,
      now,
      defaultRuntime: defaultConfigPort.getDefaultRuntime(),
      hasActiveClaim,
    })
  }

  // ── Sweep fetch helpers ────────────────────────────────────────────────────

  private isAgentInScope(agentId: string): boolean {
    if (this.config.agentIdPrefix && !agentId.startsWith(this.config.agentIdPrefix)) return false
    if (this.config.agentDenylist && this.config.agentDenylist.includes(agentId)) return false
    if (this.config.agentAllowlist && !this.config.agentAllowlist.includes(agentId)) return false
    return true
  }

  private agentScopeClause(params: unknown[], column: string): string {
    let sql = ''
    if (this.config.agentIdPrefix) {
      params.push(this.config.agentIdPrefix + '%')
      sql += ` AND ${column} LIKE $${params.length}`
    }
    if (this.config.agentDenylist) {
      params.push(this.config.agentDenylist)
      sql += ` AND NOT (${column} = ANY($${params.length}::text[]))`
    }
    if (this.config.agentAllowlist) {
      params.push(this.config.agentAllowlist)
      sql += ` AND ${column} = ANY($${params.length}::text[])`
    }
    return sql
  }

  private async fetchPendingStale(): Promise<QueueRow[]> {
    const params: unknown[] = [this.clock.now(), this.config.pendingStaleAfter, this.config.batchLimit]
    let sql = `SELECT id, agent_id, message_id, payload, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at
         FROM message_queue
        WHERE status='pending'
          AND created_at < $1::timestamptz - ($2)::interval`
    sql += this.agentScopeClause(params, 'agent_id')
    sql += ` ORDER BY created_at LIMIT $3`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchReceivedExpired(): Promise<QueueRow[]> {
    let sql = `SELECT id, agent_id, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at
         FROM message_queue
        WHERE status IN ('received', 'in_progress')
          AND claim_expires_at < $1::timestamptz`
    const params: unknown[] = [this.clock.now(), this.config.batchLimit]
    sql += this.agentScopeClause(params, 'agent_id')
    sql += ` ORDER BY claim_expires_at LIMIT $2`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchObservableWork(): Promise<QueueRow[]> {
    let sql = `SELECT id, agent_id, status, claim_expires_at, created_at,
              last_wake_attempt_at, last_heartbeat_at
         FROM message_queue
        WHERE status IN ('received', 'in_progress')
          AND (claim_expires_at IS NULL OR claim_expires_at >= $1::timestamptz)`
    const params: unknown[] = [this.clock.now(), this.config.batchLimit]
    sql += this.agentScopeClause(params, 'agent_id')
    sql += ` ORDER BY created_at LIMIT $2`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchAbandonRecent(): Promise<QueueRow[]> {
    // v0.9: 'failed' status removed from schema. IMPLICIT_ABANDON detection
    // is now via claim-ttl sweeper (rolling back to 'pending'). This fetch
    // is a no-op in v0.9 — Issue #349 will redesign abandonment tracking.
    return []
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
