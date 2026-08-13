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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { StateDaemon } from '../core/state-daemon/index'
import {
  assertRuntimeMemoryReadyProjectResolutionCurrent,
  captureRuntimeMemoryReadyAuthority,
  resolveRuntimeMemoryReadyProject,
  type RuntimeMemoryReadyProjectResolution,
} from '../core/runtime-memory-ready'
import { PgAdapter } from '../core/db/pg-adapter'
import {
  AunConfigurationReconciler,
  DbConfigurationDesiredStateStore,
  DbConfigurationLeasePort,
  configurationEffectAuthorizationDigest,
  type ConfigurationApplyResult,
  type ConfigurationEffectAuthorization,
  type ConfigurationProjectionPort,
  type ConfigurationProjectionReadback,
  type ConfigurationRollbackResult,
} from '../core/aun-configuration-reconciler'
import {
  buildDefaultAunConfigurationCandidate,
  type AunConfigurationCandidate,
} from '../core/aun-configuration-candidate'
import { configurationDigest, type AunConfigurationDesiredState } from '../core/aun-configuration-desired-state'
import {
  parseStateDaemonLaunchAgentPlist,
  STATE_DAEMON_PLIST_NAME,
  validateStateDaemonCanaryOverlayEnv,
  type StateDaemonCanaryOverlayValidation,
} from '../core/state-daemon/launchagent'
import { parseClaudeMcpGet } from './aun/bootstrap-adapter-claude'
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
import { receiveTargeted, type TargetedReceiveResult } from './aun/receive'
import { runQueueWork, type RunQueueWorkCliResult } from './aun/run-queue-work'
import type { QueueWorkClaimFence } from '../core/queue-work'
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

export const STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR = 'STATE_DAEMON_DIRECT_ENTRY_ARGS_UNSUPPORTED' as const
export const STATE_DAEMON_DIRECT_ENTRY_DIAGNOSTIC_COMMANDS = [
  'bun cli/index.ts state-daemon readiness --format json',
  'bun cli/index.ts state-daemon queue-readiness --agent-id <id> --format json',
] as const

export type StateDaemonDirectEntryArgvValidation =
  | {
      ok: true
      code: null
      argv: []
    }
  | {
      ok: false
      code: typeof STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR
      argv: string[]
      diagnosticCommands: typeof STATE_DAEMON_DIRECT_ENTRY_DIAGNOSTIC_COMMANDS
    }

/**
 * This file is the daemon-only entry point. Diagnostics belong to cli/index.ts;
 * accepting their arguments here would silently start another LISTEN process.
 */
export function validateStateDaemonDirectEntryArgv(
  argv: readonly string[] = process.argv.slice(2),
): StateDaemonDirectEntryArgvValidation {
  if (argv.length === 0) return { ok: true, code: null, argv: [] }
  return {
    ok: false,
    code: STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR,
    argv: [...argv],
    diagnosticCommands: STATE_DAEMON_DIRECT_ENTRY_DIAGNOSTIC_COMMANDS,
  }
}

export class StateDaemonDirectEntryArgsError extends Error {
  readonly code = STATE_DAEMON_DIRECT_ENTRY_ARGS_ERROR
  readonly argv: string[]

  constructor(validation: Extract<StateDaemonDirectEntryArgvValidation, { ok: false }>) {
    super(
      `${validation.code}: bin/state-daemon.ts accepts no arguments; use `
      + validation.diagnosticCommands.join(' or '),
    )
    this.name = 'StateDaemonDirectEntryArgsError'
    this.argv = validation.argv
  }
}

export function assertStateDaemonDirectEntryArgv(
  argv: readonly string[] = process.argv.slice(2),
): void {
  const validation = validateStateDaemonDirectEntryArgv(argv)
  if (!validation.ok) throw new StateDaemonDirectEntryArgsError(validation)
}

/** Production bridge from queue arrival to the canonical runtime-v2 D1 path. */
export class RuntimeV2ShirubeD1AutoReceiveDispatcher implements ShirubeD1AutoReceiveDispatcher {
  readonly recoverDone: boolean

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
    private readonly invokeRuntimeV2: RuntimeV2Invoker = runtimeV2,
  ) {
    this.recoverDone = env.SHIRUBE_D1_ENABLED?.trim() === '1'
      && env.SHIRUBE_D1_KILL_SWITCH?.trim() === '0'
  }

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
export function exactClaimFenceFromTargetedReceive(
  received: TargetedReceiveResult,
  input: { queueId: number; agentId: string },
): QueueWorkClaimFence {
  const claimed = received.summary?.claimed
  const claimedAtMs = claimed?.claimed_at ? Date.parse(claimed.claimed_at) : Number.NaN
  const claimExpiresAtMs = claimed?.claim_expires_at ? Date.parse(claimed.claim_expires_at) : Number.NaN
  if (
    !claimed
    || String(claimed.queue_id ?? '') !== String(input.queueId)
    || claimed.claimed_by !== input.agentId
    || !Number.isFinite(claimedAtMs)
    || !Number.isFinite(claimExpiresAtMs)
    || claimExpiresAtMs <= claimedAtMs
  ) {
    throw new Error(`targeted receive returned no exact claim fence for ${input.agentId} queue_id=${input.queueId}`)
  }
  return {
    claimedBy: input.agentId,
    // Preserve the database timestamp text verbatim. PostgreSQL `now()` can
    // contain microseconds that a JavaScript Date would silently truncate.
    claimedAt: claimed.claimed_at!.trim(),
  }
}

export function describeQueueWorkFailure(result: RunQueueWorkCliResult): string {
  if (result.error) return result.error
  if (result.finalizer && typeof result.finalizer === 'object') {
    return JSON.stringify(result.finalizer)
  }
  if (result.runner && typeof result.runner === 'object') {
    return JSON.stringify(result.runner)
  }
  return 'queue work runner returned ok=false'
}

export type QueueWorkRuntimeWorkspaceDb = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export async function resolveQueueWorkRuntimeWorkspace(
  db: QueueWorkRuntimeWorkspaceDb,
  agentId: string,
): Promise<string> {
  return (await resolveQueueWorkRuntimeResolution(db, agentId)).canonical_workspace_path
}

export async function resolveQueueWorkRuntimeResolution(
  db: QueueWorkRuntimeWorkspaceDb,
  agentId: string,
): Promise<RuntimeMemoryReadyProjectResolution> {
  return resolveRuntimeMemoryReadyProject(db as any, { agent_id: agentId })
}

async function resolveQueueWorkRuntimeAuthorityResolution(
  db: QueueWorkRuntimeWorkspaceDb,
  agentId: string,
): Promise<RuntimeMemoryReadyProjectResolution> {
  const resolution = await resolveQueueWorkRuntimeResolution(db, agentId)
  const authority = await captureRuntimeMemoryReadyAuthority(db as any, resolution)
  return Object.freeze({ ...resolution, authority_tuple_digest: authority.tuple_digest })
}

function assertQueueWorkAuthorityDigestCurrent(
  expected: RuntimeMemoryReadyProjectResolution,
  current: RuntimeMemoryReadyProjectResolution,
): void {
  assertRuntimeMemoryReadyProjectResolutionCurrent(expected, current)
  if (expected.authority_tuple_digest && expected.authority_tuple_digest !== current.authority_tuple_digest) {
    throw new Error(
      `runtime memory-ready authority tuple changed: expected=${expected.authority_tuple_digest ?? 'missing'} `
      + `current=${current.authority_tuple_digest ?? 'missing'}`,
    )
  }
}

export class QueueWorkRunnerScheduler implements QueueWorkScheduler {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
    private readonly resolveRuntimeResolution: (
      agentId: string,
    ) => Promise<RuntimeMemoryReadyProjectResolution> = async (agentId) => {
      const canonicalWorkspacePath = realpathSync(cwd)
      return Object.freeze({
        agent_id: agentId,
        project: basename(canonicalWorkspacePath),
        workspace_path: canonicalWorkspacePath,
        canonical_workspace_path: canonicalWorkspacePath,
        workspace_id: null,
        source: 'canonical_workspace' as const,
        explicit_project: null,
      })
    },
    private readonly receiveInvoker: typeof receiveTargeted = receiveTargeted,
    private readonly queueWorkInvoker: typeof runQueueWork = runQueueWork,
  ) {}

  async runPending(
    input: { queueId: number; agentId: string },
    memoryReadyResolution?: RuntimeMemoryReadyProjectResolution,
  ): Promise<void> {
    const expected = memoryReadyResolution ?? await this.resolveRuntimeResolution(input.agentId)
    const beforeClaim = await this.resolveRuntimeResolution(input.agentId)
    assertQueueWorkAuthorityDigestCurrent(expected, beforeClaim)
    const env = this.envFor(input.agentId, expected)
    const received = await this.receiveInvoker({
      agentId: input.agentId,
      queueId: String(input.queueId),
      env,
      cwd: this.cwd,
    })
    if (!received.ok) {
      throw new Error(`targeted receive failed code=${received.code} stderr=${received.stderr.trim()}`)
    }
    await this.runReceivedWithFence(
      input,
      exactClaimFenceFromTargetedReceive(received, input),
      expected,
    )
  }

  async runReceived(
    input: { queueId: number; agentId: string },
    memoryReadyResolution?: RuntimeMemoryReadyProjectResolution,
  ): Promise<void> {
    const expected = memoryReadyResolution ?? await this.resolveRuntimeResolution(input.agentId)
    await this.runReceivedWithFence(input, undefined, expected)
  }

  async runDone(input: { queueId: number; agentId: string }): Promise<void> {
    const env = this.envFor(input.agentId)
    const result = await this.queueWorkInvoker({
      agentId: input.agentId,
      queueId: String(input.queueId),
      runtime: this.runtime(),
      requireClaimFence: true,
      finalize: true,
      finalizeOnly: true,
      env,
      cwd: this.cwd,
    })
    if (!result.ok) throw new Error(describeQueueWorkFailure(result))
  }

  private async runReceivedWithFence(
    input: { queueId: number; agentId: string },
    claimFence?: QueueWorkClaimFence,
    expected?: RuntimeMemoryReadyProjectResolution,
  ): Promise<void> {
    const baseline = expected ?? await this.resolveRuntimeResolution(input.agentId)
    const beforeDispatch = await this.resolveRuntimeResolution(input.agentId)
    assertQueueWorkAuthorityDigestCurrent(baseline, beforeDispatch)
    const runtimeCwd = baseline.canonical_workspace_path
    const env = {
      ...this.envFor(input.agentId, baseline),
      AUN_QUEUE_WORK_RUNTIME_CWD: runtimeCwd,
    }
    const result = await this.queueWorkInvoker({
      agentId: input.agentId,
      queueId: String(input.queueId),
      runtime: this.runtime(),
      claimFence,
      requireClaimFence: true,
      finalize: env.STATE_DAEMON_QUEUE_WORK_FINALIZE === '1',
      env,
      cwd: this.cwd,
      runtimeCwd,
    })
    if (!result.ok) {
      // Rows claimed by another path (e.g. a live TUI session that called
      // `next`) are not scheduler work — leave them untouched, no alert.
      if ((result.runner as { code?: string } | undefined)?.code === 'CLAIM_NOT_OWNED') return
      throw new Error(describeQueueWorkFailure(result))
    }
  }

  private envFor(
    agentId: string,
    memoryReadyResolution?: RuntimeMemoryReadyProjectResolution,
  ): NodeJS.ProcessEnv {
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
      ...(memoryReadyResolution ? {
        AGENT_MEMORY_PROJECT: memoryReadyResolution.project,
        AGENT_COMMS_MEMORY_READY_PROJECT: memoryReadyResolution.project,
        AUN_MEMORY_READY_RESOLUTION_JSON: JSON.stringify(memoryReadyResolution),
        AUN_QUEUE_WORK_RUNTIME_CWD: memoryReadyResolution.canonical_workspace_path,
      } : {}),
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
  set('configurationReconcilerEnabled', bool('STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED'))
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
  if (str('STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM') === '1') {
    set('queueWorkRecoveryControlRef', str('STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF') ?? null)
  }
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
  // AGENT_MEMORY_PROJECT belongs to the daemon process itself and is not a
  // fleet-wide target override. Only the state-daemon-specific equality
  // assertion may constrain a derived per-agent project.
  set('memoryReadyProject', str('STATE_DAEMON_MEMORY_READY_PROJECT'))
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

export function validateStateDaemonDirectEntryEnv(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): StateDaemonCanaryOverlayValidation {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') values[key] = value
  }
  return validateStateDaemonCanaryOverlayEnv(values, now)
}

export function assertStateDaemonDirectEntryEnv(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): void {
  const validation = validateStateDaemonDirectEntryEnv(env, now)
  if (validation.issues.length === 0) return
  const detail = validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ')
  throw new Error(`STATE_DAEMON_CANARY_OVERLAY_NO_GO: ${detail}`)
}

export function referenceMatches(actual: string | undefined, reference: string): boolean {
  if (actual === undefined) return false
  if (reference.startsWith('literal:')) return actual === reference.slice('literal:'.length)
  if (reference.startsWith('env:')) return actual === process.env[reference.slice('env:'.length)]
  // Opaque DB-owned references are projected into the native provider
  // environment verbatim.  Treating any non-empty native value as a match
  // lets an old identity/token reference satisfy a newer desired revision.
  return actual === reference
}

export function environmentReferencesMatch(
  actual: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(([key, reference]) => referenceMatches(actual[key], reference))
}

export function launchctlEnvironment(output: string, keys: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = output.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:=>|=)\\s*"?([^"\\n]+?)"?\\s*(?:\\n|$)`))
    if (match?.[1]) environment[key] = match[1].trim()
  }
  return environment
}

export function runtimeRegistrationRowsMatch(
  rows: readonly Record<string, unknown>[],
  candidate: AunConfigurationCandidate,
): boolean {
  if (!candidate.runtimeRegistration.enabled) return rows.length === 0
  if (rows.length !== 1) return false
  const row = rows[0]!
  const localPath = typeof row.local_path === 'string' ? row.local_path : ''
  return String(row.runtime_engine) === candidate.runtimeRegistration.runtimeEngine
    && Number(row.port) === candidate.runtimeRegistration.channelPort
    && localPath !== ''
    && resolve(localPath) === resolve(candidate.runtimeRegistration.workspace)
}

export interface NativeMcpCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

function nativeAbsence(result: NativeMcpCommandResult): boolean {
  return result.exitCode !== 0 && /(?:not found|no mcp server named)/i.test(result.stderr)
}

export function codexNativeMcpAbsent(
  getResult: NativeMcpCommandResult,
  listResult: NativeMcpCommandResult,
  serverName: string,
): boolean {
  if (!nativeAbsence(getResult) || listResult.exitCode !== 0) return false
  try {
    const parsed = JSON.parse(listResult.stdout)
    return Array.isArray(parsed) && parsed.filter((item) => item?.name === serverName).length === 0
  } catch {
    return false
  }
}

export function claudeNativeMcpAbsent(
  getResult: NativeMcpCommandResult,
  listResult: NativeMcpCommandResult,
  serverName: string,
): boolean {
  if (!nativeAbsence(getResult) || listResult.exitCode !== 0) return false
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const entries = listResult.stdout.split(/\r?\n/).filter((line) => new RegExp(`^\\s*${escaped}:\\s*`, 'i').test(line))
  return entries.length === 0
}

async function nativeMcpCommandResult(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
): Promise<NativeMcpCommandResult> {
  try {
    const result = await execFileAsync(command, args, options)
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      exitCode: Number.isInteger(failure.code) ? failure.code! : -1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    }
  }
}

export interface NativeReleaseIdentity {
  commit: string
  tree: string
  clean: boolean
}

export function nativeReleaseIdentityMatches(
  identity: NativeReleaseIdentity | null,
  candidate: AunConfigurationCandidate,
): boolean {
  return identity !== null
    && identity.commit === candidate.releaseCommit
    && identity.tree === candidate.releaseTree
    && identity.clean
}

async function readNativeReleaseIdentity(checkoutRoot: string): Promise<NativeReleaseIdentity | null> {
  try {
    const [commit, tree, status] = await Promise.all([
      execFileAsync('git', ['-C', checkoutRoot, 'rev-parse', 'HEAD^{commit}'], { timeout: 5_000 }),
      execFileAsync('git', ['-C', checkoutRoot, 'rev-parse', 'HEAD^{tree}'], { timeout: 5_000 }),
      execFileAsync('git', ['-C', checkoutRoot, 'status', '--porcelain'], { timeout: 5_000 }),
    ])
    const identity = {
      commit: commit.stdout.trim(),
      tree: tree.stdout.trim(),
      clean: status.stdout.trim() === '',
    }
    return /^[0-9a-f]{40}$/.test(identity.commit) && /^[0-9a-f]{40}$/.test(identity.tree)
      ? identity
      : null
  } catch {
    return null
  }
}

class NativeConfigurationProjectionPort implements ConfigurationProjectionPort {
  constructor(private readonly db: PgAdapter) {}

  async render(input: { hostId: string; desired: AunConfigurationDesiredState }): Promise<AunConfigurationCandidate> {
    const projection = input.desired.ordinaryProjection
    const providerRepoRoot = typeof projection.provider_repo_root === 'string' ? projection.provider_repo_root.trim() : ''
    const providerConfigRoot = typeof projection.provider_config_root === 'string' ? projection.provider_config_root.trim() : ''
    const daemonCheckout = typeof projection.daemon_checkout === 'string' ? projection.daemon_checkout.trim() : ''
    if (!providerRepoRoot || !providerConfigRoot || !daemonCheckout) throw new Error('ORDINARY_PROJECTION_ROOTS_INCOMPLETE')
    return buildDefaultAunConfigurationCandidate({
      hostId: input.hostId,
      desired: input.desired,
      databaseLocatorRef: process.env.AUN_DATABASE_LOCATOR_REF?.trim() || 'env:DATABASE_URL',
      databaseCredentialRef: process.env.AUN_DATABASE_CREDENTIAL_REF?.trim() || 'env:DATABASE_URL',
      bunPath: Bun.which('bun') ?? process.execPath,
      serverEntry: 'server.ts',
      providerRepoRoot: resolve(providerRepoRoot),
      providerConfigRoot: resolve(providerConfigRoot),
      daemonCheckout: resolve(daemonCheckout),
      daemonEntry: join(resolve(daemonCheckout), 'bin', 'state-daemon.ts'),
      restartRequired: true,
    })
  }

  async validate(candidate: AunConfigurationCandidate): Promise<{ ok: boolean; reasonCodes: string[] }> {
    const reasons: string[] = []
    if (!/^[0-9a-f]{64}$/.test(candidate.candidateDigest)) reasons.push('CANDIDATE_DIGEST_INVALID')
    if (candidate.providerMcp.databaseLocatorRef !== candidate.launchAgent.databaseLocatorRef) reasons.push('MIXED_DATABASE_ENDPOINT_CANDIDATE')
    const [providerRelease, daemonRelease] = await Promise.all([
      readNativeReleaseIdentity(candidate.providerMcp.checkoutRoot),
      readNativeReleaseIdentity(candidate.launchAgent.workingDirectory),
    ])
    if (!nativeReleaseIdentityMatches(providerRelease, candidate)) reasons.push('PROVIDER_RELEASE_MISMATCH')
    if (!nativeReleaseIdentityMatches(daemonRelease, candidate)) reasons.push('DAEMON_RELEASE_MISMATCH')
    return { ok: reasons.length === 0, reasonCodes: reasons }
  }

  async applyFenced(
    _candidate: AunConfigurationCandidate,
    authorization: ConfigurationEffectAuthorization,
  ): Promise<ConfigurationApplyResult> {
    const fenceVerifiedAtCommit = await authorization.verifyCurrent()
    return {
      ok: false, mutated: false, partial: false,
      authorizationDigest: configurationEffectAuthorizationDigest(authorization),
      fenceVerifiedAtCommit,
      reasonCode: fenceVerifiedAtCommit
        ? 'PROTECTED_NATIVE_CHANGE_REQUIRES_RESTART_DECISION'
        : 'ADAPTER_EFFECT_FENCE_REJECTED',
    }
  }

  async rollbackFenced(
    _candidate: AunConfigurationCandidate,
    authorization: ConfigurationEffectAuthorization,
  ): Promise<ConfigurationRollbackResult> {
    const fenceVerifiedAtCommit = await authorization.verifyCurrent()
    return {
      ok: fenceVerifiedAtCommit,
      authorizationDigest: configurationEffectAuthorizationDigest(authorization),
      fenceVerifiedAtCommit,
      ...(fenceVerifiedAtCommit ? {} : { reasonCode: 'ROLLBACK_EFFECT_FENCE_REJECTED' }),
    }
  }

  private async providerMatches(candidate: AunConfigurationCandidate): Promise<boolean> {
    try {
      const providerEnv = {
        ...process.env,
        HOME: candidate.providerMcp.providerHome,
        ...(candidate.providerMcp.provider === 'codex'
          ? { CODEX_HOME: candidate.providerMcp.providerConfigRoot }
          : { CLAUDE_CONFIG_DIR: candidate.providerMcp.providerConfigRoot }),
      }
      if (candidate.providerMcp.provider === 'codex') {
        const [getResult, listResult] = await Promise.all([
          nativeMcpCommandResult(
            'codex', ['mcp', 'get', candidate.providerMcp.serverName, '--json'],
            { env: providerEnv, timeout: 10_000 },
          ),
          nativeMcpCommandResult('codex', ['mcp', 'list', '--json'], { env: providerEnv, timeout: 10_000 }),
        ])
        if (!candidate.providerMcp.enabled) {
          return codexNativeMcpAbsent(getResult, listResult, candidate.providerMcp.serverName)
        }
        if (getResult.exitCode !== 0 || listResult.exitCode !== 0) return false
        const parsed = JSON.parse(getResult.stdout)
        const listed = JSON.parse(listResult.stdout)
        const entries = Array.isArray(listed)
          ? listed.filter((item) => item?.name === candidate.providerMcp.serverName)
          : []
        const transport = parsed?.transport
        const actualEnv = transport?.env && typeof transport.env === 'object' ? transport.env as Record<string, string> : {}
        return entries.length === 1
          && entries[0]?.enabled === true
          && parsed?.enabled === true
          && transport?.type === 'stdio'
          && resolve(String(transport?.command ?? '')) === resolve(candidate.providerMcp.command)
          && JSON.stringify(transport?.args ?? []) === JSON.stringify(candidate.providerMcp.args)
          && environmentReferencesMatch(actualEnv, candidate.providerMcp.environmentRefs)
      }
      const [getResult, listResult] = await Promise.all([
        nativeMcpCommandResult(
          'claude', ['mcp', 'get', candidate.providerMcp.serverName],
          { env: providerEnv, timeout: 10_000 },
        ),
        nativeMcpCommandResult('claude', ['mcp', 'list'], { env: providerEnv, timeout: 10_000 }),
      ])
      if (!candidate.providerMcp.enabled) {
        return claudeNativeMcpAbsent(getResult, listResult, candidate.providerMcp.serverName)
      }
      if (getResult.exitCode !== 0 || listResult.exitCode !== 0) return false
      const parsed = parseClaudeMcpGet(getResult.stdout)
      const escaped = candidate.providerMcp.serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const entries = listResult.stdout.split(/\r?\n/)
        .filter((line) => new RegExp(`^\\s*${escaped}:\\s*`, 'i').test(line))
      return entries.length === 1
        && /(?:✔|✓)?\s*Connected\s*$/i.test(entries[0]!)
        && parsed !== null
        && parsed.type.toLowerCase() === 'stdio'
        && resolve(parsed.command) === resolve(candidate.providerMcp.command)
        && JSON.stringify(parsed.args) === JSON.stringify(candidate.providerMcp.args)
        && environmentReferencesMatch(parsed.environment, candidate.providerMcp.environmentRefs)
    } catch {
      return false
    }
  }

  private async launchAgentMatches(candidate: AunConfigurationCandidate): Promise<{ plist: boolean; launchctl: boolean }> {
    const plistPath = process.env.STATE_DAEMON_LAUNCHAGENT_PLIST
      ?? join(homedir(), 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
    let plist = false
    if (existsSync(plistPath)) {
      try {
        const parsed = parseStateDaemonLaunchAgentPlist(readFileSync(plistPath, 'utf8'))
        plist = parsed.label === candidate.launchAgent.label
          && parsed.workingDirectory !== null
          && resolve(parsed.workingDirectory) === resolve(candidate.launchAgent.workingDirectory)
          && JSON.stringify(parsed.programArguments.map(resolve)) === JSON.stringify(candidate.launchAgent.programArguments.map(resolve))
          && environmentReferencesMatch(parsed.environmentVariables, candidate.launchAgent.environmentRefs)
      } catch { plist = false }
    }
    try {
      const { stdout } = await execFileAsync(
        'launchctl',
        ['print', `gui/${process.getuid?.() ?? 0}/${candidate.launchAgent.label}`],
        { timeout: 5_000 },
      )
      const environment = launchctlEnvironment(stdout, Object.keys(candidate.launchAgent.environmentRefs))
      return {
        plist,
        launchctl: environmentReferencesMatch(environment, candidate.launchAgent.environmentRefs),
      }
    } catch {
      return { plist, launchctl: false }
    }
  }

  private async runtimeMatches(candidate: AunConfigurationCandidate): Promise<boolean> {
    const rows = await this.db.query<any>(
      `SELECT r.runtime_engine, r.port, r.status, w.local_path
         FROM agent_runtime_instances r
         JOIN agent_workspaces w ON w.workspace_id = r.workspace_id
         JOIN agent_workspace_bindings b
           ON b.agent_id = r.agent_id AND b.workspace_id = r.workspace_id
          AND b.active = true AND b.binding_role = 'primary'
        WHERE r.agent_id = $1 AND r.status IN ('running', 'active')
        ORDER BY COALESCE(r.last_seen_at, r.started_at) DESC`,
      [candidate.agentId],
    ).catch(() => [])
    return runtimeRegistrationRowsMatch(rows, candidate)
  }

  async readback(candidate: AunConfigurationCandidate): Promise<ConfigurationProjectionReadback> {
    const [provider, launch, runtime, providerRelease, daemonRelease] = await Promise.all([
      this.providerMatches(candidate),
      this.launchAgentMatches(candidate),
      this.runtimeMatches(candidate),
      readNativeReleaseIdentity(candidate.providerMcp.checkoutRoot),
      readNativeReleaseIdentity(candidate.launchAgent.workingDirectory),
    ])
    const providerReleaseMatches = nativeReleaseIdentityMatches(providerRelease, candidate)
    const daemonReleaseMatches = nativeReleaseIdentityMatches(daemonRelease, candidate)
    const reasons = [
      ...(provider ? [] : ['PROVIDER_NATIVE_MISMATCH']),
      ...(launch.plist ? [] : ['LAUNCHAGENT_PLIST_MISMATCH']),
      ...(launch.launchctl ? [] : ['LAUNCHCTL_ENVIRONMENT_MISMATCH']),
      ...(runtime ? [] : ['RUNTIME_IDENTITY_MISMATCH']),
      ...(providerReleaseMatches ? [] : ['PROVIDER_RELEASE_MISMATCH']),
      ...(daemonReleaseMatches ? [] : ['DAEMON_RELEASE_MISMATCH']),
    ]
    return {
      matchesCandidate: reasons.length === 0,
      providerNativeDigest: provider
        ? configurationDigest({ projection: candidate.providerMcp, release: providerRelease })
        : configurationDigest({ provider: false, expected: candidate.providerMcp, release: providerRelease }),
      launchagentPlistDigest: launch.plist
        ? configurationDigest({ projection: candidate.launchAgent, release: daemonRelease })
        : configurationDigest({ plist: false, expected: candidate.launchAgent, release: daemonRelease }),
      launchctlEnvironmentDigest: launch.launchctl
        ? configurationDigest(candidate.launchAgent.environmentRefs)
        : configurationDigest({ launchctl: false, expected: candidate.launchAgent.environmentRefs }),
      runtimeIdentityDigest: runtime
        ? configurationDigest(candidate.runtimeRegistration)
        : configurationDigest({ runtime: false, expected: candidate.runtimeRegistration }),
      driftReasonCodes: reasons,
    }
  }
}

export async function main(): Promise<void> {
  assertStateDaemonDirectEntryArgv(process.argv.slice(2))
  // Fail before DB connection, daemon construction, LISTEN, or any runtime
  // effect when a host allowlist lacks the complete Issue #917 overlay.
  assertStateDaemonDirectEntryEnv(process.env)
  const connStr = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
  const queryClient = new Client({ connectionString: connStr })
  await queryClient.connect()
  const db = new PgClientAdapter(queryClient)
  const config = loadConfig()
  const configurationDb = config.configurationReconcilerEnabled ? new PgAdapter(connStr) : null
  const configurationReconciler = configurationDb
    ? new AunConfigurationReconciler(
        process.env.AUN_HOST_ID?.trim() || hostname(),
        new DbConfigurationDesiredStateStore(configurationDb),
        new DbConfigurationLeasePort(
          configurationDb,
          process.env.AGENT_ID?.trim() || 'state-daemon',
          process.env.STATE_DAEMON_RUNTIME_INSTANCE_ID?.trim() || null,
        ),
        new NativeConfigurationProjectionPort(configurationDb),
      )
    : undefined
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
      ? new QueueWorkRunnerScheduler(
          process.env,
          process.cwd(),
          (agentId) => resolveQueueWorkRuntimeAuthorityResolution(queryClient, agentId),
        )
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
    configurationReconciler,
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
    try {
      await configurationDb?.close()
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
