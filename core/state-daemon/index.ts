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
 *   - Polls `agents.last_seen_at` every 30s; legacy TUI/tmux runtimes are
 *     skipped so queue delivery is owned by approved runner/runtime paths.
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
 *   F5 legacy TUI/tmux prompt wake path 禁止 — no prompt submission or restart
 *      repair may count as delivery.
 *   F6 wake-daemon 並行稼働中の重複 wake は queue state idempotency +
 *      duplicate suppression で吸収.
 *   F7 既 expired claim の TTL 延長禁止 — heartbeat は `claim_expires_at >
 *      now()` の row のみ update.
 *   F8 legacy bot restart is disabled; runner/runtime health must provide
 *      recovery evidence instead.
 *   F12 `bot_registry` table / `bot-registry.txt` の参照禁止 — `agents`
 *      table が SoT (CTO 検証済).
 */
import {
  AlreadyStartedError,
  DEFAULT_CONFIG,
  loadAllAgentCommunicationManifestOverridesFromEnv,
  loadGcOverridesFromEnv,
  DBConnectionError,
  type AlertSink,
  type Clock,
  type CodexRunnerInvoker,
  type ConfigurationReconcilerService,
  type GithubWorkPuller,
  type HostRuntimeInvoker,
  type QueueWorkScheduler,
  type DBClient,
  type LivenessResult,
  type Metrics,
  type PgListenClient,
  type QueueEvent,
  type RefreshResult,
  type ShirubeD1AutoReceiveDecision,
  type ShirubeD1AutoReceiveDispatcher,
  type ShirubeD1AutoReceiveInput,
  type StateDaemonConfig,
  type StateDaemonDeps,
  type SweepResult,
  type TmuxClient,
} from './types'
import type {
  AllAgentCommunicationAdmissionDecision,
  AllAgentCommunicationAdmissionGate,
} from '../all-agent-communication-manifest'
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
import { selectAgentAdapter } from './adapter-registry'
import { evaluateRuntimeMemoryReadyGate, type RuntimeMemoryReadyGateResult } from '../runtime-memory-ready'
import {
  buildTerminalBaton,
  detectNoReplyIntent,
  parseQueuePayload,
  type NoReplyDecision,
  withTerminalBaton,
} from '../no-reply-policy'
import {
  classifyQueueSurface,
  withQueueDispositionStamp,
  type QueueSurfaceClassification,
} from '../queue-message-classification'
import {
  evaluateAutomaticProcessingEligibility,
  type AutomaticProcessingEligibilityVerdict,
} from '../communication-authority'

const CODEX_RUNNER_RUNTIMES = new Set(['codex', 'codex-runner', 'CODEX', 'CODEX_RUNNER'])
const INACTIVE_AGENT_STATUSES = new Set(['disabled', 'offline', 'retired'])
const QUEUE_WORK_SCHEDULER_SOURCE = 'state-daemon-queue-work-scheduler'
const QUEUE_WORK_RUNNER_ERROR_RECOVERY_KEY = 'queue_work_runner_error_recovery'
const QUEUE_WORK_RUNNER_ERROR_FAILED_REASON = 'QUEUE_WORK_RUNNER_ERROR_RETRY_EXHAUSTED'

function isCodexRunnerRuntime(runtime: string | null): boolean {
  return runtime !== null && CODEX_RUNNER_RUNTIMES.has(runtime)
}

function effectiveRuntime(agent: AgentRow): string | null {
  return agent.runtime_engine_preference?.trim() || agent.runtime?.trim() || null
}

function isInactiveAgentStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && INACTIVE_AGENT_STATUSES.has(status)
}

interface QueueRow {
  id: number
  agent_id: string
  message_id?: string | null
  channel_id?: string | null
  payload?: unknown
  message_type?: string | null
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
  metadata?: unknown
  profile_enabled?: unknown
  disabled_at?: Date | string | null
  expected_provider_identity?: unknown
}

function parseChannelMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
  }
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    }
  } catch {}
  return raw.split(',').map((value) => value.trim()).filter(Boolean)
}

function isProfileEnabled(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1'
}

export async function evaluateStateDaemonAutomaticProcessingEligibility(
  db: Pick<DBClient, 'query'>,
  input: { agentId: string; channelId: string | null; denylisted: boolean },
): Promise<AutomaticProcessingEligibilityVerdict> {
  const agentRows = await db.query<AgentRow>(
    `SELECT agent_id, runtime, runtime_engine_preference, status,
            profile_enabled, disabled_at
       FROM agents
      WHERE agent_id=$1`,
    [input.agentId],
  )
  const agent = agentRows.rows[0] ?? null
  let channelMember = false
  if (input.channelId) {
    const channelRows = await db.query<{ members: unknown }>(
      'SELECT members FROM channels WHERE id=$1',
      [input.channelId],
    )
    channelMember = parseChannelMembers(channelRows.rows[0]?.members).includes(input.agentId)
  }
  return evaluateAutomaticProcessingEligibility({
    enrolled: agent !== null,
    enabled: agent !== null && isProfileEnabled(agent.profile_enabled) && agent.disabled_at == null,
    runtimeReady: agent !== null
      && Boolean(effectiveRuntime(agent))
      && Boolean(agent.status?.trim())
      && !isInactiveAgentStatus(agent.status),
    channelMember,
    denylisted: input.denylisted,
  })
}

export class StateDaemon {
  private readonly db: DBClient
  private readonly pgListen: PgListenClient
  private readonly tmux: TmuxClient
  private readonly codexRunner: CodexRunnerInvoker | null
  private readonly hostRuntimeInvoker: HostRuntimeInvoker | null
  private readonly queueWorkScheduler: QueueWorkScheduler | null
  private readonly shirubeD1AutoReceive: ShirubeD1AutoReceiveDispatcher | null
  private readonly allAgentCommunicationAdmissionGate: AllAgentCommunicationAdmissionGate | null
  private readonly githubWorkPuller: GithubWorkPuller | null
  private readonly configurationReconciler: ConfigurationReconcilerService | null
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
  private readonly inflightWakes = new Set<Promise<boolean>>()
  private readonly inflightQueueWork = new Map<string, Promise<void>>()
  private readonly inflightQueueWorkIds = new Set<string>()
  private githubWorkPullerInFlight: Promise<void> | null = null
  private readonly intervalHandles: ReturnType<typeof setInterval>[] = []

  constructor(deps: StateDaemonDeps) {
    this.db = deps.db
    this.pgListen = deps.pgListen
    this.tmux = deps.tmux
    this.codexRunner = deps.codexRunner ?? null
    this.hostRuntimeInvoker = deps.hostRuntimeInvoker ?? null
    this.queueWorkScheduler = deps.queueWorkScheduler ?? null
    this.shirubeD1AutoReceive = deps.shirubeD1AutoReceive ?? null
    this.allAgentCommunicationAdmissionGate = deps.allAgentCommunicationAdmissionGate ?? null
    this.githubWorkPuller = deps.githubWorkPuller ?? null
    this.configurationReconciler = deps.configurationReconciler ?? null
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
      ...loadAllAgentCommunicationManifestOverridesFromEnv(),
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
    try {

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
    if (this.config.githubWorkPullerEnabled) {
      if (!this.githubWorkPuller) {
        this.metrics.inc('state_daemon_github_work_puller_actions_total', { result: 'missing_dependency' })
        void this.alert.alert('github work puller enabled but no puller dependency is configured')
      } else {
        this.scheduleGithubWorkPuller('startup')
        this.intervalHandles.push(
          setInterval(
            () => this.scheduleGithubWorkPuller('interval'),
            this.config.githubWorkPullerIntervalMs,
          ),
        )
      }
    }
    if (this.config.configurationReconcilerEnabled) {
      if (!this.configurationReconciler) {
        this.metrics.inc('state_daemon_configuration_reconciler_actions_total', { result: 'missing_dependency' })
        await this.alert.alert('configuration reconciler enabled but no dependency is configured')
        throw new Error('STATE_DAEMON_CONFIGURATION_RECONCILER_DEPENDENCY_REQUIRED')
      } else {
        await this.configurationReconciler.start()
        this.metrics.inc('state_daemon_configuration_reconciler_actions_total', { result: 'started' })
      }
    }
    } catch (error) {
      await this.stop().catch(() => {})
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return
    this.status = 'stopping'
    for (const h of this.intervalHandles) clearInterval(h)
    this.intervalHandles.length = 0
    // Wait up to 5s for in-flight wake jobs to finish (§1.2 invariants).
    const deadline = this.clock.now().getTime() + 5000
    while ((this.inflightWakes.size > 0 || this.inflightQueueWork.size > 0 || this.githubWorkPullerInFlight) && this.clock.now().getTime() < deadline) {
      await Promise.race([
        Promise.all([
          ...Array.from(this.inflightWakes),
          ...Array.from(this.inflightQueueWork.values()),
          ...(this.githubWorkPullerInFlight ? [this.githubWorkPullerInFlight] : []),
        ]),
        new Promise((r) => setTimeout(r, 50)),
      ])
    }
    if (this.config.configurationReconcilerEnabled && this.configurationReconciler) {
      await this.configurationReconciler.stop()
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
      if (this.queueWorkFenceConfigured()) {
        this.metrics.inc('state_daemon_scope_skipped_total', { agent_id: event.agent_id, path: 'notify' })
        this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'queue_work_fence_skipped', path: 'notify_scope' })
        return
      }
      this.metrics.inc('state_daemon_scope_skipped_total', { agent_id: event.agent_id, path: 'notify' })
      return
    }

    let row: QueueRow | null = null
    if (this.queueWorkFenceConfigured() || this.queueWorkResidueExclusionConfigured()) {
      row = await this.fetchQueueRowById(event.id)
      if (!row) return
      if (this.isQueueWorkResidueExcluded(row)) {
        this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'queue_work_residue_excluded', path: 'notify' })
        return
      }
      if (this.queueWorkFenceConfigured() && !this.isQueueWorkFenceInScope(row)) {
        this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'queue_work_fence_skipped', path: 'notify' })
        return
      }
    }

    row = row ?? await this.fetchQueueRowById(event.id)
    if (!row) return // row may have been deleted

    if (row.status === 'pending' || row.status === 'received' || (row.status === 'done' && this.shirubeD1AutoReceive)) {
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

    if (this.shirubeD1AutoReceive) {
      const recoverableD1 = await this.fetchShirubeD1RecoveryRows()
      for (const row of recoverableD1) {
        result.scanned++
        const acted = await this.runWakeIfNotSuppressed(row)
        if (acted) result.rewoken++
      }
    }

    const runnerErrorRows = this.queueWorkScheduler ? await this.fetchQueueWorkRunnerErrorRows() : []
    const runnerErrorIds = new Set(runnerErrorRows.map((row) => row.id))
    for (const row of runnerErrorRows) {
      result.scanned++
      const recovered = await this.recoverQueueWorkRunnerErrorRow(row)
      if (recovered === 'reclaimed') result.reclaimed++
      if (recovered === 'failed') result.permanentlyFailed++
    }

    // priority order per T15: row 3 (received-expired) > row 2 (pending-stale)
    const expired = await this.fetchReceivedExpired()
    for (const row of expired) {
      if (runnerErrorIds.has(row.id)) continue
      result.scanned++
      const automaticProcessing = await this.checkAutomaticProcessingEligibility(row)
      if (!automaticProcessing.ok) {
        this.recordAutomaticProcessingBlocked(row, automaticProcessing)
        continue
      }
      const d1Decision = await this.classifyShirubeD1AutoReceive(row)
      if (d1Decision.outcome !== 'not_d1') {
        if (d1Decision.outcome === 'reject') {
          this.recordShirubeD1Rejection(row, d1Decision)
          continue
        }
        this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', { result: 'restart_reclaim' })
        await this.reclaimRow(row)
        result.reclaimed++
        continue
      }
      if (!this.queueWorkScheduler && this.isQueueWorkSchedulerClaim(row)) {
        this.metrics.inc('state_daemon_queue_work_actions_total', {
          result: 'scheduler_claim_without_scheduler_skipped',
        })
        continue
      }
      const action = this.planAction(row, null, false, this.clock.now())
      this.recordQueueAction(action, row)
      const memoryReady = await this.checkMemoryReadyGate(row, action)
      if (!memoryReady.ok) {
        this.recordMemoryReadyBlocked(action, row, memoryReady)
        continue
      }
      await this.reclaimRow(row)
      result.reclaimed++
    }

    const observed = await this.fetchObservableWork()
    for (const row of observed) {
      if (runnerErrorIds.has(row.id)) continue
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
      if (runnerErrorIds.has(row.id)) continue
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
    const inflightQueueWorkIds = Array.from(this.inflightQueueWorkIds)
      .filter((id) => /^[1-9]\d*$/.test(id))
      .map((id) => Number.parseInt(id, 10))
    let sql = `UPDATE message_queue mq
          SET claim_expires_at = $1::timestamptz + ($2 || ' seconds')::interval,
              last_heartbeat_at = $1::timestamptz
        WHERE mq.status IN ('received', 'in_progress')
          AND mq.claim_expires_at > $1::timestamptz
          AND mq.payload NOT LIKE '%"runner_error"%'
          AND mq.payload NOT LIKE '%"source":"state-daemon-d1-auto-receive"%'
          AND mq.claimed_by = mq.agent_id
          AND mq.claimed_at IS NOT NULL
          AND (
            mq.claimed_at >= $1::timestamptz - ($3 || ' seconds')::interval
            OR mq.id = ANY($4::bigint[])
          )
          AND EXISTS (
            SELECT 1 FROM agents a
             WHERE a.agent_id = mq.agent_id
               AND (
                 a.status IN ('online', 'busy')
                 OR mq.id = ANY($4::bigint[])
               )
               AND a.profile_enabled IS TRUE
               AND a.disabled_at IS NULL
               AND COALESCE(NULLIF(BTRIM(a.runtime_engine_preference), ''), NULLIF(BTRIM(a.runtime), '')) IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM agent_messages am
                   JOIN channels c ON c.id = am.channel_id
                  WHERE am.id::text = mq.message_id
                    AND mq.agent_id = ANY(c.members)
               )
          )`
    const now = this.clock.now()
    const params: unknown[] = [now, this.config.claimTtlSec, this.config.activeClaimMaxAgeSec, inflightQueueWorkIds]
    sql += this.agentScopeClause(params, 'mq.agent_id')
    sql += this.queueWorkFenceClause(params, 'mq')
    sql += this.queueWorkResidueExclusionClause(params, 'mq')
    const { rowCount } = await this.dbQuery(sql, params)
    this.metrics.inc('state_daemon_heartbeat_refresh_total', { result: 'ok' }, rowCount)

    const skippedParams: unknown[] = [now, this.config.activeClaimMaxAgeSec, inflightQueueWorkIds]
    let skippedSql = `SELECT count(*)::int AS n
        FROM message_queue mq
       WHERE mq.status IN ('received', 'in_progress')
         AND mq.claim_expires_at > $1::timestamptz
         AND mq.payload NOT LIKE '%"source":"state-daemon-d1-auto-receive"%'
         AND (
           mq.claimed_by IS DISTINCT FROM mq.agent_id
           OR mq.claimed_at IS NULL
           OR (
             mq.claimed_at < $1::timestamptz - ($2 || ' seconds')::interval
             AND NOT (mq.id = ANY($3::bigint[]))
           )
         )`
    skippedSql += this.agentScopeClause(skippedParams, 'mq.agent_id')
    skippedSql += this.queueWorkFenceClause(skippedParams, 'mq')
    skippedSql += this.queueWorkResidueExclusionClause(skippedParams, 'mq')
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
      if (bot.runtime === defaultConfigPort.getDefaultRuntime()) {
        this.metrics.inc('state_daemon_bot_liveness_skipped_total', { runtime: 'legacy_tui_disabled' })
        continue
      }
      await this.alert.alert(
        `bot ${bot.agent_id} dead (runtime=${bot.runtime}, manual intervention)`,
      )
      result.escalated++
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
    if (this.isQueueWorkResidueExcluded(row)) {
      this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'queue_work_residue_excluded', path: 'wake' })
      return false
    }
    const automaticProcessing = await this.checkAutomaticProcessingEligibility(row)
    if (!automaticProcessing.ok) {
      this.recordAutomaticProcessingBlocked(row, automaticProcessing)
      return false
    }
    const d1Handled = await this.tryShirubeD1AutoReceive(row)
    if (d1Handled !== null) return d1Handled
    const manifestAdmission = await this.checkAllAgentCommunicationManifestAdmission(row)
    if (manifestAdmission.outcome !== 'admit') {
      this.metrics.inc('state_daemon_all_agent_manifest_admission_total', {
        result: 'denied',
        code: manifestAdmission.code,
      })
      void this.alert.alert(
        `ordinary communication manifest blocked ${row.agent_id} queue_id=${row.id}: ${manifestAdmission.code}`,
      )
      return false
    }
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

  private async checkAutomaticProcessingEligibility(
    row: QueueRow,
  ): Promise<AutomaticProcessingEligibilityVerdict> {
    return evaluateStateDaemonAutomaticProcessingEligibility(this.db, {
      agentId: row.agent_id,
      channelId: row.channel_id ?? null,
      denylisted: this.config.agentDenylist?.includes(row.agent_id) ?? false,
    })
  }

  private recordAutomaticProcessingBlocked(
    row: QueueRow,
    verdict: AutomaticProcessingEligibilityVerdict,
  ): void {
    for (const reason of verdict.reasons) {
      this.metrics.inc('state_daemon_automatic_processing_blocked_total', {
        agent_id: row.agent_id,
        reason,
      })
    }
    void this.alert.alert(
      `DB automatic-processing authority blocked ${row.agent_id} queue_id=${row.id}: ${verdict.reasons.join(',')}`,
    )
  }

  private async checkAllAgentCommunicationManifestAdmission(
    row: QueueRow,
  ): Promise<AllAgentCommunicationAdmissionDecision | { outcome: 'admit'; manifest_id: 'disabled'; revision: 0; artifact_digest: ''; target_sha256: '' }> {
    if (!this.config.allAgentCommunicationManifestEnforcementEnabled) {
      return { outcome: 'admit', manifest_id: 'disabled', revision: 0, artifact_digest: '', target_sha256: '' }
    }
    if (!this.allAgentCommunicationAdmissionGate) {
      return { outcome: 'deny', code: 'MANIFEST_GATE_UNAVAILABLE' }
    }
    try {
      return await this.allAgentCommunicationAdmissionGate.decide({
        phase: 'preclaim',
        queue_id: Number(row.id),
        message_id: row.message_id ?? null,
        created_at: new Date(row.created_at).toISOString(),
        agent_id: row.agent_id,
        payload: row.payload,
      })
    } catch (error) {
      return {
        outcome: 'deny',
        code: 'MANIFEST_GATE_UNAVAILABLE',
        detail: (error as Error).message ?? String(error),
      }
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
      `SELECT agent_id, runtime, runtime_engine_preference, metadata,
              (metadata->>'tmux_session') AS tmux_session, last_seen_at, status,
              profile_enabled, disabled_at, expected_provider_identity
         FROM agents WHERE agent_id=$1`,
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
      `SELECT agent_id, runtime, runtime_engine_preference, metadata,
              (metadata->>'tmux_session') AS tmux_session, last_seen_at, status,
              profile_enabled, disabled_at, expected_provider_identity
         FROM agents WHERE agent_id=$1`,
      [row.agent_id],
    )
    const bot = rows[0]
    const defaultRuntime = defaultConfigPort.getDefaultRuntime()
    if (bot && row.status === 'pending') {
      if (await this.completeNoReplyIfRequired(row)) {
        return true
      }
      const surface = classifyQueueSurface({
        agentId: row.agent_id,
        payload: row.payload,
        agent: bot,
      })
      if (!surface.actionable) {
        if (this.shouldAllowExactFencedQueueWorkPending(row, surface)) {
          this.metrics.inc('state_daemon_queue_work_actions_total', {
            result: 'pending_routing_bypass',
            message_type: surface.message_type,
          })
        } else {
          if (surface.deterministic_non_actionable) {
            this.recordQueueAction({ kind: 'terminal_non_actionable', terminal: true }, row)
            return this.completeNonActionableIfRequired(row, surface)
          }
          this.recordQueueAction({ kind: 'routing_hold', terminal: false }, row)
          this.metrics.inc('state_daemon_wake_actions_total', {
            result: 'routing_non_actionable_held',
            message_type: surface.message_type,
            route_reason: surface.routing.route_reason,
          })
          return false
        }
      }
    }
    let hasActiveClaim = false
    if (bot) {
      const activeClaimParams: unknown[] = [row.agent_id]
      let activeClaimSql = `SELECT 1 FROM message_queue mq
          WHERE mq.agent_id=$1
            AND mq.claimed_by=$1
            AND mq.status IN ('received', 'in_progress')`
      activeClaimSql += this.queueWorkResidueExclusionClause(activeClaimParams, 'mq')
      activeClaimSql += ' LIMIT 1'
      const activeClaims = await this.dbQuery(activeClaimSql, activeClaimParams)
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
    const memoryReady = await this.checkMemoryReadyGate(row, action)
    if (!memoryReady.ok) {
      this.recordMemoryReadyBlocked(action, row, memoryReady)
      return false
    }
    if (action.kind !== 'agent_missing' && row.status !== 'pending' && await this.completeNoReplyIfRequired(row)) {
      return true
    }
    if (action.kind !== 'wake_pending' && action.kind !== 'wake_received') {
      return this.runObservedQueueAction(action, row, bot)
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

  private async recoverQueueWorkRunnerErrorRow(row: QueueRow): Promise<'reclaimed' | 'failed' | 'skipped'> {
    const automaticProcessing = await this.checkAutomaticProcessingEligibility(row)
    if (!automaticProcessing.ok) {
      this.recordAutomaticProcessingBlocked(row, automaticProcessing)
      return 'skipped'
    }
    const payload = parseQueuePayload(row.payload)
    if (!payload.runner_error) return 'skipped'

    const recovery = payload[QUEUE_WORK_RUNNER_ERROR_RECOVERY_KEY]
    const previousAttempts = typeof recovery === 'object' && recovery !== null
      ? Number((recovery as { attempts?: unknown }).attempts ?? 0)
      : 0
    const attempts = Number.isFinite(previousAttempts) && previousAttempts > 0
      ? Math.floor(previousAttempts)
      : 0
    const maxReclaims = Math.max(0, this.config.queueWorkRunnerErrorMaxReclaims)
    const now = this.clock.now()
    const configuredExtensionRef = this.config.queueWorkRecoveryControlRef?.trim() || null
    const priorExtensionRef = typeof recovery === 'object' && recovery !== null
      ? String((recovery as { bounded_extension_control_ref?: unknown }).bounded_extension_control_ref ?? '').trim() || null
      : null
    const boundedExtensionAllowed = !!(
      configuredExtensionRef
      && attempts === maxReclaims
      && priorExtensionRef !== configuredExtensionRef
      && this.queueWorkFenceConfigured()
      && this.isQueueWorkFenceInScope(row)
    )

    if (attempts >= maxReclaims && !boundedExtensionAllowed) {
      const failedPayload = JSON.stringify({
        ...payload,
        [QUEUE_WORK_RUNNER_ERROR_RECOVERY_KEY]: {
          attempts,
          max_reclaims: maxReclaims,
          last_action: 'failed',
          last_at: now.toISOString(),
          source: QUEUE_WORK_SCHEDULER_SOURCE,
          reason: QUEUE_WORK_RUNNER_ERROR_FAILED_REASON,
        },
      })
      const updated = await this.dbQuery(
        `UPDATE message_queue
            SET status='failed',
                failed_reason=$2,
                done_at=$3,
                payload=$4,
                claimed_by=NULL,
                claimed_at=NULL,
                claim_expires_at=NULL,
                last_heartbeat_at=NULL
          WHERE id=$1
            AND status='in_progress'
            AND payload LIKE '%"runner_error"%'`,
        [row.id, QUEUE_WORK_RUNNER_ERROR_FAILED_REASON, now, failedPayload],
      )
      if (updated.rowCount !== 1) return 'skipped'
      this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'runner_error_failed' })
      await this.alert.alert(
        `queue work runner_error exhausted for ${row.agent_id} queue_id=${row.id}; marked failed`,
      )
      return 'failed'
    }

    const nextAttempts = attempts + 1
    const effectiveMaxReclaims = boundedExtensionAllowed ? nextAttempts : maxReclaims
    const reclaimedPayload = JSON.stringify({
      ...payload,
      [QUEUE_WORK_RUNNER_ERROR_RECOVERY_KEY]: {
        attempts: nextAttempts,
        max_reclaims: effectiveMaxReclaims,
        last_action: 'reclaimed',
        last_at: now.toISOString(),
        source: QUEUE_WORK_SCHEDULER_SOURCE,
        ...(boundedExtensionAllowed ? {
          base_max_reclaims: maxReclaims,
          bounded_extension_control_ref: configuredExtensionRef,
          bounded_extension_reason: 'exact_canary_recovery_after_control_plane_fix',
        } : {}),
      },
    })
    const updated = await this.dbQuery(
      `UPDATE message_queue
          SET status='pending',
              payload=$2,
              claimed_by=NULL,
              claimed_at=NULL,
              claim_expires_at=NULL,
              last_heartbeat_at=NULL
        WHERE id=$1
          AND status='in_progress'
          AND payload LIKE '%"runner_error"%'`,
      [row.id, reclaimedPayload],
    )
    if (updated.rowCount !== 1) return 'skipped'
    this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'runner_error_reclaimed' })
    return 'reclaimed'
  }

  private recordQueueAction(action: PlannedQueueAction, row: QueueRow): void {
    this.metrics.inc('state_daemon_state_actions_total', {
      action: action.kind,
      status: row.status,
      terminal: action.terminal ? 'true' : 'false',
    })
  }

  private async checkMemoryReadyGate(row: QueueRow, action: PlannedQueueAction): Promise<RuntimeMemoryReadyGateResult> {
    const gateRequired = action.gates.some((gate) => gate.kind === 'memory_ready' && gate.required)
    if (!gateRequired) {
      return {
        ok: true,
        gate: 'memory_ready',
        reason: 'ready',
        agent_id: row.agent_id,
        project: this.config.memoryReadyProject,
        checked_at: this.clock.now().toISOString(),
        runtime_instance_id: null,
        evidence_id: null,
        evidence_path: null,
        evidence_log_id: null,
        source: 'state_daemon_gate_not_required',
        valid_until: null,
        current_runtime: null,
        details: { gate_required: false },
      }
    }
    if (!this.config.memoryReadyGateEnabled) {
      return {
        ok: false,
        gate: 'memory_ready',
        reason: 'unaudited_bypass',
        agent_id: row.agent_id,
        project: this.config.memoryReadyProject,
        checked_at: this.clock.now().toISOString(),
        runtime_instance_id: null,
        evidence_id: null,
        evidence_path: null,
        evidence_log_id: null,
        source: 'state_daemon_config_bypass_rejected',
        valid_until: null,
        current_runtime: null,
        details: {
          configured_gate_enabled: false,
          required_contract: 'runtime_memory_ready_evidence.explicit_operator_bypass',
        },
      }
    }
    return evaluateRuntimeMemoryReadyGate(this.db, {
      agent_id: row.agent_id,
      expected_agent_id: row.agent_id,
      project: this.config.memoryReadyProject,
      now: this.clock.now(),
      queue_scope: {
        queue_id: row.id,
        status: row.status,
        action_kind: action.kind,
      },
    })
  }

  private recordMemoryReadyBlocked(
    action: PlannedQueueAction,
    row: QueueRow,
    gate: RuntimeMemoryReadyGateResult,
  ): void {
    this.metrics.inc('state_daemon_wake_actions_total', {
      result: 'memory_ready_blocked',
      action: action.kind,
      reason: gate.reason,
    })
    void this.alert.alert(
      `memory_ready gate blocked ${action.kind} for ${row.agent_id} queue_id=${row.id}: ${gate.reason}`,
    )
  }

  private async runObservedQueueAction(
    action: PlannedQueueAction,
    row: QueueRow,
    agent?: AgentRow | null,
  ): Promise<boolean> {
    switch (action.kind) {
      case 'invoke_codex_runner':
        if (this.queueWorkScheduler?.runPending) {
          this.scheduleQueueWorkRunner('pending', row, () => this.queueWorkScheduler!.runPending!({
            queueId: row.id,
            agentId: row.agent_id,
          }))
          return true
        }
        return this.invokeCodexRunner(row, agent)
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
      case 'observe_received':
        if (this.queueWorkScheduler) {
          this.scheduleQueueWorkRunner('received', row, () => this.queueWorkScheduler!.runReceived({
            queueId: row.id,
            agentId: row.agent_id,
          }))
          return true
        }
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'observed' })
        return false
      case 'legacy_tui_disabled':
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'legacy_tui_disabled' })
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })
        return false
      case 'wake_pending':
      case 'wake_received':
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'tui_wake_disabled' })
        return false
      default:
        this.metrics.inc('state_daemon_wake_actions_total', { result: 'observed' })
        return false
    }
  }

  private scheduleQueueWorkRunner(
    phase: 'pending' | 'received',
    row: QueueRow,
    run: () => Promise<void>,
  ): void {
    if (this.isQueueWorkResidueExcluded(row)) {
      this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'queue_work_residue_excluded', path: phase })
      return
    }
    if (this.queueWorkFenceConfigured() && !this.isQueueWorkFenceInScope(row)) {
      this.metrics.inc('state_daemon_queue_work_actions_total', { result: 'queue_work_fence_skipped', path: phase })
      return
    }
    const key = row.agent_id
    const queueId = String(row.id)
    if (this.inflightQueueWork.has(key)) {
      this.metrics.inc('state_daemon_queue_work_actions_total', {
        result: this.inflightQueueWorkIds.has(queueId)
          ? `${phase}_runner_dedup_skipped`
          : `${phase}_runner_agent_busy_deferred`,
      })
      return
    }
    this.metrics.inc('state_daemon_queue_work_actions_total', { result: `${phase}_runner_invoked` })
    this.inflightQueueWorkIds.add(queueId)
    const promise = Promise.resolve()
      .then(run)
      .catch((err) => {
        const message = (err as Error).message ?? String(err)
        this.metrics.inc('state_daemon_queue_work_actions_total', { result: `${phase}_runner_error` })
        void this.alert.alert(`queue work ${phase} runner failed for ${row.agent_id} queue_id=${row.id}: ${message}`)
      })
      .finally(() => {
        this.inflightQueueWorkIds.delete(queueId)
        this.inflightQueueWork.delete(key)
      })
    this.inflightQueueWork.set(key, promise)
  }

  private shirubeD1Input(row: QueueRow): ShirubeD1AutoReceiveInput {
    return {
      queueId: Number(row.id),
      agentId: row.agent_id,
      messageId: row.message_id ?? null,
      createdAt: new Date(row.created_at).toISOString(),
      status: row.status,
      payload: row.payload,
    }
  }

  private async classifyShirubeD1AutoReceive(row: QueueRow): Promise<ShirubeD1AutoReceiveDecision> {
    if (!this.shirubeD1AutoReceive) return { outcome: 'not_d1' }
    try {
      return await this.shirubeD1AutoReceive.classify(this.shirubeD1Input(row))
    } catch (error) {
      return {
        outcome: 'reject',
        reason: 'D1_CLASSIFICATION_ERROR',
        detail: (error as Error).message ?? String(error),
      }
    }
  }

  private recordShirubeD1Rejection(
    row: QueueRow,
    decision: Extract<ShirubeD1AutoReceiveDecision, { outcome: 'reject' }>,
  ): void {
    this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', {
      result: 'rejected',
      reason: decision.reason,
    })
    void this.alert.alert(
      `Shirube D1 auto-receive rejected ${row.agent_id} queue_id=${row.id}: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ''}`,
    )
  }

  /**
   * Returns null for ordinary traffic, true when a D1 dispatch was scheduled,
   * and false when D1 owned the row but intentionally stopped it fail-closed.
   */
  private async tryShirubeD1AutoReceive(row: QueueRow): Promise<boolean | null> {
    const decision = await this.classifyShirubeD1AutoReceive(row)
    if (decision.outcome === 'not_d1') {
      // Production composes both dispatchers. A received ordinary row still
      // belongs to the opt-in generic scheduler; the D1 dispatcher being
      // present must not suppress that pre-existing path. Classification has
      // already established that this is not D1 traffic, so it is safe to
      // restore the exact-row runReceived dispatch here without allowing a
      // D1-shaped rejection to fall through.
      if (row.status === 'received'
        && this.queueWorkScheduler
        && !this.config.allAgentCommunicationManifestEnforcementEnabled) {
        this.scheduleQueueWorkRunner('received', row, () => this.queueWorkScheduler!.runReceived({
          queueId: row.id,
          agentId: row.agent_id,
        }))
        return true
      }
      return null
    }
    if (decision.outcome === 'reject') {
      this.recordShirubeD1Rejection(row, decision)
      return false
    }

    this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', { result: 'admitted' })
    if (row.status !== 'pending' && row.status !== 'done') {
      this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', {
        result: 'resume_wait',
        status: row.status,
      })
      return false
    }

    const key = String(row.id)
    if (this.inflightQueueWork.has(key)) {
      this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', { result: 'duplicate_notify' })
      return true
    }
    const input = this.shirubeD1Input(row)
    this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', {
      result: row.status === 'done' ? 'resume_started' : 'started',
    })
    const promise = this.shirubeD1AutoReceive!.dispatch(input)
      .then((result) => {
        this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', {
          result: result.replayed ? 'replayed' : 'terminal',
          code: result.code,
        })
      })
      .catch((error) => {
        const message = (error as Error).message ?? String(error)
        this.metrics.inc('state_daemon_shirube_d1_auto_receive_total', { result: 'error' })
        void this.alert.alert(`Shirube D1 auto-receive failed for ${row.agent_id} queue_id=${row.id}: ${message}`)
      })
      .finally(() => {
        this.inflightQueueWork.delete(key)
      })
    this.inflightQueueWork.set(key, promise)
    return true
  }

  private scheduleGithubWorkPuller(trigger: 'startup' | 'interval'): void {
    if (!this.githubWorkPuller) return
    if (this.githubWorkPullerInFlight) {
      this.metrics.inc('state_daemon_github_work_puller_actions_total', { result: 'dedup_skipped', trigger })
      return
    }
    const startedAt = this.clock.now().getTime()
    this.metrics.inc('state_daemon_github_work_puller_actions_total', { result: 'poll_started', trigger })
    const promise = this.githubWorkPuller.pollOnce()
      .then((result) => {
        this.metrics.inc('state_daemon_github_work_puller_actions_total', { result: 'poll_completed', trigger })
        this.metrics.gaugeSet('state_daemon_github_work_puller_scanned', result.scanned)
        this.metrics.gaugeSet('state_daemon_github_work_puller_matched', result.matched)
        this.metrics.gaugeSet('state_daemon_github_work_puller_queued', result.queued)
        this.metrics.gaugeSet('state_daemon_github_work_puller_duplicate_suppressed', result.duplicateSuppressed)
        this.metrics.gaugeSet('state_daemon_github_work_puller_blocked', result.blocked)
        this.metrics.gaugeSet('state_daemon_github_work_puller_dispatch_failed', result.dispatchFailed)
        this.metrics.observe('state_daemon_github_work_puller_duration_ms', this.clock.now().getTime() - startedAt, { trigger })
      })
      .catch((err) => {
        const message = (err as Error).message ?? String(err)
        this.metrics.inc('state_daemon_github_work_puller_actions_total', { result: 'poll_error', trigger })
        void this.alert.alert(`github work puller failed (${trigger}): ${message}`)
      })
      .finally(() => {
        this.githubWorkPullerInFlight = null
      })
    this.githubWorkPullerInFlight = promise
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

  private isQueueWorkSchedulerClaim(row: QueueRow): boolean {
    const payload = parseQueuePayload(row.payload)
    return payload.receive_claim?.source === QUEUE_WORK_SCHEDULER_SOURCE
  }

  private queueWorkFenceConfigured(): boolean {
    return !!(
      this.config.queueWorkFenceQueueIds?.length
      || this.config.queueWorkFenceMessageIds?.length
      || this.config.queueWorkFenceCreatedAfter
    )
  }

  private queueWorkResidueExclusionConfigured(): boolean {
    return !!this.config.queueWorkResidueExcludedQueueIds?.length
  }

  private isQueueWorkResidueExcluded(row: QueueRow): boolean {
    const queueIds = this.config.queueWorkResidueExcludedQueueIds
    return !!queueIds?.length && queueIds.includes(Number(row.id))
  }

  private isQueueWorkFenceInScope(row: QueueRow): boolean {
    const queueIds = this.config.queueWorkFenceQueueIds
    if (queueIds?.length && !queueIds.includes(Number(row.id))) return false
    const messageIds = this.config.queueWorkFenceMessageIds
    if (messageIds?.length && (!row.message_id || !messageIds.includes(row.message_id))) return false
    const createdAfter = this.config.queueWorkFenceCreatedAfter
    if (createdAfter) {
      const fenceTime = Date.parse(createdAfter)
      const rowTime = new Date(row.created_at as unknown as string | Date).getTime()
      if (!Number.isFinite(fenceTime) || !Number.isFinite(rowTime) || rowTime < fenceTime) return false
    }
    return true
  }

  private shouldAllowExactFencedQueueWorkPending(row: QueueRow, surface: QueueSurfaceClassification): boolean {
    return !!(
      this.queueWorkScheduler?.runPending
      && row.status === 'pending'
      && !surface.deterministic_non_actionable
      && this.queueWorkFenceConfigured()
      && !this.isQueueWorkResidueExcluded(row)
      && this.isQueueWorkFenceInScope(row)
    )
  }

  private queueWorkFenceClause(params: unknown[], alias: string): string {
    if (!this.queueWorkFenceConfigured()) return ''
    let sql = ''
    const queueIds = this.config.queueWorkFenceQueueIds
    if (queueIds?.length) {
      params.push(queueIds)
      sql += ` AND ${alias}.id = ANY($${params.length}::bigint[])`
    }
    const messageIds = this.config.queueWorkFenceMessageIds
    if (messageIds?.length) {
      params.push(messageIds)
      sql += ` AND ${alias}.message_id = ANY($${params.length}::text[])`
    }
    const createdAfter = this.config.queueWorkFenceCreatedAfter
    if (createdAfter) {
      params.push(createdAfter)
      sql += ` AND ${alias}.created_at >= $${params.length}::timestamptz`
    }
    return sql
  }

  private queueWorkResidueExclusionClause(params: unknown[], alias: string): string {
    const queueIds = this.config.queueWorkResidueExcludedQueueIds
    if (!queueIds?.length) return ''
    params.push(queueIds)
    return ` AND NOT (${alias}.id = ANY($${params.length}::bigint[]))`
  }

  private async fetchQueueRowById(id: number): Promise<QueueRow | null> {
    const { rows } = await this.dbQuery<QueueRow>(
      `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.claim_expires_at, mq.created_at,
              mq.last_wake_attempt_at, mq.last_heartbeat_at,
              am.message_type, am.channel_id
         FROM message_queue mq
         LEFT JOIN agent_messages am ON am.id::text = mq.message_id
        WHERE mq.id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  private async fetchShirubeD1RecoveryRows(): Promise<QueueRow[]> {
    const params: unknown[] = [this.config.batchLimit]
    let sql = `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status,
              mq.claim_expires_at, mq.claimed_at, mq.created_at,
              mq.last_wake_attempt_at, mq.last_heartbeat_at,
              am.message_type, am.channel_id
         FROM message_queue mq
         LEFT JOIN agent_messages am ON am.id::text = mq.message_id
        WHERE mq.status = 'done'
          AND mq.payload LIKE '%"shirube_v4_d1"%'`
    sql += this.agentScopeClause(params, 'mq.agent_id')
    sql += this.queueWorkFenceClause(params, 'mq')
    sql += this.queueWorkResidueExclusionClause(params, 'mq')
    sql += ' ORDER BY mq.done_at ASC NULLS FIRST, mq.id ASC LIMIT $1'
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async completeNoReplyIfRequired(row: QueueRow): Promise<boolean> {
    if (this.isQueueWorkResidueExcluded(row)) return false
    if (!this.config.codexRunnerAutoCompleteNoReply) return false
    if (row.status !== 'pending' && row.status !== 'received' && row.status !== 'in_progress') return false
    const decision = this.noReplyDecisionForRow(row)
    if (!decision.no_reply_required) return false

    const now = this.clock.now()
    const payload = parseQueuePayload(row.payload)
    const stampedPayload = JSON.stringify(withTerminalBaton(payload, buildTerminalBaton({
      reason: decision.reason ?? 'state_daemon_auto_no_reply',
      setBy: 'state_daemon',
      source: 'deterministic_no_reply_policy',
      now: () => now,
    })))
    const updated = await this.dbQuery(
      `UPDATE message_queue
          SET status='done',
              done_at=$2,
              payload=$3,
              claim_expires_at=NULL,
              claimed_by=NULL,
              claimed_at=NULL
        WHERE id=$1
          AND status IN ('pending', 'received', 'in_progress')`,
      [row.id, now, stampedPayload],
    )
    if (updated.rowCount !== 1) {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'no_reply_stale_skipped' })
      return false
    }
    this.metrics.inc('state_daemon_wake_actions_total', { result: 'state_daemon_no_reply_completed' })
    return true
  }

  private async completeNonActionableIfRequired(
    row: QueueRow,
    surface: QueueSurfaceClassification,
  ): Promise<boolean> {
    const disposition = surface.deterministic_non_actionable
    if (!disposition) return false

    const now = this.clock.now()
    const stampedPayload = JSON.stringify(withQueueDispositionStamp(parseQueuePayload(row.payload), {
      code: disposition.reason,
      set_by: 'state_daemon',
      set_at: now.toISOString(),
      source: disposition.source,
      message_type: disposition.message_type,
      routing_decision: surface.routing.routing_decision,
      route_reason: surface.routing.route_reason,
    }))
    const updated = await this.dbQuery(
      `UPDATE message_queue
          SET status='skipped',
              failed_reason=$2,
              done_at=$3,
              payload=$4,
              claim_expires_at=NULL,
              claimed_by=NULL,
              claimed_at=NULL
        WHERE id=$1
          AND status='pending'`,
      [row.id, disposition.reason, now, stampedPayload],
    )
    if (updated.rowCount !== 1) {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'non_actionable_stale_skipped' })
      return false
    }
    this.metrics.inc('state_daemon_wake_actions_total', {
      result: 'non_actionable_terminalized',
      reason: disposition.reason,
      message_type: disposition.message_type,
    })
    return false
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

  private async invokeCodexRunner(row: QueueRow, agent?: AgentRow | null): Promise<boolean> {
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
    const autoFinalReply = this.config.codexRunnerAutoFinalReply && !completeNoReply
    const runnerInput = {
      agentId: row.agent_id,
      queueId: Number(row.id),
      messageId: row.message_id ?? null,
      requester: this.requesterFromPayload(row.payload),
      databaseUrl: this.config.codexRunnerDatabaseUrl,
      ackContent: autoFinalReply ? '' : this.boundedAckContent(row, noReplyDecision),
      completeNoReply,
      completionReason: completeNoReply
        ? noReplyDecision.reason ?? 'state_daemon_auto_no_reply'
        : null,
      autoFinalReply,
      payload: row.payload,
    }
    // Per-agent adapter selection: if the agent has a runtime_engine_preference
    // that maps to a known LLM (claude-code, codex), use the per-agent profile.
    // This allows auditor/devauditor (claude-code) and codex-* bots to each get
    // the correct headless invocation without global config changes.
    const agentAdapter = selectAgentAdapter(agent?.runtime_engine_preference)
    const effectiveProfile: RuntimeInvocationProfile | undefined =
      agentAdapter.profile ?? this.config.hostRuntimeInvocationProfile
    const hostAdapterEnabled =
      this.config.hostRuntimeAdapterEnabled || agentAdapter.kind === 'claude-code'
    const hostSelection = selectHostRuntimeAdapter({
      enabled: hostAdapterEnabled,
      profile: effectiveProfile,
      invocation: this.buildHostRuntimeInvocation(row, effectiveProfile, now),
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
    } else if (completionOutcome === 'completed_reply') {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_final_replied' })
    } else if (completionOutcome === 'completion_failed') {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_completion_failed' })
    } else if (completionOutcome === 'runtime_failed' || completionOutcome === 'unsupported_completion') {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_completion_failed' })
    } else if (completionOutcome === 'open') {
      this.metrics.inc('state_daemon_wake_actions_total', { result: 'codex_runner_open' })
    } else if (completionOutcome === 'needs_human') {
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
    let sql = `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.claim_expires_at, mq.created_at,
              mq.last_wake_attempt_at, mq.last_heartbeat_at,
              am.message_type, am.channel_id
         FROM message_queue mq
         LEFT JOIN agent_messages am ON am.id::text = mq.message_id
        WHERE mq.status='pending'
          AND mq.created_at < $1::timestamptz - ($2)::interval`
    sql += this.agentScopeClause(params, 'mq.agent_id')
    sql += this.queueWorkFenceClause(params, 'mq')
    sql += this.queueWorkResidueExclusionClause(params, 'mq')
    sql += ` ORDER BY mq.created_at LIMIT $3`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchReceivedExpired(): Promise<QueueRow[]> {
    let sql = `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.claim_expires_at, mq.created_at,
              mq.last_wake_attempt_at, mq.last_heartbeat_at,
              am.message_type, am.channel_id
         FROM message_queue mq
         LEFT JOIN agent_messages am ON am.id::text = mq.message_id
        WHERE mq.status IN ('received', 'in_progress')
          AND mq.claim_expires_at < $1::timestamptz`
    const params: unknown[] = [this.clock.now(), this.config.batchLimit]
    sql += this.agentScopeClause(params, 'mq.agent_id')
    sql += this.queueWorkFenceClause(params, 'mq')
    sql += this.queueWorkResidueExclusionClause(params, 'mq')
    sql += ` ORDER BY mq.claim_expires_at LIMIT $2`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchQueueWorkRunnerErrorRows(): Promise<QueueRow[]> {
    let sql = `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.claim_expires_at, mq.created_at,
              mq.last_wake_attempt_at, mq.last_heartbeat_at,
              am.message_type, am.channel_id
         FROM message_queue mq
         LEFT JOIN agent_messages am ON am.id::text = mq.message_id
        WHERE mq.status='in_progress'
          AND mq.payload LIKE '%"runner_error"%'`
    const params: unknown[] = [this.config.batchLimit]
    sql += this.agentScopeClause(params, 'mq.agent_id')
    sql += this.queueWorkFenceClause(params, 'mq')
    sql += this.queueWorkResidueExclusionClause(params, 'mq')
    sql += ` ORDER BY COALESCE(mq.claim_expires_at, mq.created_at), mq.created_at LIMIT $1`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchObservableWork(): Promise<QueueRow[]> {
    let sql = `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.claim_expires_at, mq.created_at,
              mq.last_wake_attempt_at, mq.last_heartbeat_at,
              am.message_type, am.channel_id
         FROM message_queue mq
         LEFT JOIN agent_messages am ON am.id::text = mq.message_id
        WHERE mq.status IN ('received', 'in_progress')
          AND (mq.claim_expires_at IS NULL OR mq.claim_expires_at >= $1::timestamptz)`
    const params: unknown[] = [this.clock.now(), this.config.batchLimit]
    sql += this.agentScopeClause(params, 'mq.agent_id')
    sql += this.queueWorkFenceClause(params, 'mq')
    sql += this.queueWorkResidueExclusionClause(params, 'mq')
    sql += ` ORDER BY mq.created_at LIMIT $2`
    const { rows } = await this.dbQuery<QueueRow>(sql, params)
    return rows
  }

  private async fetchAbandonRecent(): Promise<QueueRow[]> {
    // v0.9: 'failed' status removed from schema. IMPLICIT_ABANDON detection
    // is now via claim-ttl sweeper (rolling back to 'pending'). This fetch
    // is a no-op in v0.9 — Issue #349 will redesign abandonment tracking.
    return []
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

  /** Direct entry for #744 GitHub work puller overlap tests. */
  async __testRunGithubWorkPuller(trigger: 'startup' | 'interval' = 'interval'): Promise<void> {
    this.scheduleGithubWorkPuller(trigger)
    await Promise.resolve()
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
