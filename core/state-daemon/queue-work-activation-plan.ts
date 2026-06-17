import { existsSync } from 'node:fs'
import type { DbAdapter } from '../db'
import {
  loadQueueWorkResiduePolicyFromEnv,
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
}

const DEFAULT_RESIDUE_POLICY_FILE = 'config/queue-work-residue-policy.json'
const DEFAULT_CODEX_OUTPUT_SCHEMA = 'schemas/queue-work-result-v1.schema.json'
const SUPPORTED_RUNTIMES = new Set(['codex-exec', 'echo', 'command-json'])

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
  if (runtime === 'codex-exec') {
    env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA = DEFAULT_CODEX_OUTPUT_SCHEMA
    env.STATE_DAEMON_QUEUE_WORK_CODEX_SANDBOX = 'read-only'
  }
  if (runtime === 'command-json' && queueWorkCommand) {
    env.STATE_DAEMON_QUEUE_WORK_COMMAND = queueWorkCommand
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
  const blockers: QueueWorkActivationFinding[] = []
  const warnings: QueueWorkActivationFinding[] = []

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
  if (blockers.length > 0 || !agentId || !commit) return emptyReport(options, blockers)

  let candidate: QueueWorkActivationCandidate | null = null
  if (queueId) {
    const rows = await db.query<QueueRow>(
      `SELECT id, agent_id, message_id, status, created_at, priority
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
    }
  } else {
    const rows = await db.query<QueueRow>(
      `SELECT id, agent_id, message_id, status, created_at, priority
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
      warnings,
    }
  }

  const residuePolicyFile = options.residuePolicyFile === undefined
    ? defaultResiduePolicyFile()
    : normalizeText(options.residuePolicyFile)
  const activationEnv = buildActivationEnv(candidate, runtime, residuePolicyFile, queueWorkCommand)
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
