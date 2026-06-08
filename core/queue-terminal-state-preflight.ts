export type QueueTerminalStateSeverity = 'blocker' | 'warning' | 'info'

export type QueueTerminalStateSample = {
  queue_id: string | number
  agent_id: string | null
  message_id: string | null
  status: string | null
  created_at: string | Date | null
  claimed_by: string | null
  claimed_at: string | Date | null
  claim_expires_at: string | Date | null
  replied_at: string | Date | null
  replied_with: string | null
  done_at: string | Date | null
  payload_bytes: number
  payload_shape: 'json_like' | 'empty' | 'text'
}

export type QueueTerminalStateFinding = {
  code: string
  severity: QueueTerminalStateSeverity
  title: string
  count: number
  sample_count: number
  sample_by_agent: Record<string, number>
  samples: QueueTerminalStateSample[]
  action: string
}

export type QueueTerminalStateColumn = {
  column_name: string
  data_type: string | null
  is_nullable: string | null
}

export type QueueTerminalStateStatusCheck = {
  constraint_name: string | null
  definition: string | null
  allowed_statuses: string[]
  expected_statuses: string[]
  missing_expected_statuses: string[]
  legacy_statuses_allowed: string[]
  contract_ready: boolean
}

export type QueueTerminalStatePreflightReport = {
  ok: true
  generated_at: string
  issue_ref: '#407'
  policy: {
    read_only: true
    no_db_mutation: true
    no_queue_mutation: true
    no_schema_migration: true
    live_migration_requires_operator_approval: true
  }
  scope: {
    agent_id: string | null
  }
  contract: {
    active_statuses: string[]
    reply_terminal_status: 'replied'
    no_reply_terminal_status: 'done'
    legacy_statuses: string[]
    invariants: string[]
  }
  schema: {
    inspection_ok: boolean
    inspection_errors: string[]
    columns: QueueTerminalStateColumn[]
    missing_required_columns: string[]
    audit_columns_missing: string[]
    status_check: QueueTerminalStateStatusCheck
  }
  status_counts: Record<string, number>
  findings: QueueTerminalStateFinding[]
  preflight: {
    ok: boolean
    blocker_count: number
    blocker_codes: string[]
    migration_ready: boolean
  }
  migration_plan: Array<{
    step: string
    required_evidence: string
    live_action_allowed: false
  }>
}

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] } | any[]>
}

const ACTIVE_STATUSES = ['pending', 'received', 'in_progress']
const EXPECTED_STATUSES = ['pending', 'received', 'in_progress', 'done', 'replied']
const LEGACY_STATUSES = ['read', 'skipped', 'failed']
const REQUIRED_COLUMNS = ['status', 'replied_at', 'replied_with', 'done_at', 'claimed_by', 'claimed_at', 'claim_expires_at', 'payload']
const AUDIT_COLUMNS = ['failed_reason']

async function queryRows(db: Queryable, sql: string, params?: unknown[]): Promise<any[]> {
  const result = await db.query(sql, params)
  return Array.isArray(result) ? result : result.rows ?? []
}

async function safeQueryRows(db: Queryable, sql: string, params: unknown[], errors: string[]): Promise<any[]> {
  try {
    return await queryRows(db, sql, params)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.push(message)
    return []
  }
}

function normalizeCount(raw: unknown): number {
  const parsed = Number(raw ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function rowCount(row: any): number {
  return normalizeCount(row?.count ?? row?.n ?? row?.total_count)
}

function extractStatusLiterals(definition: string | null): string[] {
  if (!definition) return []
  return [...new Set([...definition.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter(Boolean))]
}

function sampleByAgent(samples: QueueTerminalStateSample[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const sample of samples) {
    const agent = sample.agent_id ?? '<null>'
    out[agent] = (out[agent] ?? 0) + 1
  }
  return out
}

function toSample(row: any): QueueTerminalStateSample {
  const payloadBytes = normalizeCount(row.payload_bytes)
  const payloadShape = row.payload_shape === 'json_like' || row.payload_shape === 'empty' ? row.payload_shape : 'text'
  return {
    queue_id: row.id,
    agent_id: row.agent_id ?? null,
    message_id: row.message_id ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    claimed_by: row.claimed_by ?? null,
    claimed_at: row.claimed_at ?? null,
    claim_expires_at: row.claim_expires_at ?? null,
    replied_at: row.replied_at ?? null,
    replied_with: row.replied_with ?? null,
    done_at: row.done_at ?? null,
    payload_bytes: payloadBytes,
    payload_shape: payloadShape,
  }
}

function staticFinding(
  code: string,
  severity: QueueTerminalStateSeverity,
  title: string,
  count: number,
  action: string,
): QueueTerminalStateFinding {
  return {
    code,
    severity,
    title,
    count,
    sample_count: 0,
    sample_by_agent: {},
    samples: [],
    action,
  }
}

async function dataFinding(
  db: Queryable,
  input: {
    code: string
    severity: QueueTerminalStateSeverity
    title: string
    where: string
    action: string
    agentId: string | null
  },
): Promise<QueueTerminalStateFinding> {
  const agentFilter = input.agentId ? ' AND agent_id = $1' : ''
  const params = input.agentId ? [input.agentId] : []
  const countRows = await queryRows(
    db,
    `SELECT count(*) AS count
       FROM message_queue
      WHERE ${input.where}${agentFilter}`,
    params,
  )
  const samples = (await queryRows(
    db,
    `SELECT id, agent_id, message_id, status, created_at, claimed_by, claimed_at,
            claim_expires_at, replied_at, replied_with, done_at,
            length(coalesce(payload, '')) AS payload_bytes,
            CASE
              WHEN coalesce(payload, '') = '' THEN 'empty'
              WHEN left(ltrim(payload), 1) = '{' THEN 'json_like'
              ELSE 'text'
            END AS payload_shape
       FROM message_queue
      WHERE ${input.where}${agentFilter}
      ORDER BY created_at ASC
      LIMIT 8`,
    params,
  )).map(toSample)
  return {
    code: input.code,
    severity: input.severity,
    title: input.title,
    count: rowCount(countRows[0]),
    sample_count: samples.length,
    sample_by_agent: sampleByAgent(samples),
    samples,
    action: input.action,
  }
}

function buildStatusCheck(rows: any[]): QueueTerminalStateStatusCheck {
  const row = rows[0] ?? null
  const definition = row?.definition ?? row?.constraint_def ?? null
  const allowed = extractStatusLiterals(definition)
  const missingExpected = EXPECTED_STATUSES.filter((status) => !allowed.includes(status))
  const legacyAllowed = LEGACY_STATUSES.filter((status) => allowed.includes(status))
  return {
    constraint_name: row?.constraint_name ?? row?.conname ?? null,
    definition,
    allowed_statuses: allowed,
    expected_statuses: [...EXPECTED_STATUSES],
    missing_expected_statuses: missingExpected,
    legacy_statuses_allowed: legacyAllowed,
    contract_ready: definition !== null && missingExpected.length === 0 && legacyAllowed.length === 0,
  }
}

function policy(): QueueTerminalStatePreflightReport['policy'] {
  return {
    read_only: true,
    no_db_mutation: true,
    no_queue_mutation: true,
    no_schema_migration: true,
    live_migration_requires_operator_approval: true,
  }
}

function migrationPlan(): QueueTerminalStatePreflightReport['migration_plan'] {
  return [
    {
      step: 'Inventory legacy terminal/active rows and impossible mixed states.',
      required_evidence: 'queue terminal-preflight JSON with zero reply-evidence, pending-claim, and active-owner blockers.',
      live_action_allowed: false,
    },
    {
      step: 'Archive or normalize legacy read/skipped/failed rows only under an approved migration plan.',
      required_evidence: 'backup, dry-run row counts, per-status disposition policy, and audit evidence mapping.',
      live_action_allowed: false,
    },
    {
      step: 'Narrow message_queue.status CHECK after legacy rows are handled.',
      required_evidence: 'operator approval, L1/L2/L3 review, and schema preflight proving no blocked rows remain.',
      live_action_allowed: false,
    },
  ]
}

export async function buildQueueTerminalStatePreflightReport(
  db: Queryable,
  options: { agentId?: string | null } = {},
): Promise<QueueTerminalStatePreflightReport> {
  const agentId = options.agentId ?? null
  const schemaErrors: string[] = []
  const columnRows = await safeQueryRows(
    db,
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'message_queue'
      ORDER BY ordinal_position`,
    [],
    schemaErrors,
  )
  const statusCheckRows = await safeQueryRows(
    db,
    `SELECT c.conname AS constraint_name, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'message_queue'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%status%'
      ORDER BY c.conname
      LIMIT 1`,
    [],
    schemaErrors,
  )
  const statusCheck = buildStatusCheck(statusCheckRows)
  const columnNames = new Set(columnRows.map((row) => String(row.column_name)))
  const missingRequired = REQUIRED_COLUMNS.filter((column) => !columnNames.has(column))
  const auditMissing = AUDIT_COLUMNS.filter((column) => !columnNames.has(column))

  const agentFilter = agentId ? ' WHERE agent_id = $1' : ''
  const agentParams = agentId ? [agentId] : []
  const statusRows = await queryRows(
    db,
    `SELECT status, count(*) AS count
       FROM message_queue${agentFilter}
      GROUP BY status
      ORDER BY status`,
    agentParams,
  )

  const dataFindings = await Promise.all([
    dataFinding(db, {
      agentId,
      code: 'replied_missing_reply_evidence',
      severity: 'blocker',
      title: "status='replied' rows missing replied_with or replied_at",
      where: "status = 'replied' AND (replied_with IS NULL OR replied_at IS NULL)",
      action: 'Do not treat these rows as reply evidence; reconcile with agent_messages/outbound evidence before enforcing the contract.',
    }),
    dataFinding(db, {
      agentId,
      code: 'pending_with_claim',
      severity: 'blocker',
      title: "status='pending' rows retaining claim ownership",
      where: "status = 'pending' AND (claimed_by IS NOT NULL OR claimed_at IS NOT NULL OR claim_expires_at IS NOT NULL)",
      action: 'Fix reset/reclaim paths to clear claim columns atomically before migration or restart gates rely on pending.',
    }),
    dataFinding(db, {
      agentId,
      code: 'active_claim_missing_owner',
      severity: 'blocker',
      title: "received/in_progress rows missing claimed_by",
      where: "status IN ('received', 'in_progress') AND claimed_by IS NULL",
      action: 'Reclaim or repair active rows; active processing states must be owner-bound.',
    }),
    dataFinding(db, {
      agentId,
      code: 'done_missing_done_at',
      severity: 'blocker',
      title: "status='done' rows missing done_at",
      where: "status = 'done' AND done_at IS NULL",
      action: 'Terminal no-reply completion must stamp done_at and durable terminal baton evidence.',
    }),
    dataFinding(db, {
      agentId,
      code: 'legacy_status_rows',
      severity: 'blocker',
      title: 'legacy read/skipped/failed rows still present',
      where: "status IN ('read', 'skipped', 'failed')",
      action: 'Archive or normalize with audit evidence before narrowing the status CHECK constraint.',
    }),
  ])

  const schemaFindings: QueueTerminalStateFinding[] = []
  if (schemaErrors.length > 0) {
    schemaFindings.push(staticFinding(
      'schema_inspection_failed',
      'blocker',
      'message_queue schema could not be inspected',
      schemaErrors.length,
      'Run against PostgreSQL with read-only catalog access; do not proceed to live migration without schema evidence.',
    ))
  }
  if (missingRequired.length > 0) {
    schemaFindings.push(staticFinding(
      'required_columns_missing',
      'blocker',
      `message_queue is missing required columns: ${missingRequired.join(', ')}`,
      missingRequired.length,
      'Do not run terminal-state enforcement until required columns are present.',
    ))
  }
  if (!statusCheck.definition) {
    schemaFindings.push(staticFinding(
      'message_queue_status_check_missing',
      'blocker',
      'message_queue status CHECK constraint was not found',
      1,
      'Add or repair the status CHECK constraint through reviewed migration only.',
    ))
  } else if (!statusCheck.contract_ready) {
    schemaFindings.push(staticFinding(
      'terminal_status_contract_not_enforced',
      'blocker',
      'message_queue status CHECK still permits legacy statuses or misses expected statuses',
      statusCheck.legacy_statuses_allowed.length + statusCheck.missing_expected_statuses.length,
      'Handle legacy rows, then narrow the CHECK to pending/received/in_progress/done/replied under operator-approved migration.',
    ))
  }
  if (auditMissing.length > 0) {
    schemaFindings.push(staticFinding(
      'audit_columns_missing',
      'warning',
      `message_queue audit columns missing: ${auditMissing.join(', ')}`,
      auditMissing.length,
      'Confirm replacement terminal reason/evidence storage before dropping legacy audit columns.',
    ))
  }

  const findings = [...schemaFindings, ...dataFindings]
  const blockers = findings.filter((finding) => finding.severity === 'blocker' && finding.count > 0)
  const migrationReady = blockers.length === 0 && statusCheck.contract_ready

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    issue_ref: '#407',
    policy: policy(),
    scope: { agent_id: agentId },
    contract: {
      active_statuses: [...ACTIVE_STATUSES],
      reply_terminal_status: 'replied',
      no_reply_terminal_status: 'done',
      legacy_statuses: [...LEGACY_STATUSES],
      invariants: [
        "status='replied' requires replied_with and replied_at",
        "status='done' requires done_at and durable no-reply terminal evidence",
        "status='pending' must not retain claimed_by, claimed_at, or claim_expires_at",
        "status IN ('received','in_progress') requires claimed_by",
        "legacy read/skipped/failed rows must be archived or normalized with audit evidence before status CHECK narrowing",
      ],
    },
    schema: {
      inspection_ok: schemaErrors.length === 0,
      inspection_errors: schemaErrors,
      columns: columnRows.map((row) => ({
        column_name: String(row.column_name),
        data_type: row.data_type ?? null,
        is_nullable: row.is_nullable ?? null,
      })),
      missing_required_columns: missingRequired,
      audit_columns_missing: auditMissing,
      status_check: statusCheck,
    },
    status_counts: statusRows.reduce((acc: Record<string, number>, row: any) => {
      acc[String(row.status)] = rowCount(row)
      return acc
    }, {}),
    findings,
    preflight: {
      ok: blockers.length === 0,
      blocker_count: blockers.length,
      blocker_codes: blockers.map((finding) => finding.code),
      migration_ready: migrationReady,
    },
    migration_plan: migrationPlan(),
  }
}

export function formatQueueTerminalStatePreflightText(report: QueueTerminalStatePreflightReport): string {
  const lines = [
    'Queue Terminal-State Preflight',
    `Issue: ${report.issue_ref}`,
    `Scope: ${report.scope.agent_id ?? 'all agents'}`,
    `Preflight: ${report.preflight.ok ? 'ok' : `blocked (${report.preflight.blocker_codes.join(', ')})`}`,
    `Migration ready: ${report.preflight.migration_ready ? 'yes' : 'no'}`,
    '',
    'Status CHECK:',
    `  name: ${report.schema.status_check.constraint_name ?? '-'}`,
    `  allowed: ${report.schema.status_check.allowed_statuses.join(', ') || '-'}`,
    `  legacy_allowed: ${report.schema.status_check.legacy_statuses_allowed.join(', ') || '-'}`,
    `  missing_expected: ${report.schema.status_check.missing_expected_statuses.join(', ') || '-'}`,
    '',
    'Status counts:',
    ...Object.entries(report.status_counts).map(([status, count]) => `  ${status}: ${count}`),
    '',
    'Findings:',
  ]
  for (const finding of report.findings.filter((item) => item.count > 0)) {
    lines.push(`  [${finding.severity}] ${finding.code}: ${finding.count}`)
    lines.push(`    ${finding.action}`)
  }
  if (report.findings.every((finding) => finding.count === 0)) {
    lines.push('  clean: no terminal-state contract blockers found')
  }
  return `${lines.join('\n')}\n`
}
