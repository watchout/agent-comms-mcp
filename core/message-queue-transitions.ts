export type MessageQueueTransitionDb = {
  query?<T = any>(sql: string, params?: unknown[]): Promise<{ rows?: T[]; rowCount?: number | null } | T[]>
  execute?(sql: string, params?: unknown[]): Promise<{ rowCount: number }>
}

export type MessageQueueTransitionSetValue = {
  column: string
  value: unknown
}

export type MessageQueueTransitionPredicate = {
  sql: string
  params?: unknown[]
}

export type MessageQueueTransitionInput = {
  db: MessageQueueTransitionDb
  queueId: number | string
  toStatus: string
  set?: MessageQueueTransitionSetValue[]
  where?: MessageQueueTransitionPredicate[]
  clearClaim?: boolean
}

export type MessageQueueTransitionResult = {
  rowCount: number
  sql: string
  params: unknown[]
}

const CLAIM_COLUMNS = ['claimed_by', 'claimed_at', 'claim_expires_at'] as const
const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/i

export async function transitionMessageQueueStatus(
  input: MessageQueueTransitionInput,
): Promise<MessageQueueTransitionResult> {
  const built = buildMessageQueueTransition(input)
  const result = input.db.execute
    ? await input.db.execute(built.sql, built.params)
    : await input.db.query?.(built.sql, built.params)
  if (!result) {
    throw new Error('message_queue transition db must provide query or execute')
  }
  return {
    ...built,
    rowCount: Array.isArray(result) ? result.length : result.rowCount ?? 0,
  }
}

export function buildMessageQueueTransition(input: Omit<MessageQueueTransitionInput, 'db'>): {
  sql: string
  params: unknown[]
} {
  const params: unknown[] = [input.toStatus]
  const assignments = ['status = $1']
  const clearClaim = input.toStatus === 'pending' || input.clearClaim === true
  const cleared = new Set<string>()

  for (const item of input.set ?? []) {
    assertColumnName(item.column)
    if (clearClaim && CLAIM_COLUMNS.includes(item.column as typeof CLAIM_COLUMNS[number])) {
      continue
    }
    params.push(item.value)
    assignments.push(`${item.column} = $${params.length}`)
  }

  if (clearClaim) {
    for (const column of CLAIM_COLUMNS) {
      if (cleared.has(column)) continue
      assignments.push(`${column} = NULL`)
      cleared.add(column)
    }
  }

  params.push(input.queueId)
  const where = [`id = $${params.length}`]
  for (const predicate of input.where ?? []) {
    let predicateSql = predicate.sql
    for (const value of predicate.params ?? []) {
      params.push(value)
      predicateSql = predicateSql.replace(/\?/, `$${params.length}`)
    }
    if (/\?/.test(predicateSql)) {
      throw new Error(`message_queue transition predicate has unbound placeholders: ${predicate.sql}`)
    }
    where.push(`(${predicateSql})`)
  }

  return {
    sql: `UPDATE message_queue
   SET ${assignments.join(',\n       ')}
 WHERE ${where.join('\n   AND ')}`,
    params,
  }
}

function assertColumnName(column: string): void {
  if (!COLUMN_NAME.test(column)) {
    throw new Error(`invalid message_queue transition column: ${column}`)
  }
}
