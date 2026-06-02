import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbAdapter } from './db'
import type { BotStatusDbRow, QueueWakeState } from './bot-status-db'
import { defaultConfigPort } from './ports/config-port'

const DEFAULT_LABEL = 'com.agent-comms.state-daemon'
const DEFAULT_SMOKE_AGENT_ID = '__queue_wake_smoke__'
const DEFAULT_SMOKE_TIMEOUT_MS = 15_000
const DEFAULT_SMOKE_POLL_MS = 500
const SMOKE_EVENT_TYPE = 'state_daemon.queue_wake_smoke'

export type StateDaemonReadinessStatus = 'ok' | 'degraded' | 'not_running' | 'unloaded' | 'unknown'
export type QueueWakeSmokeMode = 'dry_run' | 'execute'
export type QueueWakeSmokeResult = 'not_run' | 'pass' | 'timeout' | 'blocked' | 'error'

export interface StateDaemonRuntimeReadiness {
  label: string
  status: StateDaemonReadinessStatus
  checked_at: string
  launchd: {
    available: boolean
    loaded: boolean | null
    running: boolean | null
    state: string | null
    pid: number | null
    last_exit_status: number | null
  }
  process: {
    pid: number | null
    command: string | null
    cwd: string | null
  }
  paths: {
    program: string | null
    script: string | null
    working_directory: string | null
    stdout_path: string | null
    stderr_path: string | null
    plist_path: string | null
  }
  environment: {
    database_url: string | null
    agent_allowlist: string | null
    agent_denylist: string | null
  }
  stderr: {
    path: string | null
    exists: boolean | null
    fatal_fingerprint: string | null
  }
}

export interface QueueWakeSmokeReport {
  ok: boolean
  mode: QueueWakeSmokeMode
  result: QueueWakeSmokeResult
  error?: 'OPERATOR_APPROVAL_REQUIRED'
  generated_at: string
  plan_hash: string
  run_id: string | null
  policy: {
    dry_run_default: true
    execute_requires_confirm_plan_hash: true
    bounded_poll: true
    calls_manual_next: false
    terminalizes_existing_rows: false
  }
  options: {
    agent_id: string
    timeout_ms: number
    poll_ms: number
  }
  safety: {
    target_agent_found: boolean
    target_agent_runtime: string | null
    target_agent_status: string | null
    target_tmux_session: string | null
    active_claim_count: number
    pending_count: number
    denylist_hit: boolean
    blockers: string[]
  }
  smoke: {
    queue_id: string | null
    message_id: string | null
    inserted_at: string | null
    first_observed_at: string | null
    completed_at: string | null
    initial_status: string | null
    final_status: string | null
    row_last_wake_attempt_at: string | null
    agent_last_wake_attempt_at: string | null
    evidence: string[]
    polls: number
  }
}

export type QueueProcessingReadinessGoNoGo = 'GO' | 'NO_GO'

export interface QueueProcessingReadinessFinding {
  code: string
  severity: 'blocker' | 'warning'
  message: string
  agent_id?: string | null
  evidence?: Record<string, unknown>
}

export interface QueueProcessingReadinessReport {
  ok: boolean
  go_no_go: QueueProcessingReadinessGoNoGo
  generated_at: string
  issue_ref: '#603'
  transport_readiness: {
    ready: boolean
    state_daemon_status: StateDaemonReadinessStatus
    launchd_loaded: boolean | null
    launchd_running: boolean | null
    pid: number | null
    script: string | null
    working_directory: string | null
    stderr_fatal_fingerprint: string | null
    blocker_codes: string[]
  }
  queue_processing_readiness: {
    ready: boolean
    total_agents: number
    pending_total: number
    active_claim_total: number
    wake_state_counts: Record<QueueWakeState, number>
    stuck_agents: Array<{
      agent_id: string
      queue_wake_state: QueueWakeState
      pending_count: number
      oldest_pending_at: string | null
      active_claim_count: number
    }>
    blocker_codes: string[]
  }
  policy: {
    read_only: true
    no_db_mutation: true
    no_state_daemon_restart: true
    no_launchctl_mutation: true
    no_discord_live_write: true
    no_next_inbox_fifo_drain: true
    no_prompt_driven_processing: true
    no_live_smoke: true
  }
  blockers: QueueProcessingReadinessFinding[]
  warnings: QueueProcessingReadinessFinding[]
  recommended_next_commands: string[]
  mutation_performed: false
  restart_performed: false
}

export interface LatestQueueWakeSmoke {
  event_type: string
  agent_id: string | null
  target: string | null
  created_at: string | null
  detail: Record<string, unknown>
}

export interface QueueWakeSmokeOptions {
  agentId?: string | null
  mode?: QueueWakeSmokeMode
  confirmPlanHash?: string | null
  timeoutMs?: number
  pollMs?: number
  nowMs?: () => number
  sleepMs?: (ms: number) => Promise<void>
  denylist?: string[]
}

interface SmokeAgentRow {
  agent_id: string
  runtime: string | null
  status: string | null
  metadata: unknown
  last_wake_attempt_at: string | Date | null
}

interface QueueCountRow {
  pending_count: string | number
  active_claim_count: string | number
}

interface SmokeQueueRow {
  id: string | number
  status: string
  created_at: string | Date | null
  last_wake_attempt_at: string | Date | null
  read_at?: string | Date | null
  claimed_by?: string | null
  claimed_at?: string | Date | null
}

export interface StateDaemonRuntimeOptions {
  label?: string
  plistPath?: string
  stderrTailBytes?: number
  now?: () => Date
  env?: NodeJS.ProcessEnv
  execFileSync?: typeof execFileSync
  readFileSync?: typeof readFileSync
  existsSync?: typeof existsSync
  statSync?: typeof statSync
  getuid?: () => number
  homedir?: () => string
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function normalizeIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value)
}

function parseCount(value: string | number | undefined): number {
  if (value === undefined) return 0
  return typeof value === 'string' ? parseInt(value, 10) : value
}

function planHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12)
}

function defaultSmokeAgentId(): string {
  return process.env.STATE_DAEMON_QUEUE_SMOKE_AGENT_ID || DEFAULT_SMOKE_AGENT_ID
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseCsv(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((part) => part.trim()).filter(Boolean)
}

function isInactiveStatus(status: string | null): boolean {
  return status === 'disabled' || status === 'offline' || status === 'retired'
}

function xmlKeyValue(xml: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = xml.match(new RegExp(`<key>${escaped}<\\/key>\\s*<string>([^<]*)<\\/string>`))
  return match?.[1] ?? null
}

function plistProgramArg(xml: string, index: number): string | null {
  const match = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
  if (!match) return null
  const args = Array.from(match[1].matchAll(/<string>([^<]*)<\/string>/g)).map((m) => m[1])
  return args[index] ?? null
}

function plistEnvironment(xml: string): Record<string, string> {
  const match = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)
  if (!match) return {}
  const env: Record<string, string> = {}
  const pairRe = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g
  for (const pair of match[1].matchAll(pairRe)) env[pair[1]] = pair[2]
  return env
}

function parseLaunchctlPrint(output: string): {
  state: string | null
  pid: number | null
  lastExitStatus: number | null
  program: string | null
  script: string | null
  workingDirectory: string | null
  stdoutPath: string | null
  stderrPath: string | null
} {
  const state = output.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? null
  const pidRaw = output.match(/\bpid = (\d+)/)?.[1]
  const lastExitRaw = output.match(/\blast exit (?:status|code) = (-?\d+)/i)?.[1]
  const argsBlock = output.match(/\barguments = \{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
  const args = Array.from(argsBlock.matchAll(/^\s*([^\n]+)$/gm)).map((m) => m[1].trim()).filter(Boolean)
  return {
    state,
    pid: pidRaw ? Number(pidRaw) : null,
    lastExitStatus: lastExitRaw ? Number(lastExitRaw) : null,
    program: output.match(/\bprogram = ([^\n]+)/)?.[1]?.trim() ?? args[0] ?? null,
    script: args[1] ?? null,
    workingDirectory: output.match(/\bworking directory = ([^\n]+)/)?.[1]?.trim() ?? null,
    stdoutPath: output.match(/\bstdout path = ([^\n]+)/)?.[1]?.trim() ?? null,
    stderrPath: output.match(/\bstderr path = ([^\n]+)/)?.[1]?.trim() ?? null,
  }
}

export function fingerprintFatalStderr(stderrTail: string): string | null {
  const patterns = [
    /Module not found[^\r\n]*/i,
    /Cannot find module[^\r\n]*/i,
    /error:\s*[^\r\n]*module[^\r\n]*not found[^\r\n]*/i,
  ]
  for (const pattern of patterns) {
    const match = stderrTail.match(pattern)
    if (match) return match[0].slice(0, 240)
  }
  return null
}

function readTail(path: string, maxBytes: number, deps: Required<Pick<StateDaemonRuntimeOptions, 'readFileSync' | 'statSync'>>): string {
  const stat = deps.statSync(path)
  const content = deps.readFileSync(path, 'utf-8')
  if (stat.size <= maxBytes) return content
  return content.slice(Math.max(0, content.length - maxBytes))
}

function parsePs(output: string, pid: number): string | null {
  const line = output.split('\n').map((l) => l.trim()).find((l) => l.startsWith(String(pid)))
  return line ? line.replace(/^\d+\s+/, '') : null
}

function parseLsofCwd(output: string): string | null {
  const line = output.split('\n').find((l) => l.startsWith('n/'))
  return line ? line.slice(1) : null
}

export function inspectStateDaemonRuntime(options: StateDaemonRuntimeOptions = {}): StateDaemonRuntimeReadiness {
  const env = options.env ?? process.env
  const label = options.label ?? DEFAULT_LABEL
  const now = options.now ?? (() => new Date())
  const run = options.execFileSync ?? execFileSync
  const read = options.readFileSync ?? readFileSync
  const exists = options.existsSync ?? existsSync
  const stat = options.statSync ?? statSync
  const home = options.homedir?.() ?? env.HOME ?? homedir()
  const plistPath = options.plistPath ?? join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  const checkedAt = now().toISOString()

  let plistText: string | null = null
  if (exists(plistPath)) {
    try { plistText = read(plistPath, 'utf-8') } catch {}
  }
  const plistEnv = plistText ? plistEnvironment(plistText) : {}
  let program = plistText ? plistProgramArg(plistText, 0) : null
  let script = plistText ? plistProgramArg(plistText, 1) : null
  let workingDirectory = plistText ? xmlKeyValue(plistText, 'WorkingDirectory') : null
  let stdoutPath = plistText ? xmlKeyValue(plistText, 'StandardOutPath') : null
  let stderrPath = plistText ? xmlKeyValue(plistText, 'StandardErrorPath') : null

  let launchdAvailable = true
  let loaded: boolean | null = null
  let state: string | null = null
  let pid: number | null = null
  let lastExitStatus: number | null = null
  try {
    const uid = options.getuid?.() ?? (typeof process.getuid === 'function' ? process.getuid() : 0)
    const output = run('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf-8' }) as unknown as string
    const parsed = parseLaunchctlPrint(output)
    loaded = true
    state = parsed.state
    pid = parsed.pid
    lastExitStatus = parsed.lastExitStatus
    program = parsed.program ?? program
    script = parsed.script ?? script
    workingDirectory = parsed.workingDirectory ?? workingDirectory
    stdoutPath = parsed.stdoutPath ?? stdoutPath
    stderrPath = parsed.stderrPath ?? stderrPath
  } catch (err) {
    launchdAvailable = (err as NodeJS.ErrnoException).code !== 'ENOENT'
    loaded = plistText ? false : null
  }

  let command: string | null = null
  let cwd: string | null = null
  if (pid !== null) {
    try {
      command = parsePs(run('ps', ['-p', String(pid), '-o', 'pid=', '-o', 'command='], { encoding: 'utf-8' }) as unknown as string, pid)
    } catch {}
    try {
      cwd = parseLsofCwd(run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf-8' }) as unknown as string)
    } catch {}
  }

  let stderrExists: boolean | null = null
  let fatalFingerprint: string | null = null
  if (stderrPath) {
    stderrExists = exists(stderrPath)
    if (stderrExists) {
      try {
        fatalFingerprint = fingerprintFatalStderr(readTail(stderrPath, options.stderrTailBytes ?? 16_384, { readFileSync: read, statSync: stat }))
      } catch {}
    }
  }

  const running = state === 'running' || pid !== null
  const status: StateDaemonReadinessStatus =
    fatalFingerprint ? 'degraded'
      : running ? 'ok'
        : loaded === false ? 'unloaded'
          : loaded === true ? 'not_running'
            : 'unknown'

  return {
    label,
    status,
    checked_at: checkedAt,
    launchd: {
      available: launchdAvailable,
      loaded,
      running,
      state,
      pid,
      last_exit_status: lastExitStatus,
    },
    process: {
      pid,
      command,
      cwd,
    },
    paths: {
      program,
      script,
      working_directory: workingDirectory,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      plist_path: plistText ? plistPath : null,
    },
    environment: {
      database_url: plistEnv.DATABASE_URL ?? null,
      agent_allowlist: plistEnv.STATE_DAEMON_AGENT_ALLOWLIST ?? null,
      agent_denylist: plistEnv.STATE_DAEMON_AGENT_DENYLIST ?? null,
    },
    stderr: {
      path: stderrPath,
      exists: stderrExists,
      fatal_fingerprint: fatalFingerprint,
    },
  }
}

function smokePolicy(): QueueWakeSmokeReport['policy'] {
  return {
    dry_run_default: true,
    execute_requires_confirm_plan_hash: true,
    bounded_poll: true,
    calls_manual_next: false,
    terminalizes_existing_rows: false,
  }
}

function emptySmokeSafety(agentId: string): QueueWakeSmokeReport['safety'] {
  return {
    target_agent_found: false,
    target_agent_runtime: null,
    target_agent_status: null,
    target_tmux_session: null,
    active_claim_count: 0,
    pending_count: 0,
    denylist_hit: false,
    blockers: [`agent ${agentId} not found`],
  }
}

function buildSmokeReportBase(opts: Required<Pick<QueueWakeSmokeOptions, 'mode' | 'timeoutMs' | 'pollMs'>> & { agentId: string; nowMs: () => number }, safety: QueueWakeSmokeReport['safety']): QueueWakeSmokeReport {
  const plan = {
    kind: 'state_daemon_queue_wake_smoke',
    version: 1,
    agent_id: opts.agentId,
    timeout_ms: opts.timeoutMs,
    poll_ms: opts.pollMs,
  }
  return {
    ok: opts.mode === 'dry_run' && safety.blockers.length === 0,
    mode: opts.mode,
    result: 'not_run',
    generated_at: new Date(opts.nowMs()).toISOString(),
    plan_hash: planHash(plan),
    run_id: null,
    policy: smokePolicy(),
    options: {
      agent_id: opts.agentId,
      timeout_ms: opts.timeoutMs,
      poll_ms: opts.pollMs,
    },
    safety,
    smoke: {
      queue_id: null,
      message_id: null,
      inserted_at: null,
      first_observed_at: null,
      completed_at: null,
      initial_status: null,
      final_status: null,
      row_last_wake_attempt_at: null,
      agent_last_wake_attempt_at: null,
      evidence: [],
      polls: 0,
    },
  }
}

async function loadSmokeSafety(db: DbAdapter, agentId: string, denylist: string[]): Promise<QueueWakeSmokeReport['safety']> {
  const agents = await db.query<SmokeAgentRow>(
    `SELECT agent_id, runtime, status, metadata, last_wake_attempt_at
       FROM agents
      WHERE agent_id = $1`,
    [agentId],
  )
  if (agents.length === 0) return emptySmokeSafety(agentId)
  const agent = agents[0]
  const metadata = parseJsonObject(agent.metadata)
  const tmuxSession = typeof metadata.tmux_session === 'string' && metadata.tmux_session.trim()
    ? metadata.tmux_session.trim()
    : null
  const counts = await db.query<QueueCountRow>(
    `SELECT
       COUNT(id) FILTER (WHERE status = 'pending') AS pending_count,
       COUNT(id) FILTER (
         WHERE status IN ('received', 'in_progress') AND claimed_by = agent_id
       ) AS active_claim_count
       FROM message_queue
      WHERE agent_id = $1`,
    [agentId],
  )
  const pendingCount = parseCount(counts[0]?.pending_count)
  const activeClaimCount = parseCount(counts[0]?.active_claim_count)
  const blockers: string[] = []
  const runtime = agent.runtime ?? null
  const status = agent.status ?? null
  const denylistHit = denylist.includes(agentId)
  if (denylistHit) blockers.push('target agent is in STATE_DAEMON_AGENT_DENYLIST')
  if (isInactiveStatus(status)) blockers.push(`target agent status is ${status}`)
  if (runtime !== defaultConfigPort.getDefaultRuntime()) blockers.push(`target runtime is ${runtime ?? 'null'}, expected ${defaultConfigPort.getDefaultRuntime()}`)
  if (!tmuxSession) blockers.push('target agent is missing metadata.tmux_session')
  if (pendingCount > 0) blockers.push(`target already has ${pendingCount} pending row(s)`)
  if (activeClaimCount > 0) blockers.push(`target already has ${activeClaimCount} active claim(s)`)
  return {
    target_agent_found: true,
    target_agent_runtime: runtime,
    target_agent_status: status,
    target_tmux_session: tmuxSession,
    active_claim_count: activeClaimCount,
    pending_count: pendingCount,
    denylist_hit: denylistHit,
    blockers,
  }
}

async function recordSmokeAudit(db: DbAdapter, report: QueueWakeSmokeReport): Promise<void> {
  try {
    await db.execute(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
       VALUES ($1, $2, $3, $4, 'default')`,
      [
        SMOKE_EVENT_TYPE,
        report.options.agent_id,
        report.run_id,
        JSON.stringify({
          result: report.result,
          ok: report.ok,
          run_id: report.run_id,
          queue_id: report.smoke.queue_id,
          message_id: report.smoke.message_id,
          inserted_at: report.smoke.inserted_at,
          completed_at: report.smoke.completed_at,
          final_status: report.smoke.final_status,
          row_last_wake_attempt_at: report.smoke.row_last_wake_attempt_at,
          agent_last_wake_attempt_at: report.smoke.agent_last_wake_attempt_at,
          evidence: report.smoke.evidence,
          policy: report.policy,
        }),
      ],
    )
  } catch {
    // Diagnostics must not mask the smoke result.
  }
}

function smokePassed(row: SmokeQueueRow, agentLastWakeAttemptAt: string | null, insertedAt: string): string[] {
  const evidence: string[] = []
  const rowWake = normalizeIso(row.last_wake_attempt_at)
  if (rowWake && new Date(rowWake).getTime() >= new Date(insertedAt).getTime()) {
    evidence.push('message_queue.last_wake_attempt_at advanced')
  }
  if (agentLastWakeAttemptAt && new Date(agentLastWakeAttemptAt).getTime() >= new Date(insertedAt).getTime()) {
    evidence.push('agents.last_wake_attempt_at advanced')
  }
  if (row.status === 'pending' && !rowWake && !agentLastWakeAttemptAt) {
    evidence.push('message_queue row visible; TUI wake prompt injection disabled')
  }
  return evidence
}

export async function buildQueueWakeSmokeReport(db: DbAdapter, options: QueueWakeSmokeOptions = {}): Promise<QueueWakeSmokeReport> {
  const nowMs = options.nowMs ?? (() => Date.now())
  const sleepMs = options.sleepMs ?? defaultSleep
  const mode = options.mode ?? 'dry_run'
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_SMOKE_POLL_MS
  const agentId = options.agentId ?? defaultSmokeAgentId()
  const denylist = options.denylist ?? parseCsv(process.env.STATE_DAEMON_AGENT_DENYLIST)
  const baseOptions = { mode, timeoutMs, pollMs, agentId, nowMs }

  const safety = await loadSmokeSafety(db, agentId, denylist)
  const report = buildSmokeReportBase(baseOptions, safety)
  if (safety.blockers.length > 0) {
    report.ok = false
    report.result = 'blocked'
    return report
  }
  if (mode === 'dry_run') return report
  if (options.confirmPlanHash !== report.plan_hash) {
    report.ok = false
    report.error = 'OPERATOR_APPROVAL_REQUIRED'
    return report
  }

  const runId = `queue-wake-smoke-${randomUUID()}`
  const messageId = randomUUID()
  const insertedAt = new Date(nowMs()).toISOString()
  report.run_id = runId
  report.smoke.message_id = messageId
  report.smoke.inserted_at = insertedAt
  const content = `State-daemon queue visibility smoke ${runId}. No runtime action or tool call is requested.`
  let queueId: string | null = null
  try {
    await db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string | number; created_at?: string | Date | null }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 0, $4)
         RETURNING id, created_at`,
        [
          agentId,
          messageId,
          JSON.stringify({
            channel_id: 'state-daemon-queue-wake-smoke',
            author_id: 'state-daemon-smoke',
            author_name: 'state-daemon smoke',
            content,
            message_type: 'instruction',
            source: 'state-daemon-queue-wake-smoke',
            smoke_run_id: runId,
          }),
          insertedAt,
        ],
      )
      queueId = String(inserted[0]?.id ?? '')
    })
  } catch (err) {
    report.ok = false
    report.result = 'error'
    report.smoke.evidence.push(`insert failed: ${(err as Error).message ?? String(err)}`)
    await recordSmokeAudit(db, report)
    return report
  }

  report.smoke.queue_id = queueId
  const deadline = nowMs() + timeoutMs
  while (nowMs() <= deadline) {
    report.smoke.polls++
    const rows = await db.query<SmokeQueueRow>(
      `SELECT id, status, created_at, last_wake_attempt_at, read_at, claimed_by, claimed_at
         FROM message_queue
        WHERE id = $1`,
      [queueId],
    )
    const row = rows[0]
    if (row) {
      if (!report.smoke.first_observed_at) {
        report.smoke.first_observed_at = new Date(nowMs()).toISOString()
        report.smoke.initial_status = row.status
      }
      report.smoke.final_status = row.status
      report.smoke.row_last_wake_attempt_at = normalizeIso(row.last_wake_attempt_at)
      const agentRows = await db.query<{ last_wake_attempt_at: string | Date | null }>(
        `SELECT last_wake_attempt_at FROM agents WHERE agent_id = $1`,
        [agentId],
      )
      report.smoke.agent_last_wake_attempt_at = normalizeIso(agentRows[0]?.last_wake_attempt_at)
      const evidence = smokePassed(row, report.smoke.agent_last_wake_attempt_at, insertedAt)
      if (evidence.length > 0) {
        report.ok = true
        report.result = 'pass'
        report.smoke.completed_at = new Date(nowMs()).toISOString()
        report.smoke.evidence = evidence
        await recordSmokeAudit(db, report)
        return report
      }
    }
    if (nowMs() >= deadline) break
    await sleepMs(Math.min(pollMs, Math.max(0, deadline - nowMs())))
  }

  report.ok = false
  report.result = 'timeout'
  report.smoke.completed_at = new Date(nowMs()).toISOString()
  report.smoke.evidence.push('bounded poll timed out before queue visibility or wake-disabled evidence')
  await recordSmokeAudit(db, report)
  return report
}

export async function fetchLatestQueueWakeSmoke(db: DbAdapter): Promise<LatestQueueWakeSmoke | null> {
  const rows = await db.query<any>(
    `SELECT event_type, agent_id, target, detail, created_at
       FROM audit_log
      WHERE event_type = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [SMOKE_EVENT_TYPE],
  )
  const row = rows[0]
  if (!row) return null
  return {
    event_type: String(row.event_type),
    agent_id: row.agent_id ?? null,
    target: row.target ?? null,
    created_at: normalizeIso(row.created_at),
    detail: parseJsonObject(row.detail),
  }
}

export function summarizeQueueWakeStates(rows: Iterable<BotStatusDbRow>): {
  counts: Record<QueueWakeState, number>
  stuck_agents: Array<{ agent_id: string; queue_wake_state: QueueWakeState; pending_count: number; oldest_pending_at: string | null; active_claim_count: number }>
} {
  const counts: Record<QueueWakeState, number> = {
    none: 0,
    pending_observed: 0,
    wake_attempt_recorded: 0,
    idle_pending_no_wake_progress: 0,
    busy_active_pending_growth: 0,
  }
  const stuck_agents: Array<{ agent_id: string; queue_wake_state: QueueWakeState; pending_count: number; oldest_pending_at: string | null; active_claim_count: number }> = []
  for (const row of rows) {
    counts[row.queue_wake_state]++
    if (row.queue_wake_state === 'idle_pending_no_wake_progress' || row.queue_wake_state === 'busy_active_pending_growth') {
      stuck_agents.push({
        agent_id: row.agent_id,
        queue_wake_state: row.queue_wake_state,
        pending_count: row.pending_count,
        oldest_pending_at: row.oldest_pending_at,
        active_claim_count: row.active_claim_count,
      })
    }
  }
  return { counts, stuck_agents }
}

function readinessFinding(
  code: string,
  severity: 'blocker' | 'warning',
  message: string,
  extra: Omit<QueueProcessingReadinessFinding, 'code' | 'severity' | 'message'> = {},
): QueueProcessingReadinessFinding {
  return { code, severity, message, ...extra }
}

export function buildQueueProcessingReadinessReport(
  rows: Iterable<BotStatusDbRow>,
  runtime: StateDaemonRuntimeReadiness,
  options: { now?: Date } = {},
): QueueProcessingReadinessReport {
  const rowList = Array.from(rows)
  const blockers: QueueProcessingReadinessFinding[] = []
  const warnings: QueueProcessingReadinessFinding[] = []
  const transportBlockerCodes: string[] = []

  if (runtime.status !== 'ok') {
    transportBlockerCodes.push('STATE_DAEMON_TRANSPORT_NOT_READY')
    blockers.push(readinessFinding('STATE_DAEMON_TRANSPORT_NOT_READY', 'blocker', 'state-daemon transport is not ready', {
      evidence: {
        status: runtime.status,
        launchd_loaded: runtime.launchd.loaded,
        launchd_running: runtime.launchd.running,
        pid: runtime.process.pid,
      },
    }))
  }
  if (runtime.stderr.fatal_fingerprint) {
    transportBlockerCodes.push('STATE_DAEMON_FATAL_STDERR')
    blockers.push(readinessFinding('STATE_DAEMON_FATAL_STDERR', 'blocker', 'state-daemon stderr contains a fatal startup fingerprint', {
      evidence: {
        stderr_path: runtime.stderr.path,
        fatal_fingerprint: runtime.stderr.fatal_fingerprint,
      },
    }))
  }

  const wakeSummary = summarizeQueueWakeStates(rowList)
  const queueBlockerCodes = wakeSummary.stuck_agents.length > 0 ? ['QUEUE_WAKE_STUCK'] : []
  for (const agent of wakeSummary.stuck_agents) {
    blockers.push(readinessFinding('QUEUE_WAKE_STUCK', 'blocker', 'agent has pending queue work without safe wake progress', {
      agent_id: agent.agent_id,
      evidence: agent,
    }))
  }
  if (rowList.length === 0) {
    warnings.push(readinessFinding('NO_AGENT_STATUS_ROWS', 'warning', 'no agent status rows were returned for queue-processing readiness'))
  }

  const pendingTotal = rowList.reduce((sum, row) => sum + row.pending_count, 0)
  const activeClaimTotal = rowList.reduce((sum, row) => sum + row.active_claim_count, 0)
  const transportReady = transportBlockerCodes.length === 0
  const queueReady = queueBlockerCodes.length === 0
  const ok = transportReady && queueReady
  return {
    ok,
    go_no_go: ok ? 'GO' : 'NO_GO',
    generated_at: (options.now ?? new Date()).toISOString(),
    issue_ref: '#603',
    transport_readiness: {
      ready: transportReady,
      state_daemon_status: runtime.status,
      launchd_loaded: runtime.launchd.loaded,
      launchd_running: runtime.launchd.running,
      pid: runtime.process.pid,
      script: runtime.paths.script,
      working_directory: runtime.paths.working_directory,
      stderr_fatal_fingerprint: runtime.stderr.fatal_fingerprint,
      blocker_codes: transportBlockerCodes,
    },
    queue_processing_readiness: {
      ready: queueReady,
      total_agents: rowList.length,
      pending_total: pendingTotal,
      active_claim_total: activeClaimTotal,
      wake_state_counts: wakeSummary.counts,
      stuck_agents: wakeSummary.stuck_agents,
      blocker_codes: queueBlockerCodes,
    },
    policy: {
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_discord_live_write: true,
      no_next_inbox_fifo_drain: true,
      no_prompt_driven_processing: true,
      no_live_smoke: true,
    },
    blockers,
    warnings,
    recommended_next_commands: ok
      ? []
      : ['Repair transport or queue-processing blockers before requesting a bounded live smoke approval.'],
    mutation_performed: false,
    restart_performed: false,
  }
}

export function formatStateDaemonReadinessLine(readiness: StateDaemonRuntimeReadiness, latestSmoke?: LatestQueueWakeSmoke | null): string {
  const smokeText = latestSmoke
    ? `${latestSmoke.detail.result ?? 'unknown'}@${latestSmoke.created_at ?? 'unknown'} run=${latestSmoke.detail.run_id ?? latestSmoke.target ?? '-'}`
    : 'none'
  return [
    `state-daemon=${readiness.status}`,
    `launchd_loaded=${String(readiness.launchd.loaded)}`,
    `launchd_running=${String(readiness.launchd.running)}`,
    `pid=${readiness.process.pid ?? '-'}`,
    `path=${readiness.paths.script ?? '-'}`,
    `cwd=${readiness.process.cwd ?? readiness.paths.working_directory ?? '-'}`,
    `stderr_fatal=${readiness.stderr.fatal_fingerprint ?? 'none'}`,
    `queue_smoke=${smokeText}`,
  ].join(' ')
}

export function formatQueueProcessingReadinessText(report: QueueProcessingReadinessReport): string {
  const lines = [
    'State-Daemon Queue Processing Readiness',
    `Generated: ${report.generated_at}`,
    `Result: ${report.go_no_go}`,
    `Transport: ready=${report.transport_readiness.ready} status=${report.transport_readiness.state_daemon_status} loaded=${String(report.transport_readiness.launchd_loaded)} running=${String(report.transport_readiness.launchd_running)} pid=${report.transport_readiness.pid ?? '-'}`,
    `Queue: ready=${report.queue_processing_readiness.ready} agents=${report.queue_processing_readiness.total_agents} pending=${report.queue_processing_readiness.pending_total} active_claims=${report.queue_processing_readiness.active_claim_total}`,
    `Wake states: ${Object.entries(report.queue_processing_readiness.wake_state_counts).map(([state, count]) => `${state}=${count}`).join(', ')}`,
    `Mutation performed: ${report.mutation_performed}`,
    `Restart performed: ${report.restart_performed}`,
  ]
  if (report.blockers.length > 0) {
    lines.push('', 'Blockers:')
    for (const blocker of report.blockers) {
      lines.push(`- ${blocker.code}${blocker.agent_id ? ` agent=${blocker.agent_id}` : ''}: ${blocker.message}`)
    }
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export function formatQueueWakeSmokeText(report: QueueWakeSmokeReport): string {
  const lines = [
    'State-Daemon Queue Wake Smoke',
    `Generated: ${report.generated_at}`,
    `Mode: ${report.mode} result=${report.result} ok=${report.ok}`,
    `Plan hash: ${report.plan_hash}`,
    `Agent: ${report.options.agent_id} timeout=${report.options.timeout_ms}ms poll=${report.options.poll_ms}ms`,
    `Policy: bounded_poll=${report.policy.bounded_poll} manual_next=${report.policy.calls_manual_next} terminalizes_existing_rows=${report.policy.terminalizes_existing_rows}`,
  ]
  if (report.error === 'OPERATOR_APPROVAL_REQUIRED') {
    lines.push(`Error: ${report.error}; rerun with --execute --confirm ${report.plan_hash}`)
  }
  if (report.safety.blockers.length > 0) {
    lines.push(`Blockers: ${report.safety.blockers.join('; ')}`)
  }
  if (report.run_id) lines.push(`Run: ${report.run_id}`)
  if (report.smoke.queue_id) {
    lines.push(
      `Queue: id=${report.smoke.queue_id} status=${report.smoke.final_status ?? '-'} inserted=${report.smoke.inserted_at ?? '-'} completed=${report.smoke.completed_at ?? '-'}`,
      `Wake: row=${report.smoke.row_last_wake_attempt_at ?? '-'} agent=${report.smoke.agent_last_wake_attempt_at ?? '-'} polls=${report.smoke.polls}`,
      `Evidence: ${report.smoke.evidence.join('; ') || 'none'}`,
    )
  }
  return `${lines.join('\n')}\n`
}
