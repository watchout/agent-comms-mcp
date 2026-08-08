import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { DbAdapter } from '../db'
import {
  detectQueueWorkHandoffContract,
  type QueueWorkHandoffContract,
  type QueueWorkWritebackMode,
} from '../queue-work'
import {
  loadQueueWorkResiduePolicyFromEnv,
  validateStateDaemonCanaryOverlayEnv,
  validateQueueWorkCanaryResiduePreflight,
  type QueueWorkCanaryResidueDb,
} from './launchagent'

export type QueueWorkActivationRuntime = 'codex-exec' | 'echo' | 'command-json'

export interface QueueWorkActivationPlanOptions {
  agentId?: string | null
  queueId?: string | null
  commit?: string | null
  runtime?: string | null
  queueWorkCommand?: string | null
  residuePolicyFile?: string | null
  githubWritebackMode?: string | null
  mediatedPostingCommand?: string | null
  mediatedPostingArgsJson?: string | null
  canaryControlRef?: string | null
  canaryOwnerDecisionRef?: string | null
  canaryExpiresAt?: string | null
  canaryPriorPlistSha256?: string | null
  canaryRollbackCommand?: string | null
  canaryObservedStateDestination?: string | null
  canarySubjectDigest?: string | null
  now?: () => Date
}

export interface QueueWorkActivationCandidate {
  queue_id: string
  agent_id: string
  message_id: string | null
  status: string
  created_at: string | null
  priority: number | null
}

export interface QueueWorkActivationFinding {
  code: string
  message: string
  evidence?: Record<string, unknown>
}

export interface QueueWorkActivationMediatedPostingReadiness {
  command_path: string | null
  command_present: boolean
  command_probe: 'not_required' | 'not_run' | 'passed' | 'failed'
  summary?: string | null
}

export interface QueueWorkActivationPlanReport {
  ok: boolean
  go_no_go: 'GO' | 'NO_GO'
  generated_at: string
  issue_ref: '#603'
  target: {
    agent_id: string | null
    queue_id: string | null
    commit: string | null
    runtime: QueueWorkActivationRuntime | string
  }
  candidate: QueueWorkActivationCandidate | null
  policy: {
    read_only: true
    no_db_mutation: true
    no_state_daemon_restart: true
    no_launchctl_mutation: true
    no_live_runner_enablement: true
    no_queue_drain: true
    no_payload_echo: true
    execute_requires_separate_approval: true
  }
  activation_env: Record<string, string>
  handoff_contract: QueueWorkHandoffContract | null
  mediated_posting: QueueWorkActivationMediatedPostingReadiness
  dry_run_command: string[]
  execute_command: string[]
  blockers: QueueWorkActivationFinding[]
  warnings: QueueWorkActivationFinding[]
  mutation_performed: false
  restart_performed: false
}

type QueueRow = {
  id: string | number
  agent_id: string
  message_id?: string | null
  status: string
  created_at?: string | Date | null
  priority?: string | number | null
  payload?: string | null
}

const DEFAULT_RESIDUE_POLICY_FILE = 'config/queue-work-residue-policy.json'
const DEFAULT_CODEX_OUTPUT_SCHEMA = 'schemas/queue-work-result-v1.schema.json'
const SUPPORTED_RUNTIMES = new Set(['codex-exec', 'echo', 'command-json'])
const CANARY_OVERLAY_OPTION_ENV = [
  ['canaryControlRef', 'STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF'],
  ['canaryOwnerDecisionRef', 'STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF'],
  ['canaryExpiresAt', 'STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT'],
  ['canaryPriorPlistSha256', 'STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256'],
  ['canaryRollbackCommand', 'STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND'],
  ['canaryObservedStateDestination', 'STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION'],
  ['canarySubjectDigest', 'STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST'],
] as const satisfies readonly (readonly [keyof QueueWorkActivationPlanOptions, string])[]

function execFileJson(
  command: string,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, {
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const execErr = err as (NodeJS.ErrnoException & { code?: unknown }) | null
      resolvePromise({
        status: err == null ? 0 : typeof execErr.code === 'number' ? execErr.code : 1,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeQueueIdParam(value: string): string | number {
  return /^[1-9]\d*$/.test(value) ? Number.parseInt(value, 10) : value
}

function normalizeDate(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString()
  const text = normalizeText(value ?? null)
  return text
}

function normalizePriority(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function declaresShirubeD1Binding(payload: string | null): boolean {
  if (!payload) return false
  try {
    const parsed = JSON.parse(payload)
    return parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Object.prototype.hasOwnProperty.call(parsed, 'shirube_v4_d1')
  } catch {
    return false
  }
}

function normalizeQueueRow(row: QueueRow): QueueWorkActivationCandidate {
  return {
    queue_id: String(row.id),
    agent_id: row.agent_id,
    message_id: normalizeText(row.message_id ?? null),
    status: row.status,
    created_at: normalizeDate(row.created_at),
    priority: normalizePriority(row.priority),
  }
}

function defaultResiduePolicyFile(): string | null {
  return existsSync(DEFAULT_RESIDUE_POLICY_FILE) ? DEFAULT_RESIDUE_POLICY_FILE : null
}

function buildActivationEnv(
  candidate: QueueWorkActivationCandidate,
  runtime: QueueWorkActivationRuntime | string,
  residuePolicyFile: string | null,
  queueWorkCommand: string | null,
  handoffContract: QueueWorkHandoffContract,
  mediatedPostingCommand: string | null,
  mediatedPostingArgsJson: string | null,
  options: QueueWorkActivationPlanOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    STATE_DAEMON_CODEX_RUNNER_ENABLED: '0',
    STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '1',
    STATE_DAEMON_AGENT_ALLOWLIST: candidate.agent_id,
    STATE_DAEMON_QUEUE_WORK_RUNTIME: runtime,
    STATE_DAEMON_QUEUE_WORK_FINALIZE: '1',
    STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS: candidate.queue_id,
  }
  if (candidate.message_id) env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS = candidate.message_id
  if (candidate.created_at) env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER = candidate.created_at
  if (residuePolicyFile) env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE = residuePolicyFile
  env.STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT = handoffContract.kind
  if (handoffContract.github_backed) {
    env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE = handoffContract.posting_mode
  }
  if (mediatedPostingCommand) {
    env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND = mediatedPostingCommand
  }
  if (mediatedPostingArgsJson) {
    env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON = mediatedPostingArgsJson
  }
  if (runtime === 'codex-exec') {
    env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA = DEFAULT_CODEX_OUTPUT_SCHEMA
    env.STATE_DAEMON_QUEUE_WORK_CODEX_SANDBOX = 'read-only'
  }
  if (runtime === 'command-json' && queueWorkCommand) {
    env.STATE_DAEMON_QUEUE_WORK_COMMAND = queueWorkCommand
  }
  for (const [optionKey, envKey] of CANARY_OVERLAY_OPTION_ENV) {
    const value = normalizeText(options[optionKey] as string | null | undefined)
    if (value) env[envKey] = value
  }
  return env
}

function buildRestoreCommand(env: Record<string, string>, commit: string, execute: boolean): string[] {
  const command = [
    'bun',
    'scripts/state-daemon-launchagent.ts',
    'restore',
    '--commit',
    commit,
    '--disable-codex-runner',
    '--enable-queue-work-scheduler',
    '--agent-allowlist',
    env.STATE_DAEMON_AGENT_ALLOWLIST,
    '--queue-work-runtime',
    env.STATE_DAEMON_QUEUE_WORK_RUNTIME,
    '--queue-work-finalize',
    '--queue-work-fence-queue-ids',
    env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS,
  ]
  const canaryOverlayEnv = Object.fromEntries(
    CANARY_OVERLAY_OPTION_ENV
      .map(([, envKey]) => [envKey, env[envKey]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  )
  if (Object.keys(canaryOverlayEnv).length > 0) {
    command.push('--canary-overlay-env-json', JSON.stringify(canaryOverlayEnv))
  }
  if (env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS) {
    command.push('--queue-work-fence-message-ids', env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER) {
    command.push('--queue-work-fence-created-after', env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE) {
    command.push('--queue-work-residue-policy-file', env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA) {
    command.push('--queue-work-codex-output-schema', env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_CODEX_SANDBOX) {
    command.push('--queue-work-codex-sandbox', env.STATE_DAEMON_QUEUE_WORK_CODEX_SANDBOX)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_COMMAND) {
    command.push('--queue-work-command', env.STATE_DAEMON_QUEUE_WORK_COMMAND)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT) {
    command.push('--queue-work-handoff-contract', env.STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE) {
    command.push('--queue-work-github-writeback-mode', env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND) {
    command.push('--queue-work-mediated-posting-command', env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND)
  }
  if (env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON) {
    command.push('--queue-work-mediated-posting-args-json', env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON)
  }
  if (execute) command.push('--execute')
  return command
}

function emptyReport(options: QueueWorkActivationPlanOptions, blockers: QueueWorkActivationFinding[]): QueueWorkActivationPlanReport {
  return {
    ok: false,
    go_no_go: 'NO_GO',
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    issue_ref: '#603',
    target: {
      agent_id: normalizeText(options.agentId ?? null),
      queue_id: normalizeText(options.queueId ?? null),
      commit: normalizeText(options.commit ?? null),
      runtime: normalizeText(options.runtime ?? null) ?? 'codex-exec',
    },
    candidate: null,
    policy: {
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_live_runner_enablement: true,
      no_queue_drain: true,
      no_payload_echo: true,
      execute_requires_separate_approval: true,
    },
    activation_env: {},
    handoff_contract: null,
    mediated_posting: {
      command_path: normalizeText(options.mediatedPostingCommand ?? null),
      command_present: false,
      command_probe: 'not_run',
      summary: null,
    },
    dry_run_command: [],
    execute_command: [],
    blockers,
    warnings: [],
    mutation_performed: false,
    restart_performed: false,
  }
}

function residueDb(db: DbAdapter): QueueWorkCanaryResidueDb {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
      const rows = await db.query<T>(sql, params as any[])
      return { rows, rowCount: rows.length }
    },
  }
}

export async function buildQueueWorkActivationPlan(
  db: DbAdapter,
  options: QueueWorkActivationPlanOptions = {},
): Promise<QueueWorkActivationPlanReport> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString()
  const agentId = normalizeText(options.agentId ?? null)
  const queueId = normalizeText(options.queueId ?? null)
  const commit = normalizeText(options.commit ?? null)
  const runtime = normalizeText(options.runtime ?? null) ?? 'codex-exec'
  const queueWorkCommand = normalizeText(options.queueWorkCommand ?? null)
  const githubWritebackMode = normalizeText(options.githubWritebackMode ?? null) ?? 'none'
  const mediatedPostingCommand = normalizeText(options.mediatedPostingCommand ?? null)
  const mediatedPostingArgsJson = normalizeText(options.mediatedPostingArgsJson ?? null)
  const blockers: QueueWorkActivationFinding[] = []
  const warnings: QueueWorkActivationFinding[] = []
  const mediatedPostingReadiness: QueueWorkActivationMediatedPostingReadiness = {
    command_path: mediatedPostingCommand,
    command_present: mediatedPostingCommand ? existsSync(mediatedPostingCommand) : false,
    command_probe: 'not_run',
    summary: null,
  }

  if (!agentId) {
    blockers.push({ code: 'agent_id_required', message: 'Queue-work activation planning requires --agent-id.' })
  }
  if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) {
    blockers.push({ code: 'commit_required', message: 'Queue-work activation planning requires a 7-40 character git commit SHA.' })
  }
  if (!SUPPORTED_RUNTIMES.has(runtime)) {
    blockers.push({
      code: 'queue_work_runtime_unsupported',
      message: 'Queue-work activation runtime must be codex-exec, echo, or command-json.',
      evidence: { runtime },
    })
  }
  if (runtime === 'command-json' && !queueWorkCommand) {
    blockers.push({
      code: 'queue_work_command_required',
      message: 'STATE_DAEMON_QUEUE_WORK_RUNTIME=command-json requires --queue-work-command.',
    })
  }
  if (!['none', 'mediated'].includes(githubWritebackMode)) {
    blockers.push({
      code: 'queue_work_github_writeback_mode_invalid',
      message: 'Queue-work GitHub writeback mode must be none or mediated.',
      evidence: { github_writeback_mode: githubWritebackMode },
    })
  }
  if (mediatedPostingArgsJson) {
    try {
      const parsed = JSON.parse(mediatedPostingArgsJson)
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
        throw new Error('not string array')
      }
    } catch {
      blockers.push({
        code: 'queue_work_mediated_posting_args_invalid',
        message: '--queue-work-mediated-posting-args-json must be a JSON string array.',
      })
    }
  }
  if (blockers.length > 0 || !agentId || !commit) return emptyReport(options, blockers)

  let candidate: QueueWorkActivationCandidate | null = null
  let candidatePayload: string | null = null
  if (queueId) {
    const rows = await db.query<QueueRow>(
      `SELECT id, agent_id, message_id, status, created_at, priority, payload
         FROM message_queue
        WHERE id = $1
        LIMIT 1`,
      [normalizeQueueIdParam(queueId)],
    )
    if (rows.length === 0) {
      blockers.push({
        code: 'queue_id_not_found',
        message: `message_queue row ${queueId} was not found.`,
        evidence: { queue_id: queueId },
      })
    } else {
      candidate = normalizeQueueRow(rows[0])
      candidatePayload = normalizeText(rows[0].payload ?? null)
    }
  } else {
    const rows = await db.query<QueueRow>(
      `SELECT id, agent_id, message_id, status, created_at, priority, payload
         FROM message_queue
        WHERE agent_id = $1
          AND status = 'pending'
        ORDER BY priority DESC, created_at ASC, id ASC
        LIMIT $2`,
      [agentId, 2],
    )
    if (rows.length === 0) {
      blockers.push({
        code: 'pending_queue_row_not_found',
        message: `No pending message_queue row was found for ${agentId}.`,
        evidence: { agent_id: agentId },
      })
    } else if (rows.length > 1) {
      blockers.push({
        code: 'queue_id_required_for_multiple_pending',
        message: `Multiple pending queue rows exist for ${agentId}; pass --queue-id to bind the canary to one exact row.`,
        evidence: { queue_ids: rows.map((row) => String(row.id)) },
      })
    } else {
      candidate = normalizeQueueRow(rows[0])
      candidatePayload = normalizeText(rows[0].payload ?? null)
      warnings.push({
        code: 'queue_id_auto_selected',
        message: 'A single pending queue row was auto-selected; exact --queue-id is preferred for live canaries.',
        evidence: { queue_id: candidate.queue_id },
      })
    }
  }

  if (candidate && candidate.agent_id !== agentId) {
    blockers.push({
      code: 'queue_row_agent_mismatch',
      message: `message_queue row ${candidate.queue_id} belongs to ${candidate.agent_id}, not ${agentId}.`,
      evidence: { queue_id: candidate.queue_id, row_agent_id: candidate.agent_id, requested_agent_id: agentId },
    })
  }
  if (candidate && candidate.status !== 'pending') {
    blockers.push({
      code: 'queue_row_not_pending',
      message: `message_queue row ${candidate.queue_id} is ${candidate.status}; activation canary requires a pending row.`,
      evidence: { queue_id: candidate.queue_id, status: candidate.status },
    })
  }
  if (!candidate || blockers.length > 0) {
    return {
      ...emptyReport(options, blockers),
      generated_at: generatedAt,
      candidate,
      mediated_posting: mediatedPostingReadiness,
      warnings,
    }
  }

  const handoffContract = detectQueueWorkHandoffContract({
    agentId: candidate.agent_id,
    payload: candidatePayload ?? '{}',
    postingMode: githubWritebackMode as QueueWorkWritebackMode,
  })

  if (declaresShirubeD1Binding(candidatePayload) && runtime !== 'command-json') {
    blockers.push({
      code: 'NO_GO_RUNTIME_NOT_DETERMINISTIC',
      message: 'Shirube D1 canary activation requires the deterministic command-json runtime.',
      evidence: { runtime, required_runtime: 'command-json' },
    })
  }

  if (handoffContract.github_backed && handoffContract.posting_mode !== 'mediated') {
    blockers.push({
      code: 'queue_work_github_handoff_requires_mediated_posting',
      message: 'GitHub-backed role handoffs require mediated posting; read-only codex-exec must not post GitHub evidence directly.',
      evidence: {
        runtime,
        github_writeback_mode: handoffContract.posting_mode,
        detected_from: handoffContract.detected_from,
      },
    })
  }
  if (handoffContract.github_backed && !mediatedPostingCommand) {
    blockers.push({
      code: 'queue_work_mediated_posting_command_required',
      message: 'GitHub-backed mediated queue-work handoffs require --queue-work-mediated-posting-command.',
    })
  }
  if (handoffContract.github_backed && mediatedPostingCommand && !existsSync(mediatedPostingCommand)) {
    blockers.push({
      code: 'queue_work_mediated_posting_command_not_found',
      message: '--queue-work-mediated-posting-command must point to an existing first-class posting wrapper.',
      evidence: { path: mediatedPostingCommand },
    })
  }
  if (
    handoffContract.github_backed &&
    handoffContract.posting_mode === 'mediated' &&
    mediatedPostingCommand &&
    blockers.length === 0
  ) {
    const probeArgs = mediatedPostingArgsJson ? JSON.parse(mediatedPostingArgsJson) as string[] : []
    const probe = await execFileJson(mediatedPostingCommand, [...probeArgs, '--probe'])
    try {
      const parsed = JSON.parse(probe.stdout || '{}')
      if (probe.status === 0 && parsed.ok === true) {
        mediatedPostingReadiness.command_probe = 'passed'
        mediatedPostingReadiness.summary = typeof parsed.summary === 'string' ? parsed.summary : null
      } else {
        mediatedPostingReadiness.command_probe = 'failed'
        mediatedPostingReadiness.summary = typeof parsed.summary === 'string'
          ? parsed.summary
          : probe.stderr.slice(0, 500)
        blockers.push({
          code: 'queue_work_mediated_posting_command_probe_failed',
          message: 'Mediated posting command --probe failed.',
          evidence: { status: probe.status, summary: mediatedPostingReadiness.summary },
        })
      }
    } catch {
      mediatedPostingReadiness.command_probe = 'failed'
      mediatedPostingReadiness.summary = 'probe did not return JSON'
      blockers.push({
        code: 'queue_work_mediated_posting_command_probe_invalid',
        message: 'Mediated posting command --probe must return JSON.',
      })
    }
  }
  if (!handoffContract.github_backed) {
    mediatedPostingReadiness.command_probe = 'not_required'
  }

  const residuePolicyFile = options.residuePolicyFile === undefined
    ? defaultResiduePolicyFile()
    : normalizeText(options.residuePolicyFile)
  const activationEnv = buildActivationEnv(
    candidate,
    runtime,
    residuePolicyFile,
    queueWorkCommand,
    handoffContract,
    mediatedPostingCommand,
    mediatedPostingArgsJson,
    options,
  )
  const overlayValidation = validateStateDaemonCanaryOverlayEnv(
    activationEnv,
    options.now?.() ?? new Date(),
  )
  for (const issue of overlayValidation.issues) {
    blockers.push({
      code: issue.code,
      message: issue.message,
      evidence: issue.path ? { path: issue.path } : undefined,
    })
  }
  let residuePolicy = null
  try {
    residuePolicy = loadQueueWorkResiduePolicyFromEnv(activationEnv)
  } catch (err) {
    blockers.push({
      code: 'queue_work_residue_policy_load_failed',
      message: `Queue-work residue policy could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      evidence: activationEnv.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE
        ? { path: activationEnv.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE }
        : undefined,
    })
  }
  if (blockers.length === 0) {
    const residuePreflight = await validateQueueWorkCanaryResiduePreflight(residueDb(db), activationEnv, { residuePolicy })
    for (const issue of residuePreflight.errors) {
      blockers.push({
        code: issue.code,
        message: issue.message,
        evidence: issue.path ? { path: issue.path } : undefined,
      })
    }
    for (const issue of residuePreflight.warnings) {
      warnings.push({
        code: issue.code,
        message: issue.message,
        evidence: issue.path ? { path: issue.path } : undefined,
      })
    }
  }

  const dryRunCommand = blockers.length === 0 ? buildRestoreCommand(activationEnv, commit, false) : []
  const executeCommand = blockers.length === 0 ? buildRestoreCommand(activationEnv, commit, true) : []
  return {
    ok: blockers.length === 0,
    go_no_go: blockers.length === 0 ? 'GO' : 'NO_GO',
    generated_at: generatedAt,
    issue_ref: '#603',
    target: {
      agent_id: agentId,
      queue_id: queueId,
      commit,
      runtime,
    },
    candidate,
    handoff_contract: handoffContract,
    mediated_posting: mediatedPostingReadiness,
    policy: {
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_live_runner_enablement: true,
      no_queue_drain: true,
      no_payload_echo: true,
      execute_requires_separate_approval: true,
    },
    activation_env: activationEnv,
    dry_run_command: dryRunCommand,
    execute_command: executeCommand,
    blockers,
    warnings,
    mutation_performed: false,
    restart_performed: false,
  }
}

export function formatQueueWorkActivationPlanText(report: QueueWorkActivationPlanReport): string {
  const lines = [
    `Queue-work activation plan: ${report.go_no_go}`,
    `OK: ${report.ok}`,
    `Generated: ${report.generated_at}`,
    `Target: agent=${report.target.agent_id ?? '(missing)'} queue=${report.target.queue_id ?? report.candidate?.queue_id ?? '(auto)'} commit=${report.target.commit ?? '(missing)'} runtime=${report.target.runtime}`,
    `Candidate: ${report.candidate ? `${report.candidate.queue_id}:${report.candidate.agent_id}:${report.candidate.status}:${report.candidate.message_id ?? '(no-message-id)'}` : '(none)'}`,
    `Handoff contract: ${report.handoff_contract ? `${report.handoff_contract.kind} posting=${report.handoff_contract.posting_mode}` : '(none)'}`,
    `Mediated posting: command_present=${report.mediated_posting.command_present} command_probe=${report.mediated_posting.command_probe}`,
    `Mutation performed: ${report.mutation_performed}`,
    `Restart performed: ${report.restart_performed}`,
    `Execute requires separate approval: ${report.policy.execute_requires_separate_approval}`,
  ]
  if (report.blockers.length > 0) {
    lines.push('Blockers:')
    for (const blocker of report.blockers) lines.push(`- ${blocker.code}: ${blocker.message}`)
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of report.warnings) lines.push(`- ${warning.code}: ${warning.message}`)
  }
  if (report.dry_run_command.length > 0) {
    lines.push(`Dry-run command: ${report.dry_run_command.join(' ')}`)
  }
  if (report.execute_command.length > 0) {
    lines.push(`Execute command: ${report.execute_command.join(' ')}`)
  }
  return `${lines.join('\n')}\n`
}
