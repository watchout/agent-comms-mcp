/**
 * StateDaemon type contracts (Issue #323 spec v0.6 §1, §9).
 *
 * Frozen interfaces per `docs/design/state-daemon-6section-elements.md` §1.
 * Open decisions (§5) — implementer-chosen private types live in `index.ts`,
 * not here. Anything exported from this module is part of the contract.
 */

/** spec §9 — full daemon configuration. Defaults match v0.6 §13.2. */
export interface StateDaemonConfig {
  // wake / sweep (§4.3)
  pollSweepIntervalMs: number       // default 30_000
  pendingStaleAfter: string         // default '10 seconds' (PG interval string)
  readExpiredAfter: string          // default '30 seconds'
  abandonRecent: string             // default '60 seconds'
  stuckAfter: string                // default '5 minutes'
  wakeDuplicateSuppressSec: number  // default 5
  batchLimit: number                // default 100
  budgetWarnMs: number              // default 200

  // 補強 #1 claim refresh
  heartbeatIntervalMs: number       // default 30_000
  claimTtlSec: number               // default 60

  // 補強 #2 subprocess pool
  wakePoolMinCapacity: number       // default 5
  wakePoolMaxCapacity: number       // default 20
  wakePoolGrowStep: number          // default 2
  wakePoolShrinkStep: number        // default 1
  wakePoolQueueHighWatermark: number // default 10

  // 補強 #5 dead bot auto-restart
  botLivenessCheckIntervalMs: number // default 30_000
  botDeadThresholdMs: number         // default 120_000
  botRestartMaxPerHour: number       // default 3

  // §10.3 reactive control
  abnormalActivityWindowMs: number   // default 300_000 (5 min)
  abnormalActivityThreshold: number  // default 5 (msg count)

  // §8 alert thresholds
  dbErrorAlertThreshold: number      // default 5 (consecutive)

  // PR #338 sub-PR 5 — 7-day GC (spec §1.6 GC job)
  gcRepliedAfterSec: number          // default 604_800 (= 7 * 24h)
  gcIntervalMs: number               // default 3_600_000 (= 1 hour)
  gcBatchLimit: number               // default 1000 (spec invariant: batch delete to avoid deadlock)

  // #439 Codex runner handoff. Disabled by default until operator-approved
  // state_daemon restart/activation; tests enable it explicitly.
  codexRunnerEnabled: boolean
  codexRunnerDatabaseUrl: string
  codexRunnerAckContentMaxChars: number
  /**
   * Optional emergency narrowing gate. Production should normally leave this
   * null so DB agent/channel state decides the fleet surface.
   */
  agentAllowlist: string[] | null
  /**
   * Normal fleet exclusion gate. Keep disabled/test/human identities here when
   * they should never be woken by state_daemon even if a queue row is inserted.
   */
  agentDenylist: string[] | null

  /**
   * Test-only scope guard. When set, every queue / agents query the daemon
   * issues is filtered to `agent_id LIKE prefix||'%'`. Production MUST leave
   * this `null` so the daemon scans the full fleet — the field exists only so
   * contract tests on a shared dev DB cannot interfere with live fleet rows.
   * §5 Open decision (test infrastructure / fixture builder).
   */
  agentIdPrefix: string | null
}

/** Defaults per spec v0.6 §9 + §13.2 CEO 採択 (O2-O8). */
export const DEFAULT_CONFIG: StateDaemonConfig = {
  pollSweepIntervalMs: 30_000,
  pendingStaleAfter: '10 seconds',
  readExpiredAfter: '30 seconds',
  abandonRecent: '60 seconds',
  stuckAfter: '5 minutes',
  wakeDuplicateSuppressSec: 5,
  batchLimit: 100,
  budgetWarnMs: 200,
  heartbeatIntervalMs: 30_000,
  claimTtlSec: 60,
  wakePoolMinCapacity: 5,
  wakePoolMaxCapacity: 20,
  wakePoolGrowStep: 2,
  wakePoolShrinkStep: 1,
  wakePoolQueueHighWatermark: 10,
  botLivenessCheckIntervalMs: 30_000,
  botDeadThresholdMs: 120_000,
  botRestartMaxPerHour: 3,
  abnormalActivityWindowMs: 300_000,
  abnormalActivityThreshold: 5,
  dbErrorAlertThreshold: 5,
  agentIdPrefix: null,
  gcRepliedAfterSec: 604_800,
  gcIntervalMs: 3_600_000,
  gcBatchLimit: 1000,
  codexRunnerEnabled: false,
  codexRunnerDatabaseUrl: 'postgresql:///agent_comms?host=/tmp',
  codexRunnerAckContentMaxChars: 240,
  agentAllowlist: null,
  agentDenylist: null,
}

/**
 * Env-driven override loader for the 7-day GC knobs (PR #338 sub-PR 5,
 * spec §1.6 GC job + env-driven thresholds precedent from sub-PR 2
 * cycle 2 `loadStallThresholdsFromEnv`). Reads `STATE_DAEMON_GC_AGE_DAYS`
 * (converted to seconds), `STATE_DAEMON_GC_INTERVAL_MS`, and
 * `STATE_DAEMON_GC_BATCH_LIMIT`. Each field falls back per-field when its
 * env var is unset, malformed, or non-positive — the existing defaults in
 * `DEFAULT_CONFIG` are the fallback values, so callers can write
 * `{ ...DEFAULT_CONFIG, ...loadGcOverridesFromEnv() }`.
 */
export function loadGcOverridesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<StateDaemonConfig> {
  const out: Partial<StateDaemonConfig> = {}
  const parsePositive = (key: string): number | null => {
    const raw = env[key]
    if (raw === undefined) return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    return n
  }
  const ageDays = parsePositive('STATE_DAEMON_GC_AGE_DAYS')
  if (ageDays !== null) out.gcRepliedAfterSec = Math.round(ageDays * 86_400)
  const intervalMs = parsePositive('STATE_DAEMON_GC_INTERVAL_MS')
  if (intervalMs !== null) out.gcIntervalMs = Math.round(intervalMs)
  const batchLimit = parsePositive('STATE_DAEMON_GC_BATCH_LIMIT')
  if (batchLimit !== null) out.gcBatchLimit = Math.round(batchLimit)
  return out
}

/** pg_notify('queue_event', ...) JSON payload (§7.3).
 *
 * Status union tracks the additive public-release schema. `replied` is
 * reserved for an actual reply row with `replied_with`/`replied_at`; no-reply
 * terminal closures use `skipped` or `failed` with `failed_reason`/`done_at`.
 */
export interface QueueEvent {
  op: 'INSERT' | 'UPDATE'
  id: number
  agent_id: string
  status: 'pending' | 'read' | 'received' | 'in_progress' | 'done' | 'replied' | 'skipped' | 'failed'
  claim_expires_at: string | null
}

/** Result aggregates returned by §1.2 batch methods. */
export interface SweepResult {
  scanned: number
  rewoken: number
  reclaimed: number
  abandonReset: number
  permanentlyFailed: number
  durationMs: number
  budgetWarn: boolean
}

export interface RefreshResult {
  refreshed: number
  skipped: number
}

export interface LivenessResult {
  checked: number
  restarted: number
  escalated: number
}

/** §1.5 error taxonomy. */
export class AlreadyStartedError extends Error {
  constructor() { super('StateDaemon already started') }
}
export class DBConnectionError extends Error {
  constructor(message: string, public cause?: unknown) { super(message) }
}
export class TmuxSendKeysError extends Error {
  constructor(message: string) { super(message) }
}
export class WakePoolSaturatedError extends Error {
  constructor(message: string) { super(message) }
}
export class BotRestartLimitError extends Error {
  constructor(public agentId: string) {
    super(`bot ${agentId} hit restart loop limit (1h/N)`)
  }
}

// ── Dependency interfaces (DI for test fakes per §1.2 invariants) ────────────

export interface DBClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
}

export interface PgListenClient {
  /** LISTEN <channel>; events delivered via callback. Reconnect handled by impl. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<void>
  unlisten(): Promise<void>
}

export interface TmuxClient {
  sessionExists(session: string): Promise<boolean>
  sendKeys(session: string, payload: string): Promise<void>
  /** §5.4 補強 #5 — restart launcher (existing `scripts/restart-bot.sh` hook). */
  restartSession(agentId: string): Promise<void>
}

export interface Clock {
  now(): Date
}

export interface Metrics {
  inc(name: string, labels?: Record<string, string | number>, by?: number): void
  observe(name: string, value: number, labels?: Record<string, string | number>): void
  gaugeSet(name: string, value: number, labels?: Record<string, string | number>): void
}

export interface AlertSink {
  alert(content: string): Promise<void>
}

export interface CodexRunnerInvocation {
  agentId: string
  queueId: number
  messageId: string | null
  requester: string | null
  databaseUrl: string
  ackContent: string
}

export interface CodexRunnerResult {
  ok: boolean
  code: number
  stdout?: string
  stderr?: string
}

export interface CodexRunnerInvoker {
  invoke(input: CodexRunnerInvocation): Promise<CodexRunnerResult>
}

export interface StateDaemonDeps {
  db: DBClient
  pgListen: PgListenClient
  tmux: TmuxClient
  codexRunner?: CodexRunnerInvoker
  clock: Clock
  metrics: Metrics
  alert: AlertSink
  config?: Partial<StateDaemonConfig>
}
