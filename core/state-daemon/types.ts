/**
 * StateDaemon type contracts (Issue #323 spec v0.6 §1, §9).
 *
 * Frozen interfaces per `docs/design/state-daemon-6section-elements.md` §1.
 * Open decisions (§5) — implementer-chosen private types live in `index.ts`,
 * not here. Anything exported from this module is part of the contract.
 */
import type {
  RuntimeRunnerTypedResult,
} from './runtime-runner-contract'
import type {
  HostRuntimeCommand,
  HostRuntimeRunnerInvocation,
  HostRuntimeRunnerResult,
  RuntimeInvocationProfile,
} from './host-runtime-invocation'
import type {
  AllAgentCommunicationAdmissionGate,
} from '../all-agent-communication-manifest'

/** spec §9 — full daemon configuration. Defaults match v0.6 §13.2. */
export interface StateDaemonConfig {
  /** DB desired-state reconciler; bootstrap projections enable this explicitly. */
  configurationReconcilerEnabled: boolean

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
  activeClaimMaxAgeSec: number      // default 300; daemon must not keep a claim alive forever
  queueWorkRunnerErrorMaxReclaims: number // default 3; fail after this many runner_error reclaims
  /** Exact canary control ref allowed one audited retry-budget extension. */
  queueWorkRecoveryControlRef: string | null

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
  codexRunnerAutoCompleteNoReply: boolean
  codexRunnerAutoFinalReply: boolean
  // CP-40D host runtime invocation adapter wiring. Disabled by default and
  // selected only when an explicit profile plus fixture/host invoker is wired.
  hostRuntimeAdapterEnabled: boolean
  hostRuntimeInvocationProfile: RuntimeInvocationProfile | null
  hostRuntimeInvocationSupportedFlags: string[] | null
  hostRuntimeInvocationSchemaPath: string | null
  hostRuntimeInvocationSchemaJson: string | null
  hostRuntimeInvocationOutputLastMessagePath: string | null
  memoryReadyGateEnabled: boolean
  memoryReadyProject: string
  /**
   * Temporary one-target canary overlay only. A non-null value is valid only
   * after LaunchAgent preflight verifies the Issue #917 control/owner refs,
   * subject, expiry, prior-plist digest, rollback command, and receipt
   * destination. It never makes an agent eligible; DB agent/channel state
   * remains authoritative and steady-state production leaves this null.
   */
  agentAllowlist: string[] | null
  /**
   * Normal fleet exclusion gate. Keep disabled/test/human identities here when
   * they should never be woken by state_daemon even if a queue row is inserted.
   */
  agentDenylist: string[] | null

  /**
   * Ordinary all-agent communication manifest admission. This remains false
   * by default and is independent of the protected Shirube D1 dispatcher.
   * Enabling without an injected gate fails closed before ordinary claim.
   */
  allAgentCommunicationManifestEnforcementEnabled: boolean

  /**
   * Optional queue-work fence for bounded canaries. When configured, daemon
   * queue-work/claim-refresh paths must ignore queue rows that do not match
   * the exact queue id, message id, and/or created_at lower bound.
   */
  queueWorkFenceQueueIds: number[] | null
  queueWorkFenceMessageIds: string[] | null
  queueWorkFenceCreatedAfter: string | null
  /**
   * Governed #758 residue rows that must be preserved as evidence and must
   * never be claimed, refreshed, reclaimed, or scheduled by queue-work.
   */
  queueWorkResidueExcludedQueueIds: number[] | null

  /**
   * #744 GitHub-first autonomous work discovery. Disabled by default because
   * it touches governance routing and queue lifecycle. When enabled, the
   * state-daemon supervises an internal non-cron worker that discovers GitHub
   * work and writes AUN queue notifications whose canonical instruction is the
   * GitHub URL.
   */
  githubWorkPullerEnabled: boolean
  githubWorkPullerIntervalMs: number
  githubWorkPullerRepos: string[] | null
  githubWorkPullerLabels: string[] | null
  githubWorkPullerOwnerAllowlist: string[] | null

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
  configurationReconcilerEnabled: false,
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
  activeClaimMaxAgeSec: 300,
  queueWorkRunnerErrorMaxReclaims: 3,
  queueWorkRecoveryControlRef: null,
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
  codexRunnerAutoCompleteNoReply: true,
  codexRunnerAutoFinalReply: false,
  hostRuntimeAdapterEnabled: false,
  hostRuntimeInvocationProfile: null,
  hostRuntimeInvocationSupportedFlags: null,
  hostRuntimeInvocationSchemaPath: null,
  hostRuntimeInvocationSchemaJson: null,
  hostRuntimeInvocationOutputLastMessagePath: null,
  memoryReadyGateEnabled: true,
  memoryReadyProject: 'agent-comms-mcp',
  agentAllowlist: null,
  agentDenylist: null,
  allAgentCommunicationManifestEnforcementEnabled: false,
  queueWorkFenceQueueIds: null,
  queueWorkFenceMessageIds: null,
  queueWorkFenceCreatedAfter: null,
  queueWorkResidueExcludedQueueIds: null,
  githubWorkPullerEnabled: false,
  githubWorkPullerIntervalMs: 120_000,
  githubWorkPullerRepos: null,
  githubWorkPullerLabels: null,
  githubWorkPullerOwnerAllowlist: null,
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

export function loadAllAgentCommunicationManifestOverridesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<StateDaemonConfig> {
  const raw = env.STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED
  if (raw === undefined) return {}
  const normalized = raw.trim().toLowerCase()
  return {
    // An explicit malformed value must not silently disable enforcement and
    // reopen ordinary auto-receive. Arming the gate makes missing/invalid
    // wiring deny before claim, while an absent variable remains default-off.
    allAgentCommunicationManifestEnforcementEnabled:
      normalized === '1' || normalized === 'true'
        ? true
        : normalized === '0' || normalized === 'false'
          ? false
          : true,
  }
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
export class WakePoolSaturatedError extends Error {
  constructor(message: string) { super(message) }
}
export class BotRestartLimitError extends Error {
  constructor(public agentId: string) {
    super(`legacy bot restart is disabled for ${agentId}`)
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
  /** Legacy adapter hook retained for compatibility; StateDaemon no longer restarts TUI/tmux bots. */
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

export type {
  RuntimeBatonContext,
  RuntimeQueueContext,
  RuntimeRunnerAdapter,
  RuntimeRunnerCommand,
  RuntimeRunnerInvocation,
  RuntimeRunnerKind,
  RuntimeRunnerResult,
  RuntimeRunnerTypedResult,
} from './runtime-runner-contract'

export interface CodexRunnerInvocation {
  agentId: string
  queueId: number
  messageId: string | null
  requester: string | null
  databaseUrl: string
  ackContent: string
  completeNoReply?: boolean
  completionReason?: string | null
  autoFinalReply?: boolean
  payload?: unknown
}

export interface CodexRunnerResult {
  ok: boolean
  code: number
  stdout?: string
  stderr?: string
  typed_result?: RuntimeRunnerTypedResult
}

export interface CodexRunnerInvoker {
  invoke(input: CodexRunnerInvocation): Promise<CodexRunnerResult>
}

export interface HostRuntimeInvocationExecution {
  profile: RuntimeInvocationProfile
  invocation: HostRuntimeRunnerInvocation
  command: HostRuntimeCommand
}

export interface HostRuntimeInvoker {
  invoke(input: HostRuntimeInvocationExecution): Promise<HostRuntimeRunnerResult>
}

/** Schedules queue work for agents driven by LLM runners (Codex, Claude Code, etc.). */
export interface QueueWorkScheduler {
  runPending?(input: { queueId: number; agentId: string }): Promise<void>
  runReceived(input: { queueId: number; agentId: string }): Promise<void>
}

/**
 * Dedicated queue-arrival bridge for an authorized Shirube D1 row.
 * Classification is deliberately separate from dispatch so D1-shaped invalid
 * rows can fail closed before any generic routing or runner path is considered.
 */
export interface ShirubeD1AutoReceiveInput {
  queueId: number
  agentId: string
  messageId: string | null
  createdAt: string
  status: string
  payload: unknown
}

export type ShirubeD1AutoReceiveDecision =
  | { outcome: 'not_d1' }
  | { outcome: 'admit' }
  | { outcome: 'reject'; reason: string; detail?: string }

export interface ShirubeD1AutoReceiveResult {
  code: string
  replayed: boolean
}

export interface ShirubeD1AutoReceiveDispatcher {
  classify(input: ShirubeD1AutoReceiveInput): ShirubeD1AutoReceiveDecision | Promise<ShirubeD1AutoReceiveDecision>
  dispatch(input: ShirubeD1AutoReceiveInput): Promise<ShirubeD1AutoReceiveResult>
}

/** #744 supervised GitHub work puller; implementation lives outside StateDaemon. */
export interface GithubWorkPuller {
  pollOnce(): Promise<{
    scanned: number
    matched: number
    queued: number
    duplicateSuppressed: number
    blocked: number
    dispatchFailed: number
  }>
}

export interface ConfigurationReconcilerService {
  start(): Promise<void>
  stop(): Promise<void>
  sweepOnce(): Promise<unknown>
}

export interface StateDaemonDeps {
  db: DBClient
  pgListen: PgListenClient
  tmux: TmuxClient
  codexRunner?: CodexRunnerInvoker
  hostRuntimeInvoker?: HostRuntimeInvoker
  queueWorkScheduler?: QueueWorkScheduler
  shirubeD1AutoReceive?: ShirubeD1AutoReceiveDispatcher
  allAgentCommunicationAdmissionGate?: AllAgentCommunicationAdmissionGate
  githubWorkPuller?: GithubWorkPuller
  configurationReconciler?: ConfigurationReconcilerService
  clock: Clock
  metrics: Metrics
  alert: AlertSink
  config?: Partial<StateDaemonConfig>
}
