export const MESSAGE_QUEUE_STATUS_DRIFT_CODE = 'DB_CODE_DRIFT'
export const MESSAGE_QUEUE_STATUS_TABLE = 'message_queue'
export const MESSAGE_QUEUE_STATUS_CONSTRAINT = 'message_queue_status_check'

export const MESSAGE_QUEUE_ACTIVE_RECEIVE_VOCABULARY = [
  'pending',
  'received',
  'in_progress',
  'done',
  'replied',
] as const

export type MessageQueueStatusGuardSource =
  | 'postgres_constraint'
  | 'sqlite_schema'
  | 'missing_constraint'
  | 'uninspectable'

export type MessageQueueStatusSchemaReport = {
  ok: boolean
  code: typeof MESSAGE_QUEUE_STATUS_DRIFT_CODE
  operation: string
  table: typeof MESSAGE_QUEUE_STATUS_TABLE
  constraint: typeof MESSAGE_QUEUE_STATUS_CONSTRAINT
  expected_vocabulary: string[]
  required_statuses: string[]
  actual_vocabulary: string[]
  missing_statuses: string[]
  constraint_definition: string | null
  source: MessageQueueStatusGuardSource
  detail: string
}

export type MessageQueueStatusSchemaGuardDb = {
  query<T = any>(sql: string, params?: any[]): Promise<T[] | { rows: T[] }>
}

export type MessageQueueStatusSchemaGuardOptions = {
  operation?: string
  requiredStatuses?: readonly string[]
}

export class DbCodeDriftError extends Error {
  code = MESSAGE_QUEUE_STATUS_DRIFT_CODE
  report: MessageQueueStatusSchemaReport

  constructor(report: MessageQueueStatusSchemaReport) {
    super(formatMessageQueueStatusCodeDrift(report))
    this.name = 'DbCodeDriftError'
    this.report = report
  }
}

export function isDbCodeDriftError(err: unknown): err is DbCodeDriftError {
  return err instanceof DbCodeDriftError
    || (typeof err === 'object'
      && err !== null
      && (err as { code?: unknown }).code === MESSAGE_QUEUE_STATUS_DRIFT_CODE
      && typeof (err as { report?: unknown }).report === 'object')
}

export function extractMessageQueueStatusVocabulary(constraintDefinition: string | null | undefined): string[] {
  if (!constraintDefinition) return []
  const statusInBodies = Array.from(
    constraintDefinition.matchAll(/\bstatus\b\s+IN\s*\(([^)]*)\)/gi),
    (m) => m[1] ?? '',
  )
  const source = statusInBodies.length > 0 ? statusInBodies.join(',') : constraintDefinition
  const values: string[] = []
  for (const match of source.matchAll(/'((?:''|[^'])*)'/g)) {
    const value = (match[1] ?? '').replace(/''/g, "'")
    if (value && !values.includes(value)) values.push(value)
  }
  return values
}

export function buildMessageQueueStatusSchemaReport(input: {
  operation?: string
  constraintDefinition: string | null
  source: MessageQueueStatusGuardSource
  requiredStatuses?: readonly string[]
}): MessageQueueStatusSchemaReport {
  const expected = [...MESSAGE_QUEUE_ACTIVE_RECEIVE_VOCABULARY]
  const required = [...(input.requiredStatuses ?? expected)]
  const actual = extractMessageQueueStatusVocabulary(input.constraintDefinition)
  const actualSet = new Set(actual)
  const missing = required.filter((status) => !actualSet.has(status))
  const ok = missing.length === 0 && input.constraintDefinition !== null && actual.length > 0
  const operation = input.operation ?? 'message_queue receive'
  const detail = ok
    ? `${MESSAGE_QUEUE_STATUS_TABLE}.${MESSAGE_QUEUE_STATUS_CONSTRAINT} accepts required status vocabulary for ${operation}.`
    : `${MESSAGE_QUEUE_STATUS_TABLE}.${MESSAGE_QUEUE_STATUS_CONSTRAINT} is incompatible for ${operation}; missing statuses: ${missing.join(', ') || 'unknown'}.`

  return {
    ok,
    code: MESSAGE_QUEUE_STATUS_DRIFT_CODE,
    operation,
    table: MESSAGE_QUEUE_STATUS_TABLE,
    constraint: MESSAGE_QUEUE_STATUS_CONSTRAINT,
    expected_vocabulary: expected,
    required_statuses: required,
    actual_vocabulary: actual,
    missing_statuses: missing,
    constraint_definition: input.constraintDefinition,
    source: input.source,
    detail,
  }
}

export function formatMessageQueueStatusCodeDrift(report: MessageQueueStatusSchemaReport): string {
  return `Error [${MESSAGE_QUEUE_STATUS_DRIFT_CODE}]: ${report.detail} ${JSON.stringify({
    code: report.code,
    operation: report.operation,
    table: report.table,
    constraint: report.constraint,
    expected_vocabulary: report.expected_vocabulary,
    required_statuses: report.required_statuses,
    actual_vocabulary: report.actual_vocabulary,
    missing_statuses: report.missing_statuses,
    constraint_definition: report.constraint_definition,
    source: report.source,
  })}`
}

export async function buildMessageQueueStatusVocabularyReport(
  db: MessageQueueStatusSchemaGuardDb,
  options: MessageQueueStatusSchemaGuardOptions = {},
): Promise<MessageQueueStatusSchemaReport> {
  const pgConstraint = await readPostgresConstraintDefinition(db)
  if (pgConstraint.definition) {
    return buildMessageQueueStatusSchemaReport({
      operation: options.operation,
      constraintDefinition: pgConstraint.definition,
      source: 'postgres_constraint',
      requiredStatuses: options.requiredStatuses,
    })
  }

  const sqliteConstraint = await readSqliteConstraintDefinition(db)
  if (sqliteConstraint.definition) {
    return buildMessageQueueStatusSchemaReport({
      operation: options.operation,
      constraintDefinition: sqliteConstraint.definition,
      source: 'sqlite_schema',
      requiredStatuses: options.requiredStatuses,
    })
  }

  return buildMessageQueueStatusSchemaReport({
    operation: options.operation,
    constraintDefinition: null,
    source: pgConstraint.readable || sqliteConstraint.readable ? 'missing_constraint' : 'uninspectable',
    requiredStatuses: options.requiredStatuses,
  })
}

export async function assertMessageQueueStatusVocabularyCompatible(
  db: MessageQueueStatusSchemaGuardDb,
  options: MessageQueueStatusSchemaGuardOptions = {},
): Promise<MessageQueueStatusSchemaReport> {
  const report = await buildMessageQueueStatusVocabularyReport(db, options)
  if (!report.ok) throw new DbCodeDriftError(report)
  return report
}

async function readPostgresConstraintDefinition(
  db: MessageQueueStatusSchemaGuardDb,
): Promise<{ definition: string | null; readable: boolean }> {
  try {
    const rows = await queryRows<{ constraint_definition: string | null }>(db, `
      SELECT pg_get_constraintdef(c.oid) AS constraint_definition
        FROM pg_constraint c
       WHERE c.conrelid = 'message_queue'::regclass
         AND c.conname = $1
       LIMIT 1`,
      [MESSAGE_QUEUE_STATUS_CONSTRAINT],
    )
    const definition = rows[0]?.constraint_definition
    return { definition: typeof definition === 'string' && definition.trim() ? definition : null, readable: true }
  } catch {
    return { definition: null, readable: false }
  }
}

async function readSqliteConstraintDefinition(
  db: MessageQueueStatusSchemaGuardDb,
): Promise<{ definition: string | null; readable: boolean }> {
  try {
    const rows = await queryRows<{ constraint_definition: string | null }>(db, `
      SELECT sql AS constraint_definition
        FROM sqlite_master
       WHERE type = 'table'
         AND name = $1
       LIMIT 1`,
      [MESSAGE_QUEUE_STATUS_TABLE],
    )
    const definition = rows[0]?.constraint_definition
    return { definition: typeof definition === 'string' && definition.trim() ? definition : null, readable: true }
  } catch {
    return { definition: null, readable: false }
  }
}

async function queryRows<T>(
  db: MessageQueueStatusSchemaGuardDb,
  sql: string,
  params?: any[],
): Promise<T[]> {
  const result = await db.query<T>(sql, params)
  if (Array.isArray(result)) return result
  return Array.isArray(result.rows) ? result.rows : []
}
