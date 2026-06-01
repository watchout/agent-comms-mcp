import { existsSync, readFileSync } from 'node:fs'
import {
  inspectStateDaemonRuntime,
  type StateDaemonRuntimeReadiness,
} from './state-daemon-readiness'

export type Cp70DoctorSeverity = 'blocker' | 'warning' | 'info'

export type Cp70DoctorOptions = {
  agentId?: string | null
  staleSeconds?: number
  inspectLaunchAgent?: boolean
  launchAgent?: StateDaemonRuntimeReadiness | null
  launchAgentPlistText?: string | null
  now?: () => Date
  readFileSync?: typeof readFileSync
  existsSync?: typeof existsSync
}

export type Cp70FindingSample = {
  source: string
  record_id: string | number | null
  queue_id: string | number | null
  queue_ids?: Array<string | number>
  agent_id: string | null
  status: string | null
  created_at: string | Date | null
  evidence: string | null
}

export type Cp70Finding = {
  code: string
  severity: Cp70DoctorSeverity
  title: string
  count: number
  sample_count: number
  samples: Cp70FindingSample[]
  action: string
}

export type Cp70RepairPlanItem = {
  finding_code: string
  dry_run_only: true
  mutation_allowed: false
  exact_ids: Array<string | number>
  commands: string[]
  note: string
}

export type Cp70QueueBacklogRow = {
  agent_id: string
  status: string
  count: number
}

export type Cp70Preflight = {
  ok: boolean
  gate: 'control-plane'
  failed_blocker_count: number
  failed_blocker_codes: string[]
}

export type Cp70DoctorReport = {
  ok: true
  generated_at: string
  scope: {
    agent_id: string | null
    stale_minutes: number
  }
  policy: {
    read_only: true
    no_fifo_drain: true
    no_prompt_driven_processing: true
    no_state_daemon_restart: true
    no_discord_activation: true
    no_schema_migration: true
    repair_is_dry_run_exact_id_only: true
  }
  queue_backlog: {
    status_counts: Record<string, number>
    by_agent_status: Cp70QueueBacklogRow[]
  }
  duplicate_active_baton: {
    supported: boolean
    unsupported_reason: string | null
  }
  launchagent: StateDaemonRuntimeReadiness | null
  findings: Cp70Finding[]
  repair_plan: Cp70RepairPlanItem[]
  non_goals: string[]
  summary: {
    blocker_count: number
    warning_count: number
  }
}

type QueryResult = { rows: any[] } | any[]

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>
}

const SAMPLE_LIMIT = 50

export const CP70_TUI_WAKE_PROMPT_PATTERNS = [
  'Call the agent-comms next tool now. Do not call inbox.',
  'Start processing the agent-comms message you just received',
  'processing tool for its queue_id',
] as const

function rowsOf(result: QueryResult): any[] {
  return Array.isArray(result) ? result : result.rows
}

async function queryRows(db: Queryable, sql: string, params: unknown[] = []): Promise<any[]> {
  return rowsOf(await db.query(sql, params))
}

async function queryRowsSafe(db: Queryable, sql: string, params: unknown[] = []): Promise<{ rows: any[]; error: string | null }> {
  try {
    return { rows: await queryRows(db, sql, params), error: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function promptParams(): string[] {
  return CP70_TUI_WAKE_PROMPT_PATTERNS.map((pattern) => `%${pattern}%`)
}

function promptWhere(column: string, startIndex = 1): string {
  return CP70_TUI_WAKE_PROMPT_PATTERNS
    .map((_pattern, i) => `${column} LIKE $${startIndex + i}`)
    .join(' OR ')
}

function buildAgentFilter(alias: string, params: unknown[], agentId: string | null): string {
  if (!agentId) return ''
  params.push(agentId)
  return ` AND ${alias}.agent_id = $${params.length}`
}

function buildAgentMessageFilter(params: unknown[], agentId: string | null): string {
  if (!agentId) return ''
  params.push(agentId)
  const authorIndex = params.length
  params.push(`%${agentId}%`)
  const metadataIndex = params.length
  return ` AND (am.author_id = $${authorIndex} OR coalesce(am.metadata::text, '') LIKE $${metadataIndex})`
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function totalCount(rows: any[]): number {
  return rows.length > 0 && rows[0].total_count !== undefined
    ? toNumber(rows[0].total_count)
    : rows.length
}

function truncate(value: unknown, max = 240): string | null {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function parseQueueIds(value: unknown): Array<string | number> {
  if (Array.isArray(value)) return value as Array<string | number>
  if (typeof value === 'number') return [value]
  if (typeof value !== 'string') return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function sampleFromRow(row: any): Cp70FindingSample {
  const queueIds = parseQueueIds(row.queue_ids)
  return {
    source: row.source_table ?? row.source ?? 'unknown',
    record_id: row.record_id ?? row.id ?? null,
    queue_id: row.queue_id ?? row.id ?? null,
    queue_ids: queueIds.length > 0 ? queueIds : undefined,
    agent_id: row.agent_id ?? row.author_id ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    evidence: truncate(row.evidence ?? row.content ?? row.payload ?? row.reason ?? null),
  }
}

function samplesFromRows(rows: any[]): Cp70FindingSample[] {
  return rows.slice(0, 8).map(sampleFromRow)
}

function finding(
  code: string,
  severity: Cp70DoctorSeverity,
  title: string,
  rows: any[],
  action: string,
  count = totalCount(rows),
): Cp70Finding {
  return {
    code,
    severity,
    title,
    count,
    sample_count: rows.length,
    samples: samplesFromRows(rows),
    action,
  }
}

function emptyFinding(
  code: string,
  severity: Cp70DoctorSeverity,
  title: string,
  action: string,
): Cp70Finding {
  return finding(code, severity, title, [], action, 0)
}

function shellQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function closeObsoleteDryRunCommand(sample: Cp70FindingSample, reason: string, includeActive = false): string | null {
  if (sample.queue_id === null || !sample.agent_id) return null
  const include = includeActive ? ' --include-active' : ''
  return [
    'agent-com queue close-obsolete',
    `--agent-id ${shellQuote(sample.agent_id)}`,
    `--queue-id ${shellQuote(sample.queue_id)}`,
    include.trim(),
    `--reason ${shellQuote(reason)}`,
    '--dry-run',
  ].filter(Boolean).join(' ')
}

function exactIds(samples: Cp70FindingSample[]): Array<string | number> {
  const ids: Array<string | number> = []
  for (const sample of samples) {
    if (sample.queue_id !== null) ids.push(sample.queue_id)
    for (const id of sample.queue_ids ?? []) ids.push(id)
  }
  return Array.from(new Set(ids))
}

function buildDuplicateBatonRows(rows: any[]): any[] {
  const groups = new Map<string, any[]>()
  for (const row of rows) {
    const key = `${row.agent_id ?? ''}:${row.baton_key ?? row.record_id ?? ''}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const duplicateGroups = Array.from(groups.values())
    .filter((group) => group.length > 1)
  return duplicateGroups
    .map((group) => ({
      source_table: 'message_queue.baton',
      record_id: group[0].baton_key ?? group[0].record_id ?? null,
      queue_id: null,
      queue_ids: group.map((row) => row.queue_id ?? row.id).filter((id) => id !== null && id !== undefined).join(','),
      agent_id: group[0].agent_id ?? null,
      status: 'active',
      created_at: group[0].created_at ?? null,
      evidence: `active_count=${group.length}, baton_or_conversation=${group[0].baton_key ?? group[0].record_id ?? '(unknown)'}`,
      total_count: duplicateGroups.length,
    }))
}

function buildRepairPlan(findings: Cp70Finding[]): Cp70RepairPlanItem[] {
  const byCode = Object.fromEntries(findings.map((item) => [item.code, item]))
  const plan: Cp70RepairPlanItem[] = []

  const prompt = byCode.TUI_WAKE_PROMPT_PRESENT
  const promptSamples = prompt?.samples.filter((sample) => sample.source === 'message_queue.payload' && sample.queue_id !== null) ?? []
  if (promptSamples.length > 0) {
    plan.push({
      finding_code: 'TUI_WAKE_PROMPT_PRESENT',
      dry_run_only: true,
      mutation_allowed: false,
      exact_ids: exactIds(promptSamples),
      commands: promptSamples
        .map((sample) => closeObsoleteDryRunCommand(sample, 'legacy TUI wake prompt artifact', sample.status === 'received' || sample.status === 'in_progress'))
        .filter((cmd): cmd is string => Boolean(cmd)),
      note: 'Dry-run only. Close prompt artifacts one explicit queue_id at a time after operator review.',
    })
  }

  const staleActive = byCode.STALE_ACTIVE_QUEUE_ROWS
  if (staleActive && staleActive.samples.length > 0) {
    plan.push({
      finding_code: 'STALE_ACTIVE_QUEUE_ROWS',
      dry_run_only: true,
      mutation_allowed: false,
      exact_ids: exactIds(staleActive.samples),
      commands: staleActive.samples
        .map((sample) => closeObsoleteDryRunCommand(sample, 'stale active row after CP-70 preflight review', true))
        .filter((cmd): cmd is string => Boolean(cmd)),
      note: 'Dry-run only. Active rows require exact queue_id review; this slice does not apply mutations.',
    })
  }

  const duplicate = byCode.DUPLICATE_ACTIVE_BATON
  if (duplicate && duplicate.samples.length > 0) {
    plan.push({
      finding_code: 'DUPLICATE_ACTIVE_BATON',
      dry_run_only: true,
      mutation_allowed: false,
      exact_ids: exactIds(duplicate.samples),
      commands: exactIds(duplicate.samples).map((id) => `agent-com diagnose-delivery --queue-id ${shellQuote(id)}`),
      note: 'Dry-run diagnosis only. Resolve duplicate active baton rows with an exact-id repair plan in a separately approved change.',
    })
  }

  return plan
}

function readLaunchAgentPlistText(
  runtime: StateDaemonRuntimeReadiness | null,
  options: Cp70DoctorOptions,
): string | null {
  if (options.launchAgentPlistText !== undefined) return options.launchAgentPlistText
  const path = runtime?.paths.plist_path
  if (!path) return null
  const exists = options.existsSync ?? existsSync
  const read = options.readFileSync ?? readFileSync
  try {
    if (!exists(path)) return null
    return read(path, 'utf8')
  } catch {
    return null
  }
}

function launchAgentPromptRows(runtime: StateDaemonRuntimeReadiness | null, plistText: string | null): any[] {
  if (!runtime || !plistText) return []
  return CP70_TUI_WAKE_PROMPT_PATTERNS
    .filter((pattern) => plistText.includes(pattern))
    .map((pattern) => ({
      source_table: 'launchagent.plist',
      record_id: runtime.paths.plist_path,
      queue_id: null,
      agent_id: null,
      status: runtime.status,
      created_at: runtime.checked_at,
      evidence: pattern,
    }))
}

function launchAgentMismatchRows(runtime: StateDaemonRuntimeReadiness | null): any[] {
  if (!runtime) return []
  const rows: any[] = []
  const installed = Boolean(runtime.paths.plist_path)
  if (installed && runtime.launchd.available === false) {
    rows.push({ source_table: 'launchagent.runtime', record_id: runtime.label, status: runtime.status, reason: 'launchctl unavailable while LaunchAgent plist exists' })
  }
  if (installed && runtime.launchd.loaded === false) {
    rows.push({ source_table: 'launchagent.runtime', record_id: runtime.label, status: runtime.status, reason: 'LaunchAgent plist exists but launchd job is not loaded' })
  }
  if (runtime.launchd.loaded === true && runtime.launchd.running === false) {
    rows.push({ source_table: 'launchagent.runtime', record_id: runtime.label, status: runtime.status, reason: 'launchd job is loaded but not running' })
  }
  if (runtime.status === 'degraded') {
    rows.push({ source_table: 'launchagent.runtime', record_id: runtime.label, status: runtime.status, reason: runtime.stderr.fatal_fingerprint ?? 'state_daemon runtime is degraded' })
  }
  if (runtime.process.cwd && runtime.paths.working_directory && runtime.process.cwd !== runtime.paths.working_directory) {
    rows.push({
      source_table: 'launchagent.runtime',
      record_id: runtime.label,
      status: runtime.status,
      reason: `process cwd ${runtime.process.cwd} differs from LaunchAgent WorkingDirectory ${runtime.paths.working_directory}`,
    })
  }
  return rows
}

function suspectPathRows(runtime: StateDaemonRuntimeReadiness | null): any[] {
  if (!runtime) return []
  const values: Array<[string, string | null]> = [
    ['paths.program', runtime.paths.program],
    ['paths.script', runtime.paths.script],
    ['paths.working_directory', runtime.paths.working_directory],
    ['process.command', runtime.process.command],
    ['process.cwd', runtime.process.cwd],
  ]
  const suspect = /(?:^|\/)(?:private\/tmp|tmp)\/(?:agent-comms|state-daemon-build)/i
  return values
    .filter(([_source, value]) => value !== null && suspect.test(value))
    .map(([source, value]) => ({
      source_table: `launchagent.${source}`,
      record_id: runtime.label,
      queue_id: null,
      agent_id: null,
      status: runtime.status,
      created_at: runtime.checked_at,
      evidence: value,
    }))
}

async function resolveLaunchAgent(options: Cp70DoctorOptions): Promise<StateDaemonRuntimeReadiness | null> {
  if (options.launchAgent !== undefined) return options.launchAgent
  if (options.inspectLaunchAgent === false) return null
  return inspectStateDaemonRuntime()
}

export function buildCp70Preflight(report: Cp70DoctorReport): Cp70Preflight {
  const failed = report.findings.filter((finding) => finding.severity === 'blocker' && finding.count > 0)
  return {
    ok: failed.length === 0,
    gate: 'control-plane',
    failed_blocker_count: failed.length,
    failed_blocker_codes: failed.map((finding) => finding.code),
  }
}

export async function buildCp70DoctorReport(db: Queryable, options: Cp70DoctorOptions = {}): Promise<Cp70DoctorReport> {
  const agentId = options.agentId ?? null
  const staleSeconds = Number.isFinite(options.staleSeconds) && (options.staleSeconds ?? 0) >= 0
    ? Number(options.staleSeconds)
    : 15 * 60
  const staleMinutes = Math.floor(staleSeconds / 60)
  const now = options.now ?? (() => new Date())

  const countParams: unknown[] = []
  const countAgentFilter = buildAgentFilter('mq', countParams, agentId)
  const statusCountsRows = await queryRows(
    db,
    `SELECT mq.status, count(*)::int AS count
       FROM message_queue mq
      WHERE 1=1${countAgentFilter}
      GROUP BY mq.status
      ORDER BY mq.status`,
    countParams,
  )

  const backlogRows = await queryRows(
    db,
    `SELECT mq.agent_id, mq.status, count(*)::int AS count
       FROM message_queue mq
      WHERE mq.status IN ('pending', 'received', 'in_progress')
        ${countAgentFilter}
      GROUP BY mq.agent_id, mq.status
      ORDER BY count DESC, mq.agent_id ASC, mq.status ASC
      LIMIT 100`,
    countParams,
  )

  const mqPromptParams = promptParams()
  const mqPromptAgentFilter = buildAgentFilter('mq', mqPromptParams, agentId)
  const messageQueuePromptRows = await queryRows(
    db,
    `SELECT 'message_queue.payload' AS source_table,
            mq.id AS record_id, mq.id AS queue_id, mq.agent_id, mq.message_id,
            mq.status, mq.created_at, mq.payload AS evidence,
            count(*) OVER ()::int AS total_count
       FROM message_queue mq
      WHERE (${promptWhere('mq.payload')})
        ${mqPromptAgentFilter}
      ORDER BY mq.created_at ASC
      LIMIT ${SAMPLE_LIMIT}`,
    mqPromptParams,
  )

  const amContentParams = promptParams()
  const amContentFilter = buildAgentMessageFilter(amContentParams, agentId)
  const agentMessageContentRows = await queryRows(
    db,
    `SELECT 'agent_messages.content' AS source_table,
            am.id AS record_id, NULL AS queue_id, am.author_id AS agent_id,
            NULL AS status, am.created_at, am.content AS evidence,
            count(*) OVER ()::int AS total_count
       FROM agent_messages am
      WHERE (${promptWhere('am.content')})
        ${amContentFilter}
      ORDER BY am.created_at ASC
      LIMIT ${SAMPLE_LIMIT}`,
    amContentParams,
  )

  const amMetadataParams = promptParams()
  const amMetadataFilter = buildAgentMessageFilter(amMetadataParams, agentId)
  const agentMessageMetadataRows = await queryRows(
    db,
    `SELECT 'agent_messages.metadata' AS source_table,
            am.id AS record_id, NULL AS queue_id, am.author_id AS agent_id,
            NULL AS status, am.created_at, coalesce(am.metadata::text, '') AS evidence,
            count(*) OVER ()::int AS total_count
       FROM agent_messages am
      WHERE (${promptWhere("coalesce(am.metadata::text, '')")})
        ${amMetadataFilter}
      ORDER BY am.created_at ASC
      LIMIT ${SAMPLE_LIMIT}`,
    amMetadataParams,
  )

  const staleParams: unknown[] = [String(staleSeconds)]
  const staleAgentFilter = buildAgentFilter('mq', staleParams, agentId)
  const staleActiveRows = await queryRows(
    db,
    `SELECT 'message_queue.active' AS source_table,
            mq.id AS record_id, mq.id AS queue_id, mq.agent_id, mq.message_id,
            mq.status, mq.created_at,
            ('claimed_by=' || coalesce(mq.claimed_by, '(null)') || ', claimed_at=' || coalesce(mq.claimed_at::text, '(null)') || ', claim_expires_at=' || coalesce(mq.claim_expires_at::text, '(null)')) AS evidence,
            count(*) OVER ()::int AS total_count
       FROM message_queue mq
      WHERE mq.status IN ('received', 'in_progress')
        AND (
          (mq.claim_expires_at IS NOT NULL AND mq.claim_expires_at < now())
          OR (mq.claim_expires_at IS NULL AND mq.claimed_at IS NOT NULL AND mq.claimed_at < now() - ($1 || ' seconds')::interval)
          OR (mq.claimed_at IS NULL AND mq.created_at < now() - ($1 || ' seconds')::interval)
        )
        ${staleAgentFilter}
      ORDER BY coalesce(mq.claim_expires_at, mq.claimed_at, mq.created_at) ASC
      LIMIT ${SAMPLE_LIMIT}`,
    staleParams,
  )

  const duplicateParams: unknown[] = []
  const duplicateAgentFilter = buildAgentFilter('mq', duplicateParams, agentId)
  const duplicateQuery = await queryRowsSafe(
    db,
    `SELECT 'message_queue.baton' AS source_table,
            coalesce(mq.baton_id::text, mq.conversation_id::text) AS record_id,
            coalesce(mq.baton_id::text, mq.conversation_id::text) AS baton_key,
            mq.id AS queue_id,
            mq.agent_id,
            mq.status,
            mq.created_at,
            coalesce(mq.baton_id::text, mq.conversation_id::text) AS evidence
       FROM message_queue mq
      WHERE mq.status IN ('received', 'in_progress')
        AND (mq.baton_id IS NOT NULL OR mq.conversation_id IS NOT NULL)
        ${duplicateAgentFilter}
      ORDER BY mq.agent_id ASC, coalesce(mq.baton_id::text, mq.conversation_id::text) ASC, mq.created_at ASC
      LIMIT 500`,
    duplicateParams,
  )
  const duplicateBatonRows = duplicateQuery.error ? [] : buildDuplicateBatonRows(duplicateQuery.rows)

  const launchAgent = await resolveLaunchAgent(options)
  const launchAgentPlistText = readLaunchAgentPlistText(launchAgent, options)
  const launchPromptRows = launchAgentPromptRows(launchAgent, launchAgentPlistText)
  const launchMismatchRows = launchAgentMismatchRows(launchAgent)
  const launchPathRows = suspectPathRows(launchAgent)

  const promptRows = [
    ...messageQueuePromptRows,
    ...agentMessageContentRows,
    ...agentMessageMetadataRows,
    ...launchPromptRows,
  ]
  const promptTotal =
    totalCount(messageQueuePromptRows)
    + totalCount(agentMessageContentRows)
    + totalCount(agentMessageMetadataRows)
    + launchPromptRows.length

  const findings = [
    finding(
      'TUI_WAKE_PROMPT_PRESENT',
      'blocker',
      'legacy TUI wake prompt artifacts are present in DB or LaunchAgent evidence',
      promptRows,
      'Do not drain with next and do not prompt an LLM to call next/inbox/processing/done. Review exact ids and close obsolete artifacts only by explicit queue_id dry-run first.',
      promptTotal,
    ),
    finding(
      'STALE_ACTIVE_QUEUE_ROWS',
      'blocker',
      `received/in_progress rows stale beyond ${staleMinutes} minutes`,
      staleActiveRows,
      'Classify each exact queue_id. This slice only reports dry-run exact-id repair commands.',
    ),
    duplicateQuery.error
      ? emptyFinding(
        'DUPLICATE_ACTIVE_BATON',
        'warning',
        'duplicate active baton/turn rows could not be evaluated with current schema',
        `Duplicate active baton support unavailable: ${duplicateQuery.error}`,
      )
      : finding(
        'DUPLICATE_ACTIVE_BATON',
        'blocker',
        'duplicate active baton/conversation rows are present',
        duplicateBatonRows,
        'Inspect exact queue_ids and resolve duplicate active ownership with a separately approved exact-id repair.',
      ),
    finding(
      'STATE_DAEMON_LAUNCHAGENT_MISMATCH',
      'blocker',
      'state_daemon LaunchAgent installed/running evidence is inconsistent',
      launchMismatchRows,
      'Do not restart from this command. Fix LaunchAgent install/run mismatch through the approved operator path before reactivation.',
    ),
    finding(
      'STATE_DAEMON_CHECKOUT_PATH_SUSPECT',
      'blocker',
      'state_daemon LaunchAgent/process points at a tmp checkout or build artifact',
      launchPathRows,
      'Do not run stale tmp checkouts. Repoint through the approved install path before daemon reactivation.',
    ),
  ]

  return {
    ok: true,
    generated_at: now().toISOString(),
    scope: {
      agent_id: agentId,
      stale_minutes: staleMinutes,
    },
    policy: {
      read_only: true,
      no_fifo_drain: true,
      no_prompt_driven_processing: true,
      no_state_daemon_restart: true,
      no_discord_activation: true,
      no_schema_migration: true,
      repair_is_dry_run_exact_id_only: true,
    },
    queue_backlog: {
      status_counts: statusCountsRows.reduce((acc: Record<string, number>, row: any) => {
        acc[row.status] = toNumber(row.count)
        return acc
      }, {}),
      by_agent_status: backlogRows.map((row: any) => ({
        agent_id: row.agent_id,
        status: row.status,
        count: toNumber(row.count),
      })),
    },
    duplicate_active_baton: {
      supported: duplicateQuery.error === null,
      unsupported_reason: duplicateQuery.error,
    },
    launchagent: launchAgent,
    findings,
    repair_plan: buildRepairPlan(findings),
    non_goals: [
      'codex_session_transcript_scan',
    ],
    summary: {
      blocker_count: findings.filter((finding) => finding.severity === 'blocker' && finding.count > 0).length,
      warning_count: findings.filter((finding) => finding.severity === 'warning' && finding.count > 0).length,
    },
  }
}

export function formatCp70DoctorText(report: Cp70DoctorReport, preflight?: Cp70Preflight): string {
  const lines = [
    'CP-70 Control-Plane Doctor',
    `Scope: ${report.scope.agent_id ?? 'all agents'} / stale>${report.scope.stale_minutes}m`,
    '',
    'Policy: read-only, no FIFO drain, no prompt-driven processing, dry-run exact-id repair only',
    '',
    'Queue backlog:',
    ...Object.entries(report.queue_backlog.status_counts).map(([status, count]) => `  ${status}: ${count}`),
    '',
    'Findings:',
    ...report.findings
      .filter((finding) => finding.count > 0)
      .map((finding) => `  [${finding.severity}] ${finding.code}: ${finding.count}`),
    '',
    'Repair plan:',
    ...(report.repair_plan.length === 0
      ? ['  none']
      : report.repair_plan.map((item) => `  ${item.finding_code}: ${item.exact_ids.join(', ') || 'n/a'} (dry-run only)`)),
    '',
    `Non-goals: ${report.non_goals.join(', ')}`,
  ]
  if (preflight) {
    lines.push('', `Preflight(${preflight.gate}): ${preflight.ok ? 'ok' : `blocked (${preflight.failed_blocker_count}: ${preflight.failed_blocker_codes.join(', ')})`}`)
  }
  return `${lines.join('\n')}\n`
}
