#!/usr/bin/env bun
/**
 * state-daemon entry point (Issue #323 spec v0.6 §5.3 / §6).
 *
 * Wires the production-shape dependencies (real pg client, real tmux
 * adapter, real metrics + alert sinks) into the StateDaemon class and
 * runs until SIGTERM / SIGINT. Intended to be supervised by launchd
 * (see `config/launchd/com.agent-comms.state-daemon.plist`); a crash
 * triggers KeepAlive auto-restart.
 *
 * Usage:
 *   bun bin/state-daemon.ts
 *
 * Environment:
 *   DATABASE_URL                 — postgres connection string (required)
 *   STATE_DAEMON_LOG_PATH        — JSON log destination (default stdout)
 *   STATE_DAEMON_ALERT_CHANNEL   — agent-comms channel id for operator alerts
 *
 * Configuration overrides flow through env (matching StateDaemonConfig
 * field names with prefix STATE_DAEMON_, e.g. STATE_DAEMON_CLAIM_TTL_SEC).
 *
 * Note: this entry point is part of PR-B+C of the γ split. The pg_notify
 * trigger and the new columns it depends on land via PR #329 first.
 */
import { Client } from 'pg'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { StateDaemon } from '../core/state-daemon/index'
import { ExecFileCodexRunnerInvoker } from '../core/state-daemon/codex-runner-adapter'
import {
  githubWorkPullerEnabled,
  loadGithubWorkPullerConfigFromEnv,
  RestGithubWorkClient,
  StateDaemonGithubWorkPuller,
} from '../core/state-daemon/github-work-puller'
import {
  loadQueueWorkResiduePolicyFile,
  queueWorkResidueExcludedQueueIds,
} from '../core/state-daemon/queue-work-residue-policy'
import { receiveTargeted } from './aun/receive'
import { runQueueWork, type RunQueueWorkCliResult } from './aun/run-queue-work'
import { runtimeV2, type RuntimeV2CliOptions, type RuntimeV2CliResult } from './aun/runtime-v2'
import { classifyShirubeD1AutoReceive } from '../core/shirube-d1-runtime'
import type {
  AlertSink,
  DBClient,
  Metrics,
  PgListenClient,
  QueueWorkScheduler,
  ShirubeD1AutoReceiveDispatcher,
  ShirubeD1AutoReceiveInput,
  ShirubeD1AutoReceiveResult,
  StateDaemonConfig,
  TmuxClient,
} from '../core/state-daemon/types'

const execFileAsync = promisify(execFile)
export const SHIRUBE_D1_AUTO_RECEIVE_SOURCE = 'state-daemon-d1-auto-receive' as const

type RuntimeV2Invoker = (options: RuntimeV2CliOptions) => Promise<RuntimeV2CliResult>

/** Production bridge from queue arrival to the canonical runtime-v2 D1 path. */
export class RuntimeV2ShirubeD1AutoReceiveDispatcher implements ShirubeD1AutoReceiveDispatcher {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
    private readonly invokeRuntimeV2: RuntimeV2Invoker = runtimeV2,
  ) {}

  classify(input: ShirubeD1AutoReceiveInput) {
    return classifyShirubeD1AutoReceive({ agent_id: input.agentId, payload: input.payload }, this.env)
  }

  async dispatch(input: ShirubeD1AutoReceiveInput): Promise<ShirubeD1AutoReceiveResult> {
    const result = await this.invokeRuntimeV2({
      agentId: input.agentId,
      queueId: String(input.queueId),
      messageId: input.messageId,
      createdAfter: input.createdAt,
      runtime: this.env.STATE_DAEMON_SHIRUBE_D1_RUNTIME?.trim() || 'codex-exec',
      claimSource: SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
      invocationSource: SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
      expectedClaimSource: SHIRUBE_D1_AUTO_RECEIVE_SOURCE,
      finalize: true,
      env: this.env,
      cwd: this.cwd,
    })
    if (!result.ok || !result.outcome?.ok) {
      const outcome = result.outcome
      const detail = outcome && !outcome.ok ? outcome.detail ?? outcome.code : result.error ?? 'runtime-v2 returned no outcome'
      throw new Error(`runtime-v2 D1 dispatch failed: ${detail}`)
    }
    const finalizer = 'finalizer' in result.outcome ? result.outcome.finalizer : undefined
    return {
      code: result.outcome.code,
      replayed: input.status === 'done' || finalizer?.code === 'ALREADY_REPLIED',
    }
  }
}

// ── DBClient (single connection for queries; LISTEN uses its own client) ─────
class PgClientAdapter implements DBClient {
  private chain: Promise<void> = Promise.resolve()

  constructor(private client: Client) {}

  async query<T = any>(sql: string, params?: unknown[]) {
    const run = this.chain.then(() => this.client.query(sql, params))
    this.chain = run.then(() => undefined, () => undefined)
    const r = await run
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 }
  }
}

// ── PgListenClient (separate dedicated connection) ───────────────────────────
class PgNotifyListenClient implements PgListenClient {
  private client: Client | null = null
  constructor(private connStr: string) {}
  async listen(channel: string, onPayload: (payload: string) => void): Promise<void> {
    const c = new Client({ connectionString: this.connStr })
    await c.connect()
    c.on('notification', (msg) => {
      if (msg.channel === channel && typeof msg.payload === 'string') {
        onPayload(msg.payload)
      }
    })
    c.on('error', (err) => {
      // Surface to stderr; daemon's DB error streak path catches recurring
      // failures via its own query path.
      process.stderr.write(`[state-daemon] LISTEN client error: ${err.message}\n`)
    })
    await c.query(`LISTEN ${channel}`)
    this.client = c
  }
  async unlisten(): Promise<void> {
    if (!this.client) return
    try { await this.client.query('UNLISTEN *') } catch { /* ignore */ }
    try { await this.client.end() } catch { /* ignore */ }
    this.client = null
  }
}

// ── TmuxClient (real shell adapter) ──────────────────────────────────────────
class TmuxShellAdapter implements TmuxClient {
  async sessionExists(session: string): Promise<boolean> {
    try {
      await execFileAsync('tmux', ['has-session', '-t', session])
      return true
    } catch {
      return false
    }
  }
  async restartSession(agentId: string): Promise<void> {
    // Existing launcher: scripts/restart-bot.sh is the repo-owned bot restart
    // entrypoint. It resolves bot-registry.txt, cleans orphan ports, syncs
    // .mcp.json from registry SSOT, and recreates the tmux session.
    await execFileAsync('bash', ['scripts/restart-bot.sh', agentId])
  }
}

// ── Metrics (structured JSON log lines on stdout) ────────────────────────────
class StdoutMetrics implements Metrics {
  inc(name: string, labels?: Record<string, string | number>, by = 1): void {
    this.emit({ kind: 'inc', name, value: by, labels })
  }
  observe(name: string, value: number, labels?: Record<string, string | number>): void {
    this.emit({ kind: 'observe', name, value, labels })
  }
  gaugeSet(name: string, value: number, labels?: Record<string, string | number>): void {
    this.emit({ kind: 'gauge_set', name, value, labels })
  }
  private emit(payload: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), metric: payload }) + '\n')
  }
}

// ── AlertSink (stderr + optional agent-comms channel post) ───────────────────
class CompositeAlertSink implements AlertSink {
  constructor(private channelId: string | null) {}
  async alert(content: string): Promise<void> {
    process.stderr.write(`[state-daemon] ALERT: ${content}\n`)
    // The agent-comms post path is intentionally left as a TODO: the daemon
    // runs outside any LLM session, so it cannot use the MCP tool. A future
    // step will wire this to a CLI/HTTP endpoint of the agent-comms server.
    // Until then, stderr is the canonical alert sink and launchd's
    // StandardErrorPath captures it for operator review.
    if (this.channelId) {
      // placeholder: see comment above
    }
  }
}

// ── QueueWorkScheduler (opt-in script-controlled queue runner) ──────────────
class QueueWorkRunnerScheduler implements QueueWorkScheduler {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
  ) {}

  async runPending(input: { queueId: number; agentId: string }): Promise<void> {
    const env = this.envFor(input.agentId)
    const received = await receiveTargeted({
      agentId: input.agentId,
      queueId: String(input.queueId),
      env,
      cwd: this.cwd,
    })
    if (!received.ok) {
      throw new Error(`targeted receive failed code=${received.code} stderr=${received.stderr.trim()}`)
    }
    await this.runReceived(input)
  }

  async runReceived(input: { queueId: number; agentId: string }): Promise<void> {
    const env = this.envFor(input.agentId)
    const result = await runQueueWork({
      agentId: input.agentId,
      queueId: String(input.queueId),
      runtime: this.runtime(),
      finalize: env.STATE_DAEMON_QUEUE_WORK_FINALIZE === '1',
      env,
      cwd: this.cwd,
    })
    if (!result.ok) {
      // Rows claimed by another path (e.g. a live TUI session that called
      // `next`) are not scheduler work — leave them untouched, no alert.
      if ((result.runner as { code?: string } | undefined)?.code === 'CLAIM_NOT_OWNED') return
      throw new Error(this.describeFailure(result))
    }
  }

  private envFor(agentId: string): NodeJS.ProcessEnv {
    const env = {
      ...this.env,
      AGENT_ID: agentId,
      AGENT_COM_EXPECTED_AGENT_ID: agentId,
      AUN_RECEIVE_CLAIM_SOURCE: this.env.AUN_RECEIVE_CLAIM_SOURCE ?? 'state-daemon-queue-work-scheduler',
      AUN_QUEUE_WORK_INVOCATION_SOURCE: this.env.AUN_QUEUE_WORK_INVOCATION_SOURCE ?? 'state-daemon-queue-work-scheduler',
      // Only process rows this scheduler claimed itself (receive_claim.source
      // match) — never rows claimed by a TUI session or another runner.
      AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE:
        this.env.AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE
          ?? this.env.AUN_RECEIVE_CLAIM_SOURCE
          ?? 'state-daemon-queue-work-scheduler',
    }
    if (env.STATE_DAEMON_QUEUE_WORK_COMMAND && !env.AUN_QUEUE_WORK_COMMAND) {
      env.AUN_QUEUE_WORK_COMMAND = env.STATE_DAEMON_QUEUE_WORK_COMMAND
    }
    if (env.STATE_DAEMON_QUEUE_WORK_ARGS_JSON && !env.AUN_QUEUE_WORK_ARGS_JSON) {
      env.AUN_QUEUE_WORK_ARGS_JSON = env.STATE_DAEMON_QUEUE_WORK_ARGS_JSON
    }
    if (env.STATE_DAEMON_QUEUE_WORK_TIMEOUT_MS && !env.AUN_QUEUE_WORK_TIMEOUT_MS) {
      env.AUN_QUEUE_WORK_TIMEOUT_MS = env.STATE_DAEMON_QUEUE_WORK_TIMEOUT_MS
    }
    for (const key of [
      'CODEX_EXECUTABLE',
      'CODEX_OUTPUT_SCHEMA',
      'CODEX_SANDBOX',
      'CODEX_MODEL',
      'CODEX_PROFILE',
      'CODEX_EPHEMERAL',
      'CODEX_IGNORE_RULES',
      'CODEX_TIMEOUT_MS',
      'GITHUB_WRITEBACK_MODE',
      'MEDIATED_POSTING_COMMAND',
      'MEDIATED_POSTING_ARGS_JSON',
      'MEDIATED_POSTING_TIMEOUT_MS',
      'HANDOFF_CONTRACT',
    ]) {
      const stateKey = `STATE_DAEMON_QUEUE_WORK_${key}`
      const aunKey = `AUN_QUEUE_WORK_${key}`
      if (env[stateKey] && !env[aunKey]) env[aunKey] = env[stateKey]
    }
    return env
  }

  private runtime(): string | undefined {
    return this.env.STATE_DAEMON_QUEUE_WORK_RUNTIME ?? this.env.AUN_QUEUE_WORK_RUNTIME
  }

  private describeFailure(result: RunQueueWorkCliResult): string {
    return result.error
      ?? (result.runner && typeof result.runner === 'object'
        ? JSON.stringify(result.runner)
        : 'queue work runner returned ok=false')
  }
}

function queueWorkSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED
  return raw === '1' || raw?.toLowerCase() === 'true'
}

export function loadQueueWorkResidueExcludedQueueIds(env: NodeJS.ProcessEnv = process.env): number[] | undefined {
  const values = new Set<number>()
  const rawIds = env.STATE_DAEMON_QUEUE_WORK_RESIDUE_EXCLUDE_QUEUE_IDS
  if (rawIds) {
    for (const value of rawIds.split(',').map((part) => part.trim()).filter(Boolean)) {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
        throw new Error('STATE_DAEMON_QUEUE_WORK_RESIDUE_EXCLUDE_QUEUE_IDS must contain positive integer queue ids')
      }
      values.add(parsed)
    }
  }

  const policyFile = env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE?.trim()
  if (policyFile) {
    for (const queueId of queueWorkResidueExcludedQueueIds(loadQueueWorkResiduePolicyFile(policyFile))) {
      values.add(queueId)
    }
  }

  return values.size > 0 ? Array.from(values).sort((a, b) => a - b) : undefined
}

export function resolveGithubTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readTokenFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  const tokenFile = env.STATE_DAEMON_GITHUB_TOKEN_FILE?.trim()
  if (tokenFile) {
    const token = readTokenFile(tokenFile).trim()
    return token || undefined
  }
  const token = (env.STATE_DAEMON_GITHUB_TOKEN ?? env.GITHUB_TOKEN)?.trim()
  return token || undefined
}

// ── env → config mapping ─────────────────────────────────────────────────────
function loadConfig(): Partial<StateDaemonConfig> {
  const cfg: Partial<StateDaemonConfig> = {}
  const num = (k: string) => {
    const v = process.env[k]
    if (v == null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const str = (k: string) => process.env[k]
  const bool = (k: string) => {
    const v = process.env[k]
    if (v === undefined) return undefined
    return v === '1' || v.toLowerCase() === 'true'
  }
  const csv = (k: string) => {
    const v = process.env[k]
    if (!v) return undefined
    const values = v.split(',').map((s) => s.trim()).filter(Boolean)
    return values.length > 0 ? values : undefined
  }
  const csvNum = (k: string) => {
    const values = csv(k)
    if (!values) return undefined
    const parsed = values
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0)
    return parsed.length > 0 ? parsed : undefined
  }
  const set = <K extends keyof StateDaemonConfig>(k: K, v: StateDaemonConfig[K] | undefined) => {
    if (v !== undefined) (cfg as any)[k] = v
  }
  set('pollSweepIntervalMs', num('STATE_DAEMON_POLL_SWEEP_INTERVAL_MS'))
  set('pendingStaleAfter', str('STATE_DAEMON_PENDING_STALE_AFTER'))
  set('readExpiredAfter', str('STATE_DAEMON_READ_EXPIRED_AFTER'))
  set('abandonRecent', str('STATE_DAEMON_ABANDON_RECENT'))
  set('stuckAfter', str('STATE_DAEMON_STUCK_AFTER'))
  set('wakeDuplicateSuppressSec', num('STATE_DAEMON_WAKE_DUPLICATE_SUPPRESS_SEC'))
  set('batchLimit', num('STATE_DAEMON_BATCH_LIMIT'))
  set('budgetWarnMs', num('STATE_DAEMON_BUDGET_WARN_MS'))
  set('heartbeatIntervalMs', num('STATE_DAEMON_HEARTBEAT_INTERVAL_MS'))
  set('claimTtlSec', num('STATE_DAEMON_CLAIM_TTL_SEC'))
  set('activeClaimMaxAgeSec', num('STATE_DAEMON_ACTIVE_CLAIM_MAX_AGE_SEC'))
  set('wakePoolMinCapacity', num('STATE_DAEMON_WAKE_POOL_MIN_CAPACITY'))
  set('wakePoolMaxCapacity', num('STATE_DAEMON_WAKE_POOL_MAX_CAPACITY'))
  set('wakePoolGrowStep', num('STATE_DAEMON_WAKE_POOL_GROW_STEP'))
  set('wakePoolShrinkStep', num('STATE_DAEMON_WAKE_POOL_SHRINK_STEP'))
  set('wakePoolQueueHighWatermark', num('STATE_DAEMON_WAKE_POOL_QUEUE_HIGH_WATERMARK'))
  set('botLivenessCheckIntervalMs', num('STATE_DAEMON_BOT_LIVENESS_CHECK_INTERVAL_MS'))
  set('botDeadThresholdMs', num('STATE_DAEMON_BOT_DEAD_THRESHOLD_MS'))
  set('botRestartMaxPerHour', num('STATE_DAEMON_BOT_RESTART_MAX_PER_HOUR'))
  set('abnormalActivityWindowMs', num('STATE_DAEMON_ABNORMAL_ACTIVITY_WINDOW_MS'))
  set('abnormalActivityThreshold', num('STATE_DAEMON_ABNORMAL_ACTIVITY_THRESHOLD'))
  set('dbErrorAlertThreshold', num('STATE_DAEMON_DB_ERROR_ALERT_THRESHOLD'))
  set('codexRunnerEnabled', str('STATE_DAEMON_CODEX_RUNNER_ENABLED') === '1')
  set('codexRunnerDatabaseUrl', str('STATE_DAEMON_CODEX_RUNNER_DATABASE_URL'))
  set('codexRunnerAckContentMaxChars', num('STATE_DAEMON_CODEX_RUNNER_ACK_CONTENT_MAX_CHARS'))
  set('codexRunnerAutoCompleteNoReply', bool('STATE_DAEMON_CODEX_RUNNER_AUTO_COMPLETE_NO_REPLY'))
  set('codexRunnerAutoFinalReply', bool('STATE_DAEMON_CODEX_RUNNER_AUTO_FINAL_REPLY'))
  set('memoryReadyProject', str('STATE_DAEMON_MEMORY_READY_PROJECT') ?? str('AGENT_MEMORY_PROJECT'))
  set('agentAllowlist', csv('STATE_DAEMON_AGENT_ALLOWLIST'))
  set('agentDenylist', csv('STATE_DAEMON_AGENT_DENYLIST'))
  set('queueWorkFenceQueueIds', csvNum('STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS'))
  set('queueWorkFenceMessageIds', csv('STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS'))
  set('queueWorkFenceCreatedAfter', str('STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER'))
  set('queueWorkResidueExcludedQueueIds', loadQueueWorkResidueExcludedQueueIds(process.env))
  set('githubWorkPullerEnabled', bool('STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED') ?? false)
  set('githubWorkPullerIntervalMs', num('STATE_DAEMON_GITHUB_WORK_INTERVAL_MS'))
  set('githubWorkPullerRepos', csv('STATE_DAEMON_GITHUB_WORK_REPOS'))
  set('githubWorkPullerLabels', csv('STATE_DAEMON_GITHUB_WORK_LABELS'))
  set('githubWorkPullerOwnerAllowlist', csv('STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST'))
  return cfg
}

export async function main(): Promise<void> {
  const connStr = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
  const queryClient = new Client({ connectionString: connStr })
  await queryClient.connect()
  const db = new PgClientAdapter(queryClient)
  const config = loadConfig()
  const githubConfig = loadGithubWorkPullerConfigFromEnv(process.env)
  if (config.githubWorkPullerRepos && config.githubWorkPullerRepos.length > 0) {
    githubConfig.repos = config.githubWorkPullerRepos
  }
  if (config.githubWorkPullerLabels && config.githubWorkPullerLabels.length > 0) {
    githubConfig.labels = config.githubWorkPullerLabels
  }
  if (config.githubWorkPullerOwnerAllowlist && config.githubWorkPullerOwnerAllowlist.length > 0) {
    githubConfig.ownerAllowlist = config.githubWorkPullerOwnerAllowlist
  }

  const daemon = new StateDaemon({
    db,
    pgListen: new PgNotifyListenClient(connStr),
    tmux: new TmuxShellAdapter(),
    codexRunner: new ExecFileCodexRunnerInvoker(process.cwd()),
    queueWorkScheduler: queueWorkSchedulerEnabled()
      ? new QueueWorkRunnerScheduler(process.env, process.cwd())
      : undefined,
    shirubeD1AutoReceive: new RuntimeV2ShirubeD1AutoReceiveDispatcher(process.env, process.cwd()),
    githubWorkPuller: githubWorkPullerEnabled(process.env)
      ? new StateDaemonGithubWorkPuller({
        db,
        client: new RestGithubWorkClient({
          token: resolveGithubTokenFromEnv(process.env),
        }),
        config: githubConfig,
      })
      : undefined,
    clock: { now: () => new Date() },
    metrics: new StdoutMetrics(),
    alert: new CompositeAlertSink(process.env.STATE_DAEMON_ALERT_CHANNEL ?? null),
    config,
  })

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    process.stderr.write(`[state-daemon] received ${signal}, shutting down\n`)
    try {
      await daemon.stop()
    } catch (err) {
      process.stderr.write(`[state-daemon] stop error: ${(err as Error).message}\n`)
    }
    try {
      await queryClient.end()
    } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await daemon.start()
  process.stderr.write(`[state-daemon] started (pid=${process.pid})\n`)

  // Idle until signal — the daemon's intervals carry the work.
  await new Promise<void>(() => {})
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[state-daemon] fatal: ${(err as Error).message ?? err}\n`)
    process.exit(1)
  })
}
