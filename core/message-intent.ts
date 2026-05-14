export interface MessageDispositionInput {
  intent?: unknown
  expect_response?: unknown
  context?: unknown
  metadata?: unknown
}

export interface MessageDisposition {
  intent: string
  expectResponse: boolean
  context: Record<string, unknown>
}

export interface MessageDispositionDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeMessageDisposition(input: MessageDispositionInput): MessageDisposition {
  const metadata = isRecord(input.metadata) ? input.metadata : {}

  const rawIntent = typeof input.intent === 'string'
    ? input.intent
    : typeof metadata.intent === 'string'
      ? metadata.intent
      : 'request'
  const intent = rawIntent.trim() || 'request'

  const rawExpectResponse = typeof input.expect_response === 'boolean'
    ? input.expect_response
    : typeof metadata.expect_response === 'boolean'
      ? metadata.expect_response
      : undefined
  const expectResponse = rawExpectResponse ?? (intent === 'inform' ? false : true)

  const rawContext = isRecord(input.context)
    ? input.context
    : isRecord(metadata.context)
      ? metadata.context
      : {}

  return { intent, expectResponse, context: rawContext }
}

function parseContext(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {}
  }
  return {}
}

function isMissingDispositionColumnError(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown }
  return err.code === '42703'
    || (typeof err.message === 'string' && /no such column|does not exist/i.test(err.message))
}

export function hasExplicitMessageDisposition(input: MessageDispositionInput): boolean {
  if (input.intent !== undefined || input.expect_response !== undefined || input.context !== undefined) {
    return true
  }
  const metadata = isRecord(input.metadata) ? input.metadata : {}
  return metadata.intent !== undefined
    || metadata.expect_response !== undefined
    || metadata.context !== undefined
}

export async function readMessageQueueDisposition(
  db: MessageDispositionDb,
  queueId: string | number,
): Promise<MessageDisposition> {
  try {
    const row = await db.query<{
      intent?: string | null
      expect_response?: boolean | number | null
      context?: unknown
    }>(
      `SELECT intent, expect_response, context FROM message_queue WHERE id = $1 LIMIT 1`,
      [queueId],
    )
    const r = row.rows[0]
    if (!r) return normalizeMessageDisposition({})
    return {
      intent: r.intent ?? 'request',
      expectResponse: r.expect_response === 1 ? true : r.expect_response === 0 ? false : r.expect_response ?? true,
      context: parseContext(r.context),
    }
  } catch (err) {
    if (isMissingDispositionColumnError(err)) return normalizeMessageDisposition({})
    throw err
  }
}
